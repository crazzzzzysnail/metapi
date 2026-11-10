import { describe, expect, it } from 'vitest';
import {
  describeGroupPricing,
  describePriceReason,
  isAuthoritativePricing,
  renderGroupPricingValue,
} from './modelPricingPresentation.js';

/**
 * 价格展示三态（T1.28）。
 *
 * 核心约束：**未知不得显示为 $0**。历史实现用 `?? 0` 兜底，
 * 于是"没有价格依据"在界面上与"这个模型免费"长得一模一样。
 */

describe('renderGroupPricingValue 三态', () => {
  it('精确 token 价正常渲染', () => {
    expect(renderGroupPricingValue({
      quotaType: 0,
      inputPerMillion: 0.5,
      outputPerMillion: 1.5,
      evidence: { source: 'upstream-ratio', precision: 'exact' },
    })).toBe('$0.5/$1.5 / 1M');
  });

  it('未知标原因，绝不输出 $0', () => {
    const text = renderGroupPricingValue({
      quotaType: 0,
      evidence: { source: 'unavailable', precision: 'unknown', reason: 'ratio-missing' },
    });
    expect(text).toBe('未知 · 上游未提供倍率');
    expect(text).not.toContain('0/0');
  });

  it('有数值但被判未知时仍以未知为准（防御性优先级）', () => {
    expect(renderGroupPricingValue({
      quotaType: 0,
      inputPerMillion: 75,
      outputPerMillion: 75,
      evidence: { precision: 'unknown', reason: 'group-unavailable' },
    })).toBe('未知 · 分组倍率未知');
  });

  it('缺 evidence 的老数据退回原行为，不崩不误报未知', () => {
    expect(renderGroupPricingValue({ quotaType: 0, inputPerMillion: 2, outputPerMillion: 8 }))
      .toBe('$2/$8 / 1M');
  });

  it('全空的老数据也不误判为未知', () => {
    // quotaType=0 且没有任何 perMillion 字段：属于"没配价"，应显式说未知而不是 0/0
    expect(renderGroupPricingValue({ quotaType: 0 })).toContain('未知');
  });

  it('来自失效字段的动态计费标参考值并说明未解析', () => {
    expect(renderGroupPricingValue({
      quotaType: 0,
      inputPerMillion: 75,
      outputPerMillion: 75,
      billingMode: 'tiered_expr',
      billingExpr: 'tier("base", p * 1 + c * 1)',
      evidence: { source: 'derived-from-stale-field', precision: 'approximate' },
    })).toBe('参考 $75/$75 / 1M · 动态计费未解析');
  });

  it('表达式已解析的动态计费按精确价显示，不带"参考"前缀（S5c）', () => {
    expect(renderGroupPricingValue({
      quotaType: 0,
      inputPerMillion: 1,
      outputPerMillion: 1,
      billingMode: 'tiered_expr',
      billingExpr: 'tier("base", p * 1 + c * 1)',
      evidence: { source: 'upstream-dynamic-expr', precision: 'exact' },
    })).toBe('$1/$1 / 1M');
  });

  it('按次计费的两种形态都能渲染', () => {
    expect(renderGroupPricingValue({
      quotaType: 1, perCallTotal: 0.002,
      evidence: { source: 'upstream-per-call', precision: 'exact' },
    })).toBe('$0.002 / call');

    expect(renderGroupPricingValue({
      quotaType: 1, perCallInput: 0.01, perCallOutput: 0.02,
    })).toBe('$0.01/$0.02 / call');
  });
});

describe('辅助函数', () => {
  it('未知原因码有中文文案，陌生原因码原样透传而不崩', () => {
    expect(describePriceReason('dynamic-billing-unparsed')).toBe('动态计费未解析');
    expect(describePriceReason('brand-new-code')).toBe('brand-new-code');
    expect(describePriceReason(undefined)).toBe('价格未知');
  });

  it('isAuthoritativePricing 只认 exact；缺省视为可信以兼容老数据', () => {
    expect(isAuthoritativePricing({ quotaType: 0, evidence: { precision: 'exact' } })).toBe(true);
    expect(isAuthoritativePricing({ quotaType: 0, evidence: { precision: 'approximate' } })).toBe(false);
    expect(isAuthoritativePricing({ quotaType: 0, evidence: { precision: 'unknown' } })).toBe(false);
    expect(isAuthoritativePricing({ quotaType: 0 })).toBe(true);
  });

  it('describeGroupPricing 会把表达式带上，便于排查', () => {
    const text = describeGroupPricing({
      quotaType: 0,
      inputPerMillion: 75,
      outputPerMillion: 75,
      billingMode: 'tiered_expr',
      billingExpr: 'tier("base", p * 1 + c * 1)',
      evidence: { source: 'derived-from-stale-field', precision: 'approximate' },
    });
    expect(text).toContain('动态计费未解析');
    expect(text).toContain('tier("base", p * 1 + c * 1)');
  });
});
