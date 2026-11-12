import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 金额显示守卫（F3 / 方案 a1 的最后一环）。
 *
 * 要防的是同一件事反复发生：新页面直接写 `$${x.toFixed(2)}`，于是顶栏切到人民币后
 * 那一处仍是美元。本会话已经修掉过 Dashboard、SearchModal、三个图表、
 * SortableChannelRow 里各自的局部实现——散落一次就得再收敛一次。
 *
 * 写法沿用 billingQuotaScale.architecture.test.ts：读源码 + 字符串断言。
 * 之所以用源码断言而不是渲染测试：渲染测试只能覆盖被测到的组件，
 * 而这条规则要管的是"以后新增的任何文件"。
 */

const SCAN_ROOT = 'src/web';

/**
 * 白名单及理由。**每一条都是刻意决定，不是漏网**：
 *
 * - `numberFormat.ts` / `i18n.supplement.ts`：符号与文案的定义地本身。
 * - `currencyContext.tsx`：只提供币种与汇率，不拼金额字符串。
 * - `DownstreamKeyTrendChart.tsx`：下游密钥成本天然跨站聚合，buckets 里既无
 *   siteId 也无按站拆分，而汇率逐站维护 —— 乘任何"代表汇率"都会得到看似精确
 *   实则无据的数，因此显式保持美元口径（见该文件注释）。
 *
 * ModelAnalysisPanel / modelPricingPresentation / ProxyLogs / Models / Sites
 * 都不在黑名单里且实测干净：它们的金额已统一走共享出口，无需豁免。
 */
const ALLOWED_FILES = new Set([
  'src/web/numberFormat.ts',
  'src/web/i18n.supplement.ts',
  'src/web/i18n.tsx',
  'src/web/currencyContext.tsx',
  'src/web/components/charts/DownstreamKeyTrendChart.tsx',
]);

function collectSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(`../../${dir}/`, import.meta.url), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(full); continue; }
      // 测试文件允许为了断言而写出 $ 字面量
      if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.includes('.test.')) continue;
      files.push(full);
    }
  };
  walk(SCAN_ROOT);
  return files;
}

/** 真·硬编码美元：`$` 紧跟数字表达式，且该行确有金额语义（排除 CSS/图标/日期等噪音）。 */
/**
 * 真·硬编码美元：`$` 后紧跟数字表达式。
 *
 * ⚠️ 这里吃过一次教训：初版写成 /\$\$\{/（要求两个连续 $），而真实代码是
 * `return \`${value.toFixed(2)}\``——只有一个 $ 紧跟 {，结果守卫对最常见形态
 * 完全失明：注入负控制后测试仍然全绿。
 * 更糟的是下面"检测器自证"那条用例当时也过了，因为我喂它的样本带反引号前缀
 * (`$${...}`)，形状与真实代码不同。**自测样本必须用真实写法的形状**，
 * 否则守卫只能证明它认识自己编的那一种写法。
 */
const HARDCODED_MONEY = [
  /\$\{[^}]*\.toFixed/,          // `${v.toFixed(2)}` 与被误写的 `$${v.toFixed(2)}` 都能命中
  /`\$[0-9]/,                    // 模板里直接写死金额 `$1.23`
  /["']\$["']/,                  // 孤立的 '$' 占位符
];

function findViolations(source: string): string[] {
  const found: string[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    // 非金额的 $ 用法先排掉：CSS calc/color、SVG path、className 模板、日期时间拼接
    if (/color-mix|rgba?\(|box-shadow|border|background|padding|margin|stroke|viewBox|svg|className|font-/.test(line)) return;
    if (/getFullYear|getHours|padStart|toISOString|dayKey|formatDate|params\.toString/.test(line)) return;
    if (/percentage|share|\}%|percent|Percent/.test(line)) return;
    // 时长与 token 量也会用 toFixed，但它们不是金额：
    // `${(ms / 1000).toFixed(1)}s`、`${(value / 1e9).toFixed(2)}B`、`${latMs}ms`。
    // 判据是"结尾单位不是钱"且整行没有金额语义，免得把「消耗总额 $…」一起放过。
    if (/\}(s|B|M|K)`/.test(line) && !/(Cost|cost|Balance|balance|Spend|Reward|price|Price|Money)/.test(line)) return;
    if (/latMs|latSec/.test(line) && !/(Cost|cost|Balance|balance|Spend|Reward)/.test(line)) return;
    // 站点 API 地址的模式标记符（/v1#$、/v1/chat$）里的 $ 与金额无关。
    // 守卫第一次跑就把 sitesEditor.ts 的这行误报过，故在此排除。
    if (/endsWith\(['"]\$['"]\)|startsWith\(['"]\$['"]\)/.test(line)) return;
    if (HARDCODED_MONEY.some((re) => re.test(line))) {
      found.push(`${index + 1}: ${trimmed.slice(0, 100)}`);
    }
  });
  return found;
}

