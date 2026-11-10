import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildModelPricingCatalogFromData,
  normalizeCommonPricingPayload,
} from './modelPricingService.js';

/**
 * auto 分组与档位归属（T4.4 / T4.5）。
 *
 * ⚠️ 本文件在 2026-11-09 被整体重写。旧版断言的是**实现推算出来的价格**，
 * 而用户实测证明那些推算全部错误：
 *   - siteB `group_ratio.default = 2`，且 sample-model-cal **不挂 default**
 *     （实际 enable_groups = [组乙, 组甲]），旧实现却给它一条 ×2 的 default 档；
 *   - siteA 28 个模型里 0 个显式含 default，旧实现给每个都造了一条；
 *   - `auto_groups = [grp-daily, grp-perf]` 是**站点默认链路**，
 *     某 apikey 实际配的是 grp-codex → grp-codex-pro → 组丁-chs，
 *     且 grp-daily/grp-perf 下根本没有 sample-model-cal 的计费信息。
 *
 * 因此现在锁定的契约是**反向的**：不允许出现任何未经上游声明的档位。
 */

const siteA = JSON.parse(
  readFileSync(new URL('./__fixtures__/siteA-tiered-pricing.json', import.meta.url), 'utf8'),
);
const siteB = JSON.parse(
  readFileSync(new URL('./__fixtures__/siteB-tiered-pricing.json', import.meta.url), 'utf8'),
);

function buildCatalog(raw: unknown) {
  const data = normalizeCommonPricingPayload(raw);
  if (!data) throw new Error('归一失败');
  return buildModelPricingCatalogFromData(data);
}

describe('档位必须严格等于模型声明的分组', () => {
  it('siteA sample-model-cal 只有 组丁-chs 一档，不含 default、不含 auto:*', () => {
    const catalog = buildCatalog(siteA);
    const entry = catalog.models.find((m) => m.modelName === 'sample-model-cal')!;
    expect(entry).toBeDefined();

    expect(Object.keys(entry.groupPricing).sort()).toEqual(['组丁-chs']);
    expect(entry.groupPricing.default).toBeUndefined();
    expect(entry.groupPricing['auto:grp-daily']).toBeUndefined();
    expect(entry.groupPricing['auto:grp-perf']).toBeUndefined();
  });

  it('siteA sample-model-len 只出它自己声明的 codex 系分组', () => {
    const catalog = buildCatalog(siteA);
    const entry = catalog.models.find((m) => m.modelName === 'sample-model-len')!;
    const declared = siteA.data.find((x: any) => x.model_name === 'sample-model-len').enable_groups;

    expect(Object.keys(entry.groupPricing).sort()).toEqual([...declared].sort());
  });

  it('siteB sample-model-cal 只有 组乙/组甲（×1），绝不出现 ×2 的 default 档', () => {
    const catalog = buildCatalog(siteB);
    const entry = catalog.models.find((m) => m.modelName === 'sample-model-cal')!;

    // 上游 group_ratio.default = 2，若误并入就会把 0.3 报成 0.6
    expect(entry.groupPricing.default).toBeUndefined();
    expect(Object.keys(entry.groupPricing).sort()).toEqual(['组甲', '组乙'].sort());
    for (const tier of Object.values(entry.groupPricing)) {
      // 组乙/组甲倍率均为 1 → 就是表达式基础价本身（峰档 p*0.3）
      expect(tier.inputPerMillion).toBe(0.3);
    }
  });

  it('全站没有任何 auto:* 形式的推算档', () => {
    for (const raw of [siteA, siteB]) {
      const catalog = buildCatalog(raw);
      const leaked = catalog.models.filter((m) =>
        Object.keys(m.groupPricing).some((group) => group.startsWith('auto:') || group === 'auto'));
      expect(leaked.map((m) => m.modelName)).toEqual([]);
    }
  });

  it('显式挂 default 的模型仍正常出 default 档（不能矫枉过正）', () => {
    const catalog = buildCatalog(siteB);
    // siteB 有 2 个模型 enable_groups 含 default
    const withDefault = catalog.models.filter((m) => m.groupPricing.default);
    expect(withDefault.length).toBeGreaterThan(0);
    for (const entry of withDefault) {
      expect(entry.enableGroups).toContain('default');
    }
  });
});

describe('auto_groups 只透传，不参与定价', () => {
  it('siteA 原样给出站点默认链路名单', () => {
    const catalog = buildCatalog(siteA);
    expect(catalog.autoGroups).toEqual(['grp-daily', 'grp-perf']);
  });

  it('siteB 的 default 聚合入口也原样保留', () => {
    const catalog = buildCatalog(siteB);
    expect(catalog.autoGroups).toEqual(['default']);
  });

  it('非法项剔除、缺失视为空数组', () => {
    expect(buildCatalog({ ...siteA, auto_groups: ['grp-daily', '', null, 123] }).autoGroups)
      .toEqual(['grp-daily', '123']);
    for (const value of [undefined, null, 'grp-daily', {}]) {
      expect(buildCatalog({ ...siteA, auto_groups: value }).autoGroups ?? []).toEqual([]);
    }
  });

  it('auto_groups 存在但模型未挂这些分组时，不会凭空长出对应档', () => {
    const catalog = buildCatalog({
      ...siteB,
      auto_groups: ['grp-daily', 'grp-perf'],
    });
    const entry = catalog.models.find((m) => m.modelName === 'sample-model-cal')!;
    expect(Object.keys(entry.groupPricing).sort()).toEqual(['组甲', '组乙'].sort());
  });
});

describe('分组缺倍率时报未知，不借 default 的倍率', () => {
  it('siteB 场景：模型挂了 group_ratio 里没有的分组 → 该档标未知', () => {
    const catalog = buildCatalog({
      ...siteB,
      data: siteB.data.map((m: any) => m.model_name === 'sample-model-cal'
        ? { ...m, enable_groups: ['不存在组'] }
        : m),
    });
    const entry = catalog.models.find((m) => m.modelName === 'sample-model-cal')!;
    const tier = entry.groupPricing['不存在组'];
    expect(tier).toBeDefined();
    expect(tier.evidence?.precision).toBe('unknown');
    expect(tier.evidence?.reason).toBe('group-unavailable');
    // 关键：没有被 default 的 ×2 污染
    expect(tier.inputPerMillion).toBeUndefined();
  });

  it('分组倍率为 0 是合法值（免费分组），按 0 计而非退回 default', () => {
    const catalog = buildCatalog({
      ...siteB,
      group_ratio: { ...siteB.group_ratio, 免费组: 0 },
      data: siteB.data.map((m: any) => m.model_name === 'sample-model-cal'
        ? { ...m, enable_groups: ['免费组'] }
        : m),
    });
    const tier = catalog.models.find((m) => m.modelName === 'sample-model-cal')!.groupPricing['免费组']!;
    expect(tier.inputPerMillion).toBe(0);
    expect(tier.evidence?.precision).toBe('exact');
  });

  it('完全没有 enable_groups 时档位为空对象，不猜 default', () => {
    const catalog = buildCatalog({
      ...siteB,
      data: [{
        model_name: 'no-groups',
        quota_type: 0,
        model_ratio: 1,
        completion_ratio: 1,
        model_price: 0,
      }],
    });
    const entry = catalog.models.find((m) => m.modelName === 'no-groups')!;
    expect(Object.keys(entry.groupPricing)).toEqual([]);
  });
});
