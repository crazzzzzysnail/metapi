import { and, eq, lt } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { upsertRow } from "../db/dialectUpsert.js";
import type {
  PersistedSnapshotRecord,
  SnapshotPersistenceAdapter,
} from "./snapshotCacheService.js";

type AdminSnapshotIdentity = {
  namespace: string;
  key: string;
};

type AdminSnapshotRow = typeof schema.adminSnapshots.$inferSelect;

function serializeSnapshotKey(key: string) {
  return JSON.stringify(key);
}

function buildSnapshotWhere(identity: AdminSnapshotIdentity) {
  return and(
    eq(schema.adminSnapshots.namespace, identity.namespace),
    eq(schema.adminSnapshots.snapshotKey, serializeSnapshotKey(identity.key)),
  );
}

function normalizeTimestamp(value: string, fallbackIso: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallbackIso;
}

function coercePersistedRecord<T>(
  row: AdminSnapshotRow,
): PersistedSnapshotRecord<T> | null {
  const fallbackIso = new Date().toISOString();

  try {
    return {
      payload: JSON.parse(row.payload) as T,
      generatedAt: normalizeTimestamp(row.generatedAt, fallbackIso),
      expiresAt: normalizeTimestamp(row.expiresAt, fallbackIso),
      staleUntil: normalizeTimestamp(row.staleUntil, fallbackIso),
    };
  } catch {
    return null;
  }
}

export async function readAdminSnapshot<T>(
  identity: AdminSnapshotIdentity,
): Promise<PersistedSnapshotRecord<T> | null> {
  const row = await db
    .select()
    .from(schema.adminSnapshots)
    .where(buildSnapshotWhere(identity))
    .get();

  if (!row) return null;

  const record = coercePersistedRecord<T>(row);
  if (record) return record;

  await db
    .delete(schema.adminSnapshots)
    .where(eq(schema.adminSnapshots.id, row.id))
    .run();
  return null;
}

export async function writeAdminSnapshot<T>(
  identity: AdminSnapshotIdentity,
  record: PersistedSnapshotRecord<T>,
): Promise<void> {
  const payload = JSON.stringify(record.payload);
  const values = {
    namespace: identity.namespace,
    snapshotKey: serializeSnapshotKey(identity.key),
    payload,
    generatedAt: record.generatedAt,
    expiresAt: record.expiresAt,
    staleUntil: record.staleUntil,
    updatedAt: new Date().toISOString(),
  };

  // 走方言感知 upsert。原先直接写 `.onConflictDoUpdate(...)`：MySQL 下抛
  // TypeError，而本函数的调用方 snapshotCacheService 会把持久化写失败整条
  // catch 成 console.warn —— 于是线上表现不是报错，而是"快照永远不落库、
  // 进程重启即丢"，比 500 更难发现。
  // namespace + snapshot_key 的唯一索引在三种方言的 bootstrap SQL 里都有。
  await upsertRow({
    table: schema.adminSnapshots,
    values,
    conflictTarget: [
      schema.adminSnapshots.namespace,
      schema.adminSnapshots.snapshotKey,
    ],
    set: {
      payload: values.payload,
      generatedAt: values.generatedAt,
      expiresAt: values.expiresAt,
      staleUntil: values.staleUntil,
      updatedAt: values.updatedAt,
    },
  });
}

export async function deleteExpiredAdminSnapshots(beforeIso?: string) {
  const cutoffIso = beforeIso || new Date().toISOString();
  await db
    .delete(schema.adminSnapshots)
    .where(lt(schema.adminSnapshots.staleUntil, cutoffIso))
    .run();
}

/**
 * 按命名空间清掉落库的快照。
 *
 * 只清内存缓存不够：`readSnapshotCache` 在内存无条目时会把库里那份读回来并复用，
 * 于是"保存成功但页面还是旧数字"，看起来像没生效。进程重启后库里那份同样还在。
 */
export async function deleteAdminSnapshotsByNamespace(namespace: string) {
  await db
    .delete(schema.adminSnapshots)
    .where(eq(schema.adminSnapshots.namespace, namespace))
    .run();
}

export function createAdminSnapshotPersistence<T>(
  identity: AdminSnapshotIdentity,
): SnapshotPersistenceAdapter<T> {
  return {
    read: () => readAdminSnapshot<T>(identity),
    write: (record) => writeAdminSnapshot(identity, record),
  };
}
