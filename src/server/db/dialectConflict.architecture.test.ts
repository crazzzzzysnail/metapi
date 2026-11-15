import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 方言边界守卫（跨库 upsert / insert-ignore 回归）。
 *
 * 缺陷现场：Drizzle 的 insert builder 按方言暴露**不同的**冲突处理 API ——
 * SQLite / PostgreSQL 是 `onConflictDoUpdate` / `onConflictDoNothing`，
 * MySQL 只有 `onDuplicateKeyUpdate`。不带方言分支直接写前两者，在
 * DB_TYPE=mysql 下就是
 * `db.insert(...).values(...).onConflictDoUpdate is not a function` → HTTP 500。
 *
 * 为什么必须做成源码门禁而不是运行时测试：开发跑 SQLite；单测的假 db 只 mock
 * 其中一种方法名（等于把 bug 写进测试）；实库 parity 用例只比表结构、不跑业务
 * upsert。三条通路全都"绿"，MySQL 上线照样炸。
 *
 * 规则：除权威实现 `db/dialectUpsert.ts` 与白名单里**已自带方言分支**的存量文件外，
 * 任何生产代码都不得直接调用 drizzle 的冲突处理 API —— 一律改走 dialectUpsert。
 */

const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * 白名单及理由。**每一条都是刻意保留，不是漏网**：
 *
 * - `db/dialectUpsert.ts`：本规则的权威实现，唯一允许同时出现两种方言 API 的文件。
 * - `db/upsertSetting.ts`：settings 表既有的方言分支（mysql 先查后写）。
 *   迁到 dialectUpsert 要回归 settings 全部读写路径，不在本切片内。
 * - `services/usageAggregationService.ts`：用量投影的 5 组方言分支，
 *   且带 mysql 专项单测（usageAggregationService.mysql.test.ts）。
 * - `routes/api/accounts.ts`：model_availability 的 mysql 分支在事务内，
 *   走 tx 句柄先查后写，与 dialectUpsert 缺省用全局 db 的形态不同。
 *
 * 白名单只放行"已正确分支"的存量文件，不放行"新写一处裸调用"。
 */
const ALLOWED_FILES = new Set([
  'db/dialectUpsert.ts',
  'db/upsertSetting.ts',
  'services/usageAggregationService.ts',
  'routes/api/accounts.ts',
]);

/**
 * 三方言专属的冲突处理 API 字面量。
 *
 * ⚠️ 每条都匹配「方法名 + 左括号」，且**自测样本必须用真实代码的形状**：
 * 本仓吃过一次教训 —— 检测器写成需要两个连续 `$` 而真实代码只有一个，
 * 结果对最常见形态完全失明，注入负控制后测试仍然全绿。
 */
const CONFLICT_APIS = [
  /\.onConflictDoUpdate\s*\(/,
  /\.onConflictDoNothing\s*\(/,
  /\.onDuplicateKeyUpdate\s*\(/,
] as const;

function collectProductionServerFiles(rootDir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(rootDir).sort()) {
    const absolutePath = join(rootDir, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...collectProductionServerFiles(absolutePath));
      continue;
    }
    // 测试文件里的假 db 必须 mock 具体方法名，不参与本门禁
    if (!entry.endsWith('.ts') || entry.includes('.test.')) continue;
    files.push(absolutePath);
  }

  return files;
}

function toRelative(absolutePath: string): string {
  return relative(SERVER_ROOT, absolutePath).split(sep).join('/');
}

/** 返回命中冲突 API 的行号；注释行不算调用。 */
function findConflictApiLines(source: string): number[] {
  const hits: number[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    // 方言差异必须写成文字说明，故注释与 JSDoc 里的方法名不构成调用
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (CONFLICT_APIS.some((pattern) => pattern.test(line))) hits.push(index + 1);
  });
  return hits;
}

describe('server database dialect boundaries for conflict handling', () => {
  it('detects every conflict API in the real shapes used by this repository', () => {
    // 检测器自证：样本取自本仓真实写法的形状，而不是理想化排版。
    const samples = [
      ['      .onConflictDoUpdate({ target: schema.x.siteId, set: next as any })', 'onConflictDoUpdate 单行'],
      ['    .onConflictDoUpdate({', 'onConflictDoUpdate 换行'],
      ['        .onConflictDoNothing()', 'onConflictDoNothing 无参'],
      ['      .onDuplicateKeyUpdate({', 'onDuplicateKeyUpdate'],
      ['await (db.insert(t).values(v) as any).onConflictDoNothing({ target: t.id }).run();', '同行链式'],
    ] as const;

    for (const [line, label] of samples) {
      expect(findConflictApiLines(line), label).toHaveLength(1);
    }

    // 负向：注释与文档描述不该被算成调用
    expect(findConflictApiLines(' * SQLite / PostgreSQL use `onConflictDoUpdate` while MySQL uses')).toEqual([]);
    expect(findConflictApiLines('  // 与 .onDuplicateKeyUpdate 同源')).toEqual([]);
  });

  it('scans production server files so the guard cannot pass vacuously', () => {
    const relPaths = collectProductionServerFiles(SERVER_ROOT).map(toRelative);
    // 扫不到文件就说明遍历根选错了，门禁会假绿
    expect(relPaths.length).toBeGreaterThan(100);
    expect(relPaths).toContain('db/dialectUpsert.ts');
    expect(relPaths).toContain('services/billing/siteBillingProfileService.ts');
    expect(relPaths).toContain('services/modelService.ts');
  });

  it('keeps dialect-specific conflict APIs inside the helper and whitelisted legacy sites', () => {
    const offenders: Array<{ file: string; lines: number[] }> = [];

    for (const filePath of collectProductionServerFiles(SERVER_ROOT)) {
      const relPath = toRelative(filePath);
      if (ALLOWED_FILES.has(relPath)) continue;
      const lines = findConflictApiLines(readFileSync(filePath, 'utf8'));
      if (lines.length > 0) offenders.push({ file: relPath, lines });
    }

    expect(offenders).toEqual([]);
  });

  it('requires the authoritative helper to branch on the runtime dialect', () => {
    // 权威实现若退化成只支持一种方言，白名单就成了空转的豁免
    const source = readFileSync(join(SERVER_ROOT, 'db', 'dialectUpsert.ts'), 'utf8');
    expect(source).toContain("runtimeDbDialect === 'mysql'");
    expect(source).toContain('.onDuplicateKeyUpdate(');
    expect(source).toContain('.onConflictDoUpdate(');
    expect(source).toContain('.onConflictDoNothing()');
  });
});
