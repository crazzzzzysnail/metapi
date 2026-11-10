import { describe, expect, it } from 'vitest';
import {
  buildModelPricingCatalogFromData,
  normalizeCommonPricingPayload,
} from './modelPricingService.js';

/**
 * S4 分组链路的回归锁定（T4.5）。
 *
 * 核查结论：清单里 T4.1/T4.2/T4.3 描述的改动**大部分已在现行代码中成立**，
 * 因此本文件不改行为，只把契约钉住，防止后续被"顺手优化"掉：
 *
 *   - 目录按 `siteId:accountId` 缓存**完整多分组数据**，读取时才按 group 选档
 *     （routes/api/tokens.ts:764）。这正是清单推荐的形态；
 *     若把 group 塞进缓存键，会让 N 个分组产生 N 倍上游请求，属倒退。
 *   - 令牌分组缺失 → effectiveGroupName 为 null → 标 unavailable + 「当前令牌分组未知」，
 *     不回退编造一个分组。
 *   - usable_group 为空时不得让所有模型都消失。
 */

const payload = {
  success: true,
  group_ratio: { default: 1, vip: 0.5, svip: 0 },
  usable_group: { default: 'Default', vip: 'VIP' },
  auto_groups: ['default'],
  data: [
    {
      model_name: 'multi/group-model',
      quota_type: 0,
      model_ratio: 10,
      completion_ratio: 2,
      model_price: 0,
      enable_groups: ['default', 'vip'],
    },
    {
      model_name: 'default-only',
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 1,
      model_price: 0,
      enable_groups: ['default'],
    },
  ],
};

function catalog() {
  const data = normalizeCommonPricingPayload(payload);
  if (!data) throw new Error('归一失败');
  return buildModelPricingCatalogFromData(data);
}

describe('分组目录的完整性与档位选择', () => {
  it('一份目录同时带出多个分组的档位（缓存整目录、按 group 查的前提）', () => {
    const entry = catalog().models.find((m) => m.modelName === 'multi/group-model')!;

    // 该模型 enableGroups = [default, vip]，两档都要在
    expect(entry.groupPricing.default).toBeDefined();
    expect(entry.groupPricing.vip).toBeDefined();
    expect(entry.groupPricing.default!.inputPerMillion).toBe(20);
    // vip 倍率 0.5 → 10 × 2 × 0.5
    expect(entry.groupPricing.vip!.inputPerMillion).toBe(10);
  });

  it('svip 倍率为 0 时也得 0，且这是"免费"不是"未知"', () => {
    const result = catalog();
    expect(result.groupRatio.svip).toBe(0);

    // 显式允许 svip 的模型应拿到 0 价 + exact 证据
    const forced = normalizeCommonPricingPayload({
      ...payload,
      data: [{
        model_name: 'svip-model',
        quota_type: 0,
        model_ratio: 10,
        completion_ratio: 1,
        model_price: 0,
        enable_groups: ['svip'],
      }],
    })!;
    const built = buildModelPricingCatalogFromData(forced);
    const pricing = built.models[0]!.groupPricing.svip!;
    expect(pricing.inputPerMillion).toBe(0);
    expect(pricing.evidence?.precision).toBe('exact');
  });

  it('仅 default 可用的模型不会长出 vip 档', () => {
    const entry = catalog().models.find((m) => m.modelName === 'default-only')!;
    expect(entry.groupPricing.default).toBeDefined();
    expect(entry.groupPricing.vip).toBeUndefined();
  });

  it('分组表里没有该分组时报未知，不退回 default 档（2026-11-09 修正）', () => {
    const data = normalizeCommonPricingPayload({
      ...payload,
      data: [{
        model_name: 'orphan-group',
        quota_type: 0,
        model_ratio: 4,
        completion_ratio: 1,
        model_price: 0,
        enable_groups: ['ghost'],
      }],
    })!;
    const built = buildModelPricingCatalogFromData(data);
    const entry = built.models.find((m) => m.modelName === 'orphan-group')!;

    // 旧行为：ghost 无倍率 → 借 default 的倍率出一档。
    // 这在 siteB(default=2) 上等于给一个未声明分组报翻倍价，属凭空造价，已禁止。
    expect(entry.groupPricing.default).toBeUndefined();
    expect(entry.groupPricing.ghost!.evidence?.precision).toBe('unknown');
    expect(entry.groupPricing.ghost!.evidence?.reason).toBe('group-unavailable');
    expect(entry.groupPricing.ghost!.inputPerMillion).toBeUndefined();
  });

  it('usable_group 为空不影响目录构造（可用性由上层判断，不在这里抹模型）', () => {
    const data = normalizeCommonPricingPayload({
      ...payload,
      usable_group: {},
      auto_groups: [],
    });
    expect(data).not.toBeNull();
    const built = buildModelPricingCatalogFromData(data!);
    expect(built.models.length).toBe(2);
  });

  it('enable_groups 缺省或空数组时档位为空，不猜 default（2026-11-09 修正）', () => {
    const data = normalizeCommonPricingPayload({
      success: true,
      group_ratio: { default: 1 },
      data: [
        { model_name: 'no-field', quota_type: 0, model_ratio: 1, completion_ratio: 1, model_price: 0 },
        { model_name: 'empty-list', quota_type: 0, model_ratio: 1, completion_ratio: 1, model_price: 0, enable_groups: [] },
      ],
    })!;
    const built = buildModelPricingCatalogFromData(data);
    for (const name of ['no-field', 'empty-list']) {
      const entry = built.models.find((m) => m.modelName === name)!;
      // 上游没声明分组 → 如实为空，由 UI 显示"未知"。
      // 伪造 default 会让实扣路径拿 default 倍率出价（siteB 的 default 是 ×2）。
      expect(entry.enableGroups).toEqual([]);
      expect(Object.keys(entry.groupPricing)).toEqual([]);
    }
  });
});
