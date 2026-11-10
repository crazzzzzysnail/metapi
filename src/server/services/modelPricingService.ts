import type { RequestInit as UndiciRequestInit } from 'undici';
import { withSiteProxyRequestInit } from './siteProxy.js';
import { ratioToUsdPerMillion, tokensToUsd } from './billing/quotaScale.js';
import type { BillingMeter, BillingTier, ParsedBillingPlanV2, TierCondition, TierRates } from './billing/billingPlanV2.js';
import { parseBillingExprV2, tierMatchesAt } from './billing/billingPlanV2.js';
import { isAutoGroupName } from './billing/groupNames.js';
import {
  knownPriceEvidence,
  normalizeBillingMode,
  unknownPriceEvidence,
  type BillingMode,
  type PriceEvidence,
  type PriceUnavailableReason,
} from './billing/pricingContract.js';
import {
  buildNewApiCookieCandidates,
  fetchJsonWithShieldCookieRetry,
} from './platforms/newApiShield.js';

const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;
const PRICE_CACHE_FAILURE_TTL_MS = 60 * 1000;
const PRICING_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_GROUP = 'default';
const ONE_HUB_PER_CALL_RATIO = 0.002;
// 注：原先这里有 MIN_ROUTING_REFERENCE_COST = 1e-6 作为路由参考价下限。
// 已移除 —— 对 0 价钳下限会让免费模型的 totalCost 变正，进而触发 N1 描述的
// "observed 接管用户 unitCost"问题。参考价现在如实保留 0。
const ROUTING_REFERENCE_USAGE = {
  promptTokens: 500_000,
  completionTokens: 500_000,
  totalTokens: 1_000_000,
};

export interface PricingModel {
  modelName: string;
  quotaType: number;
  modelRatio: number;
  completionRatio: number;
  cacheRatio?: number;
  cacheCreationRatio?: number;
  modelPrice: number | { input: number; output: number } | null;
  enableGroups: string[];
  modelDescription?: string | null;
  tags?: string[];
  supportedEndpointTypes?: string[];
  ownerBy?: string | null;
  /**
   * 上游声明的计费模式（S5a）。tiered_expr 时 `modelRatio` 不再作数，
   * 见 billing/pricingContract.ts 文件头的 A1 取证结论。
   */
  billingMode?: BillingMode;
  /** 表达式原文，本轮只保存不解析（解析属 S5b/S5c）。 */
  billingExpr?: string | null;
  /**
   * 上游厂商 ID（T3.1）。真实载荷确认存在（`vendor_id`），
   * 用于把同名模型归到同一厂商；hub 侧另有 `billing_usage_schema` /
   * `price_presentation`，但实测本类上游**并不返回**这两个字段，
   * 因此不预留假字段，等真出现再加。
   */
  vendorId?: number | null;
  /**
   * 上游是否真的提供了 model_ratio 字段。
   * false 时 `modelRatio` 的 0 只是占位值、并非"免费"语义，
   * 展示与统计都必须走 unknown 分支，不得输出 $0。
   */
  hasUpstreamRatio?: boolean;
}

/** 归一后的定价数据：模型表 + 分组倍率表 + auto 链路（T4.4）。 */
export interface PricingData {
  models: Map<string, PricingModel>;
  groupRatio: Record<string, number>;
  /**
   * auto 分组链路（S4 / T4.4）。
   *
   * 实测语义（2026-11-09 siteA）：令牌挂在 `auto` 分组上，实际请求由上游
   * 自动路由到 `auto_groups` 列出的下属分组（如 grp-daily / grp-perf）。
   * `/api/user/self/groups` 里 auto 的 ratio 是**字符串 "auto"**（不是数字），
   * 而 `/api/pricing.group_ratio.auto` 给的是 1 —— 两者都表达"auto 自身无独立倍率"。
   *
   * 因此本字段只做**透传与展示**：绝不推断 auto 的实际倍率（那取决于上游调度策略，
   * 猜一个数就是把不确定性强行包装成确定价格）。
   */
  autoGroups?: string[];
}

/**
 * self-log 提供的价格覆盖（D12 修复后）。
 *
 * 所有比率改为可选：只有上游**显式给出**的值才参与覆盖。
 * 旧版 `modelRatio: number` 强制调用方提供，中间层便以 1 填充，
 * 等于用一个未经声明的倍率绕开定价目录去记账。
 */
export interface ProxyBillingPricingOverride {
  modelRatio?: number;
  completionRatio?: number;
  cacheRatio?: number;
  cacheCreationRatio?: number;
  groupRatio?: number;
}

interface PricingCacheEntry {
  fetchedAt: number;
  ttlMs: number;
  data: PricingData | null;
}

interface RoutingReferenceCostCacheEntry {
  fetchedAt: number;
  ttlMs: number;
  costs: Map<string, number>;
}

export interface EstimateProxyCostInput {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
  modelName: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  promptTokensIncludeCache?: boolean | null;
  /**
   * 本次请求实际使用的令牌分组（三-3）。
   *
   * 不传时退回旧行为（取模型 enableGroups 里第一个有倍率的分组），
   * 那条路径在 siteA 上算错过：令牌挂 `auto`、模型声明
   * `[disc-codex, disc-codex-pro, grp-codex-pro, grp-codex]`，
   * 前两个没有倍率，于是选了 grp-codex-pro(×0.3)，而上游实际按
   * grp-codex(×0.15) 结算 —— 多算一倍。
   */
  tokenGroup?: string | null;
  /** 令牌的 auto 链路（上游 `/api/token/` 的 auto_groups），按上游命中顺序排列。 */
  autoGroups?: string[] | null;
  billingPricingOverride?: ProxyBillingPricingOverride | null;
}

export interface ModelGroupPricing {
  quotaType: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheCreationPerMillion?: number;
  perCallInput?: number;
  perCallOutput?: number;
  perCallTotal?: number;
  /**
   * 多档动态计费的**全部**档位（二-3）。
   * 只有 len/时间分档的表达式才有值；单档与非动态计费不填。
   * inputPerMillion 仍是第一档的代表价，用于路由参考价等单值场景。
   */
  tiers?: DynamicTierPrice[];
  /**
   * 这组数字的可信度（S2）。缺省视为 exact，兼容既有调用方。
   * tiered_expr 站点会拿到 derived-from-stale-field，展示层需降级为"参考值"。
   */
  evidence?: PriceEvidence;
  /** 上游计费模式原文所在档位（S5a）。 */
  billingMode?: BillingMode;
  /** 动态计费表达式原文；本轮只透传供排查，不参与计算。 */
  billingExpr?: string | null;
}

export interface ModelPricingCatalogEntry {
  modelName: string;
  quotaType: number;
  modelDescription: string | null;
  tags: string[];
  supportedEndpointTypes: string[];
  ownerBy: string | null;
  enableGroups: string[];
  groupPricing: Record<string, ModelGroupPricing>;
  /** 上游声明的计费模式（S5a）；tiered_expr 表示静态倍率已不作数。 */
  billingMode?: BillingMode;
  /** 上游厂商 ID（T3.1），用于同名模型归厂。 */
  vendorId?: number | null;
}

export interface ModelPricingCatalog {
  models: ModelPricingCatalogEntry[];
  groupRatio: Record<string, number>;
  /** auto 分组的下属链路（T4.4）。空数组表示该站点没有 auto 聚合分组。 */
  autoGroups?: string[];
  /**
   * 最近一次取价失败原因（T9.4）。null = 没有失败记录。
   *
   * 走 catalog 字段而不是独立导出一个查询函数，是有意的：
   * `tokens.channel-presentation.test.ts` 用完整工厂函数 mock 了整个 modelPricingService，
   * 新增具名导入会在**模块链接期**就失败（不是运行时），那种错误无法用 typeof 守卫规避。
   */
  lastFailureReason?: string | null;
}

export interface ProxyBillingDetails {
  quotaType: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    billablePromptTokens: number;
    promptTokensIncludeCache: boolean | null;
  };
  pricing: {
    modelRatio: number;
    completionRatio: number;
    cacheRatio: number;
    cacheCreationRatio: number;
    groupRatio: number;
    /**
     * 本次取价实际采用的口径（S2）。旧记录可能缺省，读取方需容错。
     * 'unavailable' 只可能来自历史落库记录：现行实现在拿不到价时不写 billing_details。
     */
    evidenceSource?: PriceEvidence['source'] | 'unavailable';
    /** 命中的动态计费档位名（T6.4）。仅 dynamic 口径存在。 */
    tierName?: string;
    /**
     * 本次计价实际采用的分组名（三-2）。
     * 没有它，日志里只有 groupRatio 数字，事后无法回答"这 0.15 是哪一档"。
     */
    groupName?: string | null;
  };
  breakdown: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion: number;
    cacheCreationPerMillion: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheCreationCost: number;
    totalCost: number;
  };
}

