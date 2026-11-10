import { describe, expect, it } from 'vitest';
import {
  buildModelPricingCatalogFromData,
  normalizeCommonPricingPayload,
} from './modelPricingService.js';
import { readFileSync } from 'node:fs';

/**
 * A1 取证回归（S2 + S5a）。
 *
 * fixture 为真实上游 `/api/pricing` 载荷（已去除版本指纹），
 * 其关键事实：目标模型 model_ratio=37.5、billing_mode=tiered_expr、
 * billing_expr 声明的真实单价为 p*1+c*1。旧实现据此算出并展示 `75/75 USD/1M`，
 * 而 37.5 是上游迁移到动态计费后未同步清理的历史残留值。
 *
 * 本文件锁定两件事：
 *   ① 该站点的价格必须被标为「来自失效字段」，不得继续以精确价口径展示；
 *   ② 表达式原文要透传到目录，供后续 S5b/S5c 解析与人工排查。
 *
 * 全部走纯函数，不经 fetch —— 早先用 undici mock + 模块级定价缓存的写法
 * 在共享 worker 下会串味（同批次其它文件也 mock undici），表现为随机 null。
 */

const payload = JSON.parse(
  readFileSync(new URL('./__fixtures__/siteC-tiered-pricing.json', import.meta.url), 'utf8'),
);
const TARGET_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';

function catalogOf(raw: unknown = payload) {
  const data = normalizeCommonPricingPayload(raw);
  if (!data) throw new Error('归一失败：检查载荷形状');
  return buildModelPricingCatalogFromData(data);
}

function pricingOf(modelName: string, raw: unknown = payload) {
  const entry = catalogOf(raw).models.find((m) => m.modelName === modelName);
  if (!entry) throw new Error(`目录中缺少模型 ${modelName}`);
  return { entry, pricing: entry.groupPricing.default! };
}

