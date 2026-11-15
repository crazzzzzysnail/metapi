import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 方言感知的 upsert / 幂等插入（跨库回归）。
 *
 * 缺陷现场：`db/index.ts` 以 `any` 导出共用的 db 门面，MySQL 下
 * `.onConflictDoUpdate(...)` 是 `not a function` → HTTP 500。本测试用
 * **按方言取舍的假 db** 复现该形状：MySQL 假链上刻意没有 onConflict*，
 * 非 MySQL 假链上刻意没有 onDuplicateKeyUpdate。实现一旦走错分支，
 * 立刻抛出与线上同形的 TypeError，而不是静默通过。
 *
 * 与源码门禁 dialectConflict.architecture.test.ts 的分工：
 *   - 本文件证明「权威实现本身的分支选择与参数传递正确」；
 *   - 门禁证明「没有别的地方绕过权威实现裸调方言 API」。
 */

/**
 * `eq` / `and` 换成可辨认的纯对象，好让断言能看出「单列没套 AND、多列套了 AND」。
 * 只 mock 本模块用到的两个导出；drizzle 真实返回的是 SQL 包装对象，
 * 其内部形状与本测试要证明的分支选择无关，不该成为断言依赖。
 */
vi.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => ({ kind: 'eq', column, value }),
  and: (...conditions: unknown[]) => ({ kind: 'and', conditions }),
}));

const hoisted = vi.hoisted(() => {
  const state: {
    dialect: 'sqlite' | 'mysql' | 'postgres';
    calls: string[];
    captured: Record<string, unknown>;
    existingRow: Record<string, unknown> | null;
    insertError: unknown;
  } = {
    dialect: 'sqlite',
    calls: [],
    captured: {},
    existingRow: null,
    insertError: null,
  };
  return { state };
});

vi.mock('./index.js', () => ({
  // 用 getter 暴露，让 vi.mock 的工厂能随 state.dialect 实时改变方言
  get runtimeDbDialect() { return hoisted.state.dialect; },
  get db() { return makeFakeDb(); },
  schema: {},
}));

/** 按当前方言提供**且仅提供**该方言合法的方法。 */
function makeFakeDb() {
  const { state } = hoisted;
  const isMysql = state.dialect === 'mysql';

  const tail = { run: async () => ({ changes: 1 }) };

  const conflictChain: Record<string, unknown> = {
    run: async () => {
      state.calls.push('insert.run');
      if (state.insertError) throw state.insertError;
      return { changes: 1 };
    },
  };
  if (!isMysql) {
    conflictChain.onConflictDoUpdate = (input: { target: unknown; set: unknown }) => {
      state.calls.push('onConflictDoUpdate');
      state.captured.target = input.target;
      state.captured.set = input.set;
      return tail;
    };
    conflictChain.onConflictDoNothing = (input?: unknown) => {
      state.calls.push('onConflictDoNothing');
      state.captured.nothingTarget = input === undefined ? 'no-target' : 'with-target';
      return tail;
    };
  } else {
    conflictChain.onDuplicateKeyUpdate = (input: { set: unknown }) => {
      state.calls.push('onDuplicateKeyUpdate');
      state.captured.set = input.set;
      return tail;
    };
  }

  const selectChain: Record<string, unknown> = {
    from: () => selectChain,
    where: (condition: unknown) => {
      state.captured.where = condition;
      return selectChain;
    },
    get: async () => state.existingRow ?? undefined,
  };

  return {
    insert: () => ({ values: (values: Record<string, unknown>) => {
      state.captured.values = values;
      return conflictChain;
    } }),
    select: () => selectChain,
  };
}

const { upsertRow, insertRowIfAbsent } = await import('./dialectUpsert.js');

const TABLE = { name: 't' };
const COL_A = { brand: 'col_a' };
const COL_B = { brand: 'col_b' };

function reset(dialect: 'sqlite' | 'mysql' | 'postgres') {
  hoisted.state.dialect = dialect;
  hoisted.state.calls = [];
  hoisted.state.captured = {};
  hoisted.state.existingRow = null;
  hoisted.state.insertError = null;
}