const pricingCache = new Map<string, PricingCacheEntry>();
const routingReferenceCostCache = new Map<string, RoutingReferenceCostCacheEntry>();

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function toPositiveInt(value: unknown): number {
  return Math.max(0, Math.round(toNumber(value, 0)));
}

function roundCost(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}

function normalizeModelPrice(value: unknown): number | { input: number; output: number } | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return null;

  const input = toNumber((value as any).input, Number.NaN);
  const output = toNumber((value as any).output, Number.NaN);
  if (Number.isNaN(input) && Number.isNaN(output)) return null;

  return {
    input: Number.isNaN(input) ? 0 : input,
    output: Number.isNaN(output) ? 0 : output,
  };
}

/**
 * 解析分组倍率表。
 *
 * T1.17：0 是合法倍率（免费分组），不得用 `ratio > 0` 丢弃。
 * 旧实现会把 `{vip: 0}` 整条抹掉，导致该分组查无此项、进而被其它分组的倍率顶替。
 */
function normalizeGroupRatio(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const ratio = toNumber(value, Number.NaN);
      if (Number.isFinite(ratio) && ratio >= 0) result[key] = ratio;
    }
  }

  // ⚠️ 2026-11-09：只在上游**完全没给分组倍率表**时才补一个 default=1；
  // 表存在但缺 default（siteA 正是如此）时**绝不注入**。
  // 旧写法无条件补 default，于是"模型挂了个 group_ratio 里没有的分组"会被
  // 后续逻辑当成"default 存在且为 1"，进而在 siteB(default=2) 上把未列分组按 ×2 计价。
  if (Object.keys(result).length === 0) {
    result[DEFAULT_GROUP] = 1;
  }

  return result;
}

function normalizeStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || '').trim()).filter(Boolean);
  }

  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeRatio(value: unknown, fallback: number): number {
  const ratio = toNumber(value, Number.NaN);
  if (Number.isFinite(ratio) && ratio >= 0) return ratio;
  return fallback;
}

function normalizePricingModels(rawModels: unknown[]): Map<string, PricingModel> {
  const models = new Map<string, PricingModel>();

  for (const raw of rawModels) {
    if (!raw || typeof raw !== 'object') continue;

    const modelName = String((raw as any).model_name || '').trim();
    if (!modelName) continue;

    const quotaType = toPositiveInt((raw as any).quota_type);
    // 记录上游是否真的给了 model_ratio：缺失/非法时不再默认成 1，
    // 而是留给证据层判定为「未知」（T1.17 / T1.18）。
    const rawModelRatio = toNumber((raw as any).model_ratio, Number.NaN);
    const hasModelRatio = Number.isFinite(rawModelRatio) && rawModelRatio >= 0;
    const modelRatio = hasModelRatio ? rawModelRatio : 0;
    const completionRatioRaw = toNumber((raw as any).completion_ratio, Number.NaN);
    const completionRatio = Number.isFinite(completionRatioRaw) && completionRatioRaw >= 0
      ? completionRatioRaw
      : 1;
    // S5a：识别动态计费并保存表达式原文。本轮不解析，只用于可信度判定。
    const billingMode = normalizeBillingMode((raw as any).billing_mode);
    const billingExprRaw = (raw as any).billing_expr;
    const billingExpr = typeof billingExprRaw === 'string' && billingExprRaw.trim()
      ? billingExprRaw.trim()
      : null;
    const vendorIdRaw = toNumber((raw as any).vendor_id, Number.NaN);
    const vendorId = Number.isFinite(vendorIdRaw) && vendorIdRaw > 0 ? Math.trunc(vendorIdRaw) : null;
    const cacheRatio = normalizeRatio(
      (raw as any).cache_ratio ?? (raw as any).cacheRatio,
      1,
    );
    const cacheCreationRatio = normalizeRatio(
      (raw as any).cache_creation_ratio
        ?? (raw as any).cacheCreationRatio
        ?? (raw as any).create_cache_ratio
        ?? (raw as any).createCacheRatio,
      1,
    );
    const enableGroupsRaw = (raw as any).enable_groups;
    // 非数组（字段缺失）时为空列表，不伪造 default —— 理由见下方 models.set 处注释。
    const enableGroups = Array.isArray(enableGroupsRaw)
      ? enableGroupsRaw.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [];
    const modelDescriptionRaw = (raw as any).model_description;
    const modelDescription = typeof modelDescriptionRaw === 'string'
      ? (modelDescriptionRaw.trim() || null)
      : null;
    const tags = normalizeStringArray((raw as any).tags);
    const supportedEndpointTypes = normalizeStringArray((raw as any).supported_endpoint_types);
    const ownerByRaw = (raw as any).owner_by;
    const ownerBy = typeof ownerByRaw === 'string' ? (ownerByRaw.trim() || null) : null;

    models.set(modelName, {
      modelName,
      quotaType,
      // D3：0 倍率是「免费」这一真实语义，不得回退成 1；
      // 字段缺失时保持 0，由证据层标为 unknown，而不是伪造一个正价。
      modelRatio,
      completionRatio,
      cacheRatio,
      cacheCreationRatio,
      modelPrice: normalizeModelPrice((raw as any).model_price),
      // ⚠️ 2026-11-09：上游没给 enable_groups 时**不再**伪造 [default]。
      // 那会让下面所有链路以为该模型确实挂在 default 上，
      // 于是按 default 倍率计价 —— siteB 的 ×2 正是这样被套到未声明分组的模型上的。
      // 空数组 = "分组信息缺失"，目录里表现为没有任何档位，UI 显示未知。
      enableGroups,
      modelDescription,
      tags,
      supportedEndpointTypes,
      ownerBy,
      billingMode,
      billingExpr,
      vendorId,
      hasUpstreamRatio: hasModelRatio,
    });
  }

  return models;
}

function unwrapPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  if ('data' in (payload as any)) return (payload as any).data;
  return payload;
}

/**
 * 归一新 API 家族的 `/api/pricing` 载荷。
 * 导出理由同 normalizeOneHubPricingPayload：纯函数可直接测，避免依赖 fetch mock 与模块级缓存。
 */
export function normalizeCommonPricingPayload(payload: unknown): PricingData | null {
  const maybeData = unwrapPayload(payload);
  if (!Array.isArray(maybeData)) return null;

  const models = normalizePricingModels(maybeData);
  if (models.size === 0) return null;

  const groupRatio = normalizeGroupRatio((payload as any)?.group_ratio);
  // T4.4：读取 auto 链路。上游给的是字符串数组，非法项剔除；缺省为空数组而非 null，
  // 便于下游统一处理（"没有下属分组"与"没探测到"在此都表现为空）。
  const autoGroupsRaw = (payload as any)?.auto_groups;
  const autoGroups = Array.isArray(autoGroupsRaw)
    ? Array.from(new Set(autoGroupsRaw.map((item: unknown) => String(item || '').trim()).filter(Boolean)))
    : [];
  return { models, groupRatio, autoGroups };
}

/**
 * one-hub / done-hub 的缓存倍率默认值。
 *
 * A7 取证结论（参照已验证可用的 all-api-hub 实现）：
 * 上游把缓存价表达为**相对输入价的倍率**，放在 `price.extra_ratios` 下，
 * 且这些键是**可选**的，缺省值并非 1 —— 缺省即代表上游按固定折扣计费：
 *   cached_read_tokens    0.1   （读缓存一折）
 *   cached_write_tokens   1.25  （写缓存加价）
 *   cached_write_1h_tokens   2
 *   cached_tokens            1  （OpenAI 形态的读缓存）
 *
 * 旧实现读的是 `price.input_cache_read / price.cache_read` 这类**绝对价**键名，
 * 上游从不返回它们，于是恒为 NaN、再回落到 1，等于把一折读缓存算成原价。
 */
const ONE_HUB_CACHE_RATIO_DEFAULTS = {
  cachedRead: 0.1,
  cachedWrite: 1.25,
  cachedWrite1h: 2,
  cachedTokens: 1,
} as const;

