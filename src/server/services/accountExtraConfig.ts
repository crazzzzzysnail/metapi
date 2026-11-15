import { config } from '../config.js';
import type { SubscriptionPlanSummary, SubscriptionSummary } from './platforms/base.js';

type AutoReloginConfig = {
  username?: unknown;
  passwordCipher?: unknown;
  updatedAt?: unknown;
};

type Sub2ApiAuthConfig = {
  refreshToken?: unknown;
  tokenExpiresAt?: unknown;
};

type Sub2ApiSubscriptionConfig = {
  updatedAt?: unknown;
  activeCount?: unknown;
  totalUsedUsd?: unknown;
  subscriptions?: unknown;
};

export type AccountCredentialMode = 'auto' | 'session' | 'apikey';

const VALID_CREDENTIAL_MODES = new Set<AccountCredentialMode>([
  'auto',
  'session',
  'apikey',
]);

type AccountExtraConfig = {
  platformUserId?: unknown;
  credentialMode?: unknown;
  useSystemProxy?: unknown;
  oauth?: {
    provider?: unknown;
    [key: string]: unknown;
  };
  autoRelogin?: AutoReloginConfig;
  sub2apiAuth?: Sub2ApiAuthConfig;
  sub2apiSubscription?: Sub2ApiSubscriptionConfig;
  manualBalanceUsd?: unknown;
  [key: string]: unknown;
};

type ExtraConfigInput = string | Record<string, unknown> | null | undefined;
type OauthProviderCarrier = {
  extraConfig?: ExtraConfigInput;
  oauthProvider?: unknown;
};
type OauthProviderInput = ExtraConfigInput | OauthProviderCarrier;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOauthProviderCarrier(value: unknown): value is OauthProviderCarrier {
  return isRecord(value) && ('extraConfig' in value || 'oauthProvider' in value);
}

function parseExtraConfig(extraConfig?: ExtraConfigInput): AccountExtraConfig {
  if (!extraConfig) return {};
  if (isRecord(extraConfig)) return extraConfig as AccountExtraConfig;
  if (typeof extraConfig !== 'string') return {};
  try {
    const parsed = JSON.parse(extraConfig) as unknown;
    if (!isRecord(parsed)) return {};
    return parsed as AccountExtraConfig;
  } catch {
    return {};
  }
}

function normalizeUserId(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw.trim(), 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return undefined;
}

function normalizeNonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTimestampMs(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function normalizeNonNegativeNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.round(raw * 1_000_000) / 1_000_000;
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed * 1_000_000) / 1_000_000;
    }
  }
  return undefined;
}

function normalizeIsoDateTime(raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const ms = raw > 10_000_000_000 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return new Date(ms).toISOString();
  }

  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return undefined;
}

export function normalizeCredentialMode(raw: unknown): AccountCredentialMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!VALID_CREDENTIAL_MODES.has(normalized as AccountCredentialMode)) return undefined;
  return normalized as AccountCredentialMode;
}

export function getProxyUrlFromExtraConfig(extraConfig?: ExtraConfigInput): string | null {
  const parsed = parseExtraConfig(extraConfig);
  return normalizeNonEmptyString(parsed.proxyUrl) ?? null;
}

export function getUseSystemProxyFromExtraConfig(extraConfig?: ExtraConfigInput): boolean {
  const parsed = parseExtraConfig(extraConfig);
  return parsed.useSystemProxy === true;
}

export function resolveProxyUrlFromExtraConfig(
  extraConfig?: ExtraConfigInput,
  systemProxyUrl = config.systemProxyUrl,
): string | null {
  const explicitProxyUrl = getProxyUrlFromExtraConfig(extraConfig);
  if (explicitProxyUrl) return explicitProxyUrl;
  if (!getUseSystemProxyFromExtraConfig(extraConfig)) return null;
  return normalizeNonEmptyString(systemProxyUrl) ?? null;
}

export function getPlatformUserIdFromExtraConfig(extraConfig?: ExtraConfigInput): number | undefined {
  const parsed = parseExtraConfig(extraConfig);
  return normalizeUserId(parsed.platformUserId);
}

