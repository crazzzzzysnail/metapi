import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBillingExprV2, tierMatchesAt, projectCalendarWindows } from './billingPlanV2.js';

/**
 * S5b 多档表达式解析（T5.2–T5.6）。
 *
 * 全部断言取自 2026-11-09 三个真实上游的实测载荷，不是构造样例：
 *   - siteA `sample-model-len`        len 分档（阈值 272000）
 *   - siteA `sample-model-cal`     时间分档（工作日 9-12 / 14-18 UTC 为峰）
 *   - siteB   `sample-model-cal`     同形态但小时区间不同（1-4 / 6-10 UTC）
 *   - siteC                      单档
 */

const siteA = JSON.parse(readFileSync(new URL('../__fixtures__/siteA-tiered-pricing.json', import.meta.url), 'utf8'));
const siteB = JSON.parse(readFileSync(new URL('../__fixtures__/siteB-tiered-pricing.json', import.meta.url), 'utf8'));

function exprOf(catalog: { data: Array<{ model_name: string; billing_expr?: string }> }, name: string): string {
  const found = catalog.data.find((m) => m.model_name === name);
  if (!found?.billing_expr) throw new Error(`fixture 中缺少模型 ${name} 的表达式`);
  return found.billing_expr;
}

describe('① 单档形态（siteC 全量 + 新站点部分）', () => {
  it('tier("base", p * 1 + c * 1)', () => {
    const plan = parseBillingExprV2('tier("base", p * 1 + c * 1)');
    expect(plan.kind).toBe('single');
    if (plan.kind !== 'single') return;
    expect(plan.tier.name).toBe('base');
    expect(plan.tier.rates.input).toBe(1);
    expect(plan.tier.rates.output).toBe(1);
    expect(plan.tier.condition).toEqual({ kind: 'always' });
  });

  it('未出现的计量项保持 undefined，不当作 1 倍（上一版踩过的坑）', () => {
    const plan = parseBillingExprV2('tier("base", p * 1 + c * 1)');
    if (plan.kind !== 'single') throw new Error('应为 single');
    expect(plan.tier.rates.cacheRead).toBeUndefined();
    expect(plan.tier.rates.cacheWrite).toBeUndefined();
  });

  it('免费模型显式给 0 系数时保留 0（不是缺省）', () => {
    const plan = parseBillingExprV2(exprOf(siteB, 'agnes-3.0-flash'));
    if (plan.kind !== 'single') throw new Error('应为 single');
    expect(plan.tier.rates.input).toBe(0);
    expect(plan.tier.rates.output).toBe(0);
  });
});