/** 取 extra_ratios 里的一个相对倍率；非法或非正数退回默认。 */
function pickExtraRatio(
  extra: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = toNumber(extra?.[key], Number.NaN);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * 把 one-hub / done-hub 的两个上游响应归一成定价数据。
 *
 * 导出理由：这是纯函数，直接测试比经由 `fetchModelPricingCatalog` 更可靠 ——
 * 后者要穿过 undici mock、模块级定价缓存与并发调度，在共享 worker 下会不组乙。
 */
export function normalizeOneHubPricingPayload(availablePayload: unknown, groupPayload: unknown): PricingData | null {
  const available = unwrapPayload(availablePayload);
  if (!available || typeof available !== 'object') return null;

  const transformed: unknown[] = [];
  for (const [modelName, rawValue] of Object.entries(available as Record<string, unknown>)) {
    const item = rawValue as any;
    const price = item?.price || {};
    const input = toNumber(price.input, 0);
    const output = toNumber(price.output, input);
    const extra = (price.extra_ratios && typeof price.extra_ratios === 'object')
      ? price.extra_ratios as Record<string, unknown>
      : {};
    const isTokenType = String(price.type || '').toLowerCase() === 'tokens';

    // T2.2：缓存倍率直接取相对值，不再除 input（那是把倍率误当绝对价）。
    const cacheReadRatio = pickExtraRatio(extra, 'cached_read_tokens', ONE_HUB_CACHE_RATIO_DEFAULTS.cachedRead);
    const cacheWriteRatio = pickExtraRatio(extra, 'cached_write_tokens', ONE_HUB_CACHE_RATIO_DEFAULTS.cachedWrite);

    // T2.3：长上下文档位。阈值或倍率不合法时不启用该档，但保留基础价。
    const longContext = price.long_context;
    const longContextUsable = !!longContext
      && toNumber(longContext.threshold, Number.NaN) > 0
      && Number.isFinite(toNumber(longContext.input_ratio, Number.NaN))
      && Number.isFinite(toNumber(longContext.output_ratio, Number.NaN));

    transformed.push({
      model_name: modelName,
      model_description: item?.description || item?.desc || '',
      quota_type: isTokenType ? 0 : 1,
      // one-hub 没有倍率概念，这里的 1 只是占位；真实价走 model_price 直采。
      model_ratio: 1,
      completion_ratio: input > 0 ? output / input : 1,
      cache_ratio: cacheReadRatio,
      cache_creation_ratio: cacheWriteRatio,
      model_price: { input, output },
      // one-hub 的 available_model 用 groups 字段；缺失时留空而非伪造 default（同 T4.4 判据）。
      enable_groups: Array.isArray(item?.groups) ? item.groups.map((g: unknown) => String(g || '').trim()).filter(Boolean) : [],
      supported_endpoint_types: Array.isArray(item?.supported_endpoint_types) ? item.supported_endpoint_types : [],
      tags: Array.isArray(item?.tags) ? item.tags : [],
      owner_by: item?.owned_by || item?.provider || null,
      // 供展示与后续解析使用；本轮不参与计算。
      ...(longContextUsable ? { long_context: longContext } : {}),
    });
  }

  const models = normalizePricingModels(transformed);
  if (models.size === 0) return null;

  const groupMap = unwrapPayload(groupPayload);
  const groupRatioSource: Record<string, number> = {};
  if (groupMap && typeof groupMap === 'object') {
    for (const [key, group] of Object.entries(groupMap as Record<string, any>)) {
      // 上游有两种历史形态，都要吃下：
      //   {vip: 0.5}            —— 扁平倍率（one-hub 部分版本、以及 /api/user_group_map 的简化返回）
      //   {vip: {name,ratio}}   —— 嵌套对象（all-api-hub 的 transformUserGroup 走的这一支）
      // 旧实现只认后者，遇到扁平形态会 toNumber(undefined, 1) → 所有分组静默变 1 倍。
      const ratio = (group && typeof group === 'object')
        ? toNumber(group.ratio ?? group.value ?? group.multiplier, Number.NaN)
        : toNumber(group, Number.NaN);
      groupRatioSource[key] = Number.isFinite(ratio) && ratio >= 0 ? ratio : 1;
    }
  }

  const groupRatio = normalizeGroupRatio(groupRatioSource);
  return { models, groupRatio };
}

async function fetchJson(url: string, options?: UndiciRequestInit): Promise<unknown> {
  const { fetch } = await import('undici');
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, PRICING_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...(await withSiteProxyRequestInit(url, {
        ...options,
        signal: controller.signal,
        body: options?.body ?? undefined,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      })),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`pricing fetch timeout (${Math.round(PRICING_FETCH_TIMEOUT_MS / 1000)}s)`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }
}

function normalizeUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * buildTokenCandidates 的最小入参形状。
 * 单独抽出是为了让「令牌候选」这条契约可以被独立测试，而不必构造完整计费输入。
 */
export interface PricingTokenCandidateInput {
  account: {
    accessToken?: string | null;
    apiToken?: string | null;
  };
}

/**
 * 定价请求的令牌候选序列。
 *
 * 顺序即优先级：session 令牌在前，apikey 令牌在后（R14 决议）。
 * 站点级 `sites.api_key` **不在候选内** —— 启动时 `migrateSiteApiKeysToAccounts()`
 * 会把它下推成 apikey 账户并清空原字段，因此这里读到的永远是空值。
 * 该不变量由 siteApiKeyMigrationService.pricing-chain.test.ts 锁定（D10'）。
 */
export function buildTokenCandidates(input: PricingTokenCandidateInput): string[] {
  const candidates = [
    input.account.accessToken,
    input.account.apiToken,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  return Array.from(new Set(candidates));
}

async function fetchCommonPricing(baseUrl: string, token?: string, sitePlatform?: string): Promise<PricingData | null> {
  const normalizedPlatform = (sitePlatform || '').trim().toLowerCase();
  const shouldTryShieldCookie = !!token && (normalizedPlatform === 'anyrouter' || token.includes('='));
  if (shouldTryShieldCookie) {
    const payload = await fetchJsonViaNewApiShield(`${baseUrl}/api/pricing`, token!);
    const data = normalizeCommonPricingPayload(payload);
    if (data) return data;
  }

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = await fetchJson(`${baseUrl}/api/pricing`, { headers });
  return normalizeCommonPricingPayload(payload);
}

async function fetchOneHubPricing(baseUrl: string, token?: string): Promise<PricingData | null> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const [availablePayload, groupPayload] = await Promise.all([
    fetchJson(`${baseUrl}/api/available_model`, { headers }),
    fetchJson(`${baseUrl}/api/user_group_map`, { headers }),
  ]);

  return normalizeOneHubPricingPayload(availablePayload, groupPayload);
}

function getCacheKey(input: EstimateProxyCostInput): string {
  return `${input.site.id}:${input.account.id}`;
}

function normalizeModelKey(modelName: string): string {
  return modelName.trim().toLowerCase();
}

/**
 * 构造路由参考价表（T9.1 / T9.2）。
 *
 * 两条排除规则：
 *   ① `quotaType === 1`（按次计费）不进表。它的"每百万 token 成本"没有意义，
 *      塞进去会让按次通道在 `1/unitCost` 打分里得到一个虚构的组甲/昂贵位次。
 *      这类通道的排序交由 `configured`（用户 unitCost）或 `fallback` 决定。
 *   ② 取不到价的（null / 非有限）不进表 —— 不得用兜底常数冒充一个真实成本。
 *
 * 另外**不再对 0 价做下限钳制**：免费模型的 0 是有意义的信号，
 * clamp 到 MIN_ROUTING_REFERENCE_COST 会让 totalCost 变正、
 * 从而触发 `resolveEffectiveUnitCost` 的 observed 分支接管用户配置的 unitCost（N1）。
 */
function buildRoutingReferenceCostMap(data: PricingData): Map<string, number> {
  const costs = new Map<string, number>();
  for (const model of data.models.values()) {
    if (model.quotaType === 1) continue;
    const cost = calculateModelUsageCost(model, ROUTING_REFERENCE_USAGE, data.groupRatio);
    // 注意：Number.isFinite(null) 为 true，所以必须先排除 null 再判有限性。
    if (cost === null || !Number.isFinite(cost)) continue;
    costs.set(normalizeModelKey(model.modelName), cost);
  }
  return costs;
}

function syncRoutingReferenceCostCache(
  key: string,
  fetchedAt: number,
  ttlMs: number,
  data: PricingData | null,
): void {
  if (!data) {
    routingReferenceCostCache.delete(key);
    return;
  }

  routingReferenceCostCache.set(key, {
    fetchedAt,
    ttlMs,
    costs: buildRoutingReferenceCostMap(data),
  });
}

/**
 * 真正具备「模型计价目录」能力的平台（T2.5）。
 *
 * 判据是**这里有没有对应的取价实现**，不是平台名字看着像不像：
 *   - new-api / one-api / veloera / anyrouter → `fetchCommonPricing`（`/api/pricing`）
 *   - one-hub / done-hub → `fetchOneHubPricing`（`/api/available_model` + `/api/user_group_map`）
 *   - **sub2api 不在列**：它只有订阅摘要与余额，全文没有 pricing / available_model，
 *     原先被错误地列为支持，导致 UI 显示"可查目录"而结果恒为空。
 *
 * 路由层应引用本常量而不是再维护一份名单，避免两处漂移。
 * （长期形态是 P9 平台能力声明表；在它落地前，这里是唯一权威来源。）
 */
export const PRICING_CATALOG_PLATFORMS = new Set([
  'new-api',
  'one-api',
  'veloera',
  'anyrouter',
  'one-hub',
  'done-hub',
]);

/** 该平台的取价端点类型，用于诊断信息与文档。 */
export function getPricingEndpointKind(platform?: string | null): 'common' | 'one-hub' | 'none' {
  const key = (platform || '').trim().toLowerCase();
  if (key === 'one-hub' || key === 'done-hub') return 'one-hub';
  return PRICING_CATALOG_PLATFORMS.has(key) ? 'common' : 'none';
}