export function getCredentialModeFromExtraConfig(extraConfig?: ExtraConfigInput): AccountCredentialMode | undefined {
  const parsed = parseExtraConfig(extraConfig);
  return normalizeCredentialMode(parsed.credentialMode);
}

export function getOauthProviderFromExtraConfig(extraConfig?: ExtraConfigInput): string | undefined {
  const parsed = parseExtraConfig(extraConfig);
  return normalizeNonEmptyString(parsed.oauth?.provider);
}

function getOauthProvider(input?: OauthProviderInput): string | undefined {
  if (!isOauthProviderCarrier(input)) {
    return getOauthProviderFromExtraConfig(input);
  }
  return normalizeNonEmptyString(input.oauthProvider)
    ?? getOauthProviderFromExtraConfig(input.extraConfig);
}

export function hasOauthProvider(input?: OauthProviderInput): boolean {
  return !!getOauthProvider(input);
}

type DirectAccountRoutingInput = {
  accessToken?: string | null;
  apiToken?: string | null;
  extraConfig?: ExtraConfigInput;
  oauthProvider?: string | null;
};

function hasCredentialValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function supportsDirectAccountRoutingConnection(account: DirectAccountRoutingInput): boolean {
  const credentialMode = getCredentialModeFromExtraConfig(account.extraConfig);
  if (hasOauthProvider(account)) {
    return hasCredentialValue(account.accessToken) || hasCredentialValue(account.apiToken);
  }
  if (credentialMode === 'apikey') {
    return hasCredentialValue(account.apiToken);
  }
  if (credentialMode === 'session') {
    return false;
  }
  if (hasCredentialValue(account.accessToken)) return false;
  return hasCredentialValue(account.apiToken);
}

export function requiresManagedAccountTokens(account: DirectAccountRoutingInput): boolean {
  const credentialMode = getCredentialModeFromExtraConfig(account.extraConfig);
  if (hasOauthProvider(account)) return false;
  if (credentialMode === 'apikey') return false;
  if (credentialMode === 'session') return true;
  if (hasCredentialValue(account.apiToken) && !hasCredentialValue(account.accessToken)) return false;
  return true;
}

export type ManagedSub2ApiAuth = {
  refreshToken: string;
  tokenExpiresAt?: number;
};

export type StoredSub2ApiSubscriptionSummary = SubscriptionSummary & {
  updatedAt: number;
};

export function getSub2ApiAuthFromExtraConfig(extraConfig?: ExtraConfigInput): ManagedSub2ApiAuth | null {
  const parsed = parseExtraConfig(extraConfig);
  const raw = parsed.sub2apiAuth;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const refreshToken = normalizeNonEmptyString(raw.refreshToken);
  if (!refreshToken) return null;
  const tokenExpiresAt = normalizeTimestampMs(raw.tokenExpiresAt);
  return tokenExpiresAt
    ? { refreshToken, tokenExpiresAt }
    : { refreshToken };
}

function normalizeSubscriptionItem(raw: unknown): SubscriptionPlanSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const item = raw as Record<string, unknown>;
  const normalized: SubscriptionPlanSummary = {};

  const id = normalizeUserId(item.id);
  if (id) normalized.id = id;

  const groupId = normalizeUserId(item.groupId ?? item.group_id);
  if (groupId) normalized.groupId = groupId;

  const groupName = normalizeNonEmptyString(item.groupName ?? item.group_name);
  if (groupName) normalized.groupName = groupName;

  const status = normalizeNonEmptyString(item.status);
  if (status) normalized.status = status;

  const expiresAt = normalizeIsoDateTime(
    item.expiresAt
    ?? item.expires_at
    ?? item.expiredAt
    ?? item.expired_at
    ?? item.endAt
    ?? item.end_at,
  );
  if (expiresAt) normalized.expiresAt = expiresAt;

  const dailyUsedUsd = normalizeNonNegativeNumber(item.dailyUsedUsd ?? item.daily_used_usd);
  if (dailyUsedUsd !== undefined) normalized.dailyUsedUsd = dailyUsedUsd;

  const dailyLimitUsd = normalizeNonNegativeNumber(item.dailyLimitUsd ?? item.daily_limit_usd);
  if (dailyLimitUsd !== undefined) normalized.dailyLimitUsd = dailyLimitUsd;

  const weeklyUsedUsd = normalizeNonNegativeNumber(item.weeklyUsedUsd ?? item.weekly_used_usd);
  if (weeklyUsedUsd !== undefined) normalized.weeklyUsedUsd = weeklyUsedUsd;

  const weeklyLimitUsd = normalizeNonNegativeNumber(item.weeklyLimitUsd ?? item.weekly_limit_usd);
  if (weeklyLimitUsd !== undefined) normalized.weeklyLimitUsd = weeklyLimitUsd;

  const monthlyUsedUsd = normalizeNonNegativeNumber(item.monthlyUsedUsd ?? item.monthly_used_usd);
  if (monthlyUsedUsd !== undefined) normalized.monthlyUsedUsd = monthlyUsedUsd;

  const monthlyLimitUsd = normalizeNonNegativeNumber(item.monthlyLimitUsd ?? item.monthly_limit_usd);
  if (monthlyLimitUsd !== undefined) normalized.monthlyLimitUsd = monthlyLimitUsd;

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeSubscriptionItems(raw: unknown): SubscriptionPlanSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeSubscriptionItem(item))
    .filter((item): item is SubscriptionPlanSummary => !!item);
}

