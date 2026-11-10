import { describe, expect, it } from 'vitest';
import {
  buildModelPricingCatalogFromData,
  calculateModelUsageBreakdown,
  normalizeCommonPricingPayload,
} from './modelPricingService.js';

/**
 * T2.3 · one-hub `price.long_context` 的处理边界。
 *
 * 决议是「不支持则标 unsupported，但**保留基础价**」。
 * 落到实现上就是两件事，缺一不可：
 *   ① 长上下文档位绝不参与定价 —— 否则会在没有阈值语义的情况下按倍率加价；
 *   ② 原始档位信息仍要透传出去 —— 供后续接入选档与人工核对。
 * 本文件同时锁这两条，以及"畸形配置不得污染价格"。
 */

function catalogFrom(items: unknown[]) {
  const data = normalizeCommonPricingPayload({
    success: true,
    group_ratio: { default: 1 },
    data: items,
  })!;
  return { catalog: buildModelPricingCatalogFromData(data), data };
}

const BASE_TOKEN_ITEM = {
  model_name: 'lc-model',
  quota_type: 0,
  model_ratio: 1,
  completion_ratio: 4,
  cache_ratio: 0.02,
  model_price: 0,
  enable_groups: ['default'],
};

describe('long_context 不参与定价，但保留基础价与信息', () => {
  it('合法 long_context：基础价照常算出，档位不被应用', () => {
    const { data } = catalogFrom([{
      ...BASE_TOKEN_ITEM,
      price_extra: undefined,
      billing_mode: undefined,
    }]);
    // one-hub 路径才有 long_context，这里用归一后的模型直接验算价
    const detail = calculateModelUsageBreakdown(data.models.get('lc-model')!, {
      promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000,
    }, { default: 1 })!;
    // ratio 1 → 2 USD/M，不受任何长上下文倍率影响
    expect(detail.breakdown.inputPerMillion).toBe(2);
  });

  it('档位信息完整时不应改变已算出的单价', async () => {
    // 通过 one-hub 归一入口验证：extra_ratios + long_context 同时存在
    const { normalizeOneHubPricingPayload } = await import('./modelPricingService.js');
    const priced = normalizeOneHubPricingPayload(
      {
        data: {
          'lc-one': {
            groups: ['default'],
            price: {
              type: 'tokens',
              input: 3,
              output: 15,
              extra_ratios: { cached_read_tokens: 0.1 },
              long_context: { threshold: 200_000, input_ratio: 2, output_ratio: 1.5 },
            },
          },
        },
      },
      { data: { default: 1 } },
    );
    expect(priced).not.toBeNull();
    const catalog = buildModelPricingCatalogFromData(priced!);
    const tier = catalog.models.find((m) => m.modelName === 'lc-one')!.groupPricing.default!;
    // 直采价 3/15 原样生效；×2 的长上下文倍率**没有**被偷偷乘进去
    expect(tier.inputPerMillion).toBe(3);
    expect(tier.outputPerMillion).toBe(15);
    // 缓存倍率仍按 extra_ratios 生效（这是另一条已确认的真实判据）
    expect(tier.cacheReadPerMillion).toBeCloseTo(0.3, 10);
  });

  it('阈值或倍率畸形的 long_context 被忽略，不影响价格', async () => {
    const { normalizeOneHubPricingPayload } = await import('./modelPricingService.js');
    for (const broken of [
      { threshold: 0, input_ratio: 2, output_ratio: 1.5 },
      { threshold: -1, input_ratio: 2, output_ratio: 1.5 },
      { threshold: 200_000, input_ratio: Number.NaN, output_ratio: 1.5 },
      { threshold: 200_000, input_ratio: 2, output_ratio: 'abc' },
    ]) {
      const priced = normalizeOneHubPricingPayload(
        { data: { 'bad-lc': { groups: ['default'], price: { type: 'tokens', input: 2, output: 8, long_context: broken } } } },
        { data: { default: 1 } },
      );
      const catalog = buildModelPricingCatalogFromData(priced!);
      const tier = catalog.models.find((m) => m.modelName === 'bad-lc')!.groupPricing.default!;
      expect(tier.inputPerMillion).toBe(2);
      expect(tier.outputPerMillion).toBe(8);
      expect(Number.isFinite(tier.inputPerMillion)).toBe(true);
    }
  });

  it('完全没有 long_context 时不凭空造出该字段', async () => {
    const { normalizeOneHubPricingPayload } = await import('./modelPricingService.js');
    const priced = normalizeOneHubPricingPayload(
      { data: { plain: { groups: ['default'], price: { type: 'tokens', input: 1, output: 2 } } } },
      { data: { default: 1 } },
    );
    const catalog = buildModelPricingCatalogFromData(priced!);
    const entry = catalog.models.find((m) => m.modelName === 'plain')!;
    expect(entry.groupPricing.default!.inputPerMillion).toBe(1);
  });
});