/**
 * 取价失败的原因记录（T9.4）。
 *
 * 原先两处 `catch {}` 把错误彻底吞掉，界面上只留一句"计费不可用"，
 * 用户和运维都无从判断是没权限、路径不存在还是站点压根不给定价。
 * 这里按 siteId 记一条最近失败原因供诊断接口读取；
 * **只记不抛** —— 取价失败不该打断代理请求，这一点保持原样。
 */
const pricingFailureReasonBySiteId = new Map<number, { reason: string; atMs: number }>();
const PRICING_FAILURE_TTL_MS = 10 * 60 * 1000;

/** 同一站点的失败日志做节流，避免余额/定价轮询把日志刷满。 */
const pricingFailureLoggedAtMs = new Map<number, number>();
const PRICING_FAILURE_LOG_INTERVAL_MS = 5 * 60 * 1000;

function recordPricingFailure(siteId: number, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error || 'unknown error');
  // 截断避免把整段 HTML 错误页塞进内存
  const trimmed = reason.slice(0, 300);
  pricingFailureReasonBySiteId.set(siteId, { reason: trimmed, atMs: Date.now() });

  // T9.4：原先两处 `catch {}` 让失败彻底静默。这里补一条节流日志，
  // 使运维能从程序日志里判断是"令牌无定价权限"还是"站点根本没有定价端点"。
  const lastLog = pricingFailureLoggedAtMs.get(siteId) ?? 0;
  if (Date.now() - lastLog >= PRICING_FAILURE_LOG_INTERVAL_MS) {
    pricingFailureLoggedAtMs.set(siteId, Date.now());
    console.warn(`[pricing] site ${siteId} 取价失败：${trimmed}`);
  }
}

/** 读取某站点最近一次取价失败原因；无记录或已过期返回 null。 */
export function getPricingFailureReason(siteId: number): string | null {
  const entry = pricingFailureReasonBySiteId.get(siteId);
  if (!entry) return null;
  if (Date.now() - entry.atMs >= PRICING_FAILURE_TTL_MS) {
    pricingFailureReasonBySiteId.delete(siteId);
    return null;
  }
  return entry.reason;
}

async function fetchPricingData(input: EstimateProxyCostInput): Promise<PricingData | null> {
  const baseUrl = normalizeUrl(input.site.url);
  const tokenCandidates = buildTokenCandidates(input);

  const fetcher = input.site.platform === 'one-hub' || input.site.platform === 'done-hub'
    ? (baseUrl: string, token?: string) => fetchOneHubPricing(baseUrl, token)
    : (baseUrl: string, token?: string) => fetchCommonPricing(baseUrl, token, input.site.platform);

  let lastError: unknown = null;

  for (const token of tokenCandidates) {
    try {
      const data = await fetcher(baseUrl, token);
      if (data && data.models.size > 0) {
        pricingFailureReasonBySiteId.delete(input.site.id);
        return data;
      }
    } catch (error) {
      lastError = error;
    }
  }

  // Some sites expose pricing publicly.
  try {
    const data = await fetcher(baseUrl, undefined);
    if (data && data.models.size > 0) {
      pricingFailureReasonBySiteId.delete(input.site.id);
      return data;
    }
  } catch (error) {
    lastError = lastError ?? error;
  }

  // 全部尝试都没拿到目录：记下原因，成功时没有 delete 过就一定是失败态。
  if (lastError) {
    recordPricingFailure(input.site.id, lastError);
  } else {
    recordPricingFailure(input.site.id, '上游未返回任何模型定价（可能是令牌无定价权限）');
  }

  return null;
}

async function getPricingDataCached(input: EstimateProxyCostInput): Promise<PricingData | null> {
  const key = getCacheKey(input);
  const now = Date.now();
  const cached = pricingCache.get(key);
  if (cached && now - cached.fetchedAt < cached.ttlMs) {
    if (cached.data && !routingReferenceCostCache.has(key)) {
      syncRoutingReferenceCostCache(key, cached.fetchedAt, cached.ttlMs, cached.data);
    }
    return cached.data;
  }

  const data = await fetchPricingData(input);
  const ttlMs = data ? PRICE_CACHE_TTL_MS : PRICE_CACHE_FAILURE_TTL_MS;
  pricingCache.set(key, {
    fetchedAt: now,
    ttlMs,
    data,
  });
  syncRoutingReferenceCostCache(key, now, ttlMs, data);
  return data;
}

async function refreshPricingDataCache(input: EstimateProxyCostInput): Promise<PricingData | null> {
  const key = getCacheKey(input);
  const now = Date.now();
  const data = await fetchPricingData(input);
  const ttlMs = data ? PRICE_CACHE_TTL_MS : PRICE_CACHE_FAILURE_TTL_MS;
  pricingCache.set(key, {
    fetchedAt: now,
    ttlMs,
    data,
  });
  syncRoutingReferenceCostCache(key, now, ttlMs, data);
  return data;
}

export function getCachedModelRoutingReferenceCost(input: {
  siteId: number;
  accountId: number;
  modelName: string;
}): number | null {
  const key = `${input.siteId}:${input.accountId}`;
  const cached = routingReferenceCostCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.fetchedAt >= cached.ttlMs) {
    return null;
  }

  const cost = cached.costs.get(normalizeModelKey(input.modelName));
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) {
    return null;
  }

  return cost;
}

export function getCachedModelPricingCatalog(input: EstimateProxyCostInput): ModelPricingCatalog | null {
  const key = getCacheKey(input);
  const cached = pricingCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.fetchedAt >= cached.ttlMs) {
    return null;
  }
  // 空目录 = 之前取价失败过。把失败原因一并带出，UI 才能说清"为什么没有价格"（T9.4）。
  if (!cached.data) return { models: [], groupRatio: {}, lastFailureReason: getPricingFailureReason(input.site.id) };

  if (!routingReferenceCostCache.has(key)) {
    syncRoutingReferenceCostCache(key, cached.fetchedAt, cached.ttlMs, cached.data);
  }
  return buildModelPricingCatalogFromData(cached.data);
}

function resolveModel(modelName: string, data: PricingData): PricingModel | null {
  const exact = data.models.get(modelName);
  if (exact) return exact;

  const lower = modelName.toLowerCase();
  for (const [name, model] of data.models.entries()) {
    if (name.toLowerCase() === lower) return model;
  }

  return null;
}

/**
 * 取模型在生效分组下的倍率（T1.19 / D5）。
 *
 * ⚠️ 2026-11-09 修正：**按 enableGroups 的声明顺序**取第一个有倍率的分组，
 * 不再无条件偏向 default。旧写法把 default 提到最前，而 siteB 的
 * `group_ratio.default = 2` —— 挂 [组乙, 组甲] 的模型一旦掺进 default
 * 就会被翻倍计价。上游把某分组列在前面即代表那是该模型的实际结算分组。
 *
 * **绝不**从其它分组借一个倍率过来 —— 更早的实现用
 * `Object.values(groupRatio).find(r => r > 0)`，会把 `{svip: 2}` 的倍率套到
 * 只写了 `{vip: 0}` 的模型上，凭空造出 2 倍价（方案里 M2 机制的成因）。
 *
 * 返回 null 表示「不知道倍率」，调用方必须走未知分支而非默认 1。
 */
/** 本次请求的令牌分组信息（三-3）。缺省时沿用旧的"模型分组优先"启发式。 */
export interface BillingGroupHint {
  tokenGroup?: string | null;
  autoGroups?: string[] | null;
}

/**
 * 该分组名是否是"auto"这类**没有独立倍率**的别名（三-1）。
 * 实现见 billing/groupNames —— 路由通道展示与实扣计价共用同一份判据。
 */
export { isAutoGroupName } from './billing/groupNames.js';

/**
 * 解析本次请求的计费分组倍率（三-3）。
 *
 * 顺序（与上游 new-api 家族的实际命中一致，已由 siteA 真实账单验证）：
 *   ① 令牌是显式分组且模型声明了它 → 用该分组的倍率；
 *   ② 令牌是 auto（或未标注）且有链路 → **按链路顺序取第一个模型声明了的分组**。
 *      链路是降级顺序，上游命中第一个可用档，所以是"第一个"不是"最后一个"：
 *      实测 sample-model-ratio 链路 [grp-codex, grp-codex-pro, 组丁-chs]，
 *      模型同时挂在 grp-codex 与 grp-codex-pro，上游扣的是 grp-codex(0.15)。
 *   ③ 以上都不成立 → 有 hint 时返回 null（分组未知，拒绝出价）；
 *      没有 hint（老调用方）才退回旧的启发式。
 */
function resolveGroupMultiplier(
  model: PricingModel,
  groupRatio: Record<string, number>,
  hint?: BillingGroupHint | null,
): number | null {
  return resolveBillingGroup(model, groupRatio, hint)?.ratio ?? null;
}

