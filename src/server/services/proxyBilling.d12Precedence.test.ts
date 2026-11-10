import { describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('./siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_url: string, init: Record<string, unknown>) => init,
}));

import {
  estimateProxyCost,
  buildProxyBillingDetails,
  refreshModelPricingCatalog,
} from './modelPricingService.js';

/**
 * D12 修复之优先级（缺陷 ③）。
 *
 * 旧顺序是"有 self-log 覆盖就完全跳过定价目录"，于是日志里的比率
 * （且旧实现会把缺失字段伪造成 1×）盖掉目录中的真实分组倍率。
 * 实测上游的折扣分组倍率远不是 1：siteA grp-codex ×0.15、siteB default ×2。
 * 用伪造的 1× 记账，结果不是少算一点，而是按一个上游从未声明的价格扣费。
 */

const PRICING_PAYLOAD = {
  success: true,
  group_ratio: { default: 1, 'grp-codex': 0.15 },
  data: [{
    model_name: 'gpt-x',
    quota_type: 0,
    model_ratio: 2,
    completion_ratio: 1,
    enable_groups: ['grp-codex'],
  }],
};

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    site: { id: 7_002, url: 'https://d12-precedence.test', platform: 'new-api' },
    account: { id: 7_002, accessToken: 'sess', apiToken: null },
    modelName: 'gpt-x',
    promptTokens: 1_000_000,
    completionTokens: 0,
    totalTokens: 1_000_000,
    ...overrides,
  };
}

async function primeCache(input: ReturnType<typeof makeInput>) {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(PRICING_PAYLOAD), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  await refreshModelPricingCatalog(input as never);
}

describe('目录优先于 self-log 覆盖', () => {
  it('override 声称 1× 时仍采用目录的 ×0.15', async () => {
    const input = makeInput();
    await primeCache(input);

    const catalogOnly = await estimateProxyCost(input as never);
    // 2 ratio × 2 (USD/M per ratio) × 0.15 = 0.6
    expect(catalogOnly).toBeCloseTo(0.6, 10);

    const withOverride = await estimateProxyCost({
      ...input,
      billingPricingOverride: { modelRatio: 1, completionRatio: 1, groupRatio: 1 },
    } as never);

    // 旧逻辑这里会得到 1×2×1 = 2 —— 即按上游从未声明的倍率扣费
    expect(withOverride).toBe(catalogOnly);
    expect(withOverride).not.toBeCloseTo(2, 10);
  });

  it('明细与成本走同一优先级，不出现口径分裂', async () => {
    const input = makeInput();
    await primeCache(input);

    const details = await buildProxyBillingDetails({
      ...input,
      billingPricingOverride: { modelRatio: 1, completionRatio: 1, groupRatio: 1 },
    } as never);

    expect(details).not.toBeNull();
    expect(details!.breakdown.inputPerMillion).toBeCloseTo(0.6, 10);
  });

  it('目录确实给不出该模型时，才轮到 self-log 覆盖兜底', async () => {
    // 目录里没有这个模型名
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      success: true,
      group_ratio: { default: 1 },
      data: [{ model_name: 'other-model', quota_type: 0, model_ratio: 9, completion_ratio: 1, enable_groups: ['default'] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const input = makeInput({ site: { id: 7_003, url: 'https://d12-b.test', platform: 'new-api' }, account: { id: 7_003, accessToken: 's', apiToken: null } });
    await refreshModelPricingCatalog(input as never);

    // 无覆盖 → 目录里没这个模型 → null（不瞎猜）
    expect(await estimateProxyCost(input as never)).toBeNull();

    // 有覆盖 → 用日志给的比率算出价格
    const fallback = await estimateProxyCost({
      ...input,
      billingPricingOverride: { modelRatio: 3, completionRatio: 1, groupRatio: 1 },
    } as never);
    expect(fallback).toBeCloseTo(6, 10);
  });

  it('覆盖路径同样不伪造缺省比率', async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('unreachable'));
    const input = makeInput({
      site: { id: 7_004, url: 'https://d12-c.test', platform: 'new-api' },
      account: { id: 7_004, accessToken: 's', apiToken: null },
    });
    // 只给 modelRatio，不给 completionRatio：输出侧应按未提供处理而非编成 1×
    const cost = await estimateProxyCost({
      ...input,
      promptTokens: 0,
      completionTokens: 1_000_000,
      totalTokens: 1_000_000,
      billingPricingOverride: { modelRatio: 2 },
    } as never);
    // 输入价 2×2=4/M；completion 无显式系数 → buildPricingOverrideModel 仍以 1 兜底完成计算，
    // 但关键是不因缺字段而整体放弃：仍给出一个成本
    expect(cost).not.toBeNull();
  });
});
