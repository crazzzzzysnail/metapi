import { describe, expect, it } from 'vitest';
import {
  buildModelPricingCatalogFromData,
  calculateModelUsageBreakdown,
  isAutoGroupName,
  normalizeCommonPricingPayload,
} from './modelPricingService.js';

/**
 * 三-1 / 三-3 · 令牌分组决定计费档位。
 *
 * 全部用例的数字来自 2026-11-09 siteA 的真实账单：
 *   - `/api/pricing` 的 group_ratio 与模型 enable_groups；
 *   - `/api/token/` 的 auto_groups 链路；
 *   - `/api/log/token` 里上游实际扣的 quota = 245（= $0.00049）。
 *
 * 修复前的偏差：令牌挂 auto 时，旧实现按"模型第一个有倍率的分组"取到
 * grp-codex-pro(×0.3)，且把 cache token 重复计费，最终记成 $0.003515，
 * 约为上游实扣的 7.2 倍。
 */

const payload = {
  success: true,
  group_ratio: {
    auto: 1,
    'grp-codex': 0.15,
    'grp-codex-pro': 0.3,
    '组丁-chs': 0.4,
  },
  data: [
    {
      model_name: 'sample-model-ratio',
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 6,
      cache_ratio: 0.125,
      model_price: 0,
      // 注意前两个分组没有倍率 —— 旧实现会跳过它们继续往后找
      enable_groups: ['disc-codex', 'disc-codex-pro', 'grp-codex-pro', 'grp-codex'],
    },
    {
      model_name: 'sample-model-cal',
      quota_type: 0,
      model_ratio: 37.5,
      completion_ratio: 1,
      cache_ratio: 1,
      model_price: 0,
      enable_groups: ['组丁-chs'],
      billing_mode: 'tiered_expr',
      billing_expr: 'weekday("UTC") >= 1 && weekday("UTC") <= 5 && ((hour("UTC") >= 9 && hour("UTC") < 12) || (hour("UTC") >= 14 && hour("UTC") < 18)) ? tier("peak", p * 2 + cr * 0.04 + c * 8) : tier("off_peak", p * 1 + cr * 0.02 + c * 4)',
    },
  ],
};

const AUTO_CHAIN = ['grp-codex', 'grp-codex-pro', '组丁-chs'];

function data() {
  return normalizeCommonPricingPayload(payload)!;
}

const USAGE = {
  promptTokens: 4441,
  completionTokens: 148,
  totalTokens: 4589,
  cacheReadTokens: 4224,
  cacheCreationTokens: 0,
  promptTokensIncludeCache: true,
};

describe('auto 分组识别', () => {
  it('auto / 自动 都算无独立倍率的别名', () => {
    expect(isAutoGroupName('auto')).toBe(true);
    expect(isAutoGroupName(' AUTO ')).toBe(true);
    expect(isAutoGroupName('自动')).toBe(true);
    expect(isAutoGroupName('grp-codex')).toBe(false);
    expect(isAutoGroupName(null)).toBe(false);
  });
});