describe('金额显示必须走共享出口（不得散写 $ 字面量）', () => {
  it('src/web 下不存在新的硬编码美元', () => {
    const offenders: string[] = [];
    for (const file of collectSources()) {
      if (ALLOWED_FILES.has(file.replace(/\\/g, '/'))) continue;
      const violations = findViolations(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
      if (violations.length) offenders.push(`${file}\n    ${violations.join('\n    ')}`);
    }
    expect(offenders.join('\n')).toBe('');
  });

  /**
   * 负控制自证：上面那条如果正则太松或太紧，可能"永远通过"却什么都没管住。
   * 这里直接把一条违规样本喂进去，断言检测器确实报出来。
   */
  /**
   * ⚠️ 样本形状必须取自**真实代码写法**。上一版这里只测了带反引号前缀的
   * `$${...}`，而实际散写形态是 `${value.toFixed(2)}` —— 于是检测器正则对真实
   * 代码失明时，这条自证居然也通过，掩盖了守卫失效。
   */
  it('检测器能识别典型的硬编码写法', () => {
    // 与 Sites / ProxyLogs / Accounts 里出现过的真实形状一致
    expect(findViolations('  return `${value.toFixed(2)}`;')).toHaveLength(1);
    expect(findViolations('        ? `$${log.estimatedCost.toFixed(6)}`')).toHaveLength(1);
    expect(findViolations("  const s = '$' + n.toFixed(6);")).toHaveLength(1);
    // 合法形态不应误报
    expect(findViolations('  return formatMoney(value);')).toHaveLength(0);
    expect(findViolations('  return `${money(v)} / 1M`;')).toHaveLength(0);
    expect(findViolations('  return formatBalance(a.balance);')).toHaveLength(0);
    // 噪音形态（CSS / 百分比 / URL 模式标记符）不应误报
    expect(findViolations('  background: `linear-gradient(${a});`')).toHaveLength(0);
    expect(findViolations('  return `${pct.toFixed(1)}%`;')).toHaveLength(0);
    expect(findViolations("  const marker = trimmed.endsWith('$') ? '$' : '';")).toHaveLength(0);
  });
});

/**
 * 余额格式化必须显式传币种（2026-11-12）。
 *
 * 站点管理 / 连接管理的余额在切到人民币后仍是 `$`，根因不是"没走共享出口"，
 * 而是"走了共享出口但没传币种"：formatBalance(value) 默认 USD，顶栏怎么切都不动。
 * 与上面那条硬编码守卫互补 —— 那条防新写的 `$${x}`，这条防参数缺省。
 */
// 两个余额出口都要带币种：formatBalance（带「汇率未知」标注）与
// formatBalanceInline（站点管理/连接管理的内联版，不加后缀）。
const SINGLE_ARG_BALANCE = /formatBalance(?:Inline)?\(\s*[^(),]+\s*\)/;

describe('余额格式化必须显式传币种', () => {
  it('src/web 下不存在单参数 formatBalance 调用', () => {
    const offenders: string[] = [];
    for (const file of collectSources()) {
      if (file.replace(/\\/g, '/') === 'src/web/numberFormat.ts') continue;
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      source.split(/\r?\n/).forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (SINGLE_ARG_BALANCE.test(line)) {
          offenders.push(`${file}:${index + 1} ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(offenders.join('\n')).toBe('');
  });

  it('检测器能识别单参调用，且不误报多参调用', () => {
    expect(SINGLE_ARG_BALANCE.test('formatBalance(a.balance)')).toBe(true);
    expect(SINGLE_ARG_BALANCE.test('{formatBalance(value)}')).toBe(true);
    expect(SINGLE_ARG_BALANCE.test('formatBalanceInline(a.balance)')).toBe(true);
    expect(SINGLE_ARG_BALANCE.test('formatBalance(a.balance, currency, accountRate)')).toBe(false);
    expect(SINGLE_ARG_BALANCE.test('formatBalanceInline(a.balance, currency, accountRate)')).toBe(false);
    expect(SINGLE_ARG_BALANCE.test('formatBalance(balance * rate, "CNY", 1)')).toBe(false);
  });
});
