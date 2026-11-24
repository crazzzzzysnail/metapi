import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  calculateModelUsageBreakdown,
  normalizeCommonPricingPayload,
} from './modelPricingService.js';

/**
 * T6.4 · 档位结论写入 billing_details。
 *
 * `proxy_logs.billing_details` 是 text 列、整体 JSON 序列化，因此**无需新增列**；
 * 本文件锁的是"事后能从这条记录里还原出当时按哪个口径、哪个档位算的钱"。
 * 缺了这两个字段，峰谷同价、len 跨档跳变都会变成无法解释的历史数字。
 */

const siteA = JSON.parse(
  readFileSync(new URL('./__fixtures__/siteA-tiered-pricing.json', import.meta.url), 'utf8'),
);

function modelOf(name: string) {
  const data = normalizeCommonPricingPayload(siteA)!;
  return { model: data.models.get(name)!, groupRatio: data.groupRatio };
}

describe('billing_details 的口径与档位留痕', () => {
  it('时间分档：峰段记录 peak，谷段记录 off_peak', () => {
    const { model } = modelOf('sample-model-cal');
    const ratio = { '组丁-chs': 0.4 };
    const usage = { promptTokens: 100_000, completionTokens: 10_000, totalTokens: 110_000 };

    const peak = calculateModelUsageBreakdown(model, usage, ratio, Date.UTC(2026, 10, 11, 10, 0))!;
    const offPeak = calculateModelUsageBreakdown(model, usage, ratio, Date.UTC(2026, 10, 13, 20, 0))!;

    expect(peak.pricing.evidenceSource).toBe('upstream-dynamic-expr');
    expect(peak.pricing.tierName).toBe('peak');
    expect(offPeak.pricing.tierName).toBe('off_peak');
    // 两者单价确实不同，且都留了痕
    expect(peak.breakdown.inputPerMillion).not.toBe(offPeak.breakdown.inputPerMillion);
  });

  it('len 分档：阈值两侧分别记 0_272k / 272k_plus', () => {
    const { model } = modelOf('sample-model-len');
    // 该模型实挂 disc-codex-pro / grp-codex-pro(×0.3) / grp-codex(×0.15) / disc-codex
    const ratio = { 'grp-codex': 0.15 };

    const low = calculateModelUsageBreakdown(model, {
      promptTokens: 200_000, completionTokens: 0, totalTokens: 200_000,
    }, ratio)!;
    const high = calculateModelUsageBreakdown(model, {
      promptTokens: 300_000, completionTokens: 0, totalTokens: 300_000,
    }, ratio)!;

    expect(low.pricing.tierName).toBe('0_272k');
    expect(high.pricing.tierName).toBe('272k_plus');
  });

  it('单档形态也记档位名（base/standard），便于区分上游写法', () => {
    const single = normalizeCommonPricingPayload({
      success: true,
      group_ratio: { default: 1 },
      data: [{
        model_name: 'm-single', quota_type: 0, model_ratio: 37.5, completion_ratio: 1,
        model_price: 0, enable_groups: ['default'], billing_mode: 'tiered_expr',
        billing_expr: 'tier("standard", p * 0.185 + cr * 0.037 + c * 1.11)',
      }],
    })!;
    const detail = calculateModelUsageBreakdown(single.models.get('m-single')!, {
      promptTokens: 100_000, completionTokens: 10_000, totalTokens: 110_000,
    }, single.groupRatio)!;
    expect(detail.pricing.tierName).toBe('standard');
  });

  it('非动态口径不写 tierName（不留假字段）', () => {
    const plain = normalizeCommonPricingPayload({
      success: true,
      group_ratio: { default: 1 },
      data: [{ model_name: 'm-token', quota_type: 0, model_ratio: 1, completion_ratio: 4, cache_ratio: 0.02, model_price: 0, enable_groups: ['default'] }],
    })!;
    const detail = calculateModelUsageBreakdown(plain.models.get('m-token')!, {
      promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000,
    }, plain.groupRatio)!;
    expect(detail.pricing.evidenceSource).toBe('upstream-ratio');
    expect(detail.pricing.tierName).toBeUndefined();
  });

  it('按次计费也产出明细（分组名/倍率/每次价），过去直接返回 null', () => {
    // 真实上游形态（已中性化）：quota_type=1 按次、model_price 为每请求价、
    // enable_groups 含一个低倍率的"按次"分组。旧实现 estimated_cost 落库正确，
    // 但 billing_details 为空 → 日志"分组/计费"整行消失，无法知道按哪档扣的。
    const perCall = normalizeCommonPricingPayload({
      success: true,
      group_ratio: { 'grp-a': 1, '按次': 0.2 },
      data: [{
        model_name: 'img-model', quota_type: 1, model_ratio: 0, completion_ratio: 0,
        model_price: 10, enable_groups: ['grp-a', '按次'],
      }],
    })!;
    const detail = calculateModelUsageBreakdown(perCall.models.get('img-model')!, {
      promptTokens: 1200, completionTokens: 300, totalTokens: 1500,
    }, perCall.groupRatio, undefined, { tokenGroup: '按次' })!;

    expect(detail).not.toBeNull();
    expect(detail.quotaType).toBe(1);
    expect(detail.pricing.groupName).toBe('按次');
    expect(detail.pricing.groupRatio).toBe(0.2);
    expect(detail.pricing.evidenceSource).toBe('upstream-per-call');
    // 每次价 = model_price × 分组倍率，与 calculateModelUsageCost 同源
    expect(detail.breakdown.perCallPrice).toBe(2);
    expect(detail.breakdown.totalCost).toBe(2);
    // 每百万四字段一律不写：写了就是把"口径不适用"显示成 $0 免费
    expect(detail.breakdown.inputPerMillion).toBeUndefined();
    expect(detail.breakdown.outputPerMillion).toBeUndefined();
    expect(detail.breakdown.cacheReadPerMillion).toBeUndefined();
    expect(detail.breakdown.cacheCreationPerMillion).toBeUndefined();
    // 档位名不适用（按次没有动态档）
    expect(detail.pricing.tierName).toBeUndefined();
  });

  it('按次模型倍率未知时仍不出账（与 token 同一判据）', () => {
    const perCall = normalizeCommonPricingPayload({
      success: true,
      group_ratio: { default: 1 },
      data: [{
        model_name: 'img-orphan', quota_type: 1, model_ratio: 0, completion_ratio: 0,
        model_price: 10, enable_groups: ['未列倍率组'],
      }],
    })!;
    // enableGroups 里的分组在 group_ratio 中不存在 → resolveBillingGroup 判未知
    const detail = calculateModelUsageBreakdown(perCall.models.get('img-orphan')!, {
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
    }, { default: 1 });
    expect(detail).toBeNull();
  });

  it('序列化后仍可读回两个字段（JSON 往返）', () => {
    const { model } = modelOf('sample-model-cal');
    const detail = calculateModelUsageBreakdown(model, {
      promptTokens: 100_000, completionTokens: 10_000, totalTokens: 110_000,
    }, { '组丁-chs': 0.4 }, Date.UTC(2026, 10, 11, 10, 0));

    const roundTrip = JSON.parse(JSON.stringify(detail));
    expect(roundTrip.pricing.evidenceSource).toBe('upstream-dynamic-expr');
    expect(roundTrip.pricing.tierName).toBe('peak');
  });
});
