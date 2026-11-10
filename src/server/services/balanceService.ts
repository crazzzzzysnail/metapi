import { db, schema } from '../db/index.js';
import { getAdapter } from './platforms/index.js';
import { quotaToUsd } from './billing/quotaScale.js';
import {
  orchestrateApiKeyTelemetry,
  type TelemetryOutcome,
} from './billing/apiKeyTelemetryService.js';
import { eq } from 'drizzle-orm';
import { appendSessionTokenRebindHint, isTokenExpiredError } from './alertRules.js';
import { reportTokenExpired } from './alertService.js';
import {
  buildStoredSub2ApiSubscriptionSummary,
  getAutoReloginConfig,
  getCredentialModeFromExtraConfig,
  getSub2ApiAuthFromExtraConfig,
  mergeAccountExtraConfig,
  resolveProxyUrlFromExtraConfig,
  resolvePlatformUserId,
} from './accountExtraConfig.js';
import { decryptAccountPassword } from './accountCredentialService.js';
import { extractRuntimeHealth, setAccountRuntimeHealth } from './accountHealthService.js';
import { updateTodayIncomeSnapshot } from './todayIncomeRewardService.js';
import type { BalanceInfo } from './platforms/base.js';
import { withAccountProxyOverride, withSiteProxyRequestInit, withSiteRecordProxyRequestInit } from './siteProxy.js';
import {
  isManagedSub2ApiTokenDue,
  isSub2ApiPlatform,
} from './sub2apiManagedAuth.js';
import { refreshSub2ApiManagedSessionSingleflight } from './sub2apiRefreshSingleflight.js';

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

function isApiKeyConnection(account: typeof schema.accounts.$inferSelect): boolean {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit && explicit !== 'auto') return explicit === 'apikey';
  return !(account.accessToken || '').trim();
}

function shouldAttemptAutoRelogin(message?: string | null): boolean {
  if (!message) return false;
  if (isTokenExpiredError({ message })) return true;

  const text = message.toLowerCase();
  return (
    text.includes('access token') ||
    text.includes('new-api-user') ||
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('not login') ||
    text.includes('not logged')
  );
}

function shouldReportExpired(message?: string | null): boolean {
  if (!message) return false;
  return isTokenExpiredError({ message });
}

function isUnsupportedCheckinRuntimeHealth(health: ReturnType<typeof extractRuntimeHealth>): boolean {
  if (!health || health.state !== 'degraded') return false;
  if ((health.source || '').toLowerCase() === 'checkin') return true;
  const reason = (health.reason || '').toLowerCase();
  return (
    reason.includes('checkin endpoint not found') ||
    reason.includes('invalid url (post /api/user/checkin)') ||
    (reason.includes('http 404') && reason.includes('/api/user/checkin')) ||
    reason.includes('unsupported checkin endpoint')
  );
}

const INCOME_LOG_TYPES = [1, 4] as const;
const LOG_PAGE_SIZE = 100;
const LOG_MAX_PAGES = 6;

function supportsTodayIncomeLogFallback(platform?: string | null): boolean {
  const normalized = (platform || '').toLowerCase();
  return (
    normalized === 'new-api' ||
    normalized === 'anyrouter' ||
    normalized === 'one-api' ||
    normalized === 'veloera'
  );
}

function getTodayUnixSecondsRange(now = new Date()): { start: number; end: number } {
  const startDate = new Date(now);
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  return {
    start: Math.floor(startDate.getTime() / 1000),
    end: Math.floor(endDate.getTime() / 1000),
  };
}

function parsePositiveNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function parseIncomeFromContent(content: unknown): number {
  if (typeof content !== 'string') return 0;
  const normalized = content.replace(/,/g, '');
  const match = normalized.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

function extractLogItems(payload: any): Array<{ quota?: unknown; content?: unknown }> {
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function extractLogTotal(payload: any): number | null {
  const candidates = [payload?.data?.total, payload?.total];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value.trim(), 10);
      if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
    }
  }
  return null;
}

