import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBillingExprV2, tierMatchesAt } from './billingPlanV2.js';

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

describe('拒绝路径：解析不出就 unsupported，绝不给近似数', () => {
  it.each([
    ['', 'empty-expr'],
    ['fixed(0.002)', 'not-a-tier-expression'],
    ['p * 1 + c * 1', 'not-a-tier-expression'],
    ['tier("x", p * 1 - c * 1)', 'malformed-term'],
    ['tier("x", )', 'malformed-term'],
    ['tier("x", img * 0.1)', 'unknown-variable'],
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

  it('siteA 音频模型 ai 被明确标为不支持模态，而不是算出错价', () => {
    const audioModel = siteA.data.find((m: any) => (m.billing_expr || '').includes('ai *'));
    if (!audioModel) return; // 该站点当前无音频模型时跳过（不硬编期望）
    const plan = parseBillingExprV2(audioModel.billing_expr);
    expect(plan.kind).toBe('unsupported');
    if (plan.kind === 'unsupported') expect(plan.reason).toBe('unsupported-meter');
  });
});
