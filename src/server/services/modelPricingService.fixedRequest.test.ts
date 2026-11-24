import { describe, expect, it } from 'vitest';
import {
  buildModelPricingCatalogFromData,
  calculateModelUsageBreakdown,
  calculateModelUsageCost,
  normalizeCommonPricingPayload,
} from './modelPricingService.js';

/**
 * `fixed(X)` 每请求固定价。
 *
 * 上游载荷形态（全部合成值，与任何真实站点数值无关）：
 *   billing_mode = "tiered_expr"
 *   billing_expr = 'tier("base", fixed(0.0004))'
 *   model_ratio  = 37.5（迁移后未清理的历史残留，**不作数**）
 *
 * 语义判据： `fixed(N)` 的 N 乘以
 * 该站充值价后恰好等于一个整的每次人民币价；按"每百万 token"解读则价格荒谬且解释
 * 不了那个整除关系。
 *
 * 旧实现把 `fixed(...)` 判 malformed-term → 整式 unsupported → 回落失效
 * model_ratio=37.5 → 目录显示 $75/M（对 1M token 参考用量高估约 10.9 万倍），
 * 且该数字会进入路由参考价，把最便宜的一档排到最贵。
 *
 * 本文件锁定四件事：
 *   ① 目录给出每请求价，**不**产出每百万四项；
 *   ② 实扣与 token 数无关（同样一次请求，100 token 与 1M token 同价）；
 *   ③ 分组倍率照常乘到每请求价上；
 *   ④ fixed 与 token 混用的表达式明确拒绝，不猜一个口径。
 */

const payload = {
  group_ratio: { default: 1, premium: 2 },
  auto_groups: ['default'],
  data: [
    {
      model_name: 'sample-model-fixed-flat',
      quota_type: 0,
      model_ratio: 37.5,
      model_price: 0,
      completion_ratio: 1,
      enable_groups: ['default', 'premium'],
      billing_mode: 'tiered_expr',
      billing_expr: 'tier("base", fixed(0.0004))',
    },
    {
      model_name: 'sample-model-fixed-len',
      quota_type: 0,
      model_ratio: 37.5,
      model_price: 0,
      completion_ratio: 1,
      enable_groups: ['default'],
      billing_mode: 'tiered_expr',
      billing_expr: 'len <= 32000 ? tier("short", fixed(0.01)) : tier("long", fixed(0.03))',
    },
    {
      model_name: 'sample-model-mixed',
      quota_type: 0,
      model_ratio: 37.5,
      model_price: 0,
      completion_ratio: 1,
      enable_groups: ['default'],
      billing_mode: 'tiered_expr',
      billing_expr: 'len <= 32000 ? tier("short", fixed(0.01)) : tier("long", p * 2)',
    },
    {
      model_name: 'sample-model-token',
      quota_type: 0,
      model_ratio: 1,
      model_price: 0,
      completion_ratio: 2,
      enable_groups: ['default'],
      billing_mode: 'token',
    },
  ],
};

function pricingData() {
  const data = normalizeCommonPricingPayload(payload);
  if (!data) throw new Error('归一失败：检查载荷形状');
  return data;
}

function catalogPricingOf(modelName: string, group = 'default') {
  const entry = buildModelPricingCatalogFromData(pricingData()).models
    .find((m) => m.modelName === modelName);
  if (!entry) throw new Error(`目录中缺少模型 ${modelName}`);
  const pricing = entry.groupPricing[group];
  if (!pricing) throw new Error(`目录中缺少分组 ${group}`);
  return pricing;
}

function modelOf(modelName: string) {
  const model = pricingData().models.get(modelName);
  if (!model) throw new Error(`载荷中缺少模型 ${modelName}`);
  return model;
}

const ONE_CALL_100 = { promptTokens: 60, completionTokens: 40, totalTokens: 100 };
const ONE_CALL_1M = { promptTokens: 500_000, completionTokens: 500_000, totalTokens: 1_000_000 };