describe('② len 分档（siteA sample-model-len 实测）', () => {
  const expr = exprOf(siteA, 'sample-model-len');

  it('解析出两个档位与正确阈值', () => {
    const plan = parseBillingExprV2(expr);
    expect(plan.kind).toBe('conditional');
    if (plan.kind !== 'conditional') return;
    expect(plan.selector).toBe('token-length');
    expect(plan.tiers.map((t) => t.name)).toEqual(['0_272k', '272k_plus']);
    expect(plan.tiers[0]!.condition).toEqual({ kind: 'token-length', operator: '<=', thresholdTokens: 272000 });
    expect(plan.tiers[1]!.condition).toEqual({ kind: 'token-length', operator: '>', thresholdTokens: 272000 });
  });

  it('各档系数逐一对上真实表达式', () => {
    const plan = parseBillingExprV2(expr);
    if (plan.kind !== 'conditional') return;
    // ≤272K: p*4 cr*0.4 cc*5 c*20 | >272K: p*8 cr*0.8 cc*10 c*30
    expect(plan.tiers[0]!.rates).toEqual({ input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 });
    expect(plan.tiers[1]!.rates).toEqual({ input: 8, cacheRead: 0.8, cacheWrite: 10, output: 30 });
  });

  it('选档：边界值 272000 落在低档（<=），272001 落高档', () => {
    const plan = parseBillingExprV2(expr);
    if (plan.kind !== 'conditional') return;
    expect(tierMatchesAt(plan.tiers[0]!, { inputTokens: 272000 })).toBe(true);
    expect(tierMatchesAt(plan.tiers[1]!, { inputTokens: 272000 })).toBe(false);
    expect(tierMatchesAt(plan.tiers[0]!, { inputTokens: 272001 })).toBe(false);
    expect(tierMatchesAt(plan.tiers[1]!, { inputTokens: 272001 })).toBe(true);
  });

  it('含 cc1h 的四计量档位（实测两种形态都存在）', () => {
    // 单档：claude-sonnet-5-5；分档：claude-haiku-5-5（阈值 100000）
    const single = siteA.data.find((m: any) => (m.billing_expr || '').includes('cc1h') && !m.billing_expr.includes('?'));
    const conditional = siteA.data.find((m: any) => (m.billing_expr || '').includes('cc1h') && m.billing_expr.includes('?'));
    expect(single).toBeDefined();
    expect(conditional).toBeDefined();

    const singlePlan = parseBillingExprV2(single!.billing_expr);
    if (singlePlan.kind !== 'single') throw new Error('单档形态应为 single');
    // cc1h 必须映射到独立计量项，不能覆盖 cc —— 两者在真实表达式里数值不同
    expect(singlePlan.tier.rates.cacheWrite1h).toBeDefined();
    expect(singlePlan.tier.rates.cacheWrite).toBeDefined();
    expect(singlePlan.tier.rates.cacheWrite1h).not.toBe(singlePlan.tier.rates.cacheWrite);

    const condPlan = parseBillingExprV2(conditional!.billing_expr);
    if (condPlan.kind !== 'conditional') throw new Error('分档形态应为 conditional');
    for (const tier of condPlan.tiers) {
      expect(tier.rates.cacheWrite1h).toBeDefined();
      expect(tier.rates.cacheWrite).toBeDefined();
    }
    expect(condPlan.tiers[0]!.condition).toEqual({ kind: 'token-length', operator: '<=', thresholdTokens: 100000 });
  });
});