async function fetchTodayIncomeFromLogs(params: {
  baseUrl: string;
  accessToken: string;
  platform?: string | null;
  platformUserId?: number;
}): Promise<number | null> {
  const baseUrl = params.baseUrl.trim();
  const accessToken = params.accessToken.trim();
  if (!baseUrl || !accessToken) return null;

  const { fetch } = await import('undici');
  const { start, end } = getTodayUnixSecondsRange();
  const conversionScale = params.platform;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  if (typeof params.platformUserId === 'number' && Number.isFinite(params.platformUserId)) {
    headers['New-Api-User'] = String(Math.trunc(params.platformUserId));
  }

  let hasAnyLogResponse = false;
  let totalIncome = 0;

  for (const logType of INCOME_LOG_TYPES) {
    let page = 1;
    while (page <= LOG_MAX_PAGES) {
      const query = new URLSearchParams({
        p: String(page),
        page_size: String(LOG_PAGE_SIZE),
        type: String(logType),
        token_name: '',
        model_name: '',
        start_timestamp: String(start),
        end_timestamp: String(end),
        group: '',
      });

      try {
        const requestUrl = `${baseUrl}/api/log/self?${query.toString()}`;
        const response = await fetch(requestUrl, await withSiteProxyRequestInit(requestUrl, {
          method: 'GET',
          headers,
        }));
        if (!response.ok) break;

        const payload = await response.json().catch(() => null);
        if (!payload || typeof payload !== 'object') break;
        hasAnyLogResponse = true;

        const items = extractLogItems(payload);
        for (const item of items) {
          const quotaRaw = parsePositiveNumber(item?.quota);
          if (quotaRaw > 0) {
            totalIncome += quotaToUsd(quotaRaw, conversionScale);
            continue;
          }
          totalIncome += parseIncomeFromContent(item?.content);
        }

        const total = extractLogTotal(payload);
        if (items.length === 0) break;
        if (total != null && page * LOG_PAGE_SIZE >= total) break;
        page += 1;
      } catch {
        break;
      }
    }
  }

  if (!hasAnyLogResponse) return null;
  return Math.round(totalIncome * 1_000_000) / 1_000_000;
}

async function tryAutoRelogin(account: any, site: any): Promise<string | null> {
  const adapter = getAdapter(site.platform);
  if (!adapter) return null;

  const relogin = getAutoReloginConfig(account.extraConfig);
  if (!relogin) return null;

  const password = decryptAccountPassword(relogin.passwordCipher);
  if (!password) return null;

  const loginResult = await withAccountProxyOverride(
    resolveProxyUrlFromExtraConfig(account.extraConfig),
    () => adapter.login(site.url, relogin.username, password),
  );
  if (!loginResult.success || !loginResult.accessToken) return null;

  await db.update(schema.accounts)
    .set({
      accessToken: loginResult.accessToken,
      status: account.status === 'expired' ? 'active' : account.status,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.accounts.id, account.id))
    .run();

  return loginResult.accessToken;
}

