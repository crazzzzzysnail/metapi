import { FastifyInstance } from "fastify";
import { db, schema, runtimeDbDialect } from "../../db/index.js";
import { insertAndGetById } from "../../db/insertHelpers.js";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { refreshBalance } from "../../services/balanceService.js";
import { getAdapter } from "../../services/platforms/index.js";
import {
  convergeAccountMutation,
  rebuildRoutesBestEffort,
} from "../../services/accountMutationWorkflow.js";
import {
  getCredentialModeFromExtraConfig,
  getProxyUrlFromExtraConfig,
  guessPlatformUserIdFromUsername,
  hasOauthProvider,
  clearBalanceEvidenceInExtraConfig,
  getSub2ApiAuthFromExtraConfig,
  mergeAccountExtraConfig,
  normalizeCredentialMode as normalizeCredentialModeInput,
  resolvePlatformUserId,
  setBalanceEvidenceInExtraConfig,
  setManualBalanceUsdInExtraConfig,
  type AccountCredentialMode,
} from "../../services/accountExtraConfig.js";
import { encryptAccountPassword } from "../../services/accountCredentialService.js";
import { applyAccountUpdateWorkflow } from "../../services/accountUpdateWorkflow.js";
import { startBackgroundTask } from "../../services/backgroundTaskService.js";
import { parseCheckinRewardAmount } from "../../services/checkinRewardParser.js";
import { estimateRewardWithTodayIncomeFallback } from "../../services/todayIncomeRewardService.js";
import { getLocalDayRangeUtc } from "../../services/localTimeService.js";
import {
  buildRuntimeHealthForAccount,
  setAccountRuntimeHealth,
  type RuntimeHealthState,
} from "../../services/accountHealthService.js";
import { appendSessionTokenRebindHint } from "../../services/alertRules.js";
import {
  parseSiteProxyUrlInput,
  withAccountProxyOverride,
  withSiteRecordProxyRequestInit,
} from "../../services/siteProxy.js";
import { createRateLimitGuard } from "../../middleware/requestRateLimit.js";
import { getAccountsSnapshot } from "../../services/accountsOverviewService.js";
import {
  type AccountCreatePayload,
  parseAccountBatchPayload,
  parseAccountCreatePayload,
  parseAccountHealthRefreshPayload,
  parseAccountLoginPayload,
  parseAccountManualModelDeletePayload,
  parseAccountManualModelsPayload,
  parseAccountRebindSessionPayload,
  parseAccountUpdatePayload,
  parseAccountVerifyTokenPayload,
} from "../../contracts/accountsRoutePayloads.js";
import { proxyPoolIdExists } from "../../services/proxyPoolService.js";
import {
  requireSiteApiBaseUrl,
  runWithSiteApiEndpointPool,
  SiteApiEndpointSkipError,
} from "../../services/siteApiEndpointService.js";
import { resolveModelDiscoveryUrl } from "../../proxy-core/orchestration/upstreamRequest.js";
import {
  buildBatchApiKeyConnectionName,
  parseBatchApiKeys,
} from "../../services/apiKeyBatch.js";
import { createManualAccount } from "../../services/manualAccountCreationService.js";

type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

type AccountHealthRefreshResult = {
  accountId: number;
  username: string | null;
  siteName: string;
  status: "success" | "failed" | "skipped";
  state: RuntimeHealthState;
  message: string;
};

type AccountCapabilities = {
  canCheckin: boolean;
  canRefreshBalance: boolean;
  proxyOnly: boolean;
};

type VerifyFailureReason =
  | "needs-user-id"
  | "invalid-user-id"
  | "shield-blocked"
  | null;

const limitAccountLogin = createRateLimitGuard({
  bucket: "accounts-login",
  max: 5,
  windowMs: 60_000,
});

const limitAccountVerifyToken = createRateLimitGuard({
  bucket: "accounts-verify-token",
  max: 5,
  windowMs: 60_000,
});

function parseBooleanFlag(raw?: string): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function hasSessionTokenValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveRequestedCredentialMode(input: unknown): AccountCredentialMode {
  return normalizeCredentialModeInput(input) || "auto";
}

function resolveStoredCredentialMode(
  account: typeof schema.accounts.$inferSelect,
): AccountCredentialMode {
  const fromConfig = getCredentialModeFromExtraConfig(account.extraConfig);
  if (fromConfig && fromConfig !== "auto") return fromConfig;
  return hasSessionTokenValue(account.accessToken) ? "session" : "apikey";
}

function buildCapabilitiesFromCredentialMode(
  credentialMode: AccountCredentialMode,
  hasSessionToken: boolean,
  oauthIdentity?:
    | string
    | null
    | Pick<
        typeof schema.accounts.$inferSelect,
        "extraConfig" | "oauthProvider"
      >,
): AccountCapabilities {
  if (hasOauthProvider(oauthIdentity)) {
    return {
      canCheckin: false,
      canRefreshBalance: false,
      proxyOnly: true,
    };
  }
  const sessionCapable =
    credentialMode === "session"
      ? hasSessionToken
      : credentialMode === "apikey"
        ? false
        : hasSessionToken;
  return {
    canCheckin: sessionCapable,
    canRefreshBalance: sessionCapable,
    proxyOnly: !sessionCapable,
  };
}

function buildCapabilitiesForAccount(
  account: typeof schema.accounts.$inferSelect,
): AccountCapabilities {
  const credentialMode = resolveStoredCredentialMode(account);
  return buildCapabilitiesFromCredentialMode(
    credentialMode,
    hasSessionTokenValue(account.accessToken),
    account,
  );
}

function normalizeBatchIds(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => Number.parseInt(String(item), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
}

/**
 * 批量设置代理载荷解析：与站点批量同形。
 * proxyUrl/proxyId/useSystemProxy 任一出现即 presentAny；null/空串=清除该格。
 * 三格共存，由解析链决定生效项，服务端不做互斥清理（前端批量弹窗负责单选语义）。
 */
function parseBatchAccountProxySettings(data: unknown): {
  presentAny: boolean;
  proxyUrl?: string | null;
  proxyId?: number | null;
  useSystemProxy?: boolean;
  error?: string;
} {
  const body = (data && typeof data === 'object' && !Array.isArray(data))
    ? data as Record<string, unknown>
    : {};
  const hasProxyUrl = Object.prototype.hasOwnProperty.call(body, 'proxyUrl');
  const hasProxyId = Object.prototype.hasOwnProperty.call(body, 'proxyId');
  const hasUseSystemProxy = Object.prototype.hasOwnProperty.call(body, 'useSystemProxy');
  const result: {
    presentAny: boolean;
    proxyUrl?: string | null;
    proxyId?: number | null;
    useSystemProxy?: boolean;
    error?: string;
  } = { presentAny: hasProxyUrl || hasProxyId || hasUseSystemProxy };

  if (hasProxyUrl) {
    const parsed = parseSiteProxyUrlInput(body.proxyUrl);
    if (!parsed.valid) {
      result.error = 'Invalid proxyUrl. Expected a valid http(s)/socks proxy URL.';
      return result;
    }
    result.proxyUrl = parsed.proxyUrl;
  }

  if (hasProxyId) {
    const raw = body.proxyId;
    if (raw === null || raw === '') {
      result.proxyId = null;
    } else {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        result.error = 'Invalid proxyId. Expected a positive integer or null.';
        return result;
      }
      result.proxyId = parsed;
    }
  }

  if (hasUseSystemProxy) {
    if (typeof body.useSystemProxy !== 'boolean') {
      result.error = 'Invalid useSystemProxy value. Expected boolean.';
      return result;
    }
    result.useSystemProxy = body.useSystemProxy;
  }

  return result;
}

