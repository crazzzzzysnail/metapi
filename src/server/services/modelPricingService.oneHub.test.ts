import { describe, expect, it } from 'vitest';
import {
  buildModelPricingCatalogFromData,
  normalizeOneHubPricingPayload,
} from './modelPricingService.js';

/**
 * one-hub / done-hub 定价字段映射（T2.1–T2.3、T2.6）。
 *
 * A7 取证结论：上游把缓存价表达为 `price.extra_ratios.*` 下的**相对倍率**，
 * 而旧实现读的是 `price.input_cache_read` 这类**绝对价**键名 —— 上游从不返回它们，
 * 于是恒为 NaN 再回落到 1，等于把「一折读缓存」按原价计费。
 *
 * 这里直接测归一函数与目录构造，不经 fetch：
 * 走网络那条路要穿过 undici mock、模块级定价缓存与并发调度，在共享 worker 下不组乙。
 */

function catalogOf(available: unknown, groups: unknown = { default: 1 }) {
  const data = normalizeOneHubPricingPayload({ data: available }, { data: groups });
  if (!data) throw new Error('归一失败：检查载荷形状');
  return buildModelPricingCatalogFromData(data);
}

describe('one-hub 定价字段映射', () => {
  it('token 型走直采价，不再恒显示 $2/M（T2.1）', () => {
    const catalog = catalogOf({
      'gpt-4o': { groups: ['default'], price: { type: 'tokens', input: 2.5, output: 10 } },
    });
    const pricing = catalog.models.find((m) => m.modelName === 'gpt-4o')!.groupPricing.default!;

    // 旧实现：model_ratio 合成成 1 → 恒得 1×2×1 = 2 USD/M，与真实价无关
    expect(pricing.inputPerMillion).toBe(2.5);
    expect(pricing.outputPerMillion).toBe(10);
    expect(pricing.evidence?.source).toBe('upstream-direct-price');
    expect(pricing.evidence?.precision).toBe('exact');
  });

  it('completion_ratio 用 output/input，input 为 0 时不除零（T2.1）', () => {
    const catalog = catalogOf({
      'ratio-model': { groups: ['default'], price: { type: 'tokens', input: 2, output: 8 } },
      'zero-input-model': { groups: ['default'], price: { type: 'tokens', input: 0, output: 0 } },
    });

    expect(catalog.models.find((m) => m.modelName === 'ratio-model')!.groupPricing.default!.outputPerMillion).toBe(8);

    // 直采价全 0 → 不满足"至少一侧为正"，退回倍率口径；关键是不得抛错或产出 NaN
    const zero = catalog.models.find((m) => m.modelName === 'zero-input-model')!.groupPricing.default!;
    expect(Number.isFinite(zero.inputPerMillion ?? 0)).toBe(true);
  });

  it('extra_ratios 的缓存倍率按相对值生效（T2.2 / A7）', () => {
    const catalog = catalogOf({
      'claude-x': {
        groups: ['default'],
        price: {
          type: 'tokens',
          input: 3,
          output: 15,
          extra_ratios: { cached_read_tokens: 0.1, cached_write_tokens: 1.25 },
        },
      },
    });
    const pricing = catalog.models.find((m) => m.modelName === 'claude-x')!.groupPricing.default!;

    // 缓存读 = 输入价 × 0.1；写 = 输入价 × 1.25
    expect(pricing.cacheReadPerMillion).toBeCloseTo(0.3, 10);
    expect(pricing.cacheCreationPerMillion).toBeCloseTo(3.75, 10);
  });

  it('缺省 extra_ratios 时用 hub 同款默认值，而不是 1（T2.2）', () => {
    const catalog = catalogOf({
      'no-extra': { groups: ['default'], price: { type: 'tokens', input: 4, output: 4 } },
    });
    const pricing = catalog.models.find((m) => m.modelName === 'no-extra')!.groupPricing.default!;

    // 默认读缓存 0.1 → 4×0.1=0.4；默认写缓存 1.25 → 4×1.25=5
    expect(pricing.cacheReadPerMillion).toBeCloseTo(0.4, 10);
    expect(pricing.cacheCreationPerMillion).toBeCloseTo(5, 10);
  });

  it('times 型按 price.input × 0.002 计价（T2.6）', () => {
    const catalog = catalogOf({
      'per-call-model': { groups: ['default'], price: { type: 'times', input: 20, output: 20 } },
    });
    const entry = catalog.models.find((m) => m.modelName === 'per-call-model')!;

    expect(entry.quotaType).toBe(1);
    expect(entry.groupPricing.default!.perCallInput).toBeCloseTo(0.04, 10);
    expect(entry.groupPricing.default!.evidence?.source).toBe('upstream-per-call');
  });

  it('分组倍率会乘到直采价上（扁平形态 {vip:0.5}）', () => {
    const catalog = catalogOf(
      { 'vip-model': { groups: ['vip'], price: { type: 'tokens', input: 2, output: 6 } } },
      { default: 1, vip: 0.5 },
    );
    expect(catalog.groupRatio.vip).toBe(0.5);

    const pricing = catalog.models.find((m) => m.modelName === 'vip-model')!.groupPricing.vip!;
    expect(pricing.inputPerMillion).toBe(1);
    expect(pricing.outputPerMillion).toBe(3);
  });

  it('也吃下嵌套形态 {vip:{name,ratio}}（hub 走的那一支）', () => {
    const catalog = catalogOf(
      { 'vip-model': { groups: ['vip'], price: { type: 'tokens', input: 2, output: 6 } } },
      { default: { name: 'Default', ratio: 1 }, vip: { name: 'VIP', ratio: 0.5 } },
    );
    expect(catalog.groupRatio.vip).toBe(0.5);
    expect(catalog.models.find((m) => m.modelName === 'vip-model')!.groupPricing.vip!.inputPerMillion).toBe(1);
  });

  it('分组表结构不认识时退回 1 倍而不是 NaN/0', () => {
    const catalog = catalogOf(
      { x: { groups: ['default'], price: { type: 'tokens', input: 2, output: 2 } } },
      { weird: { nope: true } },
    );
    expect(catalog.groupRatio.weird).toBe(1);
    expect(Number.isFinite(catalog.groupRatio.weird)).toBe(true);
  });

  it('groups 缺省时档位为空，不伪造 default（2026-11-09 修正）', () => {
    const catalog = catalogOf({
      'no-groups': { price: { type: 'tokens', input: 1, output: 2 } },
    });
    const entry = catalog.models.find((m) => m.modelName === 'no-groups')!;
    // 与 new-api 家族同判据：未声明分组就不出档，避免拿 default 倍率凭空定价。
    expect(entry.enableGroups).toEqual([]);
    expect(Object.keys(entry.groupPricing)).toEqual([]);
  });

  it('显式声明 groups 的模型正常出该分组档', () => {
    const catalog = catalogOf({
      'with-groups': { groups: ['vip'], price: { type: 'tokens', input: 2, output: 6 } },
    }, { default: 1, vip: 0.5 });
    const entry = catalog.models.find((m) => m.modelName === 'with-groups')!;
    expect(Object.keys(entry.groupPricing)).toEqual(['vip']);
    expect(entry.groupPricing.vip!.inputPerMillion).toBe(1);
  });
});
