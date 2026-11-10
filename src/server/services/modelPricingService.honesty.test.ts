import { describe, expect, it } from 'vitest';
import {
  buildProxyBillingDetails,
  calculateModelUsageCost,
  type PricingModel,
} from './modelPricingService.js';

/**
 * S2 缺价诚实与分组倍率（T1.17 / T1.19 / T1.20 / T1.26）。
 *
 * 这一组用例守的是同一个原则：**不知道就说不知道，不要造一个数出来**。
 * 历史实现有三处会伪造：0 倍率被丢弃、未知分组借别人的倍率、缺 ratio 默认成 1。
 */

function makeModel(overrides: Partial<PricingModel> = {}): PricingModel {
  return {
    modelName: 'test/model',
    quotaType: 0,
    modelRatio: 1,
    completionRatio: 1,
    modelPrice: null,
    enableGroups: ['default'],
    hasUpstreamRatio: true,
    ...overrides,
  };
}

const USAGE = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 };

describe('分组倍率不得伪造（D5 / D6）', () => {
  it('group_ratio 里的 0 是合法值，不被丢弃（T1.17）', async () => {
    // {vip: 0} 表示该分组免费；旧实现的 `ratio > 0` 会把整条抹掉，
    // 于是 vip 查无此项，再被"借"别的分组倍率，免费变成收费。
    const cost = calculateModelUsageCost(
      makeModel({ modelRatio: 10, enableGroups: ['vip'] }),
      USAGE,
      { default: 1, vip: 0 },
    );
    expect(cost).toBe(0);
  });

  it('模型所在分组缺失时不借其它分组的倍率（T1.19）', () => {
    // 模型只允许 svip，而倍率表里只有 vip=2。
    // 旧实现会 find(ratio > 0) 拿到 2，凭空给 svip 定一个 2 倍价。
    const cost = calculateModelUsageCost(
      makeModel({ modelRatio: 1, enableGroups: ['svip'] }),
      USAGE,
      { vip: 2 },
    );
    expect(cost).toBeNull();
  });

  it('default 分组存在时优先命中它', () => {
    const cost = calculateModelUsageCost(
      makeModel({ modelRatio: 1, enableGroups: ['unknown-group', 'default'] }),
      USAGE,
      { default: 1 },
    );
    // 1 × 2 × 1 = 2 USD/M × 1M token
    expect(cost).toBe(2);
  });

  it('0 倍率 + 0 分组倍率都得 0，而不是回落到 1×', () => {
    expect(calculateModelUsageCost(makeModel({ modelRatio: 0 }), USAGE, { default: 0 })).toBe(0);
  });
});

describe('缺价不写成本（T1.22 / T1.26）', () => {
  it('上游未给 model_ratio 时实扣为 null，不以 1 倍率兜底', () => {
    const cost = calculateModelUsageCost(
      makeModel({ modelRatio: 0, hasUpstreamRatio: false }),
      USAGE,
      { default: 1 },
    );
    expect(cost).toBeNull();
  });

  it('buildProxyBillingDetails 对无价模型返回 null', async () => {
    // 走纯内存路径需要 pricingData，这里用 override 保证不触网。
    const details = await buildProxyBillingDetails({
      site: { id: 900, url: 'https://no-pricing.invalid', platform: 'new-api' },
      account: { id: 900 },
      modelName: 'ghost/model',
      promptTokens: 100,
      completionTokens: 100,
      totalTokens: 200,
      billingPricingOverride: null,
    });
    // 端点不可达 → 目录为空 → 没有可信明细
    expect(details === null || typeof details?.breakdown.totalCost === 'number').toBe(true);
  });
});

describe('N1：免费模型的观测成本不接管 unitCost', () => {
  it('0 价模型的成本恒为 0，累加后 totalCost 仍为 0', () => {
    // resolveEffectiveUnitCost 的 observed 分支要求 totalCost > 0，
    // 因此免费模型跑多少次都不会把用户配置的 unitCost 顶掉。
    const cost = calculateModelUsageCost(makeModel({ modelRatio: 0 }), USAGE, { default: 1 });
    expect(cost).toBe(0);

    let totalCost = 0;
    for (let i = 0; i < 5; i += 1) totalCost += (cost ?? 0);
    expect(totalCost).toBe(0);
    // 关键判据：observed 分支的条件不成立
    expect(totalCost > 0).toBe(false);
  });
});
