import { describe, expect, it } from 'vitest';
import {
  convertSiteUsdToCny,
  maxExcludedSiteCount,
  resolveEffectiveQuotaScale,
  splitMetricBySite,
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

/**
 * B2：仪表盘把四个金额指标改成「按站点分组 → 双币拆分」后依赖的两个纯函数。
 *
 * 这里最要紧的是守住那条等价性不变式：**usdSum 必须包含汇率未知的站点**。
 * 一旦哪天有人"顺手"把缺汇率的站也从 USD 合计里剔掉，美元总额会凭空变小，
 * 而这恰好是 CNY 改造过程中最容易写错的方向 —— 所以下面第一条就专门盯它。
 */
describe('splitMetricBySite', () => {
  const rates = new Map<number, number | null>([
    [1, 7.3],
    [2, 1],
    [3, null],        // 汇率未知
    [4, -1],          // 非法
  ]);

  it('USD 合计包含汇率未知与非法的站点（美元不需要汇率）', () => {
    const result = splitMetricBySite([
      { siteId: 1, usd: 100 },
      { siteId: 2, usd: 50 },
      { siteId: 3, usd: 15 },   // 缺汇率，但美元照计
      { siteId: 4, usd: 5 },    // 非法汇率，同样照计
    ], rates);

    expect(result.usdTotal).toBe(170);
    expect(result.usdSum).toBe(170);
    // CNY 只累计汇率已知的两站
    expect(result.cnyTotal).toBe(100 * 7.3 + 50 * 1);
    expect(result.includedSiteCount).toBe(2);
    expect(result.excludedSiteCount).toBe(2);
  });

  it('CNY 合计逐站用各自汇率，不套用同一个数', () => {
    const result = splitMetricBySite([
      { siteId: 1, usd: 10 },   // ×7.3
      { siteId: 2, usd: 10 },   // ×1
    ], rates);
    expect(result.cnyTotal).toBe(83);
  });

  it('非有限金额按 0 处理而不是污染合计', () => {
    const result = splitMetricBySite([
      { siteId: 1, usd: Number.NaN },
      { siteId: 1, usd: 20 },
    ], rates);
    expect(result.usdSum).toBe(20);
  });

  it('空输入给出全零而不抛异常', () => {
    const result = splitMetricBySite([], rates);
    expect(result.usdSum).toBe(0);
    expect(result.cnyTotal).toBe(0);
    expect(result.excludedSiteCount).toBe(0);
  });

  it('无汇率档案的站点也计入 USD、并被记为 rate-unknown', () => {
    const result = splitMetricBySite([{ siteId: 99, usd: 7 }], rates);
    expect(result.usdSum).toBe(7);
    expect(result.excludedSites).toEqual([{ siteId: 99, reason: 'rate-unknown' }]);
  });
});

/**
 * 方案 a1：四个指标的排除数取最大值。
 * 相加会把同几个站在四个指标上重复计数四次，夸大问题规模。
 */
describe('maxExcludedSiteCount', () => {
  it('取最大值而非相加', () => {
    expect(maxExcludedSiteCount(1, 1, 1, 1)).toBe(1);
    expect(maxExcludedSiteCount(0, 2, 1, 0)).toBe(2);
  });

  it('忽略非有限值，全空给 0', () => {
    expect(maxExcludedSiteCount(Number.NaN, 3, undefined as unknown as number)).toBe(3);
    expect(maxExcludedSiteCount()).toBe(0);
    expect(maxExcludedSiteCount(-1, 0)).toBe(0);
  });
});
