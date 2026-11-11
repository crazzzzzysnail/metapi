import { formatPrice, formatPricePair } from '../../numberFormat.js';

/**
 * 模型分组价格的前端展示口径（S2 / T1.28）。
 *
 * 三条硬规则：
 *   ① 「没有价格依据」绝不渲染成 $0 —— 那会被读成"这个模型免费"；
 *   ② 来自失效字段的价格要降级为参考值，并说明原因；
 *   ③ 动态计费在解析器接入前，如实说"未解析"而不是给一个错数。
 */

export type PricePrecisionPresentation = 'exact' | 'approximate' | 'unknown';

export interface PriceEvidencePresentation {
  source?: string;
  precision?: PricePrecisionPresentation;
  reason?: string;
}

/** 多档动态计费的一档（二-3）。后端 DynamicTierPrice 的前端镜像。 */
export interface PricingTierPresentation {
  name: string;
  input: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  /** 适用条件的人话描述，例如 `≤272K`、`周一至周五 09:00-12:00 / 14:00-18:00`。 */
  condition?: string | null;
}

export interface ModelGroupPricingPresentation {
  quotaType: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheCreationPerMillion?: number;
  perCallInput?: number;
  perCallOutput?: number;
  perCallTotal?: number;
  /** 多档动态计费的全部档位（二-3）。只有 len/时间分档的表达式才有。 */
  tiers?: PricingTierPresentation[];
  evidence?: PriceEvidencePresentation;
  billingMode?: string;
  billingExpr?: string | null;
}

/** 不可得原因 → 人话。未收录的原因码退回通用文案，不崩。 */
const REASON_LABELS: Record<string, string> = {
  'pricing-endpoint-unreachable': '定价接口不可达',
  'model-not-in-catalog': '目录中无此模型',
  'ratio-missing': '上游未提供倍率',
  'group-unavailable': '分组倍率未知',
  'dynamic-billing-unparsed': '动态计费未解析',
  'legacy-estimate': '历史估算值',
};

export function describePriceReason(reason?: string): string {
  if (!reason) return '价格未知';
  return REASON_LABELS[reason] || reason;
}

/** 该分组价格是否可信到可以直接当"官方价"展示。
 *  动态计费表达式解析出来的单价同样是权威价（S5c）。 */
export function isAuthoritativePricing(pricing: ModelGroupPricingPresentation): boolean {
  const precision = pricing.evidence?.precision;
  if (precision === undefined) return true;
  return precision === 'exact';
}

/** 是否存在可用于展示的数值（token 或按次任一有值）。 */
function hasDisplayableNumbers(pricing: ModelGroupPricingPresentation): boolean {
  if (pricing.quotaType === 0) {
    return pricing.inputPerMillion != null || pricing.outputPerMillion != null;
  }
  return pricing.perCallInput != null
    || pricing.perCallOutput != null
    || pricing.perCallTotal != null;
}

/**
 * 多档计费的逐档渲染（二-3）。
 *
 * 过去多档只报第一档的"代表价"，于是：
 *   - 峰谷模型（sample-model-cal）在谷段被扣 0.4 却显示 0.8；
 *   - 长短上下文模型（sample-model-len）跨过 272K 后价格翻倍，界面上完全看不出来。
 * 这里把每一档连同档位名一起列出，用户能直接对上自己被扣的是哪一档。
 *
 * 输出形态统一为 `$0.8/$3.2 / 1M（peak） ｜ $0.4/$1.6 / 1M（off_peak）`
 * —— 每个数字都带币种符号、单位前一个空格，与人民币口径同形。
 *
 * @param compact 精简模式（路由通道卡片用，三-3）：只列档位名不带条件长串，
 *                完整条件留给悬停详情，避免一行撑不下被截断。
 * @param firstTierOnly 只渲染首档代表价（一）：多档全文在窄卡片里必然截断，
 *                其余档位由调用方在悬停里逐条列出。
 */
function renderTierTable(
  tiers: PricingTierPresentation[],
  siteId?: number,
  convert?: (siteId: number, usd: number | undefined) => string | null,
  compact = false,
  firstTierOnly = false,
): string {
  const parts: string[] = [];
  // 一：路由通道正文放不下多档，只渲染首档（代表价），其余留给悬停逐条列出。
  const shown = firstTierOnly ? tiers.slice(0, 1) : tiers;
  for (const tier of shown) {
    const money = (usd: number | undefined): string | null => {
      if (usd == null) return null;
      if (convert && siteId != null) return convert(siteId, usd);
      // 没有 convert 时也要带符号：否则路由通道显示 `0.8/3.2`，
      // 与模型广场的 `$0.8/$3.2` 不同形（四-4）。
      return formatPrice(usd);
    };
    const input = money(tier.input);
    // 汇率未知：整表都不能给数，否则等于用一个可信的数字掩盖另一部分不可信。
    if (input === null) return '汇率未知';
    const output = money(tier.output);
    const price = output !== null ? `${input}/${output}` : input;
    // 精简模式只保留档位名；完整条件走 title 悬停（三-3）。
    const label = compact
      ? String(tier.name || '')
      : [tier.name, tier.condition].filter(Boolean).join(' · ');
    parts.push(label ? `${price} / 1M（${label}）` : `${price} / 1M`);
  }
  return parts.join(compact ? ' ｜ ' : ' ｜ ');
}