/** 解析结果：倍率 + 实际命中的分组名（三-2 需要把分组名写进 billing_details）。 */
function resolveBillingGroup(
  model: PricingModel,
  groupRatio: Record<string, number>,
  hint?: BillingGroupHint | null,
): { ratio: number; groupName: string | null } | null {
  const groups = (model.enableGroups || [])
    .map((group) => String(group || '').trim())
    .filter(Boolean);

  const tokenGroup = String(hint?.tokenGroup || '').trim();
  const chain = (hint?.autoGroups ?? [])
    .map((group) => String(group || '').trim())
    .filter(Boolean);
  const hasHint = Boolean(tokenGroup) || chain.length > 0;

  if (hasHint) {
    // ① 显式分组优先。auto 不是真分组（上游在 usable_group 里明确标它无效），
    //    不能拿它去查倍率。
    if (tokenGroup && !isAutoGroupName(tokenGroup) && groups.includes(tokenGroup)) {
      return hasExplicitRatio(groupRatio, tokenGroup)
        ? { ratio: groupRatio[tokenGroup]!, groupName: tokenGroup }
        : null;
    }

    // ② 链路顺序命中：第一个模型声明了的分组。
    for (const candidate of chain) {
      if (!groups.includes(candidate)) continue;
      // 模型声明了该分组却拿不到倍率：这是"已知分组但倍率未知"，不能继续往后猜。
      return hasExplicitRatio(groupRatio, candidate)
        ? { ratio: groupRatio[candidate]!, groupName: candidate }
        : null;
    }

    // ③ 有令牌信息但一个都对不上：拒绝出价，绝不退到别的分组。
    return null;
  }

  // ⚠️ 兼容路径：没有分组信息时返回 null（未知），**不再**退到 default。
  // 实扣路径拿不到倍率就该拒绝出价，而不是猜一个 —— siteB 的 default 是 ×2，
  // 猜测会直接导致多扣一倍。有声明则严格按声明顺序，不注入、不重排。
  if (groups.length === 0) return null;

  for (const group of groups) {
    if (hasExplicitRatio(groupRatio, group)) {
      return { ratio: groupRatio[group]!, groupName: group };
    }
  }

  return null;
}

/** 分组倍率是否被显式给出（含合法的 0）。 */
function hasExplicitRatio(groupRatio: Record<string, number>, group: string): boolean {
  const value = groupRatio[group];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function calculatePerCallCost(
  modelPrice: number | { input: number; output: number } | null,
  multiplier: number,
): number {
  if (typeof modelPrice === 'number') {
    return modelPrice * multiplier;
  }

  if (modelPrice && typeof modelPrice === 'object') {
    // done-hub/one-hub times pricing follows input ratio only.
    return toNumber(modelPrice.input, 0) * multiplier * ONE_HUB_PER_CALL_RATIO;
  }

  return 0;
}

function calculatePerCallPricing(
  modelPrice: number | { input: number; output: number } | null,
  multiplier: number,
): { input?: number; output?: number; total: number } {
  if (typeof modelPrice === 'number') {
    const total = roundCost(modelPrice * multiplier);
    return { total };
  }

  if (modelPrice && typeof modelPrice === 'object') {
    const input = roundCost(toNumber(modelPrice.input, 0) * multiplier * ONE_HUB_PER_CALL_RATIO);
    const output = roundCost(toNumber(modelPrice.output, 0) * multiplier * ONE_HUB_PER_CALL_RATIO);
    return {
      input,
      output,
      total: input,
    };
  }

  return { total: 0 };
}

/**
 * 用 self-log 元数据构造临时计价模型（D12 修复后）。
 *
 * 两条硬约束：
 *   ① **不再把 `hasUpstreamRatio` 置真**。self-log 的比率来自上游日志，
 *      不是本次定价目录里的权威条目；标为"未确认"可让证据层降级。
 *   ② groupRatio 仍挂在 DEFAULT_GROUP 键上，但这只是**内部数据结构需要**——
 *      该模型的 enableGroups 也同步设为 [DEFAULT_GROUP]，两者一致，
 *      不会出现"用 default 键存着、却按别的分组倍率取"的错配
 *      （那正是 siteB ×2 被误套的同源问题）。
 */
function buildPricingOverrideModel(
  modelName: string,
  pricingOverride: ProxyBillingPricingOverride,
): { model: PricingModel; groupRatio: Record<string, number> } {
  const groupRatio = normalizeRatio(pricingOverride.groupRatio, 1);
  return {
    model: {
      modelName,
      quotaType: 0,
      modelRatio: normalizeRatio(pricingOverride.modelRatio, 1),
      completionRatio: normalizeRatio(pricingOverride.completionRatio, 1),
      cacheRatio: normalizeRatio(pricingOverride.cacheRatio, 1),
      cacheCreationRatio: normalizeRatio(pricingOverride.cacheCreationRatio, 1),
      modelPrice: null,
      enableGroups: [DEFAULT_GROUP],
      // self-log 覆盖价属于近似口径：它是历史日志里的比率，未必等于当前目录价。
      hasUpstreamRatio: pricingOverride.modelRatio !== undefined,
    },
    groupRatio: { [DEFAULT_GROUP]: groupRatio },
  };
}

function normalizeUsageBreakdownInput(usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  promptTokensIncludeCache?: boolean | null;
}) {
  const promptTokens = toPositiveInt(usage.promptTokens);
  const completionTokens = toPositiveInt(usage.completionTokens);
  const totalTokensRaw = toPositiveInt(usage.totalTokens);
  const totalTokens = Math.max(totalTokensRaw, promptTokens + completionTokens);
  const cacheReadTokens = toPositiveInt(usage.cacheReadTokens);
  const cacheCreationTokens = toPositiveInt(usage.cacheCreationTokens);
  const promptTokensIncludeCache = usage.promptTokensIncludeCache ?? null;
  const hasSplit = promptTokens > 0 || completionTokens > 0;
  const effectivePromptTokens = hasSplit ? promptTokens : totalTokens;
  const billablePromptTokens = promptTokensIncludeCache === false
    ? effectivePromptTokens
    : Math.max(0, effectivePromptTokens - cacheReadTokens - cacheCreationTokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    billablePromptTokens,
    promptTokensIncludeCache,
  };
}

/**
 * 每百万 token 单价的取值口径（S2 / T1.16+）。
 *
 * 优先级：上游直采价 `model_price: {input, output}` > 倍率换算。
 * 理由：one-hub / done-hub 没有倍率概念，其定价路径会**合成** `model_ratio = 1`
 * 作占位值；若继续按倍率算，所有 token 模型都会得到同一个 `$2/M`，
 * 把真实直采价完全丢掉。Hub 侧 pricingPlan 也是同一优先级。
 *
 * 返回 null 表示两种口径都拿不到，调用方必须走「未知」分支，不得伪造数值。
 */
interface ResolvedPerMillion {
  input: number;
  output?: number;
  /** 缓存档允许缺省：动态计费下"表达式没提"≠"倍率 1"，缺省必须真的是空。 */
  cacheRead?: number;
  cacheCreation?: number;
  /**
   * 实际口径。注意不含 'unavailable' —— 两种口径都拿不到时本函数返回 null，
   * 由调用方构造 unknown 证据，因此这里只列举"已经拿到数值"的来源。
   */
  evidenceSource: 'upstream-direct-price' | 'upstream-ratio' | 'upstream-dynamic-expr' | 'derived-from-stale-field';
  /**
   * 命中的动态计费档位名（T6.4）。
   * 只有 dynamic 口径才有值 —— 记录"这次按哪个档算的钱"，
   * 事后才能解释同一模型为何在不同时刻/用量下成本不同。
   */
  tierName?: string;
  /**
   * 多档表达式的**全部**档位（二-3）。
   * 目录展示需要把每一档分别显示出来；实扣路径只有单档，故不填。
   */
  allTiers?: DynamicTierPrice[];
}

/** 一档的每百万单价 + 档位身份（供 UI 分别渲染各档）。 */
export interface DynamicTierPrice {
  name: string;
  input: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  /** 人类可读的适用条件，例如 `≤272K` / `峰段 周一至周五 09:00-18:00`。无法判定为 null。 */
  condition?: string | null;
}

/** 是否存在可用的直采价（对象形态且至少一侧为正）。 */
function hasUsableDirectPrice(
  modelPrice: number | { input: number; output: number } | null,
): boolean {
  if (!modelPrice || typeof modelPrice !== 'object') return false;
  const input = toNumber(modelPrice.input, Number.NaN);
  const output = toNumber(modelPrice.output, Number.NaN);
  return Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0);
}

/**
 * 动态计费的实扣选档（T6.3）。
 *
 *   - `len <= N ? … : …` → 用本次 billablePromptTokens 判阈值
 *   - 时间分档            → 用请求时刻（UTC）判 weekday/hour 区间
 *
 * 命中不到任何档时返回 null，调用方按"无价格依据"处理，
 * **绝不退回基础档硬算** —— 那等于用一个上游没适用的价格扣钱。
 */