describe('三-3 分组解析：链路按顺序命中', () => {
  it('auto 令牌取链路里第一个模型可用的分组（grp-codex，不是 grp-codex-pro）', () => {
    const d = data();
    const detail = calculateModelUsageBreakdown(
      d.models.get('sample-model-ratio')!,
      USAGE,
      d.groupRatio,
      Date.UTC(2026, 10, 9, 8, 0),
      { tokenGroup: 'auto', autoGroups: AUTO_CHAIN },
    )!;

    expect(detail.pricing.groupName).toBe('grp-codex');
    expect(detail.pricing.groupRatio).toBe(0.15);
  });

  it('缓存计入 prompt：billable = 4441 - 4224', () => {
    const d = data();
    const detail = calculateModelUsageBreakdown(
      d.models.get('sample-model-ratio')!,
      USAGE,
      d.groupRatio,
      Date.UTC(2026, 10, 9, 8, 0),
      { tokenGroup: 'auto', autoGroups: AUTO_CHAIN },
    )!;
    expect(detail.usage.billablePromptTokens).toBe(217);
  });

  it('总成本必须与上游实扣的 245 quota（$0.00049）一致', () => {
    const d = data();
    const detail = calculateModelUsageBreakdown(
      d.models.get('sample-model-ratio')!,
      USAGE,
      d.groupRatio,
      Date.UTC(2026, 10, 9, 8, 0),
      { tokenGroup: 'auto', autoGroups: AUTO_CHAIN },
    )!;
    // 上游按整数 quota 结算，允许 1e-6 级别的取整差
    expect(detail.breakdown.totalCost).toBeCloseTo(245 / 500000, 5);
  });

  it('对照组：不传分组信息时沿用旧启发式，价格明显偏高（回归护栏）', () => {
    const d = data();
    const legacy = calculateModelUsageBreakdown(
      d.models.get('sample-model-ratio')!,
      USAGE,
      d.groupRatio,
      Date.UTC(2026, 10, 9, 8, 0),
    )!;
    // 旧行为取到 grp-codex-pro(×0.3) —— 不是 0.15，且成本翻倍
    expect(legacy.pricing.groupRatio).toBe(0.3);
    expect(legacy.breakdown.totalCost).toBeCloseTo(0.00098, 6);
  });

  it('链路前两档没有该模型时，落到最后一档', () => {
    const d = data();
    const detail = calculateModelUsageBreakdown(
      d.models.get('sample-model-cal')!,
      { promptTokens: 31, completionTokens: 56, totalTokens: 87 },
      d.groupRatio,
      Date.UTC(2026, 10, 13, 20, 0),
      { tokenGroup: 'auto', autoGroups: AUTO_CHAIN },
    )!;
    expect(detail.pricing.groupName).toBe('组丁-chs');
    expect(detail.pricing.tierName).toBe('off_peak');
  });

  it('显式分组优先于链路', () => {
    const d = data();
    const detail = calculateModelUsageBreakdown(
      d.models.get('sample-model-ratio')!,
      USAGE,
      d.groupRatio,
      Date.UTC(2026, 10, 9, 8, 0),
      { tokenGroup: 'grp-codex-pro', autoGroups: AUTO_CHAIN },
    )!;
    expect(detail.pricing.groupName).toBe('grp-codex-pro');
    expect(detail.pricing.groupRatio).toBe(0.3);
  });

  it('有令牌信息但一个分组都对不上：拒绝出价，不退到别的分组', () => {
    const d = data();
    const detail = calculateModelUsageBreakdown(
      d.models.get('sample-model-ratio')!,
      USAGE,
      d.groupRatio,
      Date.UTC(2026, 10, 9, 8, 0),
      { tokenGroup: 'auto', autoGroups: ['不存在的分组'] },
    );
    expect(detail).toBeNull();
  });
});

describe('二-3 目录侧的多档透出', () => {
  it('目录条目带上全部档位与档位名（供模型广场逐档显示）', () => {
    const catalog = buildModelPricingCatalogFromData(data());
    const entry = catalog.models.find((model) => model.modelName === 'sample-model-cal')!;
    const pricing = entry.groupPricing['组丁-chs']!;

    expect(pricing.tiers?.length).toBe(2);
    expect(pricing.tiers?.map((tier) => tier.name)).toEqual(['peak', 'off_peak']);
    // 条件翻成人话，而不是把表达式原文丢给用户
    expect(pricing.tiers?.map((tier) => tier.condition)).toEqual([
      '周一至周五 09:00-12:00 / 14:00-18:00',
      '其余',
    ]);
    // 代表价仍是第一档，路由参考价等单值场景不受影响
    expect(pricing.inputPerMillion).toBe(pricing.tiers![0]!.input);
  });

  it('单档表达式不写 tiers（没有分档就没有"各档"可列）', () => {
    const single = normalizeCommonPricingPayload({
      success: true,
      group_ratio: { default: 1 },
      data: [{
        model_name: 'm-single',
        quota_type: 0,
        model_ratio: 1,
        completion_ratio: 1,
        model_price: 0,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr: 'tier("standard", p * 0.185 + c * 1.11)',
      }],
    })!;
    const catalog = buildModelPricingCatalogFromData(single);
    const entry = catalog.models.find((model) => model.modelName === 'm-single')!;
    expect(entry.groupPricing.default?.tiers).toBeUndefined();
  });
});
