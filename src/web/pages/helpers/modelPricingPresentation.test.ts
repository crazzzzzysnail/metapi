import { describe, expect, it } from 'vitest';
import { formatMoney } from '../../numberFormat.js';
import {
  describeGroupPricing,
  describePriceReason,
  describeTierDetails,
  isAuthoritativePricing,
  renderGroupPricingValue,
  type ModelGroupPricingPresentation,
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

/**
 * 路由通道正文的多档精简与币种跟随（VPS 实测返工）。
 *
 * 两条判据各自对应一个真实缺陷：
 *   - firstTierOnly：多档全文在窄卡片里必然截断；
 *   - 币种跟随：早版 USD 分支不传 convert，落到固定美元的出口，
 *     于是"设置已切人民币、正文仍是 $"。用两种币种各跑一遍才能抓住它。
 */
describe('renderGroupPricingValue 的 compact / firstTierOnly', () => {
  const multi = {
    quotaType: 0,
    inputPerMillion: 0.3,
    outputPerMillion: 1.5,
    tiers: [
      { name: '0_272k', input: 0.3, output: 1.5, condition: '<272K' },
      { name: '272k_plus', input: 0.6, output: 2.25, condition: '>272K' },
    ],
  } as ModelGroupPricingPresentation;

  it('firstTierOnly 只渲染首档，其余留给悬停', () => {
    const text = renderGroupPricingValue(multi, undefined, undefined, { compact: true, firstTierOnly: true });
    expect(text).toBe('$0.3/$1.5 / 1M（0_272k）');
    expect(text).not.toContain('272k_plus');
    // 条件不进正文，避免撑长
    expect(text).not.toContain('<272K');
  });

  it('不带 firstTierOnly 时仍逐档列出（模型广场口径不变）', () => {
    const text = renderGroupPricingValue(multi);
    expect(text).toContain('0_272k · <272K');
    expect(text).toContain('272k_plus · >272K');
  });

  it('币种由 convert 决定：USD 出 $、CNY 出 ¥，不会写死', () => {
    const usdMoney = (_s: number, u?: number) => (u == null ? null : formatMoney(u));
    const cnyMoney = (_s: number, u?: number) => (u == null ? null : formatMoney(u * 7.3, 'CNY', 1));

    const usd = renderGroupPricingValue(multi, 1, usdMoney, { compact: true, firstTierOnly: true });
    const cny = renderGroupPricingValue(multi, 1, cnyMoney, { compact: true, firstTierOnly: true });

    expect(usd).toBe('$0.3/$1.5 / 1M（0_272k）');
    expect(cny).toBe('¥2.19/¥10.95 / 1M（0_272k）');
    // 关键：两者不得互相串币符
    expect(usd).not.toContain('¥');
    expect(cny).not.toContain('$');
  });

  it('CNY 且充值价未知时整行标注，不贴 ¥ 冒充人民币价', () => {
    const unknown = renderGroupPricingValue(multi, 1, () => null, { compact: true, firstTierOnly: true });
    expect(unknown).toBe('充值价未知');
  });
});

/**
 * fixed(X) 每请求固定价的展示（2026-11-23 抓包实证）。
 *
 * 上游把这类模型按"次"收费，而 metapi 旧实现因解析失败回落失效倍率，
 * 在模型广场显示按每百万口径的推算价（实际是每次一个价）——单位与量级双错。
 * 这里锁三件事：① 单位必须是 / call；② 人民币模式同样走 / call；
 * ③ 「参考 · 动态计费未解析」警示在换算分支里不能被吞掉。
 */
describe('fixed(X) 每请求固定价展示', () => {
  const cnyConvert = (_siteId: number, usd: number | undefined): string | null =>
    usd == null ? null : formatMoney(usd * 7.3, 'CNY', 1);

  it('美元模式：渲染成 $X / call，不写 / 1M', () => {
    const text = renderGroupPricingValue({
      quotaType: 0,
      fixedPerRequest: 0.001,
      evidence: { source: 'upstream-dynamic-expr', precision: 'exact' },
      billingMode: 'tiered_expr',
    });
    expect(text).toBe('$0.001 / call');
    expect(text).not.toContain('/ 1M');
  });

  it('人民币模式：换算后仍是 / call', () => {
    const text = renderGroupPricingValue(
      {
        quotaType: 0,
        fixedPerRequest: 0.001,
        evidence: { source: 'upstream-dynamic-expr', precision: 'exact' },
        billingMode: 'tiered_expr',
      },
      1,
      cnyConvert,
    );
    expect(text).toBe('¥0.0073 / call');
    expect(text).not.toContain('/ 1M');
  });

  it('多档 fixed：逐档列出各自的每请求价', () => {
    const text = renderGroupPricingValue({
      quotaType: 0,
      fixedPerRequest: 0.01,
      tiers: [
        { name: 'short', fixedPerRequest: 0.01, condition: '≤32K' },
        { name: 'long', fixedPerRequest: 0.03, condition: '>32K' },
      ],
      evidence: { source: 'upstream-dynamic-expr', precision: 'exact' },
      billingMode: 'tiered_expr',
    });
    expect(text).toContain('$0.01 / call（short · ≤32K）');
    expect(text).toContain('$0.03 / call（long · >32K）');
    expect(text).not.toContain('/ 1M');
  });

  it('悬停详情：fixed 档也标 / call', () => {
    const text = describeTierDetails({
      quotaType: 0,
      tiers: [{ name: 'base', fixedPerRequest: 0.001, condition: null }],
    });
    expect(text).toBe('base：$0.001 / call');
  });

  it('人民币模式下「参考 · 动态计费未解析」警示不能被换算分支吞掉', () => {
    const stale = {
      quotaType: 0,
      inputPerMillion: 75,
      outputPerMillion: 75,
      evidence: { source: 'derived-from-stale-field', precision: 'approximate' as const },
      billingMode: 'tiered_expr',
    };
    // 美元模式：本来就带警示
    expect(renderGroupPricingValue(stale)).toBe('参考 $75/$75 / 1M · 动态计费未解析');
    // 人民币模式：旧实现在换算分支提前 return，警示整条消失 —— 这里必须保留
    expect(renderGroupPricingValue(stale, 1, cnyConvert))
      .toBe('参考 ¥547.5/¥547.5 / 1M · 动态计费未解析');
  });
});