function selectDynamicTierForUsage(
  plan: Extract<ParsedBillingPlanV2, { kind: 'conditional' }>,
  context: TierSelectionContext,
): BillingTier | null {
  for (const tier of plan.tiers) {
    if (tierMatchesAt(tier, { inputTokens: context.inputTokens, nowMs: context.atMs })) return tier;
  }
  return null;
}

/**
 * 把单个档位的系数表落成每百万单价。
 *
 * 计量项只认表达式里显式出现的那些：**缺省不等于 1**。
 * （真实取证：siteC 表达式只有 p/c 两项，而 cache_ratio 缺省被当 1、
 *   再乘上失效的 model_ratio=37.5，把缓存价错报成 $75/M —— 上游官方是 $0.02/M。）
 * 返回 null 表示连输入价都没有，调用方须按未知处理。
 */
function materializeSingleTier(
  rates: TierRates,
  multiplier: number,
  tierName?: string,
): ResolvedPerMillion | null {
  const scaled = (meter: BillingMeter): number | undefined => {
    const value = rates[meter];
    return value !== undefined ? roundCost(value * multiplier) : undefined;
  };

  const input = scaled('input');
  if (input === undefined) return null;

  const result: ResolvedPerMillion = { input, evidenceSource: 'upstream-dynamic-expr' };
  // T6.4：档位名随行，供 billing_details 记录"按哪个档算的钱"。
  if (tierName) result.tierName = tierName;
  // 未显式出现的计量项一律留空：不回落到 model_ratio × completionRatio，
  // 因为 dynamic 档位的存在恰恰说明 model_ratio 已经不作数了。
  const output = scaled('output');
  if (output !== undefined) result.output = output;
  const cacheRead = scaled('cacheRead');
  if (cacheRead !== undefined) result.cacheRead = cacheRead;
  const cacheWrite = scaled('cacheWrite');
  if (cacheWrite !== undefined) result.cacheCreation = cacheWrite;
  return result;
}

/** 取不到任何价格口径时的原因判定（单一出处，避免目录与实扣各写一套）。 */
function resolveMissingPriceReason(model: PricingModel): PriceUnavailableReason {
  // tiered_expr 且 ratio 不可信：真正的原因是表达式还没解析，不是字段缺失
  if ((model.billingMode ?? 'token') === 'tiered_expr') return 'dynamic-billing-unparsed';
  return 'ratio-missing';
}