describe('upsertRow', () => {
  it.each([['sqlite'], ['postgres']] as const)('%s 走 ON CONFLICT (target) DO UPDATE', async (dialect) => {
    reset(dialect);
    const values = { siteId: 9, cnyPerUsd: 7.3 };
    await upsertRow({ table: TABLE, values, conflictTarget: COL_A });

    expect(hoisted.state.calls).toEqual(['onConflictDoUpdate']);
    // 必须把目标列传下去，否则 PG 会报 no unique constraint matching
    expect(hoisted.state.captured.target).toBe(COL_A);
    // 缺省 set = 整份 values，与原 `.onConflictDoUpdate({set: next})` 语义逐字一致
    expect(hoisted.state.captured.set).toBe(values);
  });

  it('mysql 走 ON DUPLICATE KEY UPDATE 且不传 target', async () => {
    reset('mysql');
    const values = { siteId: 9, cnyPerUsd: 7.3 };
    await upsertRow({ table: TABLE, values, conflictTarget: COL_A });

    expect(hoisted.state.calls).toEqual(['onDuplicateKeyUpdate']);
    expect(hoisted.state.captured.set).toBe(values);
    expect(hoisted.state.captured.target).toBeUndefined();
  });

  it('显式 set 覆盖缺省，且不影响 values（插入列与更新列可不同）', async () => {
    for (const dialect of ['sqlite', 'mysql'] as const) {
      reset(dialect);
      const values = { namespace: 'ns', snapshotKey: 'k', payload: 'p' };
      const set = { payload: 'p' };
      await upsertRow({ table: TABLE, values, conflictTarget: [COL_A, COL_B], set });

      expect(hoisted.state.captured.set).toBe(set);
      expect(hoisted.state.captured.values).toBe(values);
    }
  });
});

describe('insertRowIfAbsent', () => {
  it('sqlite / postgres 用无 target 的 ON CONFLICT DO NOTHING，不做额外读', async () => {
    for (const dialect of ['sqlite', 'postgres'] as const) {
      reset(dialect);
      await insertRowIfAbsent({
        table: TABLE,
        values: { siteId: 3, modelName: 'm' },
        conflictColumns: [
          { column: COL_A, value: 3 },
          { column: COL_B, value: 'm' },
        ],
      });

      expect(hoisted.state.calls).toEqual(['onConflictDoNothing']);
      // 无 target 才能覆盖该表的任意唯一约束
      expect(hoisted.state.captured.nothingTarget).toBe('no-target');
    }
  });

  it('mysql 命中已有行则不插入', async () => {
    reset('mysql');
    hoisted.state.existingRow = { id: 1 };
    await insertRowIfAbsent({
      table: TABLE,
      values: { siteId: 3, modelName: 'm' },
      conflictColumns: [
        { column: COL_A, value: 3 },
        { column: COL_B, value: 'm' },
      ],
    });

    expect(hoisted.state.calls).toEqual([]);
  });

  it('mysql 未命中才插入，并把重复键竞态吞成"已存在"', async () => {
    reset('mysql');
    await insertRowIfAbsent({
      table: TABLE,
      values: { siteId: 3 },
      conflictColumns: [{ column: COL_A, value: 3 }],
    });
    expect(hoisted.state.calls).toEqual(['insert.run']);

    reset('mysql');
    hoisted.state.insertError = Object.assign(new Error("Duplicate entry '3' for key 'x_unique'"), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
    });
    await expect(insertRowIfAbsent({
      table: TABLE,
      values: { siteId: 3 },
      conflictColumns: [{ column: COL_A, value: 3 }],
    })).resolves.toBeUndefined();
  });

  it('负控制：mysql 的其他错误必须原样抛出，不得伪装成已存在', async () => {
    reset('mysql');
    hoisted.state.insertError = Object.assign(new Error('Column cannot be null'), {
      code: 'ER_BAD_NULL_ERROR',
    });
    await expect(insertRowIfAbsent({
      table: TABLE,
      values: { siteId: 3 },
      conflictColumns: [{ column: COL_A, value: 3 }],
    })).rejects.toThrow('Column cannot be null');
  });

  it('mysql 多冲突列取 AND、单列不套 AND', async () => {
    reset('mysql');
    await insertRowIfAbsent({
      table: TABLE,
      values: { siteId: 3, modelName: 'm' },
      conflictColumns: [
        { column: COL_A, value: 3 },
        { column: COL_B, value: 'm' },
      ],
    });
    expect((hoisted.state.captured.where as { kind?: string }).kind).toBe('and');

    reset('mysql');
    await insertRowIfAbsent({
      table: TABLE,
      values: { siteId: 3 },
      conflictColumns: [{ column: COL_A, value: 3 }],
    });
    expect((hoisted.state.captured.where as { kind?: string }).kind).toBe('eq');
  });
});

describe('调用方句柄', () => {
  it('txDb 优先于全局 db，供事务内使用', async () => {
    reset('mysql');
    const seen: string[] = [];
    const txDb = {
      insert: () => ({ values: () => ({ onDuplicateKeyUpdate: () => ({ run: async () => { seen.push('tx'); } }) }) }),
      select: () => ({ from: () => ({ where: () => ({ get: async () => undefined }) }) }),
    };
    await upsertRow({ table: TABLE, values: { a: 1 }, conflictTarget: COL_A, txDb });
    expect(seen).toEqual(['tx']);
    // 走了 txDb 就不该再碰全局假链
    expect(hoisted.state.calls).toEqual([]);
  });
});

beforeEach(() => {
  reset('sqlite');
});