function normalizePinnedFlag(input: unknown): boolean | null {
  if (input === undefined || input === null) return null;
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input !== 0;
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return null;
}

function resolveRequestedCreateTokens(
  body: AccountCreatePayload,
  credentialMode: AccountCredentialMode,
): string[] {
  if (credentialMode !== "apikey") {
    const single = String(body.accessToken || "").trim();
    return single ? [single] : [];
  }

  const batchTokens = parseBatchApiKeys(body.accessTokens);
  if (batchTokens.length > 0) return batchTokens;
  return parseBatchApiKeys(body.accessToken);
}

function normalizeSortOrder(input: unknown): number | null {
  if (input === undefined || input === null || input === "") return null;
  const parsed = Number.parseInt(String(input), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed);
}

function normalizeManagedRefreshToken(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeManagedTokenExpiresAt(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input) && input > 0)
    return Math.trunc(input);
  if (typeof input === "string") {
    const parsed = Number.parseInt(input.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

async function getNextAccountSortOrder(): Promise<number> {
  const rows = await db
    .select({ sortOrder: schema.accounts.sortOrder })
    .from(schema.accounts)
    .all();
  const max = rows.reduce(
    (currentMax, row) => Math.max(currentMax, row.sortOrder || 0),
    -1,
  );
  return max + 1;
}

type LoginFailureInfo = {
  message: string;
  shieldBlocked: boolean;
};

const ACCOUNT_HEALTH_REFRESH_TIMEOUT_MS = 10_000;
const ACCOUNT_VERIFY_TIMEOUT_MS = 10_000;
const ACCOUNT_VERIFY_DIAG_TIMEOUT_MS = 2_500;

function normalizeLoginFailure(
  message: string | null | undefined,
): LoginFailureInfo {
  const raw = (message || "").trim();
  const lowered = raw.toLowerCase();
  const looksLikeHtmlJsonParseError =
    lowered.includes("unexpected token") &&
    lowered.includes("not valid json") &&
    (lowered.includes("<html") || lowered.includes("<script"));
  const looksLikeShieldChallenge =
    lowered.includes("acw_sc__v2") ||
    lowered.includes("var arg1") ||
    lowered.includes("captcha") ||
    lowered.includes("challenge") ||
    lowered.includes("cloudflare tunnel error");

  if (looksLikeHtmlJsonParseError || looksLikeShieldChallenge) {
    return {
      shieldBlocked: true,
      message:
        "This site is shielded by anti-bot challenge. Account/password login is blocked. Create an API key on the target site and import that key.",
    };
  }

  return {
    shieldBlocked: false,
    message: raw || "login failed",
  };
}

function summarizeAccountHealthRefresh(results: AccountHealthRefreshResult[]) {
  return {
    total: results.length,
    healthy: results.filter((item) => item.state === "healthy").length,
    unhealthy: results.filter((item) => item.state === "unhealthy").length,
    degraded: results.filter((item) => item.state === "degraded").length,
    disabled: results.filter((item) => item.state === "disabled").length,
    unknown: results.filter((item) => item.state === "unknown").length,
    success: results.filter((item) => item.status === "success").length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
  };
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isVerificationTimeoutError(error: unknown): boolean {
  const name =
    typeof error === "object" && error && "name" in error
      ? String((error as { name?: unknown }).name || "")
      : "";
  const message =
    typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message || "")
      : String(error || "");
  const lowered = `${name} ${message}`.toLowerCase();
  return (
    lowered.includes("timeout") ||
    lowered.includes("timed out") ||
    lowered.includes("abort")
  );
}

function buildAccountVerifyTimeoutMessage(): string {
  return `Token verification timed out (${Math.max(1, Math.round(ACCOUNT_VERIFY_TIMEOUT_MS / 1000))}s)`;
}

async function getModelsWithSiteApiEndpointPool(
  site: typeof schema.sites.$inferSelect,
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
  accessToken: string,
  platformUserId?: number,
): Promise<string[]> {
  const timeoutMessage = buildAccountVerifyTimeoutMessage();
  const deadline = Date.now() + ACCOUNT_VERIFY_TIMEOUT_MS;
  return runWithSiteApiEndpointPool(site, (target) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(timeoutMessage);
    }
    if (!resolveModelDiscoveryUrl(target.baseUrl, "/v1/models")) {
      throw new SiteApiEndpointSkipError();
    }
    return withTimeout(
      () => adapter.getModels(target.baseUrl, accessToken, platformUserId),
      remainingMs,
      timeoutMessage,
    );
  });
}

function resolveUserIdFailureReason(
  message: string,
  hasProvidedUserId: boolean,
): VerifyFailureReason {
  const lowered = String(message || "")
    .trim()
    .toLowerCase();
  if (!lowered) return null;

  if (
    lowered.includes("mismatch") ||
    lowered.includes("not match") ||
    lowered.includes("invalid user id") ||
    lowered.includes("wrong user id")
  ) {
    return "invalid-user-id";
  }

  if (
    lowered.includes("missing new-api-user") ||
    lowered.includes("new-api-user required") ||
    lowered.includes("requires user id") ||
    lowered.includes("missing user id")
  ) {
    return "needs-user-id";
  }

  if (lowered.includes("new-api-user") || lowered.includes("user id")) {
    return hasProvidedUserId ? "invalid-user-id" : "needs-user-id";
  }

  return null;
}

async function refreshRuntimeHealthForRow(
  row: AccountWithSiteRow,
): Promise<AccountHealthRefreshResult> {
  const accountId = row.accounts.id;
  const username = row.accounts.username;
  const siteName = row.sites.name;
  const capabilities = buildCapabilitiesForAccount(row.accounts);

  if (
    (row.accounts.status || "active") === "disabled" ||
    (row.sites.status || "active") === "disabled"
  ) {
    setAccountRuntimeHealth(accountId, {
      state: "disabled",
      reason: "账号或站点已禁用",
      source: "health-refresh",
    });
    return {
      accountId,
      username,
      siteName,
      status: "skipped",
      state: "disabled",
      message: "账号或站点已禁用",
    };
  }

  if (capabilities.proxyOnly) {
    return {
      accountId,
      username,
      siteName,
      status: "skipped",
      state: "unknown",
      message: "仅代理账号不支持会话健康检查",
    };
  }

  try {
    await withTimeout(
      () => refreshBalance(accountId),
      ACCOUNT_HEALTH_REFRESH_TIMEOUT_MS,
      `站点健康检查超时（${Math.max(1, Math.round(ACCOUNT_HEALTH_REFRESH_TIMEOUT_MS / 1000))}s）`,
    );
    const refreshedAccount = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    const runtimeHealth = buildRuntimeHealthForAccount({
      accountStatus: refreshedAccount?.status || row.accounts.status,
      siteStatus: row.sites.status,
      extraConfig: refreshedAccount?.extraConfig ?? row.accounts.extraConfig,
      sessionCapable: capabilities.canRefreshBalance,
    });

    return {
      accountId,
      username,
      siteName,
      status: runtimeHealth.state === "unhealthy" ? "failed" : "success",
      state: runtimeHealth.state,
      message: runtimeHealth.reason,
    };
  } catch (error: any) {
    const message = String(error?.message || "健康检查失败");
    setAccountRuntimeHealth(accountId, {
      state: "unhealthy",
      reason: message,
      source: "health-refresh",
    });
    return {
      accountId,
      username,
      siteName,
      status: "failed",
      state: "unhealthy",
      message,
    };
  }
}