describe('siteC tiered_expr 定价可信度', () => {
  it('S5c 后以表达式为准：75/75 变成真实的 1/1', () => {
    const { pricing } = pricingOf(TARGET_MODEL);

    // 历史缺陷：37.5 × 2 × groupRatio(1) = 75，读的是失效的 model_ratio。
    // 现在 billing_expr `tier("base", p * 1 + c * 1)` 被解析并优先采用。
    expect(pricing.inputPerMillion).toBe(1);
    expect(pricing.outputPerMillion).toBe(1);
    // 反向锁定：绝不能再回到 75
    expect(pricing.inputPerMillion).not.toBe(75);
  });

  it('解析成功的档位标为精确的动态计费价', () => {
    const { entry, pricing } = pricingOf(TARGET_MODEL);

    expect(entry.billingMode).toBe('tiered_expr');
    expect(pricing.billingMode).toBe('tiered_expr');
    expect(pricing.evidence?.source).toBe('upstream-dynamic-expr');
    // 表达式就是上游实际执行的单价，因此是 exact 而非 approximate
    expect(pricing.evidence?.precision).toBe('exact');
  });

  it('解析不出来时才退回失效字段并降级为 approximate', () => {
    const raw = JSON.parse(JSON.stringify(payload));
    const target = raw.data.find((m: any) => m.model_name === TARGET_MODEL);
    // 换成当前白名单外的形态（多档 + len 条件）
    target.billing_expr = 'v1:len <= 200000 ? tier("standard", p * 3 + c * 15) : tier("long_context", p * 6 + c * 22.5)';

    const { pricing } = pricingOf(TARGET_MODEL, raw);

    expect(pricing.evidence?.source).toBe('derived-from-stale-field');
    expect(pricing.evidence?.precision).toBe('approximate');
    // 退回失效字段的旧算式，数值仍是 75 —— 这是"知道它不可信但仍给个参照"的折中
    expect(pricing.inputPerMillion).toBe(75);
  });

  it('表达式原文要透传，供解析与排查', () => {
    const { pricing } = pricingOf(TARGET_MODEL);
    expect(pricing.billingExpr).toBe('tier("base", p * 1 + c * 1)');
  });

  it('普通 token 模型仍是精确价，不受 tiered_expr 判定牵连', () => {
    // zai-org/GLM-5.2：ratio 0.5、无 billing_mode → 传统 token 计费
    const { entry, pricing } = pricingOf('zai-org/GLM-5.2');

    expect(entry.billingMode ?? 'token').toBe('token');
    expect(pricing.evidence?.source).toBe('upstream-ratio');
    expect(pricing.evidence?.precision).toBe('exact');
    expect(pricing.inputPerMillion).toBe(1);
  });

  it('表达式可解析时，缺 model_ratio 也能定价（表达式才是权威）', () => {
    const stripped = JSON.parse(JSON.stringify(payload));
    const target = stripped.data.find((m: any) => m.model_name === TARGET_MODEL);
    delete target.model_ratio;

    const { pricing } = pricingOf(TARGET_MODEL, stripped);

    // S5c 之后：`tier("base", p * 1 + c * 1)` 足够定出单价，不再依赖失效倍率
    expect(pricing.evidence?.source).toBe('upstream-dynamic-expr');
    expect(pricing.inputPerMillion).toBe(1);
    expect(pricing.outputPerMillion).toBe(1);
  });

  it('表达式解析不出来且缺 model_ratio 时标未知，不输出 $0 冒充免费', () => {
    const stripped = JSON.parse(JSON.stringify(payload));
    const target = stripped.data.find((m: any) => m.model_name === TARGET_MODEL);
    delete target.model_ratio;
    // 换成白名单外的多档形态 → 无口径可用
    target.billing_expr = 'v1:len <= 200000 ? tier("standard", p * 3) : tier("long", p * 6)';

    const { pricing } = pricingOf(TARGET_MODEL, stripped);

    expect(pricing.evidence?.precision).toBe('unknown');
    // 该模型是 tiered_expr，所以更准确的成因是"动态计费未解析"而非单纯缺字段。
    expect(pricing.evidence?.reason).toBe('dynamic-billing-unparsed');
    // 关键是不产出任何伪价
    expect(pricing.inputPerMillion).toBeUndefined();
    expect(pricing.outputPerMillion).toBeUndefined();
  });

  it('普通 token 模型缺失 model_ratio 时 reason 为 ratio-missing', () => {
    const stripped = JSON.parse(JSON.stringify(payload));
    const target = stripped.data.find((m: any) => m.model_name === 'zai-org/GLM-5.2');
    delete target.model_ratio;

    const { pricing } = pricingOf('zai-org/GLM-5.2', stripped);

    expect(pricing.evidence?.precision).toBe('unknown');
    expect(pricing.evidence?.reason).toBe('ratio-missing');
  });

  it('真实 ratio=0 的免费模型保持 0，不回退成 1（T1.18 / D3）', () => {
    // 本 fixture 里 ratio=0 的三个模型都是 quota_type=1（按次计费），
    // 覆盖不到「token 计费 + 0 倍率」这一形态，因此另造一条最小载荷。
    const freePayload = {
      success: true,
      group_ratio: { default: 1 },
      data: [{
        model_name: 'free/tiered-model',
        quota_type: 0,
        model_ratio: 0,
        completion_ratio: 0,
        model_price: 0,
        enable_groups: ['default'],
      }],
    };

    const { pricing } = pricingOf('free/tiered-model', freePayload);

    expect(pricing.inputPerMillion).toBe(0);
    expect(pricing.outputPerMillion).toBe(0);
    // 字段确实给了 0 —— 这是"免费"语义，不是"未知"
    expect(pricing.evidence?.source).toBe('upstream-ratio');
    expect(pricing.evidence?.precision).toBe('exact');
  });

  it('fixture 中 quota_type=1 的模型走按次口径，不产出每百万单价', () => {
    const { entry, pricing } = pricingOf('openai/gpt-oss-20b');

    // 它没有 billing_mode、ratio=0、model_price=1 → 正确的按次计费形态
    expect(entry.quotaType).toBe(1);
    expect(pricing.perCallTotal).toBe(1);
    expect(pricing.evidence?.source).toBe('upstream-per-call');
    expect(pricing.evidence?.precision).toBe('exact');
  });

  it('全站 31 个模型里 19 个应被判为动态计费（覆盖面取证）', () => {
    const catalog = catalogOf();
    const tieredCount = catalog.models.filter((m) => m.billingMode === 'tiered_expr').length;
    expect(tieredCount).toBe(19);
    expect(catalog.models).toHaveLength(31);
  });
});
