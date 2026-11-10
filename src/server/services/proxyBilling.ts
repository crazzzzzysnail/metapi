import {
  buildProxyBillingDetails,
  estimateProxyCost,
  type ProxyBillingDetails,
  type ProxyBillingPricingOverride,
} from './modelPricingService.js';
import type { SelfLogBillingMeta } from './proxyUsageFallbackService.js';

interface ProxyBillingUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  promptTokensIncludeCache: boolean | null;
}

interface ResolvedProxyUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  recoveredFromSelfLog: boolean;
  estimatedCostFromQuota: number;
  selfLogBillingMeta: SelfLogBillingMeta | null;
}

interface ResolveProxyLogBillingInput {
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
  /** 本次请求使用的令牌分组（三-3）；未知时传 null，由计价层按未知处理。 */
  tokenGroup?: string | null;
  /** 令牌的 auto 链路（上游 /api/token/ 的 auto_groups）。 */
  autoGroups?: string[] | null;
  parsedUsage: ProxyBillingUsageSummary;
  resolvedUsage: ResolvedProxyUsageSummary;
}

function toPricingOverride(meta: SelfLogBillingMeta | null): ProxyBillingPricingOverride | null {
  if (!meta) return null;
  return {
    modelRatio: meta.modelRatio,
    completionRatio: meta.completionRatio,
    cacheRatio: meta.cacheRatio,
    cacheCreationRatio: meta.cacheCreationRatio,
    groupRatio: meta.groupRatio,
  };
}

export async function resolveProxyLogBilling(
  input: ResolveProxyLogBillingInput,
): Promise<{ estimatedCost: number | null; billingDetails: ProxyBillingDetails | null }> {
  const selfLogMeta = input.resolvedUsage.selfLogBillingMeta;
  const billingPricingOverride = toPricingOverride(selfLogMeta);
  const cacheReadTokens = selfLogMeta?.cacheReadTokens ?? input.parsedUsage.cacheReadTokens;
  const cacheCreationTokens = selfLogMeta?.cacheCreationTokens ?? input.parsedUsage.cacheCreationTokens;
  const promptTokensIncludeCache = selfLogMeta?.promptTokensIncludeCache
    ?? input.parsedUsage.promptTokensIncludeCache;

  const billingInput = {
    site: input.site,
    account: input.account,
    modelName: input.modelName,
    // 三-3：把令牌分组带进计价，auto 链路按上游命中顺序解析。
    tokenGroup: input.tokenGroup ?? null,
    autoGroups: input.autoGroups ?? null,
    promptTokens: input.resolvedUsage.promptTokens,
    completionTokens: input.resolvedUsage.completionTokens,
    totalTokens: input.resolvedUsage.totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    promptTokensIncludeCache,
    billingPricingOverride,
  };

  let estimatedCost = await estimateProxyCost(billingInput);
  const billingDetails = await buildProxyBillingDetails(billingInput);

  // T1.24：estimatedCost 现在可能是 null（无任何价格依据）。
  // null <= 0 在 JS 里恰好为 true，但那是巧合而非语义，必须显式判空。
  if (
    input.resolvedUsage.estimatedCostFromQuota > 0
    && (input.resolvedUsage.recoveredFromSelfLog || estimatedCost === null || estimatedCost <= 0)
  ) {
    estimatedCost = input.resolvedUsage.estimatedCostFromQuota;
  }

  return {
    estimatedCost,
    billingDetails,
  };
}
