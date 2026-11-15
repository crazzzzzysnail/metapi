import { and, eq } from 'drizzle-orm';
import { db, runtimeDbDialect } from './index.js';

/**
 * 方言感知的 upsert / 幂等插入权威实现。
 *
 * 为什么需要这一层（缺陷现场）：Drizzle 的 insert builder 按方言暴露**不同的**
 * 冲突处理 API —— SQLite / PostgreSQL 是 `onConflictDoUpdate` / `onConflictDoNothing`，
 * MySQL 只有 `onDuplicateKeyUpdate`。而本仓的 `db` 在 `db/index.ts` 里以 `any`
 * 导出（三方言共用一个门面），TypeScript 拦不住跨方言调用，于是业务代码直接写
 * `.onConflictDoUpdate(...)` 在 SQLite 下开发一切正常，一上 MySQL 就是
 * `db.insert(...).values(...).onConflictDoUpdate is not a function` → HTTP 500。
 *
 * 同类缺陷为什么本机与 CI 都抓不到：开发跑 SQLite；单测的假 db 只 mock 其中一种
 * 方法名（等于把 bug 写进测试）；实库 parity 用例只比表结构、不跑业务 upsert。
 * 因此本文件是唯一的冲突处理落点，并由
 * `db/dialectConflict.architecture.test.ts` 门禁强制所有调用点走这里。
 *
 * 两个 API 的语义选择（逐条对应本仓既有先例，不发明新写法）：
 *   - `upsertRow`：MySQL 用单条 `ON DUPLICATE KEY UPDATE`（原子、无读后写竞态，
 *     先例 usageAggregationService 的 mysql 分支）；SQLite / PostgreSQL 用
 *     `ON CONFLICT (target) DO UPDATE`。
 *   - `insertRowIfAbsent`：MySQL 无 DO NOTHING，而 `INSERT IGNORE` 会顺带吞掉
 *     非空、外键等其他约束，语义过宽；故走「先查后插 + 撞唯一键即视为已存在」，
 *     先例 db/upsertSetting.ts 与 routes/api/accounts.ts 的 mysql 分支。
 *
 * ⚠️ 前提（调用方必须逐处核对，否则 PostgreSQL 直接报错）：
 *   `conflictTarget` 指向的列必须有主键或唯一索引，且该约束同时存在于
 *   mysql / postgres 两种 bootstrap SQL —— 由 `db/generated/*.bootstrap.sql`
 *   与启动时的 live schema 对齐（runtimeSchemaBootstrap）共同保证。
 *   缺这条约束时 PG 报 "no unique or exclusion constraint matching the ON
 *   CONFLICT specification"，MySQL 则退化成纯插入并报重复键。
 */

/** drizzle 的列引用；这里用 unknown 以免把本层绑死到具体 ORM 内部类型。 */
type ColumnLike = unknown;

export interface UpsertRowInput {
  /** 目标表（schema 导出的表对象）。 */
  table: any;
  /** 插入用的完整行值。 */
  values: Record<string, unknown>;
  /** SQLite / PostgreSQL 的冲突目标列（单列或列数组）。MySQL 忽略此参数。 */
  conflictTarget: ColumnLike | ColumnLike[];
  /**
   * 冲突时要更新的列。缺省为 `values` 全量覆盖。
   * 建议显式排除冲突键本身：把它写进 SET 子句在两种方言下都无意义，
   * 只是 PG 允许、MySQL 冗余。
   */
  set?: Record<string, unknown>;
  /** 事务句柄；缺省用全局 db。 */
  txDb?: any;
}

/**
 * 存在则更新，不存在则插入。三方言行为一致。
 */
export async function upsertRow(input: UpsertRowInput): Promise<void> {
  const client = input.txDb ?? db;
  const { table, values } = input;
  const setValues = input.set ?? values;

  if (runtimeDbDialect === 'mysql') {
    // MySQL 无需指定冲突目标：命中任一主键/唯一键即触发 UPDATE。
    await (client.insert(table).values(values) as any)
      .onDuplicateKeyUpdate({ set: setValues })
      .run();
    return;
  }

  await (client.insert(table).values(values) as any)
    .onConflictDoUpdate({ target: input.conflictTarget, set: setValues })
    .run();
}

export interface InsertRowIfAbsentInput {
  /** 目标表。 */
  table: any;
  values: Record<string, unknown>;
  /**
   * 唯一性判定列及其对应值（MySQL 分支据此构造「是否已存在」的 where 条件，
   * 多列之间取 AND）。顺序与语义应与该表的唯一索引一致。
   */
  conflictColumns: Array<{ column: ColumnLike; value: unknown }>;
  txDb?: any;
}

/**
 * 判定「MySQL 重复键错误」的唯一入口。
 *
 * 只认 ER_DUP_ENTRY / 1062 / 'duplicate entry'，刻意不认 duplicate column、
 * duplicate key name 这类 DDL 错误 —— 否则会把真正的建表缺陷吞成"已存在"。
 */
function isDuplicateEntryError(error: unknown): boolean {
  const err = error as { code?: unknown; errno?: unknown; message?: unknown } | null;
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) return true;
  return String(err.message ?? '').toLowerCase().includes('duplicate entry');
}

/**
 * 已存在则跳过，不向调用方抛重复键错误。三方言行为一致。
 *
 * 竞态说明：MySQL 分支的「先查后插」不是原子的，两个并发写同一行时后者会撞
 * ER_DUP_ENTRY；这里就地吞掉，语义与 DO NOTHING 相同。若将来某个调用点需要
 * 真正的原子性，应改用 upsertRow 而不是扩展本函数。
 */
export async function insertRowIfAbsent(input: InsertRowIfAbsentInput): Promise<void> {
  const client = input.txDb ?? db;
  const { table, values } = input;

  if (runtimeDbDialect === 'mysql') {
    const conditions = input.conflictColumns.map((item) => eq(item.column as any, item.value));
    const existing = await client
      .select()
      .from(table)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .get();
    if (existing) return;

    try {
      await client.insert(table).values(values).run();
    } catch (error) {
      // 查后到有并发插入：目标行已在即视为成功，不向上报错。
      if (isDuplicateEntryError(error)) return;
      throw error;
    }
    return;
  }

  // SQLite / PostgreSQL：不带 target 的 DO NOTHING 覆盖任意唯一约束。
  await (client.insert(table).values(values) as any).onConflictDoNothing().run();
}
