import { describe, expect, it } from 'vitest';
import {
  convertSiteUsdToCny,
  resolveEffectiveQuotaScale,
  summarizeByCurrency,
} from './currencySplit.js';

/**
 * 跨站逐站换算与排除（S6 / T8.7、T8.12）。
 *
 * 核心约束：**汇率未知 = 排除并计数**，绝不猜一个汇率把数字凑齐。
 */

describe('summarizeByCurrency', () => {
  it('全部已知时 USD/CNY 同时给出', () => {
    const result = summarizeByCurrency([
      { siteId: 1, usd: 100, cnyPerUsd: 7.3 },
      { siteId: 2, usd: 50, cnyPerUsd: 7 },
    ]);
    expect(result.usdTotal).toBe(150);
    expect(result.cnyTotal).toBeCloseTo(100 * 7.3 + 50 * 7, 6);
    expect(result.includedSiteCount).toBe(2);
    expect(result.excludedSiteCount).toBe(0);
  });

  it('缺汇率的站点被排除出 CNY 合计，但仍计入 USD 合计', () => {
    const result = summarizeByCurrency([
      { siteId: 1, usd: 100, cnyPerUsd: 7.3 },
      { siteId: 2, usd: 50, cnyPerUsd: null },
    ]);
    // USD 不需要汇率，必须完整
    expect(result.usdTotal).toBe(150);
    // CNY 只含已知站点
    expect(result.cnyTotal).toBeCloseTo(730, 6);
    expect(result.excludedSiteCount).toBe(1);
    expect(result.includedSiteCount).toBe(1);
    expect(result.excludedSites).toEqual([{ siteId: 2, reason: 'rate-unknown' }]);
  });

  it('非法汇率（0/负数/NaN）单独归因为 rate-invalid', () => {
    expect(summarizeByCurrency([{ siteId: 1, usd: 10, cnyPerUsd: 0 }]).excludedSites)
      .toEqual([{ siteId: 1, reason: 'rate-invalid' }]);
    expect(summarizeByCurrency([{ siteId: 1, usd: 10, cnyPerUsd: -7 }]).excludedSites)
      .toEqual([{ siteId: 1, reason: 'rate-invalid' }]);
    expect(summarizeByCurrency([{ siteId: 1, usd: 10, cnyPerUsd: Number.NaN }]).excludedSites)
      .toEqual([{ siteId: 1, reason: 'rate-invalid' }]);
  });

  it('全部未知时 CNY 为 0 且计数等于站点数（不是静默的空合计）', () => {
    const result = summarizeByCurrency([
      { siteId: 1, usd: 10, cnyPerUsd: null },
      { siteId: 2, usd: 20, cnyPerUsd: null },
    ]);
    expect(result.cnyTotal).toBe(0);
    expect(result.excludedSiteCount).toBe(2);
    expect(result.usdTotal).toBe(30);
  });

  it('空输入不炸', () => {
    expect(summarizeByCurrency([])).toMatchObject({
      usdTotal: 0, cnyTotal: 0, includedSiteCount: 0, excludedSiteCount: 0,
    });
  });

  it('非有限的 usd 按 0 处理，不污染合计', () => {
    const result = summarizeByCurrency([
      { siteId: 1, usd: Number.NaN, cnyPerUsd: 7 },
      { siteId: 2, usd: 10, cnyPerUsd: 7 },
    ]);
    expect(result.usdTotal).toBe(10);
    expect(Number.isFinite(result.cnyTotal)).toBe(true);
  });

  it('极小金额保留 6 位精度，不被舍成 0', () => {
    const result = summarizeByCurrency([{ siteId: 1, usd: 0.000001, cnyPerUsd: 7.3 }]);
    expect(result.cnyTotal).toBeGreaterThan(0);
    // roundMicro 的精度契约是 6 位小数：0.0000073 → 0.000007（不是 0）
    expect(result.cnyTotal).toBe(0.000007);
  });

  it('负余额（上游偶发超支）如实参与合计，不夹到 0', () => {
    const result = summarizeByCurrency([{ siteId: 1, usd: -5, cnyPerUsd: 7 }]);
    expect(result.usdTotal).toBe(-5);
    expect(result.cnyTotal).toBe(-35);
  });
});

describe('convertSiteUsdToCny', () => {
  it('正常换算', () => {
    expect(convertSiteUsdToCny(1, 7.3)).toBe(7.3);
  });

  it('汇率未知返回 null —— 调用方须显示"汇率未知"', () => {
    expect(convertSiteUsdToCny(1, null)).toBeNull();
    expect(convertSiteUsdToCny(1, 0)).toBeNull();
    expect(convertSiteUsdToCny(Number.NaN, 7.3)).toBeNull();
  });
});

describe('resolveEffectiveQuotaScale', () => {
  it('档案标尺优先于平台默认表', () => {
    expect(resolveEffectiveQuotaScale(1_000_000, 'new-api')).toBe(1_000_000);
  });

  it('无档案时退回平台默认（A9 的正解：标尺来自数据而非硬编码分支）', () => {
    expect(resolveEffectiveQuotaScale(null, 'veloera')).toBe(1_000_000);
    expect(resolveEffectiveQuotaScale(null, 'new-api')).toBe(500_000);
    expect(resolveEffectiveQuotaScale(undefined, 'unknown-platform')).toBe(500_000);
  });

  it('非法档案值不采信，仍走默认', () => {
    expect(resolveEffectiveQuotaScale(0, 'new-api')).toBe(500_000);
    expect(resolveEffectiveQuotaScale(-500000, 'new-api')).toBe(500_000);
  });
});