/**
 * 多档计费的悬停详情（三-3）：把精简行省掉的适用条件补回来。
 * 返回 null 表示不是多档模型，调用方不必挂 title。
 */
export function describeTierDetails(pricing: ModelGroupPricingPresentation): string | null {
  const tiers = pricing.tiers;
  if (!tiers || tiers.length === 0) return null;
  return tiers
    .map((tier) => {
      const price = formatPricePair(tier.input, tier.output, 'perMillion');
      return `${tier.name}${tier.condition ? `（${tier.condition}）` : ''}：${price}`;
    })
    .join('；');
}

/**
 * 渲染分组价格文本。
 *
 * @param pricing   目录里的分组价（美元口径）
 * @param siteId    所属站点；CNY 模式下按该站点汇率换算，USD 模式可不传
 * @param convert   换算回调：返回 null 表示该站点汇率未知，必须显式标注而不是显示美元数
 */
export function renderGroupPricingValue(
  pricing: ModelGroupPricingPresentation,
  siteId?: number,
  convert?: (siteId: number, usd: number | undefined) => string | null,
  options?: { compact?: boolean; firstTierOnly?: boolean },
): string {
  const compact = options?.compact === true;
  const firstTierOnly = options?.firstTierOnly === true;

  // ① 未知优先于一切数值判断：缺价时后端不会给出 xxxPerMillion，
  //    但仍要防住"有数却被判为未知"的组合。
  if (pricing.evidence?.precision === 'unknown') {
    return `未知 · ${describePriceReason(pricing.evidence.reason)}`;
  }

  if (!hasDisplayableNumbers(pricing)) {
    return `未知 · ${describePriceReason(pricing.evidence?.reason)}`;
  }

  // ② 多档优先：有 tiers 就必须逐档列出，不能退化成只报代表价（二-3）。
  if (pricing.tiers && pricing.tiers.length > 0) {
    return renderTierTable(pricing.tiers, siteId, convert, compact, firstTierOnly);
  }

  // S6 / T8.7：非美元口径下逐站换算；汇率未知的站点明确标注，不显示美元数字冒充人民币。
  if (convert && siteId != null) {
    const convertedInput = convert(siteId, pricing.quotaType === 0 ? pricing.inputPerMillion : pricing.perCallTotal ?? pricing.perCallInput);
    if (convertedInput === null) {
      return '汇率未知';
    }
    // 换算成功时以换算串为主、保留倍率关系描述
    if (pricing.quotaType === 0) {
      const convertedOutput = convert(siteId, pricing.outputPerMillion);
      return `${convertedInput}${convertedOutput !== null ? `/${convertedOutput}` : ''} / 1M`;
    }
    return `${convertedInput} / call`;
  }

  // 四-4：没有 convert 的调用方（路由通道卡片）过去拼成 `0.8/3.2 USD /1M`，
  // 与模型广场的 `$0.8/$3.2 / 1M` 不同形。现在统一走带符号的成对出口。
  const value = pricing.quotaType === 0
    ? formatPricePair(pricing.inputPerMillion, pricing.outputPerMillion, 'perMillion')
    : (pricing.perCallInput != null || pricing.perCallOutput != null)
      ? formatPricePair(pricing.perCallInput, pricing.perCallOutput, 'perCall')
      : formatPricePair(pricing.perCallTotal, undefined, 'perCall');

  // ③ 失效字段推算的要标"参考"。其余口径（上游倍率、直采价、已解析的动态计费表达式）
  //    都是上游实际执行的单价，直接显示 —— S5c 后动态计费不再降级。
  if (pricing.evidence?.source === 'derived-from-stale-field') {
    return pricing.billingMode === 'tiered_expr'
      ? `参考 ${value} · 动态计费未解析`
      : `参考 ${value} · 来自过期倍率`;
  }

  return value;
}

/**
 * 分组档位名的展示形式（T4.4）。
 * `auto:grp-daily` → "auto→grp-daily"，让链路与普通分组一眼可分。
 */
export function formatAutoTierLabel(group: string): string {
  if (!group.startsWith('auto:')) return group;
  return `auto→${group.slice('auto:'.length)}`;
}

/** 供 title/hover 使用的完整说明。 */export function describeGroupPricing(pricing: ModelGroupPricingPresentation): string {
  const main = renderGroupPricingValue(pricing);
  const parts = [main];
  // 二-3：多档模型在悬停里补全每档的适用条件与缓存价，正文只放输入/输出避免过长。
  const tierDetails = describeTierDetails(pricing);
  if (tierDetails) parts.push(tierDetails);
  if (pricing.tiers && pricing.tiers.length > 0) {
    for (const tier of pricing.tiers) {
      if (tier.cacheRead == null) continue;
      parts.push(`${tier.name || '档位'}：缓存读 ${formatPrice(tier.cacheRead)} / 1M`);
    }
  }
  if (pricing.evidence?.source) parts.push(`来源：${pricing.evidence.source}`);
  if (pricing.evidence?.precision) parts.push(`精度：${pricing.evidence.precision}`);
  if (pricing.billingExpr) parts.push(`表达式：${pricing.billingExpr}`);
  return parts.join(' ｜ ');
}
