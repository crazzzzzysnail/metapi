import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { getInsertedRowId } from '../db/insertHelpers.js';
import {
  containsMaskMarker,
  hasProxyCredentials,
  redactProxyUrl,
} from '../../shared/proxyUrlRedaction.js';
import {
  clearProxyPoolCache,
  proxyPoolDefaultUrl,
  setProxyPoolCache,
} from './proxyPoolStore.js';
import { normalizeSiteProxyUrl } from './proxyUrlNormalize.js';

/**
 * 系统代理池服务：CRUD、默认唯一（允许无默认）、系统代理镜像、启动播种、引用计数、脱敏视图。
 * 默认条目即系统代理的唯一权威：变更默认时同事务写 settings.system_proxy_url 镜像，
 * 提交成功后才刷新缓存并同步内存 config.systemProxyUrl（提交失败则两者都不动）。
 */

const DEFAULT_PROXY_NAME = '默认代理';
const SYSTEM_PROXY_URL_SETTING_KEY = 'system_proxy_url';

export type ProxyPoolView = {
  id: number;
  name: string;
  url: string;
  hasCredentials: boolean;
  isDefault: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type ProxyPoolRow = typeof schema.proxyPool.$inferSelect;

export type ProxyPoolResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };

function toView(row: ProxyPoolRow): ProxyPoolView {
  return {
    id: row.id,
    name: row.name,
    url: redactProxyUrl(row.url),
    hasCredentials: hasProxyCredentials(row.url),
    isDefault: !!row.isDefault,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/** 从库读整池并整体替换缓存；读失败保持现状（宁可用旧地址，也不要全体直连） */
export async function loadProxyPoolCache(): Promise<void> {
  try {
    const rows = await db
      .select({
        id: schema.proxyPool.id,
        url: schema.proxyPool.url,
        isDefault: schema.proxyPool.isDefault,
      })
      .from(schema.proxyPool)
      .all();
    setProxyPoolCache(rows.map((row) => ({ id: row.id, url: row.url, isDefault: !!row.isDefault })));
  } catch {
    // 表尚未迁移等场景：缓存留空，解析走 config.systemProxyUrl 回落，不构成错误
  }
}

async function selectAllRows(): Promise<ProxyPoolRow[]> {
  return db.select().from(schema.proxyPool).all();
}

async function loadRow(id: number): Promise<ProxyPoolRow | null> {
  return db.select().from(schema.proxyPool).where(eq(schema.proxyPool.id, id)).get() ?? null;
}

/** 变更默认条目后写系统代理镜像；必须在事务内与池变更同提交 */
async function writeSystemProxyMirror(txDb: typeof db, url: string): Promise<void> {
  await upsertSetting(SYSTEM_PROXY_URL_SETTING_KEY, url, txDb);
}

/** 提交成功后统一善后：刷缓存 → 同步内存镜像 → 让按 URL 匹配的站点代理缓存失效 */
async function afterPoolMutation(): Promise<void> {
  await loadProxyPoolCache();
  config.systemProxyUrl = proxyPoolDefaultUrl() || '';
  const { invalidateSiteProxyCache } = await import('./siteProxy.js');
  invalidateSiteProxyCache();
}

function invalidProxyUrlResult(): ProxyPoolResult<never> {
  return { ok: false, error: '代理地址无效，请填写合法的 http(s)/socks 代理 URL', status: 400 };
}

function maskedProxyUrlResult(): ProxyPoolResult<never> {
  return { ok: false, error: '代理地址含脱敏占位，请重新填写完整地址', status: 400 };
}

export async function listProxyPool(): Promise<ProxyPoolView[]> {
  const rows = await selectAllRows();
  return rows.sort((left, right) => left.id - right.id).map(toView);
}

/**
 * 新建条目。池为空时首条自动成为默认（仅“从无到有”）；
 * 其余情况一律需要显式设默认，符合“不自动提升”。
 */
export async function createProxyPool(input: {
  name: string;
  url: string;
}): Promise<ProxyPoolResult<ProxyPoolView>> {
  const normalizedUrl = normalizeSiteProxyUrl(input.url);
  if (!normalizedUrl) return invalidProxyUrlResult();
  if (containsMaskMarker(input.url)) return maskedProxyUrlResult();

  const nowIso = new Date().toISOString();
  const insertedId = await db.transaction(async (tx) => {
    const existing = await tx.select({ id: schema.proxyPool.id }).from(schema.proxyPool).all();
    const shouldBecomeDefault = existing.length === 0;
    const insert = await tx.insert(schema.proxyPool).values({
      name: input.name.trim(),
      url: normalizedUrl,
      isDefault: shouldBecomeDefault,
      createdAt: nowIso,
      updatedAt: nowIso,
    }).run();
    const newId = getInsertedRowId(insert);
    if (shouldBecomeDefault && newId) {
      await writeSystemProxyMirror(tx, normalizedUrl);
    }
    return newId;
  });

  if (!insertedId) return { ok: false, error: '创建代理失败', status: 500 };
  await afterPoolMutation();
  const row = await loadRow(insertedId);
  if (!row) return { ok: false, error: '创建代理失败', status: 500 };
  return { ok: true, data: toView(row) };
}

export async function renameProxyPool(id: number, name: string): Promise<ProxyPoolResult<ProxyPoolView>> {
  const existing = await loadRow(id);
  if (!existing) return { ok: false, error: '代理不存在', status: 404 };

  await db.update(schema.proxyPool)
    .set({ name: name.trim(), updatedAt: new Date().toISOString() })
    .where(eq(schema.proxyPool.id, id))
    .run();
  await afterPoolMutation();
  const row = await loadRow(id);
  if (!row) return { ok: false, error: '代理不存在', status: 404 };
  return { ok: true, data: toView(row) };
}

/**
 * 改地址：引用按 id 解析，一次改动影响所有引用者出口（调用方须先展示 usage 并确认）；
 * 默认条目改地址时同事务刷新镜像。
 */
export async function updateProxyPoolUrl(id: number, rawUrl: string): Promise<ProxyPoolResult<ProxyPoolView>> {
  const existing = await loadRow(id);
  if (!existing) return { ok: false, error: '代理不存在', status: 404 };
  const normalizedUrl = normalizeSiteProxyUrl(rawUrl);
  if (!normalizedUrl) return invalidProxyUrlResult();
  if (containsMaskMarker(rawUrl)) return maskedProxyUrlResult();

  await db.transaction(async (tx) => {
    await tx.update(schema.proxyPool)
      .set({ url: normalizedUrl, updatedAt: new Date().toISOString() })
      .where(eq(schema.proxyPool.id, id))
      .run();
    if (existing.isDefault) {
      await writeSystemProxyMirror(tx, normalizedUrl);
    }
  });

  await afterPoolMutation();
  const row = await loadRow(id);
  if (!row) return { ok: false, error: '代理不存在', status: 404 };
  return { ok: true, data: toView(row) };
}

/** 设默认：清旧默认 → 立新默认 → 同事务写镜像 */
export async function setDefaultProxyPool(id: number): Promise<ProxyPoolResult<ProxyPoolView>> {
  const existing = await loadRow(id);
  if (!existing) return { ok: false, error: '代理不存在', status: 404 };
  const normalizedUrl = normalizeSiteProxyUrl(existing.url) || '';

  await db.transaction(async (tx) => {
    await tx.update(schema.proxyPool)
      .set({ isDefault: false })
      .where(eq(schema.proxyPool.isDefault, true))
      .run();
    await tx.update(schema.proxyPool)
      .set({ isDefault: true, updatedAt: new Date().toISOString() })
      .where(eq(schema.proxyPool.id, id))
      .run();
    await writeSystemProxyMirror(tx, normalizedUrl);
  });

  await afterPoolMutation();
  const row = await loadRow(id);
  if (!row) return { ok: false, error: '代理不存在', status: 404 };
  return { ok: true, data: toView(row) };
}

/** 删除条目的引用影响面：站点数 + 连接数（供确认框与改地址提醒复用） */
export async function countProxyPoolUsage(id: number): Promise<{ siteCount: number; accountCount: number }> {
  const siteRows = await db.select({ id: schema.sites.id })
    .from(schema.sites)
    .where(eq(schema.sites.proxyId, id))
    .all();
  const accountRows = await db.select({ id: schema.accounts.id, extraConfig: schema.accounts.extraConfig })
    .from(schema.accounts)
    .all();
  let accountCount = 0;
  for (const account of accountRows) {
    if (parseProxyIdFromExtraConfig(account.extraConfig) === id) accountCount += 1;
  }
  return { siteCount: siteRows.length, accountCount };
}

/** reveal 专用：返回该条原文 URL；调用方须已鉴权并记事件 */
export async function getProxyPoolRawUrl(id: number): Promise<string | null> {
  const row = await loadRow(id);
  return row?.url ?? null;
}

/**
 * 删除：清站点/账户引用；删的是默认条目则清空镜像，
 * **不**自动提升下一条（用户决定：允许无默认，勾选系统代理即直连）。
 */
export async function deleteProxyPool(id: number): Promise<ProxyPoolResult<{ defaultId: number | null }>> {
  const existing = await loadRow(id);
  if (!existing) return { ok: false, error: '代理不存在', status: 404 };
  const wasDefault = !!existing.isDefault;

  await db.transaction(async (tx) => {
    await tx.update(schema.sites)
      .set({ proxyId: null })
      .where(eq(schema.sites.proxyId, id))
      .run();

    const accountRows = await tx.select({ id: schema.accounts.id, extraConfig: schema.accounts.extraConfig })
      .from(schema.accounts)
      .all();
    for (const account of accountRows) {
      if (parseProxyIdFromExtraConfig(account.extraConfig) !== id) continue;
      const stripped = stripProxyIdFromExtraConfig(account.extraConfig);
      await tx.update(schema.accounts)
        .set({ extraConfig: stripped, updatedAt: new Date().toISOString() })
        .where(eq(schema.accounts.id, account.id))
        .run();
    }

    await tx.delete(schema.proxyPool).where(eq(schema.proxyPool.id, id)).run();

    if (wasDefault) {
      await writeSystemProxyMirror(tx, '');
    }
  });

  await afterPoolMutation();
  const remainingDefault = await db.select({ id: schema.proxyPool.id })
    .from(schema.proxyPool)
    .where(eq(schema.proxyPool.isDefault, true))
    .get();
  return { ok: true, data: { defaultId: remainingDefault?.id ?? null } };
}

/** 引用校验（写接口用）：id 必须真实存在 */
export async function proxyPoolIdExists(id: number): Promise<boolean> {
  const row = await db.select({ id: schema.proxyPool.id })
    .from(schema.proxyPool)
    .where(eq(schema.proxyPool.id, id))
    .get();
  return !!row;
}

/**
 * 兼容入口：PUT /api/settings/runtime 的 systemProxyUrl 委托到这里。
 * 空值=清除默认（不提升下一条）；同 URL=设默认；
 * 有默认=改默认条目地址；池空=建默认。
 */
export async function applyLegacySystemProxyUrl(raw: string): Promise<ProxyPoolResult> {
  if (!raw.trim()) {
    const currentDefault = await db.select({ id: schema.proxyPool.id })
      .from(schema.proxyPool)
      .where(eq(schema.proxyPool.isDefault, true))
      .get();
    // 清默认与清镜像同事务：否则中途失败会留下「池无默认但镜像仍有值」的分裂
    await db.transaction(async (tx) => {
      if (currentDefault) {
        await tx.update(schema.proxyPool)
          .set({ isDefault: false, updatedAt: new Date().toISOString() })
          .where(eq(schema.proxyPool.id, currentDefault.id))
          .run();
      }
      await writeSystemProxyMirror(tx, '');
    });
    await afterPoolMutation();
    return { ok: true, data: undefined };
  }

  const normalizedUrl = normalizeSiteProxyUrl(raw);
  if (!normalizedUrl) return invalidProxyUrlResult();
  if (containsMaskMarker(raw)) return maskedProxyUrlResult();

  const rows = await selectAllRows();
  const sameUrl = rows.find((row) => normalizeSiteProxyUrl(row.url) === normalizedUrl);
  if (sameUrl) {
    if (sameUrl.isDefault) return { ok: true, data: undefined };
    return (await setDefaultProxyPool(sameUrl.id)).ok
      ? { ok: true, data: undefined }
      : { ok: false, error: '设置默认代理失败', status: 500 };
  }

  const currentDefault = rows.find((row) => row.isDefault);
  if (currentDefault) {
    const updated = await updateProxyPoolUrl(currentDefault.id, normalizedUrl);
    return updated.ok ? { ok: true, data: undefined } : updated;
  }

  if (rows.length === 0) {
    const created = await createProxyPool({ name: DEFAULT_PROXY_NAME, url: normalizedUrl });
    return created.ok ? { ok: true, data: undefined } : created;
  }

  // 池非空但无默认：直接更新“URL 相同”之外的第一条不成立，改为建一条并设默认
  const nowIso = new Date().toISOString();
  const insertedId = await db.transaction(async (tx) => {
    const insert = await tx.insert(schema.proxyPool).values({
      name: DEFAULT_PROXY_NAME,
      url: normalizedUrl,
      isDefault: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    }).run();
    await writeSystemProxyMirror(tx, normalizedUrl);
    return getInsertedRowId(insert);
  });
  if (!insertedId) return { ok: false, error: '设置系统代理失败', status: 500 };
  await afterPoolMutation();
  return { ok: true, data: undefined };
}

/**
 * 启动播种（applyRuntimeSettings 之后调用）：恢复既有配置，不替用户擅自选一条新代理。
 */
export async function ensureProxyPoolSeeded(): Promise<void> {
  try {
    const rows = await selectAllRows();

    const defaults = rows.filter((row) => row.isDefault).sort((a, b) => a.id - b.id);
    if (defaults.length > 1) {
      // 脏数据：多条默认 → 保留 id 最小者，其余清零
      const keep = defaults[0]!.id;
      await db.transaction(async (tx) => {
        await tx.update(schema.proxyPool).set({ isDefault: false }).where(eq(schema.proxyPool.isDefault, true)).run();
        await tx.update(schema.proxyPool).set({ isDefault: true }).where(eq(schema.proxyPool.id, keep)).run();
      });
      rows.forEach((row) => { row.isDefault = row.id === keep; });
    }

    const currentDefault = rows.find((row) => row.isDefault);
    const systemProxyUrl = normalizeSiteProxyUrl(config.systemProxyUrl);

    if (rows.length === 0) {
      if (systemProxyUrl) {
        const nowIso = new Date().toISOString();
        await db.insert(schema.proxyPool).values({
          name: DEFAULT_PROXY_NAME,
          url: systemProxyUrl,
          isDefault: true,
          createdAt: nowIso,
          updatedAt: nowIso,
        }).run();
      }
    } else if (currentDefault) {
      const defaultUrl = normalizeSiteProxyUrl(currentDefault.url) || '';
      config.systemProxyUrl = defaultUrl;
      await syncMirrorIfDrifted(defaultUrl);
    } else if (systemProxyUrl) {
      // 无默认但有系统代理值 → 命中同 URL 条目则设默认（恢复），否则保持无默认
      const matched = rows.find((row) => normalizeSiteProxyUrl(row.url) === systemProxyUrl);
      if (matched) {
        await db.update(schema.proxyPool).set({ isDefault: true }).where(eq(schema.proxyPool.id, matched.id)).run();
      } else {
        await syncMirrorIfDrifted('');
      }
    }
  } catch {
    // 播种失败不阻断启动；缓存随后按实际库内容刷新
  }

  await loadProxyPoolCache();
}

/** 镜像漂移校正：仅当 settings 值与实际权威不一致时写 */
async function syncMirrorIfDrifted(url: string): Promise<void> {
  const existing = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, SYSTEM_PROXY_URL_SETTING_KEY))
    .get();
  let current: unknown = existing?.value;
  if (typeof current === 'string') {
    try { current = JSON.parse(current); } catch { /* 原样比较 */ }
  }
  if (current !== url) {
    await writeSystemProxyMirror(db, url);
  }
}

export function resetProxyPoolCacheForTests(): void {
  clearProxyPoolCache();
}

function parseProxyIdFromExtraConfig(raw: string | null | undefined): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = Number(parsed?.proxyId);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function stripProxyIdFromExtraConfig(raw: string | null | undefined): string {
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      const candidate = JSON.parse(raw);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch { /* 非 JSON 视为空对象，避免落坏值 */ }
  }
  delete parsed.proxyId;
  return JSON.stringify(parsed);
}