/** token 量阈值的人话写法：272000 → `272K`。 */
function fmtThresholdTokens(value: number): string {
  if (value >= 1_000_000) return `${roundCost(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * 把档位条件翻成人话（二-3）。
 * UI 需要向用户解释"哪一档在什么时候生效"，因此条件必须可读而不是原文表达式。
 * 无法判定的形态返回 null —— 调用方退回只显示档位名，不编造条件。
 */
export function describeTierCondition(condition: TierCondition): string | null {
  if (condition.kind === 'always') return null;

  if (condition.kind === 'token-length') {
    const threshold = fmtThresholdTokens(condition.thresholdTokens);
    return condition.operator === '<=' ? `≤${threshold}` : `>${threshold}`;
  }

  if (condition.kind === 'calendar') {
    // 连续区间压缩成 "周一至五"，非连续才逐个列出，避免长串噪声。
    const days = [...new Set(condition.weekdays)].sort((a, b) => a - b);
    const labels = days.map((day) => WEEKDAY_LABELS[day - 1]).filter(Boolean);
    const contiguous = days.length > 1
      && days.every((day, index) => index === 0 || day === days[index - 1]! + 1);
    const dayText = contiguous && labels.length > 1
      ? `${labels[0]}至${labels[labels.length - 1]}`
      : labels.join('、');
    const hours = condition.hourRanges
      .map((range) => `${String(range.from).padStart(2, '0')}:00-${String(range.to).padStart(2, '0')}:00`)
      .join(' / ');
    return [dayText, hours].filter(Boolean).join(' ') || null;
  }

  return null;
}

/**
 * 把 conditional 计划的**全部**档位落成单价表（二-3）。
 *
 * 目录展示原先只取第一档当"代表价"，于是峰谷同价、长短上下文差异在 UI 上全部消失，
 * 用户看到的单档价格并不等于他实际被扣的那一档。这里把每一档都透出，
 * 由展示层分别渲染；代表价语义保持不变（仍用 tiers[0]），不影响路由参考价与实扣。
 *
 * 某档连输入价都没有时整档跳过 —— 显示半个价格比不显示更容易被误读。
 */
function materializeAllTiers(
  tiers: BillingTier[],
  multiplier: number,
): DynamicTierPrice[] {
  const result: DynamicTierPrice[] = [];
  for (const tier of tiers) {
    const prices = materializeSingleTier(tier.rates, multiplier, tier.name);
    if (!prices) continue;
    // 时间分档的 else 分支解析成 always —— 多档语境下它就是"其余时段"，
    // 直说比留空更有用（留空会让人以为这一档没有适用条件）。
    const condition = tier.condition.kind === 'always' && tiers.length > 1
      ? '其余'
      : describeTierCondition(tier.condition);
    result.push({
      name: tier.name,
      input: prices.input,
      output: prices.output,
      cacheRead: prices.cacheRead,
      cacheCreation: prices.cacheCreation,
      condition,
    });
  }
  return result;
}

/**
 * 实扣选档上下文（T6.3）。
 * - `undefined`（目录展示路径）：多档取第一档作代表价，不代表本次请求的适用档；
 * - 给定（计费路径）：按实际输入 token 数与时刻选出真正生效的那一档。
 */
interface TierSelectionContext {
  inputTokens: number;
  atMs?: number;
}

function resolvePerMillionPrices(
  model: PricingModel,
  multiplier: number,
  tierContext?: TierSelectionContext,
): ResolvedPerMillion | null {
  const cacheRatio = model.cacheRatio ?? 1;
  const cacheCreationRatio = model.cacheCreationRatio ?? 1;

  // ⓪ 先判"有没有任何可用口径"，再决定退不退。
  //    tiered_expr 且表达式可解析时，即使 model_ratio 缺失也能定价 —— 表达式才是权威，
  //    所以这里必须把动态计费放行到 ②，否则会把能算价的模型误标成未知。
  const billingMode = model.billingMode ?? 'token';
  // V2 解析器覆盖单档 / len 分档 / 时间分档三种真实形态。
  const parsedDynamicPlanV2: ParsedBillingPlanV2 | null = billingMode === 'tiered_expr'
    ? parseBillingExprV2(model.billingExpr)
    : null;
  // 可定价 = 解析成功（single 或 conditional 的基础档）。unsupported 不算可定价。
  const canPriceFromExpr = parsedDynamicPlanV2?.kind === 'single'
    || parsedDynamicPlanV2?.kind === 'conditional';

  if (model.hasUpstreamRatio === false && !hasUsableDirectPrice(model.modelPrice) && !canPriceFromExpr) {
    return null;
  }

  // ① 直采价优先：仅接受对象形态的 model_price（数字形态是按次计费用法，不参与此处）
  if (model.modelPrice && typeof model.modelPrice === 'object') {
    const input = toNumber(model.modelPrice.input, Number.NaN);
    const output = toNumber(model.modelPrice.output, Number.NaN);
    if (Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0)) {
      return {
        input: roundCost(input * multiplier),
        output: roundCost(output * multiplier),
        // 缓存倍率是相对输入价的比值，直采口径下同样乘到输入单价上
        cacheRead: roundCost(input * cacheRatio * multiplier),
        cacheCreation: roundCost(input * cacheCreationRatio * multiplier),
        evidenceSource: 'upstream-direct-price',
      };
    }
  }

  // ② 动态计费（S5c）：能解析出扁平单价时**以表达式为准**，不再用失效的 model_ratio。
  //    解析不出来（多档 / 条件 / 未知变量）才退回失效字段并标 approximate。
  const perMillion = (ratio: number) => roundCost(ratioToUsdPerMillion(ratio * multiplier));
  if (billingMode === 'tiered_expr') {
    // V2 解析器覆盖三种真实形态；conditional 的多档在此不参与单值定价，
    // 由 resolveDynamicTierSelection 按参考用量选基础档（T6.2）。
    const planV2 = parsedDynamicPlanV2;

    if (planV2?.kind === 'single') {
      return materializeSingleTier(planV2.tier.rates, multiplier, planV2.tier.name);
    }

    if (planV2?.kind === 'conditional') {
      // 有实扣上下文 → 按本次用量/时刻精确选档；没有（目录展示）→ 取第一档作代表价。
      if (tierContext) {
        const matched = selectDynamicTierForUsage(planV2, tierContext);
        // 一档都没命中：说明上游表达式覆盖不到这次请求，宁可不记账也不硬套一个档。
        if (!matched) return null;
        return materializeSingleTier(matched.rates, multiplier, matched.name);
      }
      // 目录展示需要一个"代表价"：取第一档作基础档（上游约定 peak/低阈值档在前）。
      // 同时把**全部**档位透出供 UI 分别显示（二-3）—— 只报代表价会让用户以为模型就这一个价。
      const base = materializeSingleTier(planV2.tiers[0]!.rates, multiplier, planV2.tiers[0]!.name);
      if (base) {
        const allTiers = materializeAllTiers(planV2.tiers, multiplier);
        if (allTiers.length > 0) base.allTiers = allTiers;
      }
      return base;
    }

    return {
      input: perMillion(model.modelRatio),
      output: perMillion(model.modelRatio * model.completionRatio),
      cacheRead: perMillion(model.modelRatio * cacheRatio),
      cacheCreation: perMillion(model.modelRatio * cacheCreationRatio),
      evidenceSource: 'derived-from-stale-field',
    };
  }

  return {
    input: perMillion(model.modelRatio),
    output: perMillion(model.modelRatio * model.completionRatio),
    cacheRead: perMillion(model.modelRatio * cacheRatio),
    cacheCreation: perMillion(model.modelRatio * cacheCreationRatio),
    evidenceSource: 'upstream-ratio',
  };
}

export function calculateModelUsageBreakdown(
  model: PricingModel,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    promptTokensIncludeCache?: boolean | null;
  },
  groupRatio: Record<string, number>,
  /** 时间分档的判定时刻（毫秒）。缺省用当前时间 —— 实扣就是"此刻的钱"。 */
  atMs?: number,
  /** 本次请求的令牌分组（三-3）。缺省沿用旧的模型分组启发式。 */
  groupHint?: BillingGroupHint | null,
): ProxyBillingDetails | null {
  if (model.quotaType === 1) {
    return null;
  }

  const resolvedGroup = resolveBillingGroup(model, groupRatio, groupHint);
  // 倍率未知时不出账：宁可没有成本，也不按 1× 悄悄扣一个可能错的价格。
  if (resolvedGroup === null) return null;
  const multiplier = resolvedGroup.ratio;
  const normalizedUsage = normalizeUsageBreakdownInput(usage);
  // 取值口径集中在 resolvePerMillionPrices：直采价优先、倍率兜底、缺失即未知。
  // T6.3：实扣路径传入选档上下文（本次输入量 + 时刻），多档表达式据此精确命中；
  //       billablePromptTokens 与上游 len 语义一致（扣除缓存后的计费输入量）。
  const prices = resolvePerMillionPrices(model, multiplier, {
    inputTokens: normalizedUsage.billablePromptTokens,
    atMs: atMs ?? Date.now(),
  });
  if (!prices) return null;
  const { input: inputPerMillion } = prices;
  // 动态计费表达式没提的计量项在这里就是 undefined；实扣按 0 计（不收该项的钱），
  // 而不是拿失效倍率编一个数。缺省语义：上游不认这个计量项。
  const outputPerMillion = prices.output ?? 0;
  const cacheReadPerMillion = prices.cacheRead ?? 0;
  const cacheCreationPerMillion = prices.cacheCreation ?? 0;
  const inputCost = roundCost((normalizedUsage.billablePromptTokens / 1_000_000) * inputPerMillion);
  const outputCost = roundCost((normalizedUsage.completionTokens / 1_000_000) * outputPerMillion);
  const cacheReadCost = roundCost((normalizedUsage.cacheReadTokens / 1_000_000) * cacheReadPerMillion);
  const cacheCreationCost = roundCost((normalizedUsage.cacheCreationTokens / 1_000_000) * cacheCreationPerMillion);
  const totalCost = roundCost(inputCost + outputCost + cacheReadCost + cacheCreationCost);

  return {
    quotaType: model.quotaType,
    usage: normalizedUsage,
    pricing: {
      modelRatio: model.modelRatio,
      completionRatio: model.completionRatio,
      cacheRatio: model.cacheRatio ?? 1,
      cacheCreationRatio: model.cacheCreationRatio ?? 1,
      groupRatio: multiplier,
      /** 命中的分组名（三-2）。日志要能回答"这个倍率是哪一档的"。 */
      groupName: resolvedGroup.groupName,
      // 记录本次实际采用的口径，便于 billing_details 事后排查（A8 相关）。
      evidenceSource: prices.evidenceSource,
      /** 命中的动态计费档位名（T6.4）。非 dynamic 口径为 undefined，不写入 JSON。 */
      tierName: prices.tierName,
    },
    breakdown: {
      inputPerMillion,
      outputPerMillion,
      cacheReadPerMillion,
      cacheCreationPerMillion,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheCreationCost,
      totalCost,
    },
  };
}

export function calculateModelUsageCost(
  model: PricingModel,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    promptTokensIncludeCache?: boolean | null;
  },
  groupRatio: Record<string, number>,
  /** 时间分档判定时刻；缺省为当前时间。 */
  atMs?: number,
  /** 本次请求的令牌分组（三-3）。 */
  groupHint?: BillingGroupHint | null,
): number | null {
  const multiplier = resolveGroupMultiplier(model, groupRatio, groupHint);

  // T1.19：倍率未知 → 无成本，不得按 1× 兜底。
  // 下游 buildRoutingReferenceCostMap 会过滤掉 null，该模型因此不进路由参考价。
  if (multiplier === null) return null;

  if (model.quotaType === 1) {
    return roundCost(calculatePerCallCost(model.modelPrice, multiplier));
  }

  // breakdown 为 null 表示「没有任何价格依据」，不能塌成 0：
  // 0 会被下游读成"这个模型免费"，正是 N2 要消灭的语义混淆。
  const breakdown = calculateModelUsageBreakdown(model, usage, groupRatio, atMs, groupHint);
  if (!breakdown) return null;
  return breakdown.breakdown.totalCost;
}

/**
 * 由归一后的定价数据构造对外目录。
 * 导出理由：纯函数，可直接断言档位/证据/分组倍率，不必经由带缓存的 fetch 路径。
 */
export function buildModelPricingCatalogFromData(pricingData: PricingData): ModelPricingCatalog {
  // 注：曾在此计算 defaultMultiplier 作为"分组无倍率时的退路"，已删除。
  // 那个退路正是 siteB 上把 ×2 强加给未列倍率分组的来源（T1.20 的判据修正）。

  const models: ModelPricingCatalogEntry[] = Array.from(pricingData.models.values())
    .map((model) => {
      // ⚠️ 2026-11-09 修正：这里**绝不**再无条件并入 DEFAULT_GROUP。
      // 旧写法假定"上游对未分组模型一律按 default 结算"，实测证伪：
      //   - siteA 28 个模型里 0 个显式含 default（它用 auto + 组丁-* 等中文分组）；
      //   - siteB 的 sample-model-cal 只挂 [组乙, 组甲]（倍率均 1），
      //     而 default 倍率是 **2** —— 凭空多出的 default 档等于报了一个翻倍的价格。
      // 结论：档位只能来自模型自己的 enable_groups。缺分组信息就如实为空，
      //       由 UI 显示"未知"，不允许用一个未经确认的分组去兜底。
      const declaredGroups = (model.enableGroups || [])
        .map((group) => String(group || '').trim())
        .filter(Boolean);

      // 档位集合 = 模型声明的分组。上游 group_ratio 里缺该分组时仍保留它，
      // 因为"分组存在但没给倍率"应按 1× 处理（siteB 的 组甲/组乙 都是这种：显式列出、倍率为 1）；
      // 而"分组压根没声明"才是我们要杜绝的凭空造档。
      // 注：declaredGroups 为空时下面的 reduce 自然产出 {} —— 不猜 default，交给 UI 显示未知。
      const effectiveGroups = Array.from(new Set(declaredGroups));

      const groupPricing = effectiveGroups.reduce<Record<string, ModelGroupPricing>>((acc, group) => {
        // ⚠️ 2026-11-09：分组自身有倍率就用它；**没有就报未知，不再退回 default**。
        // 旧写法 `groupOwn ?? defaultMultiplier` 在 siteB 上会把未列倍率的分组按 ×2 计价。
        const groupOwn = pricingData.groupRatio[group];
        const multiplier = Number.isFinite(groupOwn) && (groupOwn as number) >= 0
          ? groupOwn!
          : null;

        if (multiplier === null) {
          acc[group] = {
            quotaType: model.quotaType,
            evidence: unknownPriceEvidence('group-unavailable'),
            billingMode: model.billingMode,
            billingExpr: model.billingExpr ?? null,
          };
          return acc;
        }
        if (model.quotaType === 1) {
          const perCall = calculatePerCallPricing(model.modelPrice, multiplier);
          acc[group] = {
            quotaType: 1,
            perCallInput: perCall.input,
            perCallOutput: perCall.output,
            perCallTotal: perCall.total,
            evidence: knownPriceEvidence('upstream-per-call'),
            billingMode: model.billingMode,
            billingExpr: model.billingExpr ?? null,
          };
          return acc;
        }

        // S2：与实扣走同一个 resolvePerMillionPrices，避免展示价与计费价口径分裂。
        const prices = resolvePerMillionPrices(model, multiplier);
        if (!prices) {
          acc[group] = {
            quotaType: 0,
            evidence: unknownPriceEvidence(resolveMissingPriceReason(model)),
            billingMode: model.billingMode,
            billingExpr: model.billingExpr ?? null,
          };
          return acc;
        }

        acc[group] = {
          quotaType: 0,
          inputPerMillion: prices.input,
          outputPerMillion: prices.output,
          cacheReadPerMillion: prices.cacheRead,
          cacheCreationPerMillion: prices.cacheCreation,
          // 多档表达式：把每一档都带上，UI 分别显示（二-3）。单档时 undefined，不写空数组。
          tiers: prices.allTiers,
          evidence: knownPriceEvidence(prices.evidenceSource),
          billingMode: model.billingMode,
          billingExpr: model.billingExpr ?? null,
        };
        // 说明：只有动态计费口径会缺 output/cache 档（表达式没提的计量项保持 undefined，
        // 渲染为"未提供"而不是 $0）；其余三个口径在 resolvePerMillionPrices 里恒给全四项。
        return acc;
      }, {});

      return {
        modelName: model.modelName,
        quotaType: model.quotaType,
        modelDescription: model.modelDescription || null,
        tags: model.tags || [],
        supportedEndpointTypes: model.supportedEndpointTypes || [],
        ownerBy: model.ownerBy || null,
        // 原样透传，不伪造 default（T4.4 判据）；空数组让 UI 明确表达"分组未知"。
        enableGroups: model.enableGroups || [],
        groupPricing,
        // S5a：条目级也要带上计费模式，前端不必下钻到分组才能判断是否动态计费。
        billingMode: model.billingMode,
        vendorId: model.vendorId ?? null,
      };
    })
    .sort((a, b) => a.modelName.localeCompare(b.modelName));

  const catalog: ModelPricingCatalog = {
    models,
    groupRatio: pricingData.groupRatio,
    // auto_groups 只做**原样透传**，不再据此推算任何档位。
    // ⚠️ 2026-11-09：原先的 expandAutoGroupPricing 会按 `auto_groups × group_ratio`
    // 生成 `auto:grp-daily` 一类价格，实测证伪 —— auto_groups 描述的是**站点默认链路**，
    // 而某个 apikey 实际挂在哪些分组由令牌自身配置决定（用户实测 siteA 某 key 为
    // grp-codex → grp-codex-pro → 组丁-chs），且 grp-daily/grp-perf 下
    // 根本没有 sample-model-cal 的计费信息。用站点默认链路给单个令牌定价等于凭空造价。
    // 真实的"令牌→链路分组"映射需要另一个数据源，拿到之前这里只保留原始列表供参考。
    autoGroups: pricingData.autoGroups ?? [],
  };
  return catalog;
}

export async function fetchModelPricingCatalog(input: EstimateProxyCostInput): Promise<ModelPricingCatalog | null> {
  const pricingData = await getPricingDataCached(input);
  if (!pricingData) return null;
  return buildModelPricingCatalogFromData(pricingData);
}

export async function refreshModelPricingCatalog(input: EstimateProxyCostInput): Promise<ModelPricingCatalog | null> {
  const pricingData = await refreshPricingDataCache(input);
  if (!pricingData) return null;
  return buildModelPricingCatalogFromData(pricingData);
}

/**
 * 兜底估算（T1.21）。
 *
 * 名字即语义：这是**估算**，不是价格。返回带 `estimated` 标记的结构，
 * 让调用方能够把"估的"和"上游给的"区分开；旧实现返回裸 number，
 * 一旦落库就与真实价无法分辨。
 */
export interface EstimatedFallbackCost {
  cost: number;
  estimated: true;
}

export function estimateFallbackCost(
  totalTokens: number,
  platform: string,
): EstimatedFallbackCost {
  return { cost: roundCost(tokensToUsd(toPositiveInt(totalTokens), platform)), estimated: true };
}

/**
 * @deprecated 保留同名导出以兼容既有调用点与测试断言（R16：只增不改），
 * 内部已转调 estimateFallbackCost。新代码请直接用后者。
 */
export function fallbackTokenCost(totalTokens: number, platform: string): number {
  return estimateFallbackCost(totalTokens, platform).cost;
}

/**
 * 估算一次代理请求的成本（T1.22）。
 *
 * 返回 null 表示「没有任何价格依据」——此时不得写 0，
 * 因为 0 会被下游读成"这个模型免费"，进而污染路由成本与统计。
 * 配套的连带改动见 sharedSurface / proxyBilling / images / videos 四处。
 */
export async function estimateProxyCost(input: EstimateProxyCostInput): Promise<number | null> {
  const promptTokens = toPositiveInt(input.promptTokens);
  const completionTokens = toPositiveInt(input.completionTokens);
  const totalTokens = toPositiveInt(input.totalTokens || (promptTokens + completionTokens));
  // 三-3：令牌分组决定这一次到底按哪一档扣钱，必须一路带到计价里。
  const groupHint: BillingGroupHint | null = (
    input.tokenGroup || (input.autoGroups && input.autoGroups.length > 0)
  )
    ? { tokenGroup: input.tokenGroup ?? null, autoGroups: input.autoGroups ?? null }
    : null;
  const usage = {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    promptTokensIncludeCache: input.promptTokensIncludeCache,
  };

  try {
    // D12：优先级反转 —— **目录优先，self-log 覆盖兜底**。
    // 旧顺序是"有 override 就完全跳过目录"，于是日志里的比率（常带伪造的默认 1）
    // 会盖掉目录中真实的分组倍率与动态计费档位。
    // 现在先查目录；只有目录确实给不出这个模型的价格时，才用 self-log 元数据。
    const pricingData = await getPricingDataCached(input);
    if (pricingData) {
      const model = resolveModel(input.modelName, pricingData);
      if (model) {
        const catalogCost = calculateModelUsageCost(model, usage, pricingData.groupRatio, undefined, groupHint);
        // 目录算得出 → 直接采用；算不出（缺倍率/表达式不支持）才落到覆盖路径。
        if (catalogCost !== null) return catalogCost;
      }
    }

    if (input.billingPricingOverride) {
      const pricingOverride = buildPricingOverrideModel(input.modelName, input.billingPricingOverride);
      return calculateModelUsageCost(pricingOverride.model, usage, pricingOverride.groupRatio);
    }

    if (!pricingData) {
      // 定价端点完全不可达：估算一个数量级，交由调用方标精度。
      return estimateFallbackCost(totalTokens, input.site.platform).cost;
    }

    // 目录拿到了但没有这个模型、也没有可用覆盖：不再用 token 数瞎猜价格（D8），
    // 因为目录存在就说明上游有能力给出真价，缺条目更可能是名字没对上。
    return null;
  } catch {
    return estimateFallbackCost(totalTokens, input.site.platform).cost;
  }
}

async function fetchJsonViaNewApiShield(url: string, token: string): Promise<unknown> {
  for (const cookie of buildNewApiCookieCandidates(token)) {
    const result = await fetchJsonWithShieldCookieRetry(url, {
      headers: { Cookie: cookie },
    });
    if (result.data) return result.data;
  }

  return null;
}

export async function buildProxyBillingDetails(input: EstimateProxyCostInput): Promise<ProxyBillingDetails | null> {
  const promptTokens = toPositiveInt(input.promptTokens);
  const completionTokens = toPositiveInt(input.completionTokens);
  const totalTokens = toPositiveInt(input.totalTokens || (promptTokens + completionTokens));
  // 三-3：与 estimateProxyCost 用同一份分组提示，否则成本与明细会对不上。
  const groupHint: BillingGroupHint | null = (
    input.tokenGroup || (input.autoGroups && input.autoGroups.length > 0)
  )
    ? { tokenGroup: input.tokenGroup ?? null, autoGroups: input.autoGroups ?? null }
    : null;
  const usage = {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    promptTokensIncludeCache: input.promptTokensIncludeCache,
  };

  try {
    // D12：与 estimateProxyCost 保持同一优先级（目录优先、self-log 覆盖兜底），
    // 否则会出现"成本按目录算、明细按日志算"的口径分裂。
    const pricingData = await getPricingDataCached(input);
    if (pricingData) {
      const model = resolveModel(input.modelName, pricingData);
      if (model && model.quotaType !== 1) {
        const catalogDetails = calculateModelUsageBreakdown(model, usage, pricingData.groupRatio, undefined, groupHint);
        if (catalogDetails) return catalogDetails;
      }
    }

    if (input.billingPricingOverride) {
      const pricingOverride = buildPricingOverrideModel(input.modelName, input.billingPricingOverride);
      return calculateModelUsageBreakdown(pricingOverride.model, usage, pricingOverride.groupRatio);
    }

    return null;
  } catch {
    return null;
  }
}
