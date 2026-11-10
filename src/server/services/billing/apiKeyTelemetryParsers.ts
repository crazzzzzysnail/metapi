/**
 * API-key 余额遥测解析（S5d / T7.2、T7.3、T7.4）。
 *
 * 全部是纯函数：给响应体、出金额观测。网络调用在 apiKeyTelemetryService 里，
 * 这样三条判据（无限配额、哨兵上限、美分口径）可被单测直接覆盖真实形态。
 */

import {
  BILLING_LIMIT_SENTINEL_USD,
  normalizeTimestampMs,
  quotaToUsdAmount,
  toFiniteNonNegative,
  toFinitePositive,
  type BalanceObservation,
  type BalanceUnavailableReason,
  type TelemetryAmounts,
} from './balanceSources.js';
import { unknownBalanceObservation } from './balanceSources.js';

function dataOf(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const inner = (payload as any).data;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
  return payload as Record<string, unknown>;
}

/**
 * 到期时间归一。
 * new-api 家族用 `-1` 表达"永不过期"（实测 siteC 即为此值），
 * 这不是一个可展示的时间戳，必须与"未提供"同样处理。
 */
function parseExpiresAtMs(value: unknown): number | undefined {
  const raw = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  return normalizeTimestampMs(raw);
}

/**
 * new-api 家族 `/api/usage/token/`（T7.2）。
 *
 * 实测字段：total_granted / total_used / total_available / unlimited_quota / expires_at
 * 关键分支：`unlimited_quota === true` 或 granted 为负 → 额度字段不承载信息，
 * 只报"无限配额"这一事实，绝不换算出金额（否则会显示成负的剩余）。
 */
export function parseNewApiTokenUsage(
  payload: unknown,
  quotaPerUnit: number,
): BalanceObservation {
  const data = dataOf(payload);
  const capturedAt = Date.now();

  const rawGranted = toFiniteNonNegative(data.total_granted);
  const totalUsed = toFiniteNonNegative(data.total_used);
  const totalAvailable = toFiniteNonNegative(data.total_available);

  // 上游可能用 true 或负数表达无限（hub 侧两条都认，这里保持同等宽严）
  const unlimited = data.unlimited_quota === true
    || (typeof data.total_granted === 'number' && Number.isFinite(data.total_granted) && data.total_granted < 0);

  if (unlimited) {
    return {
      unlimitedQuota: true,
      ...(totalUsed !== undefined
        ? { totalUsedUsd: quotaToUsdAmount(totalUsed, quotaPerUnit) }
        : {}),
      ...(parseExpiresAtMs(data.expires_at) !== undefined
        ? { expiresAtMs: parseExpiresAtMs(data.expires_at) }
        : {}),
      evidence: {
        source: 'apikey-token-usage',
        precision: 'approximate',
        // 无限配额不是"读失败"，但也没有可显示的余额：标 unknown 并给出准确原因
        reason: 'unlimited-quota' satisfies BalanceUnavailableReason,
        capturedAt,
      },
    };
  }

  const balanceUsd = quotaToUsdAmount(totalAvailable, quotaPerUnit);
  const totalGrantedUsd = rawGranted !== undefined
    ? quotaToUsdAmount(rawGranted, quotaPerUnit)
    : undefined;
  const totalUsedUsd = totalUsed !== undefined
    ? quotaToUsdAmount(totalUsed, quotaPerUnit)
    : undefined;

  if (balanceUsd === undefined && totalUsedUsd === undefined) {
    return unknownBalanceObservation('malformed-payload', 'apikey-token-usage', capturedAt);
  }

  const amounts: TelemetryAmounts = {
    ...(balanceUsd !== undefined ? { balanceUsd } : {}),
    ...(totalUsedUsd !== undefined ? { totalUsedUsd } : {}),
    ...(totalGrantedUsd !== undefined ? { totalGrantedUsd } : {}),
  };
  const expiresAtMs = parseExpiresAtMs(data.expires_at);
  if (expiresAtMs !== undefined) amounts.expiresAtMs = expiresAtMs;

  return {
    ...amounts,
    evidence: {
      source: 'apikey-token-usage',
      // 额度→美元涉及除法与上游取整，属近似；只有 session 侧才敢称 exact
      precision: 'approximate',
      capturedAt,
    },
  };
}

