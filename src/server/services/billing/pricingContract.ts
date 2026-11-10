/**
 * 价格证据与计费模式的共享契约（S2 + S5a）。
 *
 * 本模块只做类型与纯判定，不做任何网络读取，因此可以被服务层、路由层、
 * 前端展示层共同引用而不产生循环依赖。
 *
 * 存在理由（A1 取证结论）：上游 New API 已把多数模型的定价迁入
 * `billing_mode: "tiered_expr"` + `billing_expr`，此时 `model_ratio` 是
 * **未同步更新的历史残留字段**。旧实现无条件拿 `model_ratio × 2` 当真实价，
 * 于是把一个已经不再作数的数字以"确定的官方价"口吻显示出来（75/75 USD/1M）。
 *
 * 诚实性要求：只要价格是「从失效字段推算」得来的，就必须带上 precision 标记，
 * 让下游能够区分「知道是多少」「大概是多少」「不知道」。
 */

/** 上游声明的计费模式。缺省按 token 倍率计费处理。 */
export type BillingMode = 'token' | 'tiered_expr';

/** 归一化上游 `billing_mode` 字段；无法识别的值一律退回 token 口径。 */
export function normalizeBillingMode(raw: unknown): BillingMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === 'tiered_expr' ? 'tiered_expr' : 'token';
}

/**
 * 价格证据的来源类别。
 * - upstream-ratio        —— 由 model_ratio × 标尺换算得到
 * - upstream-direct-price —— 上游直接给出的每百万单价
 * - upstream-per-call     —— 按次计费
 * - derived-from-stale-field —— 见文件头说明：ratio 在 tiered_expr 下已失效
 * - estimated-fallback    —— 拿不到任何价格时的粗估兜底
 * - unavailable           —— 明确不可得，不得伪造数值
 */
export type PriceEvidenceSource =
  | 'upstream-ratio'
  /** 由 billing_expr 解析出的每百万单价（S5c）：上游真正执行的价，可信。 */
  | 'upstream-dynamic-expr'
  | 'upstream-direct-price'
  | 'upstream-per-call'
  | 'derived-from-stale-field'
  | 'estimated-fallback'
  | 'unavailable';

/**
 * 精度等级。
 * exact      —— 上游权威数值，可直接展示
 * approximate—— 经过换算或推算，展示需带约等号语义
 * unknown    —— 不可得，展示层必须显式说"未知"，禁止输出 0
 */
export type PricePrecision = 'exact' | 'approximate' | 'unknown';

/** 价格不可得的原因码，供 UI 给出可操作的提示。 */
export type PriceUnavailableReason =
  | 'pricing-endpoint-unreachable'
  | 'model-not-in-catalog'
  | 'ratio-missing'
  | 'group-unavailable'
  | 'dynamic-billing-unparsed'
  | 'legacy-estimate';

export interface PriceEvidence {
  source: PriceEvidenceSource;
  precision: PricePrecision;
  /** precision 为 unknown 时必填，说明为什么不知道。 */
  reason?: PriceUnavailableReason;
  /** 证据采集时间（毫秒时间戳），用于判断是否过期。 */
  capturedAt: number;
}

/** 未知价格的统一构造入口，避免各处手拼对象导致字段漂移。 */
export function unknownPriceEvidence(
  reason: PriceUnavailableReason,
  capturedAt: number = Date.now(),
): PriceEvidence {
  return { source: 'unavailable', precision: 'unknown', reason, capturedAt };
}

/** 已知价格的统一构造入口，按来源给定默认精度。 */
export function knownPriceEvidence(
  source: Exclude<PriceEvidenceSource, 'unavailable'>,
  capturedAt: number = Date.now(),
): PriceEvidence {
  // 精度判据：上游直接给出的数值口径一律 exact；
  // 只有「拿失效字段推算」和「粗估兜底」才是 approximate。
  // 注：upstream-ratio 在 token 计费下就是上游权威价，虽然经过 ×标尺 换算，
  // 但换算本身是精确算术，不应降级为近似，否则 UI 会误报不确定性。
  const precision: PricePrecision = (
    source === 'derived-from-stale-field' || source === 'estimated-fallback'
  ) ? 'approximate' : 'exact';
  return { source, precision, capturedAt };
}

/**
 * 分组可达性四态（R8/R9 决议）。
 * - authoritative          —— 上游明确列出该分组且模型可用
 * - compatible-priced-fallback —— 分组本身未知，但价格口径兼容，可借用
 * - unknown                —— 确实不知道，必须诚实标注
 * - not-applicable         —— 该站点无分组概念
 */
export type GroupAccess =
  | 'authoritative'
  | 'compatible-priced-fallback'
  | 'unknown'
  | 'not-applicable';

/**
 * 判定某模型在某分组下的价格可信度。
 *
 * 这是 S2 的核心规则：**只要计费模式是 tiered_expr，静态 ratio 就不再是权威价**，
 * 因为表达式里的系数才是上游真正执行的单价。此处不做解析（那是 S5b/S5c），
 * 只负责把"我拿到的数其实不作数"这件事标记出来。
 */
export function resolveTokenPriceEvidence(input: {
  billingMode: BillingMode;
  /** 上游是否给了可用的 model_ratio（缺失或非法视为 false）。 */
  hasModelRatio: boolean;
  capturedAt?: number;
}): PriceEvidence {
  const capturedAt = input.capturedAt ?? Date.now();

  if (!input.hasModelRatio) {
    return unknownPriceEvidence('ratio-missing', capturedAt);
  }

  if (input.billingMode === 'tiered_expr') {
    // 字段存在但已失效：不伪造为精确价，也不武断地说完全不知道 ——
    // 用 approximate + stale 来源，让 UI 可以显示"参考值（动态计费未解析）"。
    return {
      source: 'derived-from-stale-field',
      precision: 'approximate',
      capturedAt,
    };
  }

  return knownPriceEvidence('upstream-ratio', capturedAt);
}