describe('目录：fixed(X) 产出每请求价而不是每百万价', () => {
  it('单档 fixed：给 fixedPerRequest，且绝不产出每百万四项', () => {
    const pricing = catalogPricingOf('sample-model-fixed-flat');

    expect(pricing.fixedPerRequest).toBe(0.0004);
    // 反向锁定：旧实现这里是 75（失效 model_ratio × 2）
    expect(pricing.inputPerMillion).toBeUndefined();
    expect(pricing.outputPerMillion).toBeUndefined();
    expect(pricing.cacheReadPerMillion).toBeUndefined();
    expect(pricing.cacheCreationPerMillion).toBeUndefined();
  });

  it('解析成功标为精确的动态计费价（不是 derived-from-stale-field）', () => {
    const pricing = catalogPricingOf('sample-model-fixed-flat');
    expect(pricing.evidence?.source).toBe('upstream-dynamic-expr');
    expect(pricing.evidence?.precision).toBe('exact');
  });

  it('分组倍率乘到每请求价上（premium ×2）', () => {
    expect(catalogPricingOf('sample-model-fixed-flat', 'premium').fixedPerRequest).toBe(0.0008);
  });

  it('len 分档 + fixed：每档各自带 fixedPerRequest，不混入 input', () => {
    const pricing = catalogPricingOf('sample-model-fixed-len');
    expect(pricing.fixedPerRequest).toBe(0.01);
    expect(pricing.tiers?.map((t) => t.fixedPerRequest)).toEqual([0.01, 0.03]);
    expect(pricing.tiers?.every((t) => t.input === undefined)).toBe(true);
  });

  it('fixed 与 token 混用：拒绝解析，退回失效字段并降级为近似', () => {
    const pricing = catalogPricingOf('sample-model-mixed');
    expect(pricing.evidence?.source).toBe('derived-from-stale-field');
    expect(pricing.evidence?.precision).toBe('approximate');
    // 混用时不会凭空给出按次价
    expect(pricing.fixedPerRequest).toBeUndefined();
  });

  it('普通 token 模型不受影响', () => {
    const pricing = catalogPricingOf('sample-model-token');
    expect(pricing.inputPerMillion).toBe(2);
    expect(pricing.outputPerMillion).toBe(4);
    expect(pricing.fixedPerRequest).toBeUndefined();
  });
});

describe('实扣：fixed(X) 与 token 数无关', () => {
  it('100 token 与 1M token 的一次请求成本完全相同', () => {
    const model = modelOf('sample-model-fixed-flat');
    const groupRatio = { default: 1 };

    const small = calculateModelUsageCost(model, ONE_CALL_100, groupRatio);
    const large = calculateModelUsageCost(model, ONE_CALL_1M, groupRatio);

    expect(small).toBe(0.0004);
    expect(large).toBe(0.0004);
    expect(small).toBe(large);
  });

  it('明细走 perCallPrice 口径，不写每百万四项（写 0 会被读成免费）', () => {
    const model = modelOf('sample-model-fixed-flat');
    const details = calculateModelUsageBreakdown(model, ONE_CALL_100, { default: 1 });

    expect(details).not.toBeNull();
    if (!details) return;
    expect(details.breakdown.perCallPrice).toBe(0.0004);
    expect(details.breakdown.totalCost).toBe(0.0004);
    expect(details.breakdown.inputPerMillion).toBeUndefined();
    expect(details.breakdown.outputPerMillion).toBeUndefined();
    // 上游 quota_type 是 0 —— 前端不能靠它判断"按次"，必须看 perCallPrice。
    expect(details.quotaType).toBe(0);
    expect(details.pricing.evidenceSource).toBe('upstream-dynamic-expr');
  });

  it('分组倍率同样作用于实扣（premium ×2）', () => {
    const model = modelOf('sample-model-fixed-flat');
    const details = calculateModelUsageBreakdown(
      model,
      ONE_CALL_100,
      { default: 1, premium: 2 },
      Date.now(),
      { tokenGroup: 'premium' },
    );
    expect(details?.breakdown.perCallPrice).toBe(0.0008);
  });

  it('len 分档 fixed：按输入量选档，两档价格不同', () => {
    const model = modelOf('sample-model-fixed-len');
    const short = calculateModelUsageCost(model, { promptTokens: 100, completionTokens: 10, totalTokens: 110 }, { default: 1 });
    const long = calculateModelUsageCost(model, { promptTokens: 40000, completionTokens: 10, totalTokens: 40010 }, { default: 1 });
    expect(short).toBe(0.01);
    expect(long).toBe(0.03);
  });

  it('路由参考价：1M token 参考用量拿到的就是每请求价，不再是 $75', () => {
    const model = modelOf('sample-model-fixed-flat');
    // buildRoutingReferenceCostMap 用同一函数与同一参考用量（50万 + 50万）。
    const referenceCost = calculateModelUsageCost(model, ONE_CALL_1M, { default: 1 });
    expect(referenceCost).toBe(0.0004);
    expect(referenceCost).not.toBe(75);
  });
});
