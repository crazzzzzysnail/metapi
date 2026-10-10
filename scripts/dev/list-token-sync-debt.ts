import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { maskToken, resolveAccountTokenValueStatus } from '../../src/server/services/accountTokenService.js';

/**
 * 令牌同步存量脏行「只读清单」脚本（对应 docs/plans/2026-10-09-token-sync-authority-fix.md 决策 7 / B4）。
 *
 * 背景：历史匹配缺陷会把「已补全令牌」的上游同步误判成新令牌，插入一条 masked_pending 孤儿行，
 * 与持有明文的 ready 行长期并存。本脚本只负责把这些「孤儿待补全行」候选对列出来，
 * 供人工确认后在 /tokens 界面删除。**本脚本绝不删除、修改任何数据。**
 *
 * 候选对定义：同一 accountId 内，ready 行 R 与 masked_pending 行 P 满足 maskToken(R.token) === P.token。
 * 掩码与状态判定一律复用 accountTokenService 的权威实现（one source of truth），此处不做任何复制。
 */

/** 从库内联查得到的一行令牌（含账号名 / 站点名，用于人工指认）。 */
export type TokenDebtRow = {
  id: number;
  accountId: number;
  name: string;
  token: string;
  valueStatus: string;
  createdAt: string | null;
  accountUsername: string | null;
  siteName: string;
};

/** 一对「孤儿待补全」候选：ready 明文行 + 掩码与它相等的 pending 残留行。 */
export type TokenSyncDebtPair = {
  /** 「账号名 @ 站点名」展示标签。 */
  accountLabel: string;
  /** ready 行的令牌名（人工在 /tokens 页面按 账号+令牌名+掩码 指认）。 */
  tokenName: string;
  /** 掩码值：maskToken(ready.token)，同时等于 pending 行存储的脱敏值。 */
  maskedValue: string;
  readyId: number;
  pendingId: number;
  /** pending 行的创建时间，用于判断哪条是后补的残留。 */
  pendingCreatedAt: string | null;
};

function accountLabelOf(row: TokenDebtRow): string {
  const username = (row.accountUsername || '').trim() || `账号#${row.accountId}`;
  return `${username} @ ${row.siteName}`;
}

/**
 * 纯函数：从行数组计算候选对。不碰数据库、不打印、不排序副作用（入参不被修改）。
 * 逐账号分组：组内 ready 行与 masked_pending 行按 resolveAccountTokenValueStatus 划分，
 * 掩码相等（maskToken(ready.token) === pending.token）即成一对；一个 ready 对多条 pending 时逐条输出。
 */
export function findTokenSyncDebtPairs(rows: TokenDebtRow[]): TokenSyncDebtPair[] {
  // 按 (accountId, id) 排一遍序，保证输出稳定可对比。
  const ordered = [...rows].sort((left, right) =>
    left.accountId - right.accountId || left.id - right.id
  );

  // 按账号分组。
  const grouped = new Map<number, TokenDebtRow[]>();
  for (const row of ordered) {
    const bucket = grouped.get(row.accountId);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(row.accountId, [row]);
    }
  }

  const pairs: TokenSyncDebtPair[] = [];
  for (const group of grouped.values()) {
    const readyRows = group.filter((row) => resolveAccountTokenValueStatus(row) === 'ready');
    const pendingRows = group.filter((row) => resolveAccountTokenValueStatus(row) === 'masked_pending');

    for (const ready of readyRows) {
      // 掩码计算复用服务权威实现；空掩码不参与匹配，避免把空值行误报成候选。
      const masked = maskToken(ready.token);
      if (!masked) continue;

      for (const pending of pendingRows) {
        // 候选对判定：ready 行掩码与 pending 行存储值全等。
        // 若上游掩码使用了「•」字符则此处不会命中，属宁漏报不误报的保守行为。
        if (pending.token === masked) {
          pairs.push({
            accountLabel: accountLabelOf(ready),
            tokenName: ready.name,
            maskedValue: masked,
            readyId: ready.id,
            pendingId: pending.id,
            pendingCreatedAt: pending.createdAt,
          });
        }
      }
    }
  }

  return pairs;
}

/** 联查所需的最小 db / schema 形态（用结构化注入，便于单测用假 db 验证只读性）。 */
export type TokenDebtQueryDeps = {
  db: any;
  schema: any;
  eq: (left: unknown, right: unknown) => unknown;
};

/**
 * 可注入的取数接缝：account_tokens 联 accounts、sites，带出账号名与站点名。
 * 只执行一次 select，绝无任何写操作。
 */
export async function fetchTokenDebtRows(deps: TokenDebtQueryDeps): Promise<TokenDebtRow[]> {
  const { db, schema, eq } = deps;
  const tokens = schema.accountTokens;
  const accounts = schema.accounts;
  const sites = schema.sites;

  const rows: TokenDebtRow[] = await db
    .select({
      id: tokens.id,
      accountId: tokens.accountId,
      name: tokens.name,
      token: tokens.token,
      valueStatus: tokens.valueStatus,
      createdAt: tokens.createdAt,
      accountUsername: accounts.username,
      siteName: sites.name,
    })
    .from(tokens)
    .innerJoin(accounts, eq(tokens.accountId, accounts.id))
    .innerJoin(sites, eq(accounts.siteId, sites.id))
    .all();

  return rows;
}

function formatPairLine(pair: TokenSyncDebtPair): string {
  const createdAt = pair.pendingCreatedAt ?? '未知';
  return `  · (${pair.accountLabel}, ${pair.tokenName}, ${pair.maskedValue}, ready.id=${pair.readyId}, pending.id=${pair.pendingId}, pending.createdAt=${createdAt})`;
}

/**
 * 主流程：查库（通过注入的 loadRows）→ 调纯函数算候选对 → 打印。
 * 返回候选对供调用方（含单测）断言；本函数同样绝不写库。
 */
export async function runTokenDebtList(options: {
  loadRows: () => Promise<TokenDebtRow[]>;
  log?: (line: string) => void;
}): Promise<TokenSyncDebtPair[]> {
  const log = options.log ?? ((line: string) => console.log(line));

  const rows = await options.loadRows();
  const pairs = findTokenSyncDebtPairs(rows);

  log(`[token-debt] 扫描 ${rows.length} 行令牌，发现孤儿待补全候选对 ${pairs.length} 组：`);
  for (const pair of pairs) {
    log(formatPairLine(pair));
  }
  if (pairs.length === 0) {
    log('  · 未发现候选对。');
  }

  log('');
  log('提示：以上仅为候选清单。确认后请在 /tokens 界面用批量删除或单条删除处理 pending 行；');
  log('本脚本只读，不会删除任何数据。');

  return pairs;
}

async function main(): Promise<void> {
  // 动态导入数据库模块，风格与 db-smoke.ts 保持一致；脚本自身只做查询。
  const { db, schema, closeDbConnections } = await import('../../src/server/db/index.js');
  const { eq } = await import('drizzle-orm');

  try {
    await runTokenDebtList({
      loadRows: () => fetchTokenDebtRows({ db, schema, eq }),
    });
  } finally {
    await closeDbConnections();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('[token-debt] 执行失败');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
