import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 额度标尺边界测试。
 *
 * S1 的核心目标是「谁拥有 500_000 / 1_000_000 这两个数字」——收敛到
 * src/server/services/billing/quotaScale.ts 一处。本测试用源码断言把这条规则
 * 变成可执行约束，防止后续改动重新散落字面量除数。
 *
 * 写法沿用 modelService.discovery.architecture.test.ts：readFileSync + 字符串断言。
 */

const OWNER_FILE = 'src/server/services/billing/quotaScale.ts';
const SCAN_ROOTS = ['src/server/services', 'src/server/routes'];

function readSource(repoRelativePath: string): string {
  return readFileSync(new URL(`../../../${repoRelativePath}`, import.meta.url), 'utf8');
}

/** 递归枚举待扫描的业务源码（跳过测试与迁移生成物）。 */
function collectBusinessSources(): string[] {
  const files: string[] = [];

  const walk = (dir: string) => {
    const entries = readdirSync(new URL(`../../../${dir}/`, import.meta.url), { withFileTypes: true });
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        // 迁移 SQL 生成物属于数据字典，不参与标尺断言
        if (full.includes('/db/migrations')) continue;
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
        files.push(full);
      }
    }
  };

  for (const root of SCAN_ROOTS) walk(root);
  return files;
}

/**
 * 去掉注释与字符串/模板字面量内容，避免把说明文字里的数字误判成违规常量。
 * 之后按分号切成「逻辑段」再判定，因为 roundCost 一类的乘除会跨行书写。
 */
function toSegments(source: string): string[] {
  // 部分历史文件带 UTF-8 BOM（如 routes/api/stats.ts），交给 trimStart 剥除。
  return source.trimStart()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (_m, quote) => `${quote}${quote}`)
    .replace(/\s*\n\s*/g, ' ')
    .split(';');
}

/** 只剥注释（保留字符串字面量），用于"禁止某段代码逻辑存在"这类判定。 */
function stripCommentsForGuard(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// 就地做额度换算：除以标尺或乘回标尺
const RE_SCALE_DIV = new RegExp('/\\s*(500(?:_?000){2}|1_000_000)(\\.0)?\\b');
const RE_SCALE_MUL = new RegExp('\\*\\s*(500(?:_?000){2}|1_000_000)\\b');
// 两类合法惯用法不算额度标尺：微元舍入 `round(x * 1e6) / 1e6`、每百万 token `(tokens / 1e6) * price`
const RE_BENIGN_PER_MILLION = new RegExp('[*/]\\s*1_000_000\\s*[)\\]]?\\s*[*/]');

describe('quotaScale 标尺收敛边界', () => {
  it('确实扫到足量业务源码（防止枚举失效导致空跑）', () => {
    expect(collectBusinessSources().length).toBeGreaterThan(50);
  });

  it('owner 模块保留完整的标尺表与换算函数', () => {
    const source = readSource(OWNER_FILE);

    expect(source).toContain('PLATFORM_QUOTA_DEFAULTS');
    expect(source).toContain('export function getQuotaScale');
    expect(source).toContain('export function quotaToUsd');
    expect(source).toContain('export function usdToQuota');
    expect(source).toContain('export function tokensToUsd');
    expect(source).toContain('export function ratioToUsdPerMillion');
    expect(source).toContain('export function usdDivisorSql');
  });

  it('业务源码中不存在裸的额度字面量运算', () => {
    const offenders: string[] = [];

    for (const file of collectBusinessSources()) {
      if (file === OWNER_FILE) continue;
      for (const segment of toSegments(readSource(file))) {
        if (!RE_SCALE_DIV.test(segment) && !RE_SCALE_MUL.test(segment)) continue;
        if (RE_BENIGN_PER_MILLION.test(segment)) continue;
        offenders.push(`${file}: ${segment.trim().slice(0, 120)}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('不再保留按平台挑除数的旧写法', () => {
    const offenders: string[] = [];

    for (const file of collectBusinessSources()) {
      if (file === OWNER_FILE) continue;
      const joined = toSegments(readSource(file)).join(' ');
      if (/===\s*'veloera'\s*\?/.test(joined)) offenders.push(`${file}:三元挑除数`);
      if (/function\s+resolveQuotaConversionFactor\b/.test(joined)) offenders.push(`${file}:遗留换算因子`);
      if (/const\s+QUOTA_PER_UNIT\b/.test(joined)) offenders.push(`${file}:遗留额度常量`);
    }

    expect(offenders).toEqual([]);
  });

  it('引用换算函数的文件必须从 owner 模块导入', () => {
    const offenders: string[] = [];

    for (const file of collectBusinessSources()) {
      if (file === OWNER_FILE) continue;
      const raw = readSource(file);
      if (!/\b(quotaToUsd|tokensToUsd|usdToQuota|ratioToUsdPerMillion|getQuotaScale|usdDivisorSql)\s*\(/.test(raw)) {
        continue;
      }
      // owner 模块的引用路径有两种合法形态：跨目录的 `.../billing/quotaScale.js`
      // 与同目录内的 `./quotaScale.js`（billing/ 内部互相引用）。
      // 判据是"必须来自 owner 模块"，不是字符串长得像不像。
      const importsFromOwner = /from\s+['"](?:\.\.?\/)+[^'"]*billing\/quotaScale\.js['"]/.test(raw)
        || (file.startsWith('src/server/services/billing/') && /from\s+['"]\.\/quotaScale\.js['"]/.test(raw));
      if (!importsFromOwner) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it('价格公式不再出现裸乘数（由 ratioToUsdPerMillion 承担）', () => {
    const joined = toSegments(readSource('src/server/services/modelPricingService.ts')).join(' ');

    expect(joined).not.toMatch(/modelRatio\s*\*\s*2\b/);
    expect(joined).not.toMatch(/\*\s*2\s*\*\s*multiplier/);
    expect(joined).toContain('ratioToUsdPerMillion');
  });

  it('统计 SQL 的兜底除数来自 quotaScale，路由层不再有本地副本', () => {
    const sharedRaw = readSource('src/server/services/statsShared.ts');
    const routeRaw = readSource('src/server/routes/api/stats.ts');
    const route = toSegments(routeRaw).join(' ');

    expect(sharedRaw).toContain('usdDivisorSql');
    // 要禁的是**硬编码分支逻辑**，不是解释历史的注释：先剥注释再判定，
    // 否则一段说明 veloera 往事的文档注释会被误报成违规（A9 复核时就踩过这个）。
    const sharedCode = stripCommentsForGuard(sharedRaw);
    expect(sharedCode).not.toMatch(/=\s*['"]veloera['"]/);
    expect(sharedCode).not.toMatch(/['"]veloera['"]\s*\?/);
    // D14 前半：路由层必须复用共享实现。导入路径断言必须在原始源码上做，
    // 因为 toSegments 会清空字符串字面量、连模块路径一起抹掉。
    expect(route).not.toMatch(/function\s+proxyCostSqlExpression/);
    expect(routeRaw).toMatch(/from\s+["'][^"']*statsShared\.js["']/);
  });

  it('各平台适配器统一用 this.platformName 取标尺', () => {
    for (const name of ['newApi', 'oneApi', 'veloera', 'doneHub']) {
      const source = readSource(`src/server/services/platforms/${name}.ts`);
      expect(source).toContain('billing/quotaScale.js');
      expect(source).toMatch(/quotaToUsd\([^)]*this\.platformName/);
    }
  });
});
