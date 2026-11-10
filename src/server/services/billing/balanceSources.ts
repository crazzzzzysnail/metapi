/**
 * 余额来源与精度契约（S5d / T7.1）。
 *
 * ## 为什么需要这个模块
 *
 * `BalanceInfo.balance` 是一个裸 number，界面无从判断它是"上游给的准确值"、
 * "按额度换算的近似值"、还是"根本没读到"。0 尤其危险 —— 它会被读成"余额已用尽"，
 * 进而触发预警、影响路由打分。
 *
 * ## 实测确立的三条判据（2026-11-08，真实上游 siteC）
 *   ① `/api/usage/token/` 在 `unlimited_quota: true` 时，
 *      `total_granted / total_available` 不承载信息（实测 granted 只有 1 位数、
 *      按标尺换算得出负余额）→ **必须视为无限，不得显示金额**；
 *   ② OpenAI 兼容端点的 `hard_limit_usd / soft_limit_usd / system_hard_limit_usd`
 *      普遍返回 ≥1e6 的哨兵值（实测三个字段全是 9 位数）→ **不是可用余额**；
 *   ③ `/v1/dashboard/billing/usage` 的 `total_usage` 是**美分**口径，需 ÷100。
 */

/** 余额来源。source 用于排查与优先级判定，不参与数值合并（R14：冲突不合并）。 */
export type BalanceSource =
  | 'session-user-self'        // new-api 家族 /api/user/self（账号钱包）
  | 'apikey-token-usage'       // new-api 家族 /api/usage/token/（令牌配额）
  | 'apikey-openai-billing'    // OpenAI 兼容 dashboard 双端点
  | 'apikey-sub2api-usage'     // sub2api /v1/usage
  | 'manual'                   // 用户手工维护
  | 'unknown';

export type BalancePrecision = 'exact' | 'approximate' | 'unknown';

/** 无法给出余额时的原因码，供 UI 说清"为什么没有数字"。 */
export type BalanceUnavailableReason =
  | 'no-capable-source'
  | 'all-sources-failed'
  | 'unlimited-quota'          // 无限配额：本就没有余额概念，不是读失败
  | 'sentinel-limit'           // 上游返回哨兵上限，不可当作余额
  | 'endpoint-unauthorized'
  | 'endpoint-unreachable'
  | 'malformed-payload';

export interface BalanceEvidence {
  source: BalanceSource;
  precision: BalancePrecision;
  reason?: BalanceUnavailableReason;
  capturedAt: number;
}

/**
 * 遥测结果结构。
 *
 * 关键约定：**金额字段全部可选**。缺省的含义是"该来源不提供这个量"，
 * 而不是 0。把"没有"塌成 0 是本方案要消灭的头号错误。
 */
export interface TelemetryAmounts {
  /** 剩余可用（美元）。无限配额时为 undefined。 */
  balanceUsd?: number;
  /** 已消耗（美元）。 */
  totalUsedUsd?: number;
  /** 总额度（美元）。无限配额时为 undefined。 */
  totalGrantedUsd?: number;
  /** 上游明示无限配额。为 true 时上面两个金额字段必然缺省。 */
  unlimitedQuota?: boolean;
  /** 到期时间（秒级或毫秒级时间戳，由解析层归一为毫秒）。 */
  expiresAtMs?: number;
}

export interface BalanceObservation extends TelemetryAmounts {
  evidence: BalanceEvidence;
}

/** OpenAI 兼容端点用作"无限制"哨兵的阈值（与 hub 同判据）。 */
export const BILLING_LIMIT_SENTINEL_USD = 1_000_000;

/**
 * null / undefined / 空串 → **缺省**（不是 0）。
 *
 * 这是本模块最容易写错的一处：`Number('') === 0`、`Number(null) === 0`，
 * 若直接转换，上游"没给字段"会被当成"给了 0"，于是余额显示成 $0.00、
 * 预警误判"已用尽"——正是整个方案要消灭的语义混淆。
 */
function parseFinite(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // 空串与纯空白是"没填"，不是数值 0
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 取正有限数；非法/非有限/缺省返回 undefined（绝不返回 0 冒充有效值）。 */
export function toFinitePositive(value: unknown): number | undefined {
  const n = parseFinite(value);
  return n !== undefined && n > 0 ? n : undefined;
}

/**
 * 允许 0 的有限数（"已用完"是合法状态，与"不知道"必须区分）。
 * 注意：0 只有在字段**确实存在**时才返回，缺省仍是 undefined。
 */
export function toFiniteNonNegative(value: unknown): number | undefined {
  const n = parseFinite(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

/** 上游时间戳可能是秒或毫秒，统一成毫秒；非法返回 undefined。 */
export function normalizeTimestampMs(value: unknown): number | undefined {
  const n = toFiniteNonNegative(value);
  if (n === undefined) return undefined;
  // 10 位以内按秒处理（2286 年之前的秒级时间戳都 ≤ 10 位）
  return n < 1e11 ? n * 1000 : n;
}

/**
 * 额度整数 → 美元。
 * 标尺来自站点档案或平台默认表，禁止硬编码 500000。
 */
export function quotaToUsdAmount(
  quota: number | undefined,
  quotaPerUnit: number,
): number | undefined {
  if (quota === undefined || !Number.isFinite(quota)) return undefined;
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) return undefined;
  return Math.max(0, quota) / quotaPerUnit;
}

/** 构造"未知"观测，reason 必填 —— 让调用方能说明原因而不是显示 $0。 */
export function unknownBalanceObservation(
  reason: BalanceUnavailableReason,
  source: BalanceSource = 'unknown',
  capturedAt: number = Date.now(),
): BalanceObservation {
  return {
    evidence: { source, precision: 'unknown', reason, capturedAt },
  };
}
