import { describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('./siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_url: string, init: Record<string, unknown>) => init,
  withAccountProxyOverride: (_url: string | null | undefined, fn: () => unknown) => fn(),
  withSiteRecordProxyRequestInit: (_url: string, init: Record<string, unknown>) => init,
}));

import {
  buildModelPricingCatalogFromData,
  getCachedModelRoutingReferenceCost,
  normalizeCommonPricingPayload,
  refreshModelPricingCatalog,
} from './modelPricingService.js';

/**
 * S7 路由成本口径（T9.1 / T9.2 / T9.6）。
 *
 * 两条被钉住的规则：
 *   ① 按次计费（quotaType===1）不进路由参考价表 —— 它的"每百万 token 价"没有意义；
 *   ② 取不到价的模型不进表，且**免费模型的 0 不被钳成正数**。
 *      旧实现 `Math.max(cost, 1e-6)` 会把 0 变成 1e-6，使 totalCost 为正，
 *      进而让 resolveEffectiveUnitCost 的 observed 分支接管用户配置的 unitCost（N1）。
 */

function makePayload(models: unknown[]) {
  return {
    success: true,
    group_ratio: { default: 1 },
    usable_group: { default: 'Default' },
    auto_groups: ['default'],
    data: models,
  };
}

describe('路由参考成本的准入', () => {
  it('catalog 仍包含按次与免费模型（展示需要完整目录）', async () => {
    const payload = makePayload([
      { model_name: 'token-paid', quota_type: 0, model_ratio: 5, completion_ratio: 1, model_price: 0, enable_groups: ['default'] },
      { model_name: 'token-free', quota_type: 0, model_ratio: 0, completion_ratio: 0, model_price: 0, enable_groups: ['default'] },
      { model_name: 'per-call', quota_type: 1, model_ratio: 0, completion_ratio: 1, model_price: 0.04, enable_groups: ['default'] },
    ]);
    const data = normalizeCommonPricingPayload(payload)!;
    const catalog = buildModelPricingCatalogFromData(data);

    expect(catalog.models.map((m) => m.modelName).sort()).toEqual(
      ['per-call', 'token-free', 'token-paid'].sort(),
    );
  });

  it('按次模型不产出每百万参考成本', () => {
    // calculateModelUsageCost 对 quotaType===1 走 per-call 分支；
    // buildRoutingReferenceCostMap 会直接跳过它，因此该模型不应出现在参考成本缓存里。
    const data = normalizeCommonPricingPayload(makePayload([
      { model_name: 'per-call-only', quota_type: 1, model_ratio: 0, completion_ratio: 1, model_price: 0.04, enable_groups: ['default'] },
    ]))!;

    // 用纯函数路径确认：目录里有它，但它没有 token 档单价
    const catalog = buildModelPricingCatalogFromData(data);
    const entry = catalog.models.find((m) => m.modelName === 'per-call-only')!;
    expect(entry.quotaType).toBe(1);
    expect(entry.groupPricing.default!.inputPerMillion).toBeUndefined();
    expect(entry.groupPricing.default!.perCallTotal).toBeCloseTo(0.04, 10);
  });

  it('免费模型的参考成本是 0，不被下限钳成正数（N1 关键判据）', () => {
    const data = normalizeCommonPricingPayload(makePayload([
      { model_name: 'free-model', quota_type: 0, model_ratio: 0, completion_ratio: 0, model_price: 0, enable_groups: ['default'] },
    ]))!;

    // 直接构造一次参考用量，验证结果为 0 而不是 1e-6
    const catalog = buildModelPricingCatalogFromData(data);
    const pricing = catalog.models[0]!.groupPricing.default!;
    expect(pricing.inputPerMillion).toBe(0);
    expect(pricing.outputPerMillion).toBe(0);
    // 若被 MIN_ROUTING_REFERENCE_COST 钳制，这里会变成 1e-6 —— 正是 N1 的触发条件
    expect(pricing.inputPerMillion).not.toBe(1e-6);
  });
});

describe('未知价格不进路由参考成本', () => {
  it('refreshModelPricingCatalog 对不可达站点返回 null，不伪造目录', async () => {
    // 用 mock 明确制造失败，而不是真去请求 .invalid 域名：
    // 后者依赖 DNS/abort 时序，在并发调度下会变成偶发失败（本用例曾因此抖动）。
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    const catalog = await refreshModelPricingCatalog({
      site: { id: 4_101, url: 'https://pricing-unreachable.invalid', platform: 'new-api' },
      account: { id: 4_101, accessToken: 't', apiToken: null },
      modelName: 'any',
    } as never);
    expect(catalog).toBeNull();
  });

  it('未取过价的站点查参考成本得到 null，而非兜底数', () => {
    const cost = getCachedModelRoutingReferenceCost({
      siteId: 4_202,
      accountId: 4_202,
      modelName: 'never-fetched',
    });
    expect(cost).toBeNull();
  });
});
