import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { maskToken } from '../../src/server/services/accountTokenService.js';
import {
  fetchTokenDebtRows,
  findTokenSyncDebtPairs,
  runTokenDebtList,
  type TokenDebtRow,
} from './list-token-sync-debt.js';

// 挡住真实 db/index.js：该模块在顶层会初始化 sqlite 连接，单测里无需也绝不应触碰真库。
// 脚本对 maskToken / resolveAccountTokenValueStatus 的静态导入不依赖 db 运行时。
vi.mock('../../src/server/db/index.js', () => ({
  db: {},
  schema: { accountTokens: {}, accounts: {}, sites: {} },
  closeDbConnections: async () => undefined,
}));

function makeRow(overrides: Partial<TokenDebtRow> & Pick<TokenDebtRow, 'id' | 'accountId' | 'token'>): TokenDebtRow {
  return {
    name: '令牌',
    valueStatus: 'ready',
    createdAt: '2026-10-09 10:00:00',
    accountUsername: 'alice',
    siteName: '站点A',
    ...overrides,
  };
}

const READY_TOKEN = 'abcdefghijklm123456789';
const READY_MASK = maskToken(READY_TOKEN);

describe('findTokenSyncDebtPairs（纯函数）', () => {
  it('同账号内 maskToken(ready.token) === pending.token 时成对命中', () => {
    const rows: TokenDebtRow[] = [
      makeRow({ id: 1, accountId: 7, token: READY_TOKEN, valueStatus: 'ready', name: '主令牌' }),
      makeRow({
        id: 2, accountId: 7, token: READY_MASK, valueStatus: 'masked_pending',
        name: '残留令牌', createdAt: '2026-10-08 09:00:00',
      }),
    ];

    const pairs = findTokenSyncDebtPairs(rows);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({
      accountLabel: 'alice @ 站点A',
      tokenName: '主令牌',
      maskedValue: READY_MASK,
      readyId: 1,
      pendingId: 2,
      pendingCreatedAt: '2026-10-08 09:00:00',
    });
  });

  it('ready 与 pending 掩码不相等时不命中', () => {
    const rows: TokenDebtRow[] = [
      makeRow({ id: 1, accountId: 7, token: READY_TOKEN }),
      makeRow({ id: 2, accountId: 7, token: maskToken('zzzzother9999999999'), valueStatus: 'masked_pending' }),
    ];

    expect(findTokenSyncDebtPairs(rows)).toEqual([]);
  });

  it('一个 ready 对应多条同掩码 pending 时逐条分别成对', () => {
    const rows: TokenDebtRow[] = [
      makeRow({ id: 1, accountId: 7, token: READY_TOKEN }),
      makeRow({ id: 2, accountId: 7, token: READY_MASK, valueStatus: 'masked_pending' }),
      makeRow({ id: 3, accountId: 7, token: READY_MASK, valueStatus: 'masked_pending' }),
    ];

    const pairs = findTokenSyncDebtPairs(rows);

    expect(pairs).toHaveLength(2);
    expect(pairs.map((pair) => pair.pendingId)).toEqual([2, 3]);
    expect(pairs.every((pair) => pair.readyId === 1)).toBe(true);
  });

  it('候选对只在同一 accountId 内成立，跨账号同掩码不配对', () => {
    const rows: TokenDebtRow[] = [
      makeRow({ id: 1, accountId: 7, token: READY_TOKEN }),
      makeRow({ id: 2, accountId: 8, token: READY_MASK, valueStatus: 'masked_pending' }),
    ];

    expect(findTokenSyncDebtPairs(rows)).toEqual([]);
  });

  it('空输入返回空数组且不抛错', () => {
    expect(findTokenSyncDebtPairs([])).toEqual([]);
  });
});

describe('list-token-sync-debt 只读保证', () => {
  // 底线断言 (a)：从源码文本层面确认脚本不存在任何删除 / 写库调用。
  it('脚本源码不含 db.delete / delete(schema. / db.update 等写操作', () => {
    const source = readFileSync(new URL('./list-token-sync-debt.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/db\s*\.\s*delete/);
    expect(source).not.toMatch(/delete\s*\(\s*schema\s*\./);
    expect(source).not.toMatch(/db\s*\.\s*update/);
    expect(source).not.toMatch(/\.insert\s*\(/);
    // 同时正向确认：掩码逻辑直接 import 服务权威实现，没有复制第二份。
    expect(source).toMatch(/import\s*{[^}]*maskToken[^}]*}\s*from\s*'[^']*accountTokenService\.js'/);
  });

  // 断言 (b)：注入假 db 走一遍取数 + 主流程，全程只应出现 select 链，不得有写方法被调用。
  it('注入假 db 跑完主流程，delete / update / insert 均未被调用', async () => {
    const calledMethods: string[] = [];
    const rows: TokenDebtRow[] = [
      makeRow({ id: 1, accountId: 7, token: READY_TOKEN }),
      makeRow({ id: 2, accountId: 7, token: READY_MASK, valueStatus: 'masked_pending' }),
    ];

    const fakeChain = {
      from: () => fakeChain,
      innerJoin: () => fakeChain,
      where: () => fakeChain,
      all: async () => rows,
    };

    const fakeDb: any = new Proxy({}, {
      get(_target, prop: string) {
        calledMethods.push(prop);
        if (prop === 'select') return () => fakeChain;
        // 万一脚本被改成写库，这里显式抛错让测试红，而不是静默成功。
        throw new Error(`令牌债务清单脚本不应调用 db.${prop}`);
      },
    });

    const fakeSchema: any = {
      accountTokens: { id: 't.id', accountId: 't.account_id', name: 't.name', token: 't.token', valueStatus: 't.value_status', createdAt: 't.created_at' },
      accounts: { id: 'a.id', siteId: 'a.site_id', username: 'a.username' },
      sites: { name: 's.name' },
    };

    const lines: string[] = [];
    const pairs = await runTokenDebtList({
      loadRows: () => fetchTokenDebtRows({ db: fakeDb, schema: fakeSchema, eq: () => 'eq' }),
      log: (line) => lines.push(line),
    });

    // 候选对正确产出，且输出携带指认所需的六个字段。
    expect(pairs).toHaveLength(1);
    expect(lines.join('\n')).toContain('(alice @ 站点A, 令牌, ');
    expect(lines.join('\n')).toContain('ready.id=1');
    expect(lines.join('\n')).toContain('pending.id=2');
    expect(lines.join('\n')).toContain('pending.createdAt=2026-10-09 10:00:00');
    // 末尾提示本脚本不删除数据。
    expect(lines.join('\n')).toContain('本脚本只读，不会删除任何数据');

    expect(calledMethods).toContain('select');
    for (const writeMethod of ['delete', 'update', 'insert']) {
      expect(calledMethods).not.toContain(writeMethod);
    }
  });
});