export async function refreshBalance(accountId: number) {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .all();

  if (rows.length === 0) return null;

  const account = rows[0].accounts;
  const site = rows[0].sites;

  if (isSiteDisabled(site.status)) {
    setAccountRuntimeHealth(account.id, {
      state: 'disabled',
      reason: '站点已禁用',
      source: 'balance',
    });
    return {
      balance: account.balance ?? 0,
      used: account.balanceUsed ?? 0,
      quota: account.quota ?? 0,
      skipped: true,
      reason: 'site_disabled',
    };
  }

  const adapter = getAdapter(site.platform);
  if (!adapter) return null;

  if (isApiKeyConnection(account)) {
    // T7.5：原先这里直接早退（proxy_only），于是"只有 API key"的通道永远刷不出余额，
    // 即便上游明明提供 /api/usage/token/。改为真正走一次遥测编排；
    // 全部失败时仍保持 skipped，且**不写 0**（沿用库里旧值）。
    let telemetry: TelemetryOutcome | null = null;
    try {
      // 代理配置与下方 session 路径同源（此处的 accountProxyUrl 变量在更后面才声明，
      // 早退分支里必须自己取一次，否则会引用到未定义变量）。
      const proxyUrlForTelemetry = resolveProxyUrlFromExtraConfig(account.extraConfig);
      telemetry = await orchestrateApiKeyTelemetry({
        site: { id: site.id, url: site.url, platform: site.platform },
        accountId: account.id,
        sessionBalance: null,
        fetchJson: async (url, init) => withAccountProxyOverride(proxyUrlForTelemetry, async () => {
          const { fetch } = await import('undici');
          const response = await fetch(url, await withSiteProxyRequestInit(url, init as Record<string, unknown>));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        }),
      });
    } catch {
      telemetry = null;
    }

    const adopted = telemetry?.adopted ?? null;

    // 判定顺序很关键：**无限配额必须先于"有没有金额"处理**。
    // 实测 siteC 的 key：unlimited_quota=true 且 total_used≈1546 万额度，
    // 此时 granted/available 不承载信息。若先走金额分支，
    // `balanceUsd ?? 0` 会把"没有余额概念"伪造成"余额 $0"——正是本方案要消灭的错误。
    if (adopted?.unlimitedQuota) {
      return {
        balance: account.balance ?? 0,
        used: adopted.totalUsedUsd ?? account.balanceUsed ?? 0,
        quota: account.quota ?? 0,
        skipped: true,
        source: 'unlimited-quota',
        reason: '无限配额（该令牌不受额度约束）',
      };
    }

    // 只有真正拿到可用余额数字时才写库；仅有"已消耗"不足以构成余额结论。
    if (adopted && typeof adopted.balanceUsd === 'number') {
      return {
        balance: adopted.balanceUsd,
        used: adopted.totalUsedUsd ?? account.balanceUsed ?? 0,
        quota: adopted.totalGrantedUsd ?? adopted.balanceUsd,
        source: 'apikey-telemetry',
      };
    }

    return {
      balance: account.balance ?? 0,
      used: account.balanceUsed ?? 0,
      quota: account.quota ?? 0,
      skipped: true,
      reason: 'proxy_only',
    };
  }

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  let activeAccessToken = account.accessToken;
  let activeExtraConfig = account.extraConfig;
  let balanceInfo: BalanceInfo | null = null;

  const accountProxyUrl = resolveProxyUrlFromExtraConfig(account.extraConfig);

  if (isSub2ApiPlatform(site.platform)) {
    const managedAuth = getSub2ApiAuthFromExtraConfig(activeExtraConfig);
    if (managedAuth?.refreshToken && isManagedSub2ApiTokenDue(managedAuth.tokenExpiresAt)) {
      try {
        const refreshed = await refreshSub2ApiManagedSessionSingleflight({
          account,
          site,
          currentAccessToken: activeAccessToken,
          currentExtraConfig: activeExtraConfig,
        });
        activeAccessToken = refreshed.accessToken;
        activeExtraConfig = refreshed.extraConfig;
      } catch {}
    }
  }
  const readBalance = async (token: string) => withAccountProxyOverride(accountProxyUrl,
    () => adapter.getBalance(site.url, token, platformUserId));
  const handleBalanceError = async (err: any) => {
    const message = appendSessionTokenRebindHint(err?.message || 'unknown error');
    setAccountRuntimeHealth(account.id, {
      state: 'unhealthy',
      reason: message,
      source: 'balance',
    });
    if (shouldReportExpired(message)) {
      await reportTokenExpired({
        accountId: account.id,
        username: account.username,
        siteName: site.name,
        detail: message,
      });
    }
    throw new Error(message);
  };

  try {
    balanceInfo = await readBalance(activeAccessToken);
  } catch (err: any) {
    const message = err?.message || 'unknown error';
    const canTryManagedSub2ApiRefresh =
      isSub2ApiPlatform(site.platform)
      && !!getSub2ApiAuthFromExtraConfig(activeExtraConfig)?.refreshToken
      && shouldAttemptAutoRelogin(message);

    if (canTryManagedSub2ApiRefresh) {
      try {
        const refreshed = await refreshSub2ApiManagedSessionSingleflight({
          account,
          site,
          currentAccessToken: activeAccessToken,
          currentExtraConfig: activeExtraConfig,
        });
        activeAccessToken = refreshed.accessToken;
        activeExtraConfig = refreshed.extraConfig;
        balanceInfo = await readBalance(activeAccessToken);
      } catch (retryErr: any) {
        await handleBalanceError(retryErr);
      }
    } else if (shouldAttemptAutoRelogin(message)) {
      const refreshedAccessToken = await tryAutoRelogin(account, site);
      if (refreshedAccessToken) {
        activeAccessToken = refreshedAccessToken;
        try {
          balanceInfo = await readBalance(activeAccessToken);
        } catch (retryErr: any) {
          await handleBalanceError(retryErr);
        }
      } else {
        await handleBalanceError(err);
      }
    } else {
      await handleBalanceError(err);
    }
  }

  if (!balanceInfo) {
    throw new Error('failed to fetch balance');
  }

  // T2.4：上游明确没有余额接口时，绝不写库、也不标不健康。
  // 旧实现会拿到伪造的 0 并覆盖账户真实余额，界面上显示成"已用尽"。
  if (balanceInfo.unsupported) {
    setAccountRuntimeHealth(account.id, {
      state: 'degraded',
      reason: balanceInfo.unsupportedReason || 'balance API not supported',
      source: 'balance',
    });
    return {
      balance: account.balance ?? 0,
      used: account.balanceUsed ?? 0,
      quota: account.quota ?? 0,
      skipped: true,
      reason: 'balance_unsupported',
    };
  }

  if (
    !(typeof balanceInfo.todayIncome === 'number' && Number.isFinite(balanceInfo.todayIncome)) &&
    supportsTodayIncomeLogFallback(site.platform)
  ) {
    try {
      const fallbackIncome = await withAccountProxyOverride(accountProxyUrl, () => fetchTodayIncomeFromLogs({
        baseUrl: site.url,
        accessToken: activeAccessToken,
        platform: site.platform,
        platformUserId,
      }));
      if (typeof fallbackIncome === 'number' && Number.isFinite(fallbackIncome)) {
        balanceInfo.todayIncome = fallbackIncome;
      }
    } catch {}
  }

  let nextExtraConfig = activeExtraConfig;
  if (typeof balanceInfo.todayIncome === 'number' && Number.isFinite(balanceInfo.todayIncome)) {
    nextExtraConfig = updateTodayIncomeSnapshot(nextExtraConfig, balanceInfo.todayIncome);
  }
  if (balanceInfo.subscriptionSummary && isSub2ApiPlatform(site.platform)) {
    nextExtraConfig = mergeAccountExtraConfig(nextExtraConfig, {
      sub2apiSubscription: buildStoredSub2ApiSubscriptionSummary(balanceInfo.subscriptionSummary),
    });
  }

  const existingRuntimeHealth = extractRuntimeHealth(nextExtraConfig);
  const keepUnsupportedCheckinDegraded = isUnsupportedCheckinRuntimeHealth(existingRuntimeHealth);

  // S5d 范围说明（用户确认）：API-key 遥测**只用于没有 session 的通道**
  // （见上方 isApiKeyConnection 分支）。session 侧本就是账号钱包的权威来源，
  // 再额外发 2–3 个上游请求只为拿诊断信息不划算，故此处不做任何 key 侧调用。
  const updates: Record<string, unknown> = {
    balance: balanceInfo.balance,
    balanceUsed: balanceInfo.used,
    quota: balanceInfo.quota,
    status: account.status === 'expired' ? 'active' : account.status,
    lastBalanceRefresh: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (nextExtraConfig !== account.extraConfig) {
    updates.extraConfig = nextExtraConfig;
  }

  await db.update(schema.accounts)
    .set(updates)
    .where(eq(schema.accounts.id, accountId))
    .run();

  setAccountRuntimeHealth(account.id, {
    state: keepUnsupportedCheckinDegraded ? 'degraded' : 'healthy',
    reason: keepUnsupportedCheckinDegraded
      ? (existingRuntimeHealth?.reason || '\u7ad9\u70b9\u4e0d\u652f\u6301\u7b7e\u5230\u63a5\u53e3')
      : '\u4f59\u989d\u5237\u65b0\u6210\u529f',
    source: keepUnsupportedCheckinDegraded
      ? (existingRuntimeHealth?.source || 'checkin')
      : 'balance',
  });

  return balanceInfo;
}

export async function refreshAllBalances() {
  const rows = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.status, 'active'))
    .all();

  const results: Array<{ accountId: number; balance: number | null }> = [];

  await Promise.all(
    rows.map(async (account) => {
      try {
        const info = await refreshBalance(account.id);
        results.push({ accountId: account.id, balance: info?.balance ?? null });
      } catch {
        results.push({ accountId: account.id, balance: null });
      }
    }),
  );

  return results;
}