describe('③ 时间分档（siteA / siteB sample-model-cal 实测）', () => {
  const siteAExpr = exprOf(siteA, 'sample-model-cal');
  const siteBExpr = exprOf(siteB, 'sample-model-cal');

  it('解析出 peak/off_peak 两档与 UTC 小时区间', () => {
    const plan = parseBillingExprV2(siteAExpr);
    expect(plan.kind).toBe('conditional');
    if (plan.kind !== 'conditional') return;
    expect(plan.selector).toBe('calendar');
    expect(plan.tiers.map((t) => t.name)).toEqual(['peak', 'off_peak']);

    const condition = plan.tiers[0]!.condition;
    if (condition.kind !== 'calendar') throw new Error('应为 calendar 条件');
    expect(condition.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(condition.hourRanges).toEqual([{ from: 9, to: 12 }, { from: 14, to: 18 }]);
  });

  it('峰谷价确实不同（siteA: peak p*2/c*8, off_peak p*1/c*4）', () => {
    const plan = parseBillingExprV2(siteAExpr);
    if (plan.kind !== 'conditional') return;
    expect(plan.tiers[0]!.rates).toEqual({ input: 2, cacheRead: 0.04, output: 8 });
    expect(plan.tiers[1]!.rates).toEqual({ input: 1, cacheRead: 0.02, output: 4 });
  });

  it('siteB 用不同小时区间（1-4 / 6-10 UTC），不与其他站点串味', () => {
    const plan = parseBillingExprV2(siteBExpr);
    if (plan.kind !== 'conditional') throw new Error('应为 conditional');
    const condition = plan.tiers[0]!.condition;
    if (condition.kind !== 'calendar') throw new Error('应为 calendar');
    expect(condition.hourRanges).toEqual([{ from: 1, to: 4 }, { from: 6, to: 10 }]);
  });

  it('选档判定：周三 10:00 UTC 命中峰，周五 20:00 回落谷', () => {
    const plan = parseBillingExprV2(siteAExpr);
    if (plan.kind !== 'conditional') return;
    // 2026-11-11 是周三
    expect(tierMatchesAt(plan.tiers[0]!, { inputTokens: 0, nowMs: Date.UTC(2026, 10, 11, 10, 0) })).toBe(true);
    // 2026-11-13 是周五，20 点不在 9-12/14-18 内
    expect(tierMatchesAt(plan.tiers[0]!, { inputTokens: 0, nowMs: Date.UTC(2026, 10, 13, 20, 0) })).toBe(false);
    expect(tierMatchesAt(plan.tiers[1]!, { inputTokens: 0, nowMs: Date.UTC(2026, 10, 13, 20, 0) })).toBe(true);
  });

  it('周六周日永不进峰档（weekday 范围 1..5）', () => {
    const plan = parseBillingExprV2(siteAExpr);
    if (plan.kind !== 'conditional') return;
    // 2026-11-14 周六、11-15 周日
    for (const day of [14, 15]) {
      expect(tierMatchesAt(plan.tiers[0]!, { inputTokens: 0, nowMs: Date.UTC(2026, 10, day, 10, 0) })).toBe(false);
    }
  });
});

describe('④ 非 UTC 时区时间分档（声明时区 Asia/Shanghai）', () => {
  const expr = 'weekday("Asia/Shanghai") >= 1 && weekday("Asia/Shanghai") <= 5 && ((hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 12) || (hour("Asia/Shanghai") >= 14 && hour("Asia/Shanghai") < 18)) ? tier("peak", p * 2 + cr * 0.04 + c * 8) : tier("off_peak", p * 1 + cr * 0.02 + c * 4)';

  it('解析出 peak/off_peak 与声明时区 Asia/Shanghai', () => {
    const plan = parseBillingExprV2(expr);
    expect(plan.kind).toBe('conditional');
    if (plan.kind !== 'conditional') return;
    expect(plan.tiers.map((t) => t.name)).toEqual(['peak', 'off_peak']);
    const condition = plan.tiers[0]!.condition;
    if (condition.kind !== 'calendar') throw new Error('应为 calendar');
    expect(condition.timezone).toBe('Asia/Shanghai');
    expect(condition.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(condition.hourRanges).toEqual([{ from: 9, to: 12 }, { from: 14, to: 18 }]);
    // 峰谷价不同
    expect(plan.tiers[0]!.rates).toEqual({ input: 2, cacheRead: 0.04, output: 8 });
    expect(plan.tiers[1]!.rates).toEqual({ input: 1, cacheRead: 0.02, output: 4 });
  });

  it('判档按上海本地时间，不是 UTC（硬证据）', () => {
    const plan = parseBillingExprV2(expr);
    if (plan.kind !== 'conditional') throw new Error('应为 conditional');
    // 上海周三 10:00 = UTC 周三 02:00（+8）。该 ms 按 UTC 判会落 off_peak；
    // 命中 peak 即证明按 Asia/Shanghai 判。2026-11-11 是周三。
    const shanghaiWed10 = Date.UTC(2026, 10, 11, 2, 0);
    // peak 档在该 ms（上海周三10点）命中；按 UTC 判（2点不在9-12/14-18）会落空 → 命中即证 tz 感知
    expect(tierMatchesAt(plan.tiers[0]!, { inputTokens: 0, nowMs: shanghaiWed10 })).toBe(true);
    // 上海周六 10:00 = UTC 周六 02:00，周末一律谷段
    const shanghaiSat10 = Date.UTC(2026, 10, 14, 2, 0);
    expect(tierMatchesAt(plan.tiers[0]!, { inputTokens: 0, nowMs: shanghaiSat10 })).toBe(false);
    // 上海周三 13:00 = UTC 05:00，落在 12-14 间隙 → 谷段
    const shanghaiWed13 = Date.UTC(2026, 10, 11, 5, 0);
    expect(tierMatchesAt(plan.tiers[1]!, { inputTokens: 0, nowMs: shanghaiWed13 })).toBe(true);
  });

  it('UTC 峰段投影到上海：跨午夜窗口保持起始日耦合', () => {
    // siteA 表达式：周一至周五 09-12 / 14-18 UTC
    const utcExpr = exprOf(siteA, 'sample-model-cal');
    const plan = parseBillingExprV2(utcExpr);
    if (plan.kind !== 'conditional') throw new Error('应为 conditional');
    const condition = plan.tiers[0]!.condition;
    if (condition.kind !== 'calendar') throw new Error('应为 calendar');
    const projected = projectCalendarWindows(condition, 'Asia/Shanghai');
    expect(projected).not.toBeNull();
    if (!projected) return;
    // UTC 9-12 → 上海 17:00-20:00；UTC 14-18 → 上海 22:00-次日02:00（hourTo>24 表示跨午夜）
    expect(projected).toEqual([
      { weekdays: [1, 2, 3, 4, 5], hourFrom: 17, hourTo: 20 },
      { weekdays: [1, 2, 3, 4, 5], hourFrom: 22, hourTo: 26 },
    ]);
  });
});

describe('拒绝路径：解析不出就 unsupported，绝不给近似数', () => {
  it.each([
    ['', 'empty-expr'],
    ['fixed(0.002)', 'not-a-tier-expression'],
    ['p * 1 + c * 1', 'not-a-tier-expression'],
    ['tier("x", p * 1 - c * 1)', 'malformed-term'],
    ['tier("x", )', 'malformed-term'],
    ['tier("x", img * 0.1)', 'unknown-variable'],
    // 只有音频项、没有任何可计价文本项 → 整档没有可显示的价，仍按 unsupported 拒绝。
    ['tier("x", ai * 3)', 'unsupported-meter'],
    ['len <= 0 ? tier("a", p * 1) : tier("b", p * 2)', 'invalid-threshold'],
    ['hour("UTC") >= 9 ? tier("a", p * 1) : tier("b", p * 2)', 'invalid-threshold'],
  ] as const)('%s → %s', (expr, reason) => {
    const plan = parseBillingExprV2(expr);
    expect(plan.kind).toBe('unsupported');
    if (plan.kind === 'unsupported') expect(plan.reason).toBe(reason);
  });

  it('拒绝时保留原文，便于人工补录与排查', () => {
    const expr = 'tier("x", require("fs").rmSync("/tmp/z"))';
    const plan = parseBillingExprV2(expr);
    if (plan.kind !== 'unsupported') throw new Error('应被拒绝');
    expect(plan.expr).toBe(expr);
  });

  it('不执行表达式：注入内容只会被判非法语法', () => {
    let executed = false;
    // @ts-expect-error 故意探测求值风险：若实现里存在 eval/new Function，这里会抛错而非返回 unsupported
    (globalThis as any).__canary = () => { executed = true; };
    const plan = parseBillingExprV2('tier("x", __canary() * 1 + p * 1)');
    expect(executed).toBe(false);
    expect(plan.kind).toBe('unsupported');
  });
});

describe('覆盖面统计（防止回归悄悄缩小支持面）', () => {
  it('两个新站点全部 tiered_expr 都能解析或明确归因', () => {
    for (const catalog of [siteA, siteB]) {
      const tally: Record<string, number> = {};
      for (const m of catalog.data) {
        if (!m.billing_expr) continue;
        const plan = parseBillingExprV2(m.billing_expr);
        tally[plan.kind === 'unsupported' ? `unsupported:${plan.reason}` : plan.kind] =
          (tally[plan.kind === 'unsupported' ? `unsupported:${plan.reason}` : plan.kind] || 0) + 1;
      }
      // 不允许出现"未知语法"类的兜底拒绝
      expect(Object.keys(tally).some((k) => k.includes('nested-condition'))).toBe(false);
      expect(tally.single ?? 0).toBeGreaterThan(0);
      expect(tally.conditional ?? 0).toBeGreaterThan(0);
    }
  });

  it('siteA 音频模型 ai：解析文本项、丢弃音频项（不再整式退回失效倍率）', () => {
    // 2026-11-21 改判：旧实现把含 ai 的整式判 unsupported → 目录与实扣全部退回失效
    // model_ratio=37.5，文本价被高估约 18 倍。现改为：ai 照常解析进 rates 但不进单价，
    // p/c/cr 给出上游对纯文本请求真正执行的价。
    const audioModel = siteA.data.find((m: any) => (m.billing_expr || '').includes('ai *'));
    if (!audioModel) return;
    const plan = parseBillingExprV2(audioModel.billing_expr);
    expect(plan.kind).toBe('single');
    if (plan.kind !== 'single') return;
    // 文本项齐全
    expect(plan.tier.rates.input).toBe(2);
    expect(plan.tier.rates.cacheRead).toBe(0.1);
    expect(plan.tier.rates.output).toBe(10);
    // 音频项被解析记录，但换算层（materializeSingleTier）不读取它 → 不进价
    expect((plan.tier.rates as any).audioInput).toBe(2);
  });

  it('只有音频项、无任何文本计量项时仍拒绝（没有可计价的东西）', () => {
    const plan = parseBillingExprV2('tier("audio-only", ai * 3)');
    expect(plan.kind).toBe('unsupported');
    if (plan.kind === 'unsupported') expect(plan.reason).toBe('unsupported-meter');
  });

  it('cc12h（12 小时缓存写入）作为可解析计量项被收录', () => {
    const plan = parseBillingExprV2('len <= 272000 ? tier("a", p * 1 + cc12h * 2.5 + c * 5) : tier("b", p * 2 + cc12h * 5 + c * 7.5)');
    expect(plan.kind).toBe('conditional');
    if (plan.kind !== 'conditional') return;
    expect(plan.tiers[0]!.rates.input).toBe(1);
    expect(plan.tiers[0]!.rates.cacheWrite12h).toBe(2.5);
  });
});

/**
 * fixed(X)：官方 v1 的「每请求固定美元价」（2026-11-23 抓包实证）。
 *
 * 判据（真实数值不入库，见 docs/plans 取证记录）：抓包里某站 `fixed(N)` 的 N 乘以
 * 该站充值价后恰好等于一个整的每次人民币价；按"每百万 token"解读则荒谬且解释不了
 * 那个整除关系。两种读法只有"每请求"自洽。下面用与任何真实值无关的合成数验证。
 */
describe('fixed(X) 每请求固定价', () => {
  it('单档 fixed：解析成 per-request，rates 为空（不伪造 token 系数）', () => {
    const plan = parseBillingExprV2('tier("base", fixed(0.0004))');
    expect(plan.kind).toBe('single');
    if (plan.kind !== 'single') return;
    expect(plan.tier.fixedPerRequest).toBe(0.0004);
    expect(plan.tier.rates).toEqual({});
    expect(plan.tier.condition).toEqual({ kind: 'always' });
  });

  it('len 分档 + 两档都是 fixed：逐档保留各自的每请求价', () => {
    const plan = parseBillingExprV2('len <= 32000 ? tier("short", fixed(0.01)) : tier("long", fixed(0.03))');
    expect(plan.kind).toBe('conditional');
    if (plan.kind !== 'conditional') return;
    expect(plan.tiers.map((t) => t.fixedPerRequest)).toEqual([0.01, 0.03]);
    expect(plan.tiers.map((t) => t.rates)).toEqual([{}, {}]);
  });

  it('fixed 与 token 系数混用 → 明确拒绝（两种单位无法统一展示/实扣）', () => {
    const plan = parseBillingExprV2('len <= 32000 ? tier("short", fixed(0.01)) : tier("long", p * 2)');
    expect(plan.kind).toBe('unsupported');
    if (plan.kind === 'unsupported') expect(plan.reason).toBe('mixed-billing');
  });

  it.each([
    ['tier("x", fixed(-1))', 'malformed-term'],
    ['tier("x", fixed(1e309))', 'malformed-term'],
    ['tier("x", fixed(0.01) + p * 2)', 'malformed-term'],
  ] as const)('%s → %s', (expr, reason) => {
    const plan = parseBillingExprV2(expr);
    expect(plan.kind).toBe('unsupported');
    if (plan.kind === 'unsupported') expect(plan.reason).toBe(reason);
  });

  it('裸 fixed(...) 不带 tier 包裹仍拒绝（保持既有判据）', () => {
    const plan = parseBillingExprV2('fixed(0.002)');
    expect(plan.kind).toBe('unsupported');
    if (plan.kind === 'unsupported') expect(plan.reason).toBe('not-a-tier-expression');
  });
});

/**
 * 星期编号归一（用户 2026-11-23 决定）：**0 与 7 都表示周日**。
 *
 * 上游表达式可能来自两套约定：Go 的 time.Weekday 是周日=0..周六=6，
 * ISO 是周一=1..周日=7。metapi 的 zonedParts 返回后者，因此解析时把 0 折成 7。
 */
describe('weekday 0 与 7 都表示周日', () => {
  // 真实上游形态总是 weekday + hour 组合；hour 区间写满 0-24 表示"全天"，
  // 这样样本只考察星期归一，不引入其它解析分支。
  const ALL_DAY = '(hour("UTC") >= 0 && hour("UTC") < 24)';

  function weekdaysOf(weekdayClause: string): number[] {
    const plan = parseBillingExprV2(
      `weekday("UTC") ${weekdayClause} && ${ALL_DAY} ? tier("a", p * 1) : tier("b", p * 2)`,
    );
    if (plan.kind !== 'conditional') throw new Error('应为 conditional');
    const condition = plan.tiers[0]!.condition;
    if (condition.kind !== 'calendar') throw new Error('应为 calendar');
    return condition.weekdays;
  }

  it('weekday >= 0 && <= 6（Go 的"每天"）归一成 1..7', () => {
    expect(weekdaysOf('>= 0 && weekday("UTC") <= 6')).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('区间 0..0 表示周日，归一成 [7]', () => {
    expect(weekdaysOf('>= 0 && weekday("UTC") <= 0')).toEqual([7]);
  });

  it('weekday >= 1 && <= 5 仍是周一至周五（两套约定同义）', () => {
    expect(weekdaysOf('>= 1 && weekday("UTC") <= 5')).toEqual([1, 2, 3, 4, 5]);
  });

  it('周日档在周日命中、在周一不命中（0→7 后真正参与匹配）', () => {
    const plan = parseBillingExprV2(
      `weekday("UTC") >= 0 && weekday("UTC") <= 0 && ${ALL_DAY} ? tier("sun", p * 1) : tier("other", p * 2)`,
    );
    if (plan.kind !== 'conditional') throw new Error('应为 conditional');
    // 2026-11-22 是周日，2026-11-23 是周一
    expect(tierMatchesAt(plan.tiers[0]!, { inputTokens: 0, nowMs: Date.UTC(2026, 10, 22, 12) })).toBe(true);
    expect(tierMatchesAt(plan.tiers[0]!, { inputTokens: 0, nowMs: Date.UTC(2026, 10, 23, 12) })).toBe(false);
  });
});