export function normalizeSub2ApiSubscriptionSummary(
  raw: unknown,
): StoredSub2ApiSubscriptionSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const body = raw as Record<string, unknown>;
  const subscriptions = normalizeSubscriptionItems(body.subscriptions);
  const activeCount = normalizeNonNegativeNumber(body.activeCount ?? body.active_count);
  const totalUsedUsd = normalizeNonNegativeNumber(body.totalUsedUsd ?? body.total_used_usd);
  const updatedAt = normalizeTimestampMs(body.updatedAt ?? body.updated_at);

  return {
    activeCount: Math.trunc(activeCount ?? subscriptions.length),
    totalUsedUsd: totalUsedUsd ?? 0,
    subscriptions,
    updatedAt: updatedAt ?? Date.now(),
  };
}

export function buildStoredSub2ApiSubscriptionSummary(
  summary: SubscriptionSummary,
  updatedAt = Date.now(),
): StoredSub2ApiSubscriptionSummary {
  return normalizeSub2ApiSubscriptionSummary({
    ...summary,
    updatedAt,
  }) || {
    activeCount: Math.max(0, Math.trunc(summary.activeCount || 0)),
    totalUsedUsd: normalizeNonNegativeNumber(summary.totalUsedUsd) ?? 0,
    subscriptions: normalizeSubscriptionItems(summary.subscriptions),
    updatedAt,
  };
}

export function getSub2ApiSubscriptionFromExtraConfig(
  extraConfig?: ExtraConfigInput,
): StoredSub2ApiSubscriptionSummary | null {
  const parsed = parseExtraConfig(extraConfig);
  return normalizeSub2ApiSubscriptionSummary(parsed.sub2apiSubscription);
}

export function guessPlatformUserIdFromUsername(username?: string | null): number | undefined {
  const text = (username || '').trim();
  if (!text) return undefined;
  const match = text.match(/(\d{3,8})$/);
  if (!match?.[1]) return undefined;
  return normalizeUserId(match[1]);
}

export function resolvePlatformUserId(extraConfig?: ExtraConfigInput, username?: string | null): number | undefined {
  return getPlatformUserIdFromExtraConfig(extraConfig) || guessPlatformUserIdFromUsername(username);
}

export function mergeAccountExtraConfig(
  extraConfig: ExtraConfigInput,
  patch: Record<string, unknown>,
): string {
  const merged: Record<string, unknown> = {
    ...parseExtraConfig(extraConfig),
    ...patch,
  };
  return JSON.stringify(merged);
}

/**
 * 余额可得性（F8 第 1 期）。
 *
 * 存在理由：`accounts.balance` 有 schema 默认值 0，而"没读到余额"的分支刻意不写库
 * （沿用旧值），于是库里那个 0 到底代表"账户确实没钱"还是"从没读到过"就丢了。
 * 服务端其实已经算出过原因（`balanceSources.ts` 的 `BalanceUnavailableReason`、
 * `apiKeyTelemetryService` 的 observations），只是没人落地——这里就是那块落地的砖。
 *
 * **归一化原则：宁可退回 unknown，绝不猜测。**脏数据一律降级成
 * `{status:'unknown', reason:'no-capable-source'}`，因为把坏数据解释成"已知金额"
 * 或"不适用"都会直接改变界面是否显示 `—`，属于谎报；只有明确合法的值才保留。
 */