async function executeRefreshAccountRuntimeHealth(accountId?: number) {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const targetRows = Number.isFinite(accountId as number)
    ? rows.filter((row) => row.accounts.id === accountId)
    : rows;

  const results: AccountHealthRefreshResult[] = [];
  for (const row of targetRows) {
    results.push(await refreshRuntimeHealthForRow(row));
  }

  return {
    summary: summarizeAccountHealthRefresh(results),
    results,
  };
}

export async function accountsRoutes(app: FastifyInstance) {
  // List all accounts (with site info)
  app.get<{ Querystring: { refresh?: string } }>(
    "/api/accounts",
    async (request, reply) => {
      const snapshot = await getAccountsSnapshot({
        forceRefresh: parseBooleanFlag(request.query.refresh),
      });
      reply.header("x-accounts-snapshot-cache", snapshot.cacheStatus);
      return {
        generatedAt: snapshot.generatedAt,
        accounts: snapshot.payload.accounts,
        sites: snapshot.payload.sites,
      };
    },
  );

  // Login to a site and auto-create account
  app.post<{ Body: unknown }>(
    "/api/accounts/login",
    { preHandler: [limitAccountLogin] },
    async (request, reply) => {
      const parsedBody = parseAccountLoginPayload(request.body);
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ success: false, message: parsedBody.error });
      }

      const { siteId, username, password } = parsedBody.data;

      // Get site info
      const site = await db
        .select()
        .from(schema.sites)
        .where(eq(schema.sites.id, siteId))
        .get();
      if (!site) return { success: false, message: "site not found" };

      // Get platform adapter
      const adapter = getAdapter(site.platform);
      if (!adapter)
        return { success: false, message: `不支持的平台: ${site.platform}` };

      // Login to the target site
      const loginResult = await adapter.login(site.url, username, password);
      if (!loginResult.success || !loginResult.accessToken) {
        const normalizedFailure = normalizeLoginFailure(loginResult.message);
        return {
          success: false,
          shieldBlocked: normalizedFailure.shieldBlocked,
          message: normalizedFailure.message,
        };
      }

      const guessedPlatformUserId = guessPlatformUserIdFromUsername(username);

      // Auto-fetch API token(s)
      let apiToken: string | null = null;
      let apiTokens: Array<{
        name?: string | null;
        key?: string | null;
        enabled?: boolean | null;
      }> = [];
      try {
        apiToken = await adapter.getApiToken(
          site.url,
          loginResult.accessToken,
          guessedPlatformUserId,
        );
      } catch {}
      try {
        apiTokens = await adapter.getApiTokens(
          site.url,
          loginResult.accessToken,
          guessedPlatformUserId,
        );
      } catch {}

      const preferredApiToken =
        apiTokens.find((token) => token.enabled !== false && token.key)?.key ||
        apiToken ||
        null;
      const existing = await db
        .select()
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.siteId, siteId),
            eq(schema.accounts.username, username),
          ),
        )
        .get();

      const extraConfigPatch: Record<string, unknown> = {
        credentialMode: "session",
        autoRelogin: {
          username,
          passwordCipher: encryptAccountPassword(password),
          updatedAt: new Date().toISOString(),
        },
      };
      if (guessedPlatformUserId) {
        extraConfigPatch.platformUserId = guessedPlatformUserId;
      }
      const extraConfig = mergeAccountExtraConfig(
        existing?.extraConfig,
        extraConfigPatch,
      );

      // Create or update account
      let accountId = existing?.id;
      if (existing) {
        await db
          .update(schema.accounts)
          .set({
            accessToken: loginResult.accessToken,
            apiToken: preferredApiToken || undefined,
            checkinEnabled: true,
            status: "active",
            extraConfig,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.accounts.id, existing.id))
          .run();
      } else {
        const created = await insertAndGetById<
          typeof schema.accounts.$inferSelect
        >({
          table: schema.accounts,
          idColumn: schema.accounts.id,
          values: {
            siteId,
            username,
            accessToken: loginResult.accessToken,
            apiToken: preferredApiToken || undefined,
            checkinEnabled: true,
            extraConfig,
            isPinned: false,
            sortOrder: await getNextAccountSortOrder(),
          },
          insertErrorMessage: "account create failed",
          loadErrorMessage: "account create failed",
        });
        accountId = created.id;
      }

      const result = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId!))
        .get();
      if (!result) {
        return { success: false, message: "account create failed" };
      }

      await convergeAccountMutation({
        accountId: result.id,
        preferredApiToken,
        defaultTokenSource: "sync",
        upstreamTokens: apiTokens,
        refreshBalance: true,
        refreshModels: true,
        rebuildRoutes: true,
        continueOnError: true,
      });

      const account = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, result.id))
        .get();
      return {
        success: true,
        account,
        apiTokenFound: !!preferredApiToken,
        tokenCount: apiTokens.length,
        reusedAccount: !!existing,
      };
    },
  );

  // Verify credentials against a site.
  app.post<{ Body: unknown }>(
    "/api/accounts/verify-token",
    { preHandler: [limitAccountVerifyToken] },
    async (request, reply) => {
      const parsedBody = parseAccountVerifyTokenPayload(request.body);
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ success: false, message: parsedBody.error });
      }

      const { siteId, platformUserId } = parsedBody.data;
      const accessToken = (parsedBody.data.accessToken || "").trim();
      const credentialMode = resolveRequestedCredentialMode(
        parsedBody.data.credentialMode,
      );
      const site = await db
        .select()
        .from(schema.sites)
        .where(eq(schema.sites.id, siteId))
        .get();
      if (!site) return { success: false, message: "site not found" };

      if (!accessToken) {
        return { success: false, message: "Token 不能为空" };
      }

      const adapter = getAdapter(site.platform);
      if (!adapter)
        return { success: false, message: `不支持的平台: ${site.platform}` };

      const normalizedPlatform = String(
        adapter.platformName || site.platform || "",
      )
        .trim()
        .toLowerCase();
      const parsedPlatformUserId =
        typeof platformUserId === "number" &&
        Number.isFinite(platformUserId) &&
        platformUserId > 0
          ? Math.trunc(platformUserId)
          : undefined;
      const hasProvidedUserId = parsedPlatformUserId !== undefined;
      const skipRawShieldDetection =
        normalizedPlatform === "new-api" || normalizedPlatform === "anyrouter";
      const diagnoseVerificationFailure = async (
        options: { useApiEndpointPool?: boolean } = {},
      ): Promise<VerifyFailureReason> => {
        const parseFailureReason = (
          bodyText: string,
          contentType: string,
        ): VerifyFailureReason => {
          const text = bodyText || "";
          const ct = (contentType || "").toLowerCase();
          if (
            !skipRawShieldDetection &&
            ct.includes("text/html") &&
            /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|<script/i.test(text)
          ) {
            return "shield-blocked";
          }

          try {
            const body = JSON.parse(text) as any;
            const message =
              typeof body?.message === "string" ? body.message : "";
            const userIdReason = resolveUserIdFailureReason(
              message,
              hasProvidedUserId,
            );
            if (userIdReason) return userIdReason;
            if (
              !skipRawShieldDetection &&
              /shield|challenge|captcha|acw_sc__v2|arg1/i.test(message)
            ) {
              return "shield-blocked";
            }
          } catch {}

          return null;
        };

        try {
          const { fetch } = await import("undici");
          const candidates = new Set<string>();
          const raw = accessToken.startsWith("Bearer ")
            ? accessToken.slice(7).trim()
            : accessToken;
          if (raw) {
            if (raw.includes("=")) candidates.add(raw);
            candidates.add(`session=${raw}`);
            candidates.add(`token=${raw}`);
          }

          const diagnosticUserId = hasProvidedUserId
            ? String(parsedPlatformUserId)
            : "0";
          const headerVariants: Record<string, string>[] = [
            {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              "New-Api-User": diagnosticUserId,
            },
          ];

          for (const cookie of candidates) {
            headerVariants.push({
              Cookie: cookie,
              "Content-Type": "application/json",
              "X-Requested-With": "XMLHttpRequest",
              ...(hasProvidedUserId
                ? { "New-Api-User": diagnosticUserId }
                : {}),
            });
          }

          const tryBaseUrl = async (
            baseUrl: string,
          ): Promise<VerifyFailureReason> => {
            let sawNetworkError = false;
            let sawResponse = false;
            for (const headers of headerVariants) {
              try {
                const testRes = await fetch(
                  `${baseUrl.replace(/\/+$/, "")}/api/user/self`,
                  withSiteRecordProxyRequestInit(site, {
                    headers,
                    signal: AbortSignal.timeout(ACCOUNT_VERIFY_DIAG_TIMEOUT_MS),
                  }),
                );
                sawResponse = true;
                const bodyText = await testRes.text();
                const contentType = testRes.headers.get("content-type") || "";
                const reason = parseFailureReason(bodyText, contentType);
                if (reason) return reason;
              } catch {
                sawNetworkError = true;
              }
            }
            if (sawNetworkError && !sawResponse) {
              throw new Error(`diagnostic request timed out for ${baseUrl}`);
            }
            return null;
          };

          if (options.useApiEndpointPool) {
            const diagnosticBaseUrl = await requireSiteApiBaseUrl(site);
            return await tryBaseUrl(diagnosticBaseUrl);
          }

          return await tryBaseUrl(site.url);
        } catch {}

        return null;
      };
      const buildVerificationFailureResponse = (
        failureReason: VerifyFailureReason,
      ) => {
        if (failureReason === "needs-user-id") {
          return {
            success: false,
            needsUserId: true,
            message:
              "This site requires a user ID. Please fill in your site user ID.",
          };
        }

        if (failureReason === "invalid-user-id") {
          return {
            success: false,
            invalidUserId: true,
            message:
              "The provided user ID does not match this token. Please check your site user ID.",
          };
        }

        if (failureReason === "shield-blocked") {
          return {
            success: false,
            shieldBlocked: true,
            message:
              "This site is shielded by anti-bot challenge. Create an API key on the target site and import that key.",
          };
        }

        return null;
      };

      if (
        !hasProvidedUserId &&
        (normalizedPlatform === "new-api" || normalizedPlatform === "anyrouter")
      ) {
        const preflightReason = await diagnoseVerificationFailure({
          useApiEndpointPool: credentialMode === "apikey",
        });
        if (preflightReason === "needs-user-id") {
          return buildVerificationFailureResponse(preflightReason);
        }
      }

      if (credentialMode === "apikey") {
        try {
          const models = await getModelsWithSiteApiEndpointPool(
            site,
            adapter,
            accessToken,
            parsedPlatformUserId,
          );
          const availableModels = Array.isArray(models)
            ? models.filter(
                (item) => typeof item === "string" && item.trim().length > 0,
              )
            : [];
          if (availableModels.length === 0) {
            return {
              success: false,
              message: "API Key 验证失败：未获取到可用模型",
            };
          }
          return {
            success: true,
            tokenType: "apikey",
            modelCount: availableModels.length,
            models: availableModels.slice(0, 10),
          };
        } catch (err: any) {
          if (isVerificationTimeoutError(err)) {
            const failure = buildVerificationFailureResponse(
              await diagnoseVerificationFailure({
                useApiEndpointPool: true,
              }),
            );
            if (failure) return failure;
          }
          return {
            success: false,
            message: err?.message || "API Key 验证失败",
          };
        }
      }

      let result: any;
      try {
        result = await withTimeout(
          () =>
            adapter.verifyToken(site.url, accessToken, parsedPlatformUserId),
          ACCOUNT_VERIFY_TIMEOUT_MS,
          `Token verification timed out (${Math.max(1, Math.round(ACCOUNT_VERIFY_TIMEOUT_MS / 1000))}s)`,
        );
      } catch (err: any) {
        if (isVerificationTimeoutError(err)) {
          const failure = buildVerificationFailureResponse(
            await diagnoseVerificationFailure(),
          );
          if (failure) return failure;
        }
        return {
          success: false,
          message: appendSessionTokenRebindHint(
            err?.message || "Token 验证失败",
          ),
        };
      }

      if (result.tokenType === "session") {
        return {
          success: true,
          tokenType: "session",
          userInfo: result.userInfo,
          balance: result.balance,
          apiToken: result.apiToken,
        };
      }

      if (result.tokenType === "apikey") {
        if (credentialMode === "session") {
          return {
            success: false,
            message:
              "当前凭证是 API Key，请切换到 API Key 模式，或改用 Session Token",
          };
        }
        return {
          success: true,
          tokenType: "apikey",
          modelCount: result.models?.length || 0,
          models: result.models?.slice(0, 10),
        };
      }

      // Try to explain unknown failures: missing user id vs anti-bot challenge page.
      const detectVerifyFailureReason =
        async (): Promise<VerifyFailureReason> => {
          const parseFailureReason = (
            bodyText: string,
            contentType: string,
          ): VerifyFailureReason => {
            const text = bodyText || "";
            const ct = (contentType || "").toLowerCase();
            if (
              !skipRawShieldDetection &&
              ct.includes("text/html") &&
              /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|<script/i.test(text)
            ) {
              return "shield-blocked";
            }

            try {
              const body = JSON.parse(text) as any;
              const message =
                typeof body?.message === "string" ? body.message : "";
              const userIdReason = resolveUserIdFailureReason(
                message,
                hasProvidedUserId,
              );
              if (userIdReason) return userIdReason;
              if (
                !skipRawShieldDetection &&
                /shield|challenge|captcha|acw_sc__v2|arg1/i.test(message)
              ) {
                return "shield-blocked";
              }
            } catch {}

            return null;
          };

          try {
            const { fetch } = await import("undici");
            const candidates = new Set<string>();
            const raw = accessToken.startsWith("Bearer ")
              ? accessToken.slice(7).trim()
              : accessToken;
            if (raw) {
              if (raw.includes("=")) candidates.add(raw);
              candidates.add(`session=${raw}`);
              candidates.add(`token=${raw}`);
            }

            const diagnosticUserId = hasProvidedUserId
              ? String(parsedPlatformUserId)
              : "0";
            const headerVariants: Record<string, string>[] = [
              {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "New-Api-User": diagnosticUserId,
              },
            ];

            for (const cookie of candidates) {
              headerVariants.push({
                Cookie: cookie,
                "Content-Type": "application/json",
                "X-Requested-With": "XMLHttpRequest",
                ...(hasProvidedUserId
                  ? { "New-Api-User": diagnosticUserId }
                  : {}),
              });
            }

            for (const headers of headerVariants) {
              try {
                const testRes = await fetch(
                  `${site.url}/api/user/self`,
                  withSiteRecordProxyRequestInit(site, {
                    headers,
                    signal: AbortSignal.timeout(ACCOUNT_VERIFY_DIAG_TIMEOUT_MS),
                  }),
                );
                const bodyText = await testRes.text();
                const contentType = testRes.headers.get("content-type") || "";
                const reason = parseFailureReason(bodyText, contentType);
                if (reason) return reason;
              } catch {}
            }
          } catch {}

          return null;
        };

      const failureReason = await detectVerifyFailureReason();
      if (failureReason === "needs-user-id") {
        return {
          success: false,
          needsUserId: true,
          message:
            "This site requires a user ID. Please fill in your site user ID.",
        };
      }

      if (failureReason === "invalid-user-id") {
        return {
          success: false,
          invalidUserId: true,
          message:
            "The provided user ID does not match this token. Please check your site user ID.",
        };
      }

      if (failureReason === "shield-blocked") {
        return {
          success: false,
          shieldBlocked: true,
          message:
            "This site is shielded by anti-bot challenge. Create an API key on the target site and import that key.",
        };
      }

      return {
        success: false,
        message:
          credentialMode === "session"
            ? "Session Token 验证失败"
            : "Token invalid: cannot use it as session cookie or API key",
      };
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/accounts/:id/rebind-session",
    async (request, reply) => {
      const parsedBody = parseAccountRebindSessionPayload(request.body);
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ success: false, message: parsedBody.error });
      }

      const accountId = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply
          .code(400)
          .send({ success: false, message: "账号 ID 无效" });
      }

      const nextAccessToken = (parsedBody.data.accessToken || "").trim();
      if (!nextAccessToken) {
        return reply
          .code(400)
          .send({ success: false, message: "请提供新的 Session Token" });
      }

      const row = await db
        .select()
        .from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(eq(schema.accounts.id, accountId))
        .get();
      if (!row) {
        return reply.code(404).send({ success: false, message: "账号不存在" });
      }

      const account = row.accounts;
      const site = row.sites;
      const adapter = getAdapter(site.platform);
      if (!adapter) {
        return reply
          .code(400)
          .send({
            success: false,
            message: `platform not supported: ${site.platform}`,
          });
      }

      const bodyPlatformUserId = Number.parseInt(
        String(parsedBody.data.platformUserId ?? ""),
        10,
      );
      const candidatePlatformUserId =
        Number.isFinite(bodyPlatformUserId) && bodyPlatformUserId > 0
          ? bodyPlatformUserId
          : resolvePlatformUserId(account.extraConfig, account.username);

      let verifyResult: any;
      try {
        verifyResult = await withAccountProxyOverride(
          getProxyUrlFromExtraConfig(account.extraConfig),
          () =>
            adapter.verifyToken(
              site.url,
              nextAccessToken,
              candidatePlatformUserId,
            ),
        );
      } catch (err: any) {
        return reply.code(400).send({
          success: false,
          message: appendSessionTokenRebindHint(
            err?.message || "Token 验证失败",
          ),
        });
      }

      if (verifyResult?.tokenType !== "session") {
        return reply.code(400).send({
          success: false,
          message: "新的 Token 验证失败：请提供可用的 Session Token",
        });
      }

      const nextUsernameRaw =
        typeof verifyResult?.userInfo?.username === "string"
          ? verifyResult.userInfo.username.trim()
          : "";
      const nextUsername = nextUsernameRaw || account.username || "";
      const inferredPlatformUserId = resolvePlatformUserId(
        account.extraConfig,
        nextUsername,
      );
      const resolvedPlatformUserId =
        Number.isFinite(bodyPlatformUserId) && bodyPlatformUserId > 0
          ? bodyPlatformUserId
          : inferredPlatformUserId;
      const nextApiToken =
        typeof verifyResult?.apiToken === "string" &&
        verifyResult.apiToken.trim().length > 0
          ? verifyResult.apiToken.trim()
          : account.apiToken || "";

      const updates: Record<string, unknown> = {
        accessToken: nextAccessToken,
        status: "active",
        updatedAt: new Date().toISOString(),
      };
      if (nextUsername) {
        updates.username = nextUsername;
      }
      if (nextApiToken) {
        updates.apiToken = nextApiToken;
      }
      const extraConfigPatch: Record<string, unknown> = {
        credentialMode: "session",
      };
      if (resolvedPlatformUserId) {
        extraConfigPatch.platformUserId = resolvedPlatformUserId;
      }
      if ((site.platform || "").toLowerCase() === "sub2api") {
        const existingManagedAuth = getSub2ApiAuthFromExtraConfig(
          account.extraConfig,
        );
        const requestedRefreshToken = normalizeManagedRefreshToken(
          parsedBody.data.refreshToken,
        );
        const requestedTokenExpiresAt = normalizeManagedTokenExpiresAt(
          parsedBody.data.tokenExpiresAt,
        );
        const nextRefreshToken =
          requestedRefreshToken || existingManagedAuth?.refreshToken;
        const nextTokenExpiresAt =
          requestedTokenExpiresAt ?? existingManagedAuth?.tokenExpiresAt;
        if (nextRefreshToken) {
          extraConfigPatch.sub2apiAuth = nextTokenExpiresAt
            ? {
                refreshToken: nextRefreshToken,
                tokenExpiresAt: nextTokenExpiresAt,
              }
            : { refreshToken: nextRefreshToken };
        }
      }
      updates.extraConfig = mergeAccountExtraConfig(
        account.extraConfig,
        extraConfigPatch,
      );

      await db
        .update(schema.accounts)
        .set(updates)
        .where(eq(schema.accounts.id, accountId))
        .run();

      await convergeAccountMutation({
        accountId,
        preferredApiToken: nextApiToken,
        defaultTokenSource: "sync",
        refreshBalance: true,
        refreshModels: true,
        rebuildRoutes: true,
        continueOnError: true,
      });

      const latest = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();
      return {
        success: true,
        account: latest,
        tokenType: "session",
        credentialMode: "session",
        capabilities: latest
          ? buildCapabilitiesForAccount(latest)
          : buildCapabilitiesFromCredentialMode("session", true, null),
        apiTokenFound: !!nextApiToken,
      };
    },
  );

  // Add an account (manual credential input)
  app.post<{ Body: unknown }>("/api/accounts", async (request, reply) => {
    const parsedBody = parseAccountCreatePayload(request.body);
    if (!parsedBody.success) {
      return reply
        .code(400)
        .send({ success: false, message: parsedBody.error });
    }

    const body = parsedBody.data;
    const site = await db
      .select()
      .from(schema.sites)
      .where(eq(schema.sites.id, body.siteId))
      .get();
    if (!site) {
      return reply
        .code(400)
        .send({ success: false, message: "site not found" });
    }

    const adapter = getAdapter(site.platform);
    if (!adapter) {
      return reply
        .code(400)
        .send({
          success: false,
          message: `platform not supported: ${site.platform}`,
        });
    }

    const explicitBatchTokens = parseBatchApiKeys(body.accessTokens);
    const credentialMode =
      explicitBatchTokens.length > 0
        ? "apikey"
        : resolveRequestedCredentialMode(body.credentialMode);
    const requestedTokens =
      explicitBatchTokens.length > 0
        ? explicitBatchTokens
        : resolveRequestedCreateTokens(body, credentialMode);
    if (requestedTokens.length === 0) {
      return reply.code(400).send({ success: false, message: "请填写 Token" });
    }

    if (credentialMode === "apikey" && requestedTokens.length > 1) {
      const items: Array<Record<string, unknown>> = [];
      let createdCount = 0;

      for (const [index, token] of requestedTokens.entries()) {
        try {
          const created = await createManualAccount({
            body,
            site,
            adapter,
            credentialMode,
            rawAccessToken: token,
            usernameOverride:
              buildBatchApiKeyConnectionName(
                body.username,
                index,
                requestedTokens.length,
              ) || undefined,
          });
          createdCount += 1;
          items.push({
            index,
            status: "created",
            id: created.account.id,
            username: created.account.username || null,
            queued: created.queued === true,
            message: created.message || null,
            modelCount: created.modelCount || 0,
          });
        } catch (error: any) {
          items.push({
            index,
            status: "failed",
            message: error?.message || "创建失败",
            requiresVerification: error?.requiresVerification === true,
          });
        }
      }

      if (createdCount === 0) {
        return reply.code(400).send({
          success: false,
          batch: true,
          totalCount: requestedTokens.length,
          createdCount: 0,
          failedCount: requestedTokens.length,
          message: `批量添加失败（0/${requestedTokens.length}）`,
          items,
        });
      }

      return {
        success: true,
        batch: true,
        totalCount: requestedTokens.length,
        createdCount,
        failedCount: requestedTokens.length - createdCount,
        message: `批量添加完成：成功 ${createdCount}，失败 ${requestedTokens.length - createdCount}`,
        items,
      };
    }

    try {
      const created = await createManualAccount({
        body,
        site,
        adapter,
        credentialMode,
        rawAccessToken: requestedTokens[0]!,
      });
      return {
        ...created.account,
        tokenType: created.tokenType,
        credentialMode: resolveStoredCredentialMode(created.account),
        capabilities: buildCapabilitiesForAccount(created.account),
        modelCount: created.modelCount,
        apiTokenFound: created.apiTokenFound,
        usernameDetected: created.usernameDetected,
        queued: created.queued,
        jobId: created.jobId,
        message: created.message,
      };
    } catch (err: any) {
      return reply.code(400).send({
        success: false,
        requiresVerification: err?.requiresVerification === true,
        message:
          credentialMode !== "apikey"
            ? appendSessionTokenRebindHint(err?.message || "Token 验证失败")
            : err?.message || "API Key 验证失败",
      });
    }
  });

  // Update an account
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/accounts/:id",
    async (request, reply) => {
      const id = parseInt(request.params.id);
      const parsedBody = parseAccountUpdatePayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ message: parsedBody.error });
      }
      const body = parsedBody.data as Record<string, unknown>;
      const row = await db
        .select()
        .from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(eq(schema.accounts.id, id))
        .get();
      if (!row) {
        return reply.code(404).send({ message: "account not found" });
      }
      const account = row.accounts;
      const site = row.sites;
      const updates: any = {};
      for (const key of [
        "username",
        "accessToken",
        "apiToken",
        "status",
        "checkinEnabled",
        "unitCost",
        "extraConfig",
      ]) {
        if (body[key] !== undefined) updates[key] = body[key];
      }

      const wantsManagedSub2ApiAuthPatch =
        Object.prototype.hasOwnProperty.call(body, "refreshToken") ||
        Object.prototype.hasOwnProperty.call(body, "tokenExpiresAt");
      if (
        wantsManagedSub2ApiAuthPatch &&
        (site.platform || "").toLowerCase() === "sub2api"
      ) {
        const baseExtraConfig =
          typeof updates.extraConfig === "string"
            ? updates.extraConfig
            : account.extraConfig;
        const existingManagedAuth =
          getSub2ApiAuthFromExtraConfig(baseExtraConfig);

        const nextRefreshToken = Object.prototype.hasOwnProperty.call(
          body,
          "refreshToken",
        )
          ? normalizeManagedRefreshToken(body.refreshToken)
          : existingManagedAuth?.refreshToken;
        const nextTokenExpiresAt = Object.prototype.hasOwnProperty.call(
          body,
          "tokenExpiresAt",
        )
          ? normalizeManagedTokenExpiresAt(body.tokenExpiresAt)
          : existingManagedAuth?.tokenExpiresAt;

        updates.extraConfig = mergeAccountExtraConfig(baseExtraConfig, {
          sub2apiAuth: nextRefreshToken
            ? nextTokenExpiresAt
              ? {
                  refreshToken: nextRefreshToken,
                  tokenExpiresAt: nextTokenExpiresAt,
                }
              : { refreshToken: nextRefreshToken }
            : undefined,
        });
      }

      if (body.isPinned !== undefined) {
        const normalizedPinned = normalizePinnedFlag(body.isPinned);
        if (normalizedPinned === null) {
          return reply
            .code(400)
            .send({ message: "Invalid isPinned value. Expected boolean." });
        }
        updates.isPinned = normalizedPinned;
      }

      if (body.sortOrder !== undefined) {
        const normalizedSortOrder = normalizeSortOrder(body.sortOrder);
        if (normalizedSortOrder === null) {
          return reply
            .code(400)
            .send({
              message:
                "Invalid sortOrder value. Expected non-negative integer.",
            });
        }
        updates.sortOrder = normalizedSortOrder;
      }

      if (Object.prototype.hasOwnProperty.call(body, "proxyUrl")) {
        const baseExtraConfig =
          typeof updates.extraConfig === "string"
            ? updates.extraConfig
            : account.extraConfig;
        const {
          present,
          valid,
          proxyUrl: normalizedProxy,
        } = parseSiteProxyUrlInput(body.proxyUrl);
        if (present && !valid) {
          return reply.code(400).send({ message: "Invalid proxy URL format" });
        }
        updates.extraConfig = mergeAccountExtraConfig(baseExtraConfig, {
          proxyUrl: normalizedProxy ?? undefined,
        });
      }

      // 账号级代理池引用：undefined=不改；null/空=清除；正整数=设置并校验存在
      if (Object.prototype.hasOwnProperty.call(body, "proxyId")) {
        const baseExtraConfig =
          typeof updates.extraConfig === "string"
            ? updates.extraConfig
            : account.extraConfig;
        const rawProxyId = (body as Record<string, unknown>).proxyId;
        let normalizedProxyId: number | null = null;
        if (rawProxyId !== null && rawProxyId !== "") {
          const parsed = Number(rawProxyId);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            return reply.code(400).send({ message: "Invalid proxyId. Expected a positive integer or null." });
          }
          normalizedProxyId = parsed;
        }
        if (normalizedProxyId !== null && !await proxyPoolIdExists(normalizedProxyId)) {
          return reply.code(400).send({ message: "Invalid proxyId. Proxy pool entry not found." });
        }
        updates.extraConfig = mergeAccountExtraConfig(baseExtraConfig, {
          proxyId: normalizedProxyId ?? undefined,
        });
      }

      // 账号级“使用系统代理”勾选：与自定义地址、池引用并存，由解析链决定生效项
      if (Object.prototype.hasOwnProperty.call(body, "useSystemProxy")) {
        const baseExtraConfig =
          typeof updates.extraConfig === "string"
            ? updates.extraConfig
            : account.extraConfig;
        const rawUseSystemProxy = (body as Record<string, unknown>).useSystemProxy;
        if (typeof rawUseSystemProxy !== "boolean") {
          return reply.code(400).send({ message: "Invalid useSystemProxy value. Expected boolean." });
        }
        updates.extraConfig = mergeAccountExtraConfig(baseExtraConfig, {
          useSystemProxy: rawUseSystemProxy,
        });
      }

      // F8 第 3 期：手动余额。走 extra_config 而非加列；这里不并入 needsModelRefresh——
      // 改一个展示用数字不需要重拉模型列表，否则每次保存都要白等一轮。
      if (Object.prototype.hasOwnProperty.call(body, "manualBalanceUsd")) {
        const raw = body.manualBalanceUsd;
        const isClearing =
          raw === null || (typeof raw === "string" && raw.trim() === "");
        let manualValue: number | null = null;
        if (!isClearing) {
          const n = typeof raw === "number" ? raw : Number(String(raw).trim());
          if (!Number.isFinite(n) || n < 0) {
            return reply
              .code(400)
              .send({ message: "手动余额必须是不小于 0 的数字，或留空恢复自动获取" });
          }
          manualValue = n;
        }
        const baseExtraConfig =
          typeof updates.extraConfig === "string"
            ? updates.extraConfig
            : account.extraConfig;
        updates.extraConfig = setManualBalanceUsdInExtraConfig(
          baseExtraConfig,
          manualValue,
        );
        // 手动值立即生效：写 balance + lastBalanceRefresh + known 证据，
        // 用户保存后不必等下一次刷新才看到数字，也不会被判成"从未读到"。
        if (manualValue !== null) {
          const now = new Date().toISOString();
          updates.balance = manualValue;
          updates.lastBalanceRefresh = now;
          updates.extraConfig = setBalanceEvidenceInExtraConfig(updates.extraConfig, {
            status: "known",
            source: "manual",
            capturedAt: now,
          });
        } else {
          // 清除手动值时把证据一并删掉：库里那个数字就是从手动值来的，再声称 known/manual
          // 会让界面以为还能读到，直到下一次刷新才纠正。
          updates.extraConfig = clearBalanceEvidenceInExtraConfig(updates.extraConfig);
          // 余额列与时间戳也归零：它们当初就是被手动值覆盖的，留着等于把手动数字
          // 继续冒充上游读数。下一次刷新会重新填真实值。
          updates.balance = 0;
          updates.lastBalanceRefresh = null;
        }
        // 余额类快照（账号列表、仪表盘合计、站点统计）都要重算，否则前端 15 秒内
        // 拿到的还是旧数字，看起来像没保存成功。落库的那份也必须删——readSnapshotCache
        // 内存未命中时会把库里旧快照读回来，只清内存等于没清。
        const { clearSnapshotCache } = await import(
          "../../services/snapshotCacheService.js"
        );
        const { deleteAdminSnapshotsByNamespace } = await import(
          "../../services/adminSnapshotStore.js"
        );
        for (const namespace of [
          "accounts-snapshot",
          "dashboard-summary",
          "dashboard-insights",
          "site-stats",
        ]) {
          clearSnapshotCache(namespace);
          await deleteAdminSnapshotsByNamespace(namespace);
        }
      }

      const nextAccessToken =
        typeof updates.accessToken === "string"
          ? updates.accessToken
          : account.accessToken;
      const nextApiToken = Object.prototype.hasOwnProperty.call(
        updates,
        "apiToken",
      )
        ? updates.apiToken
        : account.apiToken;
      const nextExtraConfig =
        typeof updates.extraConfig === "string"
          ? updates.extraConfig
          : account.extraConfig;
      const explicitNextMode =
        getCredentialModeFromExtraConfig(nextExtraConfig);
      const nextCredentialMode =
        explicitNextMode && explicitNextMode !== "auto"
          ? explicitNextMode
          : hasSessionTokenValue(nextAccessToken)
            ? "session"
            : "apikey";
      const nextStatus =
        typeof updates.status === "string" && updates.status.trim()
          ? updates.status.trim()
          : account.status || "active";
      const needsModelRefresh =
        Object.prototype.hasOwnProperty.call(body, "accessToken") ||
        Object.prototype.hasOwnProperty.call(body, "apiToken") ||
        Object.prototype.hasOwnProperty.call(body, "extraConfig") ||
        Object.prototype.hasOwnProperty.call(body, "proxyUrl") ||
        Object.prototype.hasOwnProperty.call(body, "proxyId") ||
        wantsManagedSub2ApiAuthPatch;
      const isExpiredApiKeyAccount =
        account.status === "expired" &&
        nextCredentialMode === "apikey" &&
        nextStatus !== "disabled";
      const shouldAttemptExpiredApiKeyRecovery =
        isExpiredApiKeyAccount && needsModelRefresh;

      const { account: updatedAccount } = await applyAccountUpdateWorkflow({
        accountId: id,
        updates,
        preferredApiToken:
          nextCredentialMode !== "apikey" ? nextApiToken : null,
        refreshModels: needsModelRefresh,
        preserveExpiredStatus: isExpiredApiKeyAccount,
        allowInactiveModelRefresh: shouldAttemptExpiredApiKeyRecovery,
        reactivateAfterSuccessfulModelRefresh:
          shouldAttemptExpiredApiKeyRecovery,
        continueOnError: true,
      });

      return updatedAccount;
    },
  );

  // Delete an account
  app.delete<{ Params: { id: string } }>(
    "/api/accounts/:id",
    async (request) => {
      const id = parseInt(request.params.id);
      await db.delete(schema.accounts).where(eq(schema.accounts.id, id)).run();
      await rebuildRoutesBestEffort();
      return { success: true };
    },
  );

  app.post<{ Body: unknown }>("/api/accounts/batch", async (request, reply) => {
    const parsedBody = parseAccountBatchPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ message: parsedBody.error });
    }

    const ids = normalizeBatchIds(parsedBody.data.ids);
    const action = String(parsedBody.data.action || "").trim();
    if (ids.length === 0) {
      return reply.code(400).send({ message: "ids is required" });
    }
    if (!["enable", "disable", "delete", "refreshBalance", "updateSettings"].includes(action)) {
      return reply.code(400).send({ message: "Invalid action" });
    }

    // updateSettings 载荷校验：与站点批量同形（undefined 不改、null/空清除）
    const batchProxy = action === "updateSettings"
      ? parseBatchAccountProxySettings(parsedBody.data)
      : null;
    if (batchProxy?.error) {
      return reply.code(400).send({ message: batchProxy.error });
    }
    if (action === "updateSettings" && !batchProxy?.presentAny) {
      return reply.code(400).send({ message: "No batch settings provided." });
    }
    if (batchProxy?.proxyId !== null && batchProxy?.proxyId !== undefined
      && !await proxyPoolIdExists(batchProxy.proxyId)) {
      return reply.code(400).send({ message: "Invalid proxyId. Proxy pool entry not found." });
    }

    const successIds: number[] = [];
    const failedItems: Array<{ id: number; message: string }> = [];
    let shouldRebuildRoutes = false;

    for (const id of ids) {
      try {
        if (action === "refreshBalance") {
          const result = await refreshBalance(id);
          if (!result) {
            failedItems.push({
              id,
              message: "Account not found or balance refresh unsupported",
            });
            continue;
          }
          successIds.push(id);
          continue;
        }

        const existing = await db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.id, id))
          .get();
        if (!existing) {
          failedItems.push({ id, message: "Account not found" });
          continue;
        }

        if (action === "delete") {
          await db
            .delete(schema.accounts)
            .where(eq(schema.accounts.id, id))
            .run();
          shouldRebuildRoutes = true;
        } else if (action === "updateSettings") {
          // 逐账号合并 extra_config：只动勾选下发的格，未下发的格保持现状
          const patch: Record<string, unknown> = {};
          if (batchProxy && 'proxyUrl' in batchProxy) patch.proxyUrl = batchProxy.proxyUrl ?? undefined;
          if (batchProxy && 'proxyId' in batchProxy) patch.proxyId = batchProxy.proxyId ?? undefined;
          if (batchProxy && 'useSystemProxy' in batchProxy) patch.useSystemProxy = batchProxy.useSystemProxy;
          await db
            .update(schema.accounts)
            .set({
              extraConfig: mergeAccountExtraConfig(existing.extraConfig, patch),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.accounts.id, id))
            .run();
        } else {
          const nextStatus = action === "enable" ? "active" : "disabled";
          await db
            .update(schema.accounts)
            .set({ status: nextStatus, updatedAt: new Date().toISOString() })
            .where(eq(schema.accounts.id, id))
            .run();
        }

        successIds.push(id);
      } catch (error: any) {
        failedItems.push({
          id,
          message: error?.message || "Batch operation failed",
        });
      }
    }

    if (shouldRebuildRoutes) {
      await rebuildRoutesBestEffort();
    }

    return {
      success: true,
      successIds,
      failedItems,
    };
  });

  app.post<{ Body: unknown }>(
    "/api/accounts/health/refresh",
    async (request, reply) => {
      const parsedBody = parseAccountHealthRefreshPayload(request.body);
      if (!parsedBody.success) {
        return reply
          .code(400)
          .send({ success: false, message: parsedBody.error });
      }

      const accountId = parsedBody.data.accountId;
      const wait = parsedBody.data.wait === true;

      if (wait) {
        const result = await executeRefreshAccountRuntimeHealth(accountId);
        if (accountId && result.summary.total === 0) {
          return reply
            .code(404)
            .send({ success: false, message: "账号不存在" });
        }
        return {
          success: true,
          ...result,
        };
      }

      const taskTitle = accountId
        ? `刷新账号运行健康状态 #${accountId}`
        : "刷新全部账号运行健康状态";
      const dedupeKey = accountId
        ? `refresh-account-runtime-health-${accountId}`
        : "refresh-all-account-runtime-health";

      const { task, reused } = startBackgroundTask(
        {
          type: "status",
          title: taskTitle,
          dedupeKey,
          notifyOnFailure: true,
          successMessage: (currentTask) => {
            const summary = (
              currentTask.result as {
                summary?: ReturnType<typeof summarizeAccountHealthRefresh>;
              }
            )?.summary;
            if (!summary) return `${taskTitle}已完成`;
            return `${taskTitle}完成：健康 ${summary.healthy}，异常 ${summary.unhealthy}，禁用 ${summary.disabled}`;
          },
          failureMessage: (currentTask) =>
            `${taskTitle}失败：${currentTask.error || "unknown error"}`,
        },
        async () => executeRefreshAccountRuntimeHealth(accountId),
      );

      return reply.code(202).send({
        success: true,
        queued: true,
        reused,
        jobId: task.id,
        status: task.status,
        message: reused
          ? "账号运行健康状态刷新进行中，请稍后查看账号列表"
          : "已开始刷新账号运行健康状态，请稍后查看账号列表",
      });
    },
  );

  // Refresh balance for an account
  app.post<{ Params: { id: string } }>(
    "/api/accounts/:id/balance",
    async (request, reply) => {
      const id = parseInt(request.params.id);
      try {
        const result = await refreshBalance(id);
        if (!result) {
          reply.code(404);
          return { message: "account not found or platform not supported" };
        }
        return result;
      } catch (err: any) {
        reply.code(400);
        return { message: err?.message || "failed to fetch balance" };
      }
    },
  );

  // Get model list for an account (available models + disabled status at site level)
  app.get<{ Params: { id: string } }>(
    "/api/accounts/:id/models",
    async (request, reply) => {
      const accountId = parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ message: "账号 ID 无效" });
      }

      const account = await db
        .select()
        .from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(eq(schema.accounts.id, accountId))
        .get();

      if (!account) {
        return reply.code(404).send({ message: "账号不存在" });
      }

      const siteId = account.accounts.siteId;

      // Get available models for this account
      const modelRows = await db
        .select({
          modelName: schema.modelAvailability.modelName,
          available: schema.modelAvailability.available,
          latencyMs: schema.modelAvailability.latencyMs,
          isManual: schema.modelAvailability.isManual,
        })
        .from(schema.modelAvailability)
        .where(eq(schema.modelAvailability.accountId, accountId))
        .all();

      // Get disabled models for this site
      const disabledRows = await db
        .select({
          modelName: schema.siteDisabledModels.modelName,
        })
        .from(schema.siteDisabledModels)
        .where(eq(schema.siteDisabledModels.siteId, siteId))
        .all();

      const disabledSet = new Set(disabledRows.map((r) => r.modelName));

      const models = modelRows
        .filter((r) => r.available)
        .map((r) => ({
          name: r.modelName,
          latencyMs: r.latencyMs,
          disabled: disabledSet.has(r.modelName),
          isManual: !!r.isManual,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        siteId,
        siteName: account.sites.name,
        models,
        totalCount: models.length,
        disabledCount: models.filter((m) => m.disabled).length,
      };
    },
  );

  // Add models manually to an account
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/accounts/:id/models/manual",
    async (request, reply) => {
      const parsedBody = parseAccountManualModelsPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ message: parsedBody.error });
      }

      const accountId = parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ message: "账号 ID 无效" });
      }

      const { models } = parsedBody.data;
      if (!Array.isArray(models) || models.length === 0) {
        return reply.code(400).send({ message: "模型列表不能为空" });
      }

      const normalizedModels = Array.from(
        new Set(
          models.map((m) => String(m).trim()).filter((m) => m.length > 0),
        ),
      );
      if (normalizedModels.length === 0) {
        return reply.code(400).send({ message: "模型列表不能为空" });
      }

      const account = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();

      if (!account) {
        return reply.code(404).send({ message: "账号不存在" });
      }

      try {
        await db.transaction(async (tx) => {
          const checkedAt = new Date().toISOString();
          for (const modelName of normalizedModels) {
            if (runtimeDbDialect === "mysql") {
              const existing = await tx
                .select()
                .from(schema.modelAvailability)
                .where(
                  and(
                    eq(schema.modelAvailability.accountId, accountId),
                    eq(schema.modelAvailability.modelName, modelName),
                  ),
                )
                .get();

              if (existing) {
                await tx
                  .update(schema.modelAvailability)
                  .set({
                    available: true,
                    latencyMs: null,
                    isManual: true,
                    checkedAt,
                  })
                  .where(eq(schema.modelAvailability.id, existing.id))
                  .run();
              } else {
                await tx
                  .insert(schema.modelAvailability)
                  .values({
                    accountId,
                    modelName,
                    available: true,
                    isManual: true,
                    latencyMs: null,
                    checkedAt,
                  })
                  .run();
              }
            } else {
              // SQLite / PostgreSQL path
              await (
                tx.insert(schema.modelAvailability).values({
                  accountId,
                  modelName,
                  available: true,
                  isManual: true,
                  latencyMs: null,
                  checkedAt,
                }) as any
              )
                .onConflictDoUpdate({
                  target: [
                    schema.modelAvailability.accountId,
                    schema.modelAvailability.modelName,
                  ],
                  set: {
                    available: true,
                    isManual: true,
                    latencyMs: null,
                    checkedAt,
                  },
                })
                .run();
            }
          }
        });
        await rebuildRoutesBestEffort();

        return { success: true };
      } catch (err: any) {
        return reply
          .code(500)
          .send({ success: false, message: err?.message || "保存失败" });
      }
    },
  );

  // 从账号中移除手动添加的模型
  app.delete<{ Params: { id: string }; Body: unknown }>(
    "/api/accounts/:id/models/manual",
    async (request, reply) => {
      const parsedBody = parseAccountManualModelDeletePayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ message: parsedBody.error });
      }

      const accountId = parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ message: "账号 ID 无效" });
      }

      const modelName = String(parsedBody.data.modelName || "").trim();
      if (!modelName) {
        return reply.code(400).send({ message: "模型名称不能为空" });
      }

      const account = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();

      if (!account) {
        return reply.code(404).send({ message: "账号不存在" });
      }

      const existing = await db
        .select({
          id: schema.modelAvailability.id,
          isManual: schema.modelAvailability.isManual,
        })
        .from(schema.modelAvailability)
        .where(
          and(
            eq(schema.modelAvailability.accountId, accountId),
            eq(schema.modelAvailability.modelName, modelName),
          ),
        )
        .get();

      if (!existing) {
        return { success: true };
      }

      if (!existing.isManual) {
        return reply.code(400).send({ message: "仅可移除手动添加的模型" });
      }

      await db
        .delete(schema.modelAvailability)
        .where(eq(schema.modelAvailability.id, existing.id))
        .run();

      await rebuildRoutesBestEffort();
      return { success: true };
    },
  );
}