/**
 * OpenAI 兼容 `/v1/dashboard/billing/subscription` + `/usage`（T7.3）。
 *
 * 实测：siteC 三个 limit 字段全是 ≥1e6 的哨兵值 —— 若不过滤会把"无限制"
 * 显示成"还剩一百万美元"。同时 `total_usage` 是**美分**，必须 ÷100。
 */
export function parseOpenAiBillingUsage(
  subscriptionPayload: unknown,
  usagePayload: unknown,
): BalanceObservation {
  const capturedAt = Date.now();
  const sub = dataOf(subscriptionPayload);
  const usage = dataOf(usagePayload);

  // balance 优先（部分网关直接给可用余额，单位即美元）
  const directBalance = toFiniteNonNegative(sub.balance);
  if (directBalance !== undefined) {
    return {
      balanceUsd: directBalance,
      evidence: { source: 'apikey-openai-billing', precision: 'exact', capturedAt },
    };
  }

  const hardLimit = toFiniteNonNegative(sub.hard_limit_usd);
  const totalUsageRaw = toFiniteNonNegative(usage.total_usage);
  // OpenAI 约定 total_usage 以美分计；缺省时部分网关改用 used_usd（已是美元）
  const usedUsd = totalUsageRaw !== undefined
    ? totalUsageRaw / 100
    : toFiniteNonNegative(usage.used_usd);

  // ② 哨兵判定：≥1e6 视为"无限制"而非余额
  if (hardLimit !== undefined && hardLimit >= BILLING_LIMIT_SENTINEL_USD) {
    if (usedUsd === undefined) {
      return unknownBalanceObservation('sentinel-limit', 'apikey-openai-billing', capturedAt);
    }
    // 只能可靠地报"已消耗"，不能报剩余
    return {
      totalUsedUsd: usedUsd,
      evidence: {
        source: 'apikey-openai-billing',
        precision: 'approximate',
        reason: 'sentinel-limit',
        capturedAt,
      },
    };
  }

  if (hardLimit === undefined || usedUsd === undefined) {
    return unknownBalanceObservation('malformed-payload', 'apikey-openai-billing', capturedAt);
  }

  return {
    balanceUsd: Math.max(0, hardLimit - usedUsd),
    totalGrantedUsd: hardLimit,
    totalUsedUsd: usedUsd,
    evidence: { source: 'apikey-openai-billing', precision: 'approximate', capturedAt },
  };
}

/**
 * sub2api `/v1/usage`（T7.4）。
 *
 * 该上游的量纲未在 metapi 侧实测确认，因此**只接受明确标注美元语义的字段**，
 * 其它一律 unknown —— 拿猜测的单位算钱是本方案反复强调要避免的错误。
 */
export function parseSub2ApiUsage(payload: unknown): BalanceObservation {
  const capturedAt = Date.now();
  const data = dataOf(payload);

  // 优先美元语义字段；找不到就不猜
  const balanceUsd = toFiniteNonNegative(data.balance_usd ?? data.remaining_usd);
  const totalUsedUsd = toFiniteNonNegative(data.used_usd ?? data.usage_usd);

  if (balanceUsd === undefined && totalUsedUsd === undefined) {
    return unknownBalanceObservation('malformed-payload', 'apikey-sub2api-usage', capturedAt);
  }

  return {
    ...(balanceUsd !== undefined ? { balanceUsd } : {}),
    ...(totalUsedUsd !== undefined ? { totalUsedUsd } : {}),
    evidence: { source: 'apikey-sub2api-usage', precision: 'approximate', capturedAt },
  };
}