export type BalanceAvailabilityStatus = 'known' | 'unavailable' | 'not-applicable' | 'unknown';

/** 与 balanceSources.ts 的 BalanceUnavailableReason 同集合 + 'manual-set'（手动填值） */
export const BALANCE_UNAVAILABLE_REASONS = [
  'no-capable-source',
  'all-sources-failed',
  'unlimited-quota',
  'sentinel-limit',
  'endpoint-unauthorized',
  'endpoint-unreachable',
  'malformed-payload',
  'manual-set',
] as const;

export type BalanceUnavailableReason = (typeof BALANCE_UNAVAILABLE_REASONS)[number];

export interface BalanceEvidence {
  status: BalanceAvailabilityStatus;
  reason: BalanceUnavailableReason | null;
  /** 结论来自哪条链路：遥测 / session / 手动 / 平台声明 */
  source: string | null;
  /** 毫秒时间戳；用于判断这条证据是不是很久以前的 */
  capturedAt: number | null;
}

const FALLBACK_BALANCE_EVIDENCE: BalanceEvidence = {
  status: 'unknown',
  reason: 'no-capable-source',
  source: null,
  capturedAt: null,
};

function normalizeCapturedAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function normalizeBalanceEvidence(raw: unknown): BalanceEvidence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const status = input.status;
  if (status !== 'known' && status !== 'unavailable' && status !== 'not-applicable') {
    // 'unknown' 与任何非法值都走这里：调用方据此回落到推断链，而不是相信这份档案
    return null;
  }
  const reason = BALANCE_UNAVAILABLE_REASONS.includes(
    (typeof input.reason === 'string' ? input.reason : '') as BalanceUnavailableReason,
  )
    ? (input.reason as BalanceUnavailableReason)
    : null;
  const source = typeof input.source === 'string' && input.source.trim()
    ? input.source.trim().slice(0, 64)
    : null;
  return { status, reason, source, capturedAt: normalizeCapturedAt(input.capturedAt) };
}

/**
 * 删除余额证据（用于清除手动余额时）。
 *
 * 不能用 `setBalanceEvidenceInExtraConfig({status:'unknown'})` 代替：归一化只接受
 * known/unavailable/not-applicable 三态，'unknown' 会被判为非法并原样保留旧证据，
 * 结果就是"手动值删了、证据还写着 known/manual"，界面继续把旧数字当真实余额。
 */
export function clearBalanceEvidenceInExtraConfig(extraConfig: ExtraConfigInput): string {
  const parsed = parseExtraConfig(extraConfig);
  delete parsed.balanceEvidence;
  return JSON.stringify(parsed);
}

/**
 * 读取已落地的余额证据。返回 null 表示**库里没有可用证据**，调用方应改用推断链
 * （runtimeHealth + lastBalanceRefresh），而不是当成"未知"直接显示 —。
 */
export function getBalanceEvidenceFromExtraConfig(
  extraConfig?: ExtraConfigInput,
): BalanceEvidence | null {
  const parsed = parseExtraConfig(extraConfig);
  return normalizeBalanceEvidence(parsed.balanceEvidence);
}

/**
 * 写入余额证据。capturedAt 缺省取当前时刻；status/reason 非法时整条丢弃并返回原串，
 * 免得把脏值塞进 extra_config 让后续读取永远走降级分支。
 */
export function setBalanceEvidenceInExtraConfig(
  extraConfig: ExtraConfigInput,
  evidence: {
    status: BalanceAvailabilityStatus;
    reason?: BalanceUnavailableReason | null;
    source?: string | null;
    capturedAt?: number | string | null;
  },
): string {
  const normalized = normalizeBalanceEvidence({
    status: evidence.status,
    reason: evidence.reason ?? null,
    source: evidence.source ?? null,
    capturedAt: evidence.capturedAt ?? Date.now(),
  });
  if (!normalized) return JSON.stringify({ ...parseExtraConfig(extraConfig) });
  return mergeAccountExtraConfig(extraConfig, { balanceEvidence: normalized });
}

