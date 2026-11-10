import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildProxyBillingDetails,
  calculateModelUsageBreakdown,
  calculateModelUsageCost,
  normalizeCommonPricingPayload,
  buildModelPricingCatalogFromData,
} from './modelPricingService.js';

/**
 * T6.3 / T6.7 实扣选档。
 *
 * 表达式取自真实上游（siteA / siteB 的 `/api/pricing`）：
 *   sample-model-len        len <= 272000 ? p*4 + cr*0.4 + cc*5 + c*20 : p*8 + cr*0.8 + cc*10 + c*30
 *   sample-model-cal     工作日 9-12/14-18 UTC → p*2 + cr*0.04 + c*8，否则 p*1 + cr*0.02 + c*4
 *
 * 要守住的不是"能算出钱"，而是**按上游真正适用的档位算钱**。
 */

const siteA = JSON.parse(
  readFileSync(new URL('./__fixtures__/siteA-tiered-pricing.json', import.meta.url), 'utf8'),
);

function modelOf(name: string) {
  const data = normalizeCommonPricingPayload(siteA);
  if (!data) throw new Error('归一失败');
  const model = data.models.get(name);
  if (!model) throw new Error(`fixture 缺少模型 ${name}`);
  return { model, groupRatio: data.groupRatio };
}

describe('len 分档实扣（sample-model-len，阈值 272000）', () => {
  const { model, groupRatio } = modelOf('sample-model-len');
  // 该模型 enable_groups 不含 default，需换成它有倍率的分组：grp-codex = 0.15
  const ratio = { 'grp-codex': 0.15 };

  it('低档用量按低档单价计费', () => {
    const detail = calculateModelUsageBreakdown(model, {
      promptTokens: 100_000, completionTokens: 10_000, totalTokens: 110_000,
    }, ratio);
    expect(detail).not.toBeNull();
    // input $4/M × 0.15 = 0.6；100k → $0.06
    expect(detail!.breakdown.inputPerMillion).toBeCloseTo(0.6, 10);
    expect(detail!.breakdown.inputCost).toBeCloseTo(0.06, 6);
  });

  it('高档用量按高档单价计费（输入价翻倍）', () => {
    const low = calculateModelUsageBreakdown(model, {
      promptTokens: 272_000, completionTokens: 0, totalTokens: 272_000,
    }, ratio)!;
    const high = calculateModelUsageBreakdown(model, {
      promptTokens: 272_001, completionTokens: 0, totalTokens: 272_001,
    }, ratio)!;

    // 边界：<= 落低档，> 落高档
    expect(low.breakdown.inputPerMillion).toBeCloseTo(0.6, 10);
    expect(high.breakdown.inputPerMillion).toBeCloseTo(1.2, 10);
  });

  it('总成本随跨档跳变，而非线性外推', () => {
    const justBelow = calculateModelUsageCost(model, {
      promptTokens: 272_000, completionTokens: 100_000, totalTokens: 372_000,
    }, ratio)!;
    const justAbove = calculateModelUsageCost(model, {
      promptTokens: 272_001, completionTokens: 100_000, totalTokens: 372_001,
    }, ratio)!;
    expect(justAbove).toBeGreaterThan(justBelow);
    // 输出也跨档（c*20 → c*30），所以差额大于仅输入增加的部分
    expect(justAbove - justBelow).toBeGreaterThan(0.0001);
  });

  it('缓存读只在表达式显式给出时参与计费', () => {
    const detail = calculateModelUsageBreakdown(model, {
      promptTokens: 50_000, completionTokens: 0, totalTokens: 50_000, cacheReadTokens: 40_000,
    }, ratio)!;
    // cr 系数 0.4 × 0.15 = 0.06/M
    expect(detail.breakdown.cacheReadPerMillion).toBeCloseTo(0.06, 10);
    expect(detail.breakdown.cacheReadCost).toBeGreaterThan(0);
  });
});

describe('时间分档实扣（sample-model-cal，工作日 9-12/14-18 UTC 为峰）', () => {
  const { model } = modelOf('sample-model-cal');
  const ratio = { '组丁-chs': 0.4 };

  function costAt(atMs: number) {
    return calculateModelUsageBreakdown(model, {
      promptTokens: 100_000, completionTokens: 100_000, totalTokens: 200_000,
    }, ratio, atMs);
  }

  it('峰段价格高于谷段', () => {
    const peak = costAt(Date.UTC(2026, 10, 11, 10, 0))!;   // 周三 10:00
    const offPeak = costAt(Date.UTC(2026, 10, 13, 20, 0))!; // 周五 20:00
    expect(peak).not.toBeNull();
    expect(offPeak).not.toBeNull();
    // peak p*2 vs off_peak p*1
    expect(peak.breakdown.inputPerMillion).toBeCloseTo(0.8, 10);
    expect(offPeak.breakdown.inputPerMillion).toBeCloseTo(0.4, 10);
  });

  it('周末一律谷段价', () => {
    const saturday = costAt(Date.UTC(2026, 10, 14, 10, 0))!;
    expect(saturday.breakdown.inputPerMillion).toBeCloseTo(0.4, 10);
  });

  it('小时区间是左闭右开：12:00 已不在 9-12 段内', () => {
    const atBoundary = costAt(Date.UTC(2026, 10, 11, 12, 0))!;
    expect(atBoundary.breakdown.inputPerMillion).toBeCloseTo(0.4, 10);
    const inside = costAt(Date.UTC(2026, 10, 11, 11, 59))!;
    expect(inside.breakdown.inputPerMillion).toBeCloseTo(0.8, 10);
  });

  it('13:00 落在两段之间 → 谷段', () => {
    const gap = costAt(Date.UTC(2026, 10, 11, 13, 0))!;
    expect(gap.breakdown.inputPerMillion).toBeCloseTo(0.4, 10);
  });
});

describe('目录展示与实扣的口径分工', () => {
  it('目录给代表价（第一档），不随当前时刻变化', () => {
    const data = normalizeCommonPricingPayload(siteA)!;
    const catalog = buildModelPricingCatalogFromData(data);
    const entry = catalog.models.find((m) => m.modelName === 'sample-model-cal')!;
    // 展示用基础档 = peak（p*2），× 0.4 = 0.8
    expect(entry.groupPricing['组丁-chs']!.inputPerMillion).toBeCloseTo(0.8, 10);
  });

  it('同一模型在峰谷两时刻产生不同 estimatedCost（验收判据）', async () => {
    const { model } = modelOf('sample-model-cal');
    const ratio = { '组丁-chs': 0.4 };
    const usage = { promptTokens: 200_000, completionTokens: 50_000, totalTokens: 250_000 };
    const peak = calculateModelUsageCost(model, usage, ratio, Date.UTC(2026, 10, 11, 10, 0));
    const offPeak = calculateModelUsageCost(model, usage, ratio, Date.UTC(2026, 10, 13, 20, 0));
    expect(peak).not.toBeNull();
    expect(offPeak).not.toBeNull();
    expect(peak).not.toBe(offPeak);
    expect(peak!).toBeGreaterThan(offPeak!);
  });
});