/** 兜底用的"无结论"证据；导出是为了避免各处再各造一份不同的形状 */
export function fallbackBalanceEvidence(): BalanceEvidence {
  return { ...FALLBACK_BALANCE_EVIDENCE };
}

/**
 * 把一个连接的余额证据归并成站点级三态（F8 第 1 期，给站点列表的汇总余额用）。
 *
 * 判据是**集合里最可信的那条**：只要有一个连接读到了数字，站点就有余额可报；
 * 全都没读到时才降级。之所以要区分 unavailable 与 not-applicable —— 前者是
 * "本该有但这次没拿到"（值得重试），后者是"这类连接压根没有余额概念"
 * （无限配额令牌、纯代理通道），重试也没用，界面文案不该混为一谈。
 *
 * 优先级 known > unavailable > not-applicable > unknown：unknown 放最后，
 * 是因为它代表"证据缺失"（存量老数据），不该盖掉任何一条明确结论。
 */
export type SiteBalanceAvailability = 'known' | 'unavailable' | 'not-applicable' | 'unknown';

export function reduceSiteBalanceAvailability(
  evidences: Array<BalanceEvidence | null | undefined>,
): SiteBalanceAvailability {
  let hasUnavailable = false;
  let hasNotApplicable = false;
  for (const evidence of evidences) {
    if (!evidence) continue;
    // 走一遍 normalize 再判定：直接信调用方传进来的 status 字符串会把脏值当结论
    const normalized = normalizeBalanceEvidence(evidence);
    if (normalized?.status === 'known') return 'known';
    if (normalized?.status === 'unavailable') hasUnavailable = true;
    else if (normalized?.status === 'not-applicable') hasNotApplicable = true;
  }
  if (hasUnavailable) return 'unavailable';
  if (hasNotApplicable) return 'not-applicable';
  return 'unknown';
}

/**
 * 手动余额（F8 第 3 期）。
 *
 * 存在理由：纯 apikey / 纯代理站点常常没有任何余额接口，刷新永远拿到
 * `no-capable-source`，界面上那个 0 与"真的没钱"无法区分，用户也没有出口。
 * 这里让用户显式填一个 USD 数值，刷新时优先采用它，并且**不再去打上游**
 * （上游本来就没有可读的余额，打了只是浪费一次请求）。
 *
 * 存 extra_config 而不是加列：这个值纯属用户偏好，不参与查询聚合，
 * 加列要走一次对线上库的迁移；同一份 extra_config 里已经放着 sub2apiAuth 等字段。
 */
export function getManualBalanceUsdFromExtraConfig(extraConfig?: ExtraConfigInput): number | null {
  const parsed = parseExtraConfig(extraConfig);
  const raw = parsed.manualBalanceUsd;
  const value = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim() !== ''
      ? Number(raw)
      : Number.NaN;
  // 负数没有意义；0 是合法的手动值（账户确实没钱）
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/** 写入/清除手动余额；传 null 表示清除，让刷新回到自动链路。 */
export function setManualBalanceUsdInExtraConfig(
  extraConfig: ExtraConfigInput,
  value: number | null,
): string {
  if (value === null) {
    const parsed = parseExtraConfig(extraConfig);
    delete parsed.manualBalanceUsd;
    return JSON.stringify(parsed);
  }
  if (!Number.isFinite(value) || value < 0) return JSON.stringify({ ...parseExtraConfig(extraConfig) });
  return mergeAccountExtraConfig(extraConfig, { manualBalanceUsd: value });
}

export function getAutoReloginConfig(extraConfig?: ExtraConfigInput): {
  username: string;
  passwordCipher: string;
} | null {
  const parsed = parseExtraConfig(extraConfig);
  const relogin = parsed.autoRelogin;
  if (!relogin || typeof relogin !== 'object' || Array.isArray(relogin)) return null;

  const username = typeof relogin.username === 'string' ? relogin.username.trim() : '';
  const passwordCipher = typeof relogin.passwordCipher === 'string' ? relogin.passwordCipher.trim() : '';
  if (!username || !passwordCipher) return null;

  return { username, passwordCipher };
}
