import { FastifyInstance, FastifyReply } from 'fastify';
import { db, schema } from '../../db/index.js';
import { getInsertedRowId } from '../../db/insertHelpers.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { detectSite } from '../../services/siteDetector.js';
import { invalidateSiteProxyCache, parseSiteProxyUrlInput } from '../../services/siteProxy.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { invalidateTokenRouterCache } from '../../services/tokenRouter.js';
import { parseSiteCustomHeadersInput } from '../../services/siteCustomHeaders.js';
import { getSub2ApiSubscriptionFromExtraConfig, getBalanceEvidenceFromExtraConfig, reduceSiteBalanceAvailability } from '../../services/accountExtraConfig.js';
import {
  parseSiteBatchPayload,
  parseSiteCreatePayload,
  parseSiteDetectPayload,
  parseSiteDisabledModelsPayload,
  parseSiteUpdatePayload,
} from '../../contracts/siteRoutePayloads.js';
import { getSiteInitializationPreset } from '../../../shared/siteInitializationPresets.js';
import { normalizeSiteApiEndpointBaseUrl } from '../../services/siteApiEndpointService.js';
import { analyzePrimarySiteUrl } from '../../../shared/sitePrimaryUrl.js';
import { probeSiteModels } from '../../services/modelService.js';
import { normalizePerfMetricsCapabilityInput } from '../../services/perfMetricsCapability.js';
import { proxyPoolIdExists } from '../../services/proxyPoolService.js';

function sseWrite(raw: import('http').ServerResponse, event: string, data: unknown) {
  try { raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
}

function normalizeSiteStatus(input: unknown): 'active' | 'disabled' | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') return null;
  const status = input.trim().toLowerCase();
  if (status === 'active' || status === 'disabled') return status;
  return null;
}

function normalizePinnedFlag(input: unknown): boolean | null {
  if (input === undefined || input === null) return null;
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') return input !== 0;
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return null;
}

function normalizeUseSystemProxyFlag(input: unknown): boolean | null {
  return normalizePinnedFlag(input);
}

/**
 * 代理池引用入参：undefined=不改；null/空=清除；正整数=设置（存在性由调用方校验）。
 */
function parseSiteProxyIdInput(input: unknown): { present: boolean; valid: boolean; proxyId: number | null } {
  if (input === undefined) return { present: false, valid: true, proxyId: null };
  if (input === null || input === '') return { present: true, valid: true, proxyId: null };
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed <= 0) return { present: true, valid: false, proxyId: null };
  return { present: true, valid: true, proxyId: parsed };
}

function normalizeSortOrder(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  const parsed = Number.parseInt(String(input), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed);
}

function normalizeGlobalWeight(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(0.01, Math.min(100, Number(parsed.toFixed(3))));
}

function normalizeOptionalExternalCheckinUrl(input: unknown): {
  valid: boolean;
  present: boolean;
  url: string | null;
} {
  if (input === undefined) {
    return { valid: true, present: false, url: null };
  }
  if (input === null) {
    return { valid: true, present: true, url: null };
  }
  if (typeof input !== 'string') {
    return { valid: false, present: true, url: null };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: true, present: true, url: null };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, present: true, url: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, present: true, url: null };
  }
  return { valid: true, present: true, url: parsed.toString().replace(/\/+$/, '') };
}

type ErrorLike = {
  message?: string;
  code?: string | number;
  cause?: unknown;
};

function normalizeCanonicalSiteUrl(value: string): string {
  return analyzePrimarySiteUrl(value).persistedUrl;
}

function normalizeSitePlatform(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

type SiteApiEndpointInputRow = {
  url: string;
  enabled: boolean;
  sortOrder: number;
};

function normalizeSiteApiEndpointBoolean(input: unknown): boolean | null {
  return normalizePinnedFlag(input);
}

function normalizeSiteApiEndpointsInput(input: unknown): {
  valid: boolean;
  present: boolean;
  apiEndpoints: SiteApiEndpointInputRow[];
  error?: string;
} {
  if (input === undefined) {
    return { valid: true, present: false, apiEndpoints: [] };
  }
  if (input === null) {
    return { valid: true, present: true, apiEndpoints: [] };
  }
  if (!Array.isArray(input)) {
    return {
      valid: false,
      present: true,
      apiEndpoints: [],
      error: 'Invalid apiEndpoints. Expected an array.',
    };
  }

  const seenUrls = new Set<string>();
  const apiEndpoints: SiteApiEndpointInputRow[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const row = input[index];
    if (!row || typeof row !== 'object') {
      return {
        valid: false,
        present: true,
        apiEndpoints: [],
        error: 'Invalid apiEndpoints item. Expected an object.',
      };
    }

    const rawUrl = typeof (row as { url?: unknown }).url === 'string'
      ? (row as { url: string }).url
      : '';
    const normalizedUrl = normalizeSiteApiEndpointBaseUrl(rawUrl);
    if (!normalizedUrl) {
      return {
        valid: false,
        present: true,
        apiEndpoints: [],
        error: 'Invalid apiEndpoints url. Expected a valid http(s) URL.',
      };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      return {
        valid: false,
        present: true,
        apiEndpoints: [],
        error: 'Invalid apiEndpoints url. Expected a valid http(s) URL.',
      };
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return {
        valid: false,
        present: true,
        apiEndpoints: [],
        error: 'Invalid apiEndpoints url. Expected a valid http(s) URL.',
      };
    }

    if (seenUrls.has(normalizedUrl)) {
      return {
        valid: false,
        present: true,
        apiEndpoints: [],
        error: `Duplicate apiEndpoints url: ${normalizedUrl}`,
      };
    }
    seenUrls.add(normalizedUrl);

    const normalizedEnabled = normalizeSiteApiEndpointBoolean((row as { enabled?: unknown }).enabled);
    if ((row as { enabled?: unknown }).enabled !== undefined && normalizedEnabled === null) {
      return {
        valid: false,
        present: true,
        apiEndpoints: [],
        error: 'Invalid apiEndpoints enabled value. Expected boolean.',
      };
    }

    const normalizedSortOrder = normalizeSortOrder((row as { sortOrder?: unknown }).sortOrder);
    if ((row as { sortOrder?: unknown }).sortOrder !== undefined && normalizedSortOrder === null) {
      return {
        valid: false,
        present: true,
        apiEndpoints: [],
        error: 'Invalid apiEndpoints sortOrder value. Expected non-negative integer.',
      };
    }

    apiEndpoints.push({
      url: normalizedUrl,
      enabled: normalizedEnabled ?? true,
      sortOrder: normalizedSortOrder ?? index,
    });
  }

  return { valid: true, present: true, apiEndpoints };
}

async function loadSiteApiEndpointsBySiteIds(siteIds: number[]) {
  if (siteIds.length === 0) {
    return new Map<number, Array<typeof schema.siteApiEndpoints.$inferSelect>>();
  }

  const rows = await db.select().from(schema.siteApiEndpoints)
    .where(inArray(schema.siteApiEndpoints.siteId, siteIds))
    .orderBy(
      asc(schema.siteApiEndpoints.siteId),
      asc(schema.siteApiEndpoints.sortOrder),
      asc(schema.siteApiEndpoints.id),
    )
    .all();

  const bySiteId = new Map<number, Array<typeof schema.siteApiEndpoints.$inferSelect>>();
  for (const row of rows) {
    const current = bySiteId.get(row.siteId) || [];
    current.push({
      ...row,
      url: normalizeSiteApiEndpointBaseUrl(row.url),
    });
    bySiteId.set(row.siteId, current);
  }
  return bySiteId;
}

async function attachSiteApiEndpoints<T extends { id: number }>(siteRows: T[]) {
  const bySiteId = await loadSiteApiEndpointsBySiteIds(siteRows.map((row) => row.id));
  return siteRows.map((row) => ({
    ...row,
    apiEndpoints: bySiteId.get(row.id) || [],
  }));
}

async function loadSiteWithApiEndpoints(siteId: number) {
  const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
  if (!site) return null;
  const [hydrated] = await attachSiteApiEndpoints([site]);
  return hydrated || null;
}

function getErrorChain(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current as ErrorLike);
    current = (current as ErrorLike).cause;
  }
  return chain;
}

function isSitesPlatformUrlConflict(error: unknown): boolean {
  return getErrorChain(error).some((entry) => {
    const message = String(entry.message || '');
    const lowered = message.toLowerCase();
    const code = String(entry.code || '');
    const isSqliteSitesUnique = (
      (code === 'SQLITE_CONSTRAINT' || code === 'SQLITE_CONSTRAINT_UNIQUE')
      && lowered.includes('unique constraint failed: sites.platform, sites.url')
    );
    return (code === '23505' && lowered.includes('sites_platform_url_unique'))
      || (code === 'ER_DUP_ENTRY' && lowered.includes('sites_platform_url_unique'))
      || isSqliteSitesUnique
      || (lowered.includes('duplicate key value violates unique constraint') && lowered.includes('sites_platform_url_unique'))
      || (lowered.includes('duplicate entry') && lowered.includes('sites_platform_url_unique'));
  });
}

function findExistingSiteBinding(
  siteRows: Array<{ id: number; url: string; platform: string }>,
  platform: string,
  normalizedUrl: string,
  excludedSiteId?: number,
) {
  return siteRows.find((site) => (
    site.platform === platform
    && site.url === normalizedUrl
    && site.id !== excludedSiteId
  ));
}

function sendSiteBindingConflict(reply: FastifyReply, platform: string, normalizedUrl: string) {
  return reply.code(409).send({
    error: `A ${platform} site with URL ${normalizedUrl} already exists.`,
  });
}

type SiteSubscriptionAggregate = {
  activeCount: number;
  totalUsedUsd: number;
  totalMonthlyLimitUsd: number | null;
  totalRemainingUsd: number | null;
  nextExpiresAt: string | null;
  planNames: string[];
  updatedAt: number | null;
};

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function pickEarlierIsoDate(current?: string | null, next?: string | null): string | null {
  if (!current) return next || null;
  if (!next) return current;
  const currentMs = Date.parse(current);
  const nextMs = Date.parse(next);
  if (!Number.isFinite(currentMs)) return next;
  if (!Number.isFinite(nextMs)) return current;
  return nextMs < currentMs ? next : current;
}

function aggregateSiteSubscription(
  current: SiteSubscriptionAggregate | undefined,
  extraConfig?: string | null,
): SiteSubscriptionAggregate | undefined {
  const stored = getSub2ApiSubscriptionFromExtraConfig(extraConfig);
  if (!stored) return current;

  const planNames = new Set(current?.planNames || []);
  let totalMonthlyLimitUsd = current?.totalMonthlyLimitUsd ?? null;
  let nextExpiresAt = current?.nextExpiresAt ?? null;

  for (const item of stored.subscriptions) {
    if (item.groupName) planNames.add(item.groupName);
    if (typeof item.monthlyLimitUsd === 'number' && Number.isFinite(item.monthlyLimitUsd)) {
      totalMonthlyLimitUsd = roundMetric((totalMonthlyLimitUsd ?? 0) + item.monthlyLimitUsd);
    }
    nextExpiresAt = pickEarlierIsoDate(nextExpiresAt, item.expiresAt);
  }

  const totalUsedUsd = roundMetric((current?.totalUsedUsd || 0) + stored.totalUsedUsd);
  const totalRemainingUsd = totalMonthlyLimitUsd == null
    ? null
    : roundMetric(Math.max(0, totalMonthlyLimitUsd - totalUsedUsd));

  return {
    activeCount: (current?.activeCount || 0) + stored.activeCount,
    totalUsedUsd,
    totalMonthlyLimitUsd,
    totalRemainingUsd,
    nextExpiresAt,
    planNames: Array.from(planNames),
    updatedAt: Math.max(current?.updatedAt || 0, stored.updatedAt || 0) || null,
  };
}

export async function sitesRoutes(app: FastifyInstance) {
  function invalidateSiteCaches() {
    invalidateSiteProxyCache();
    invalidateTokenRouterCache();
  }

  async function applySiteStatusSideEffects(
    siteId: number,
    existingSiteName: string,
    normalizedStatus: 'active' | 'disabled',
  ) {
    const now = new Date().toISOString();
    if (normalizedStatus === 'disabled') {
      await db.update(schema.accounts)
        .set({ status: 'disabled', updatedAt: now })
        .where(eq(schema.accounts.siteId, siteId))
        .run();

      try {
        const createdAt = formatUtcSqlDateTime(new Date());
        await db.insert(schema.events).values({
          type: 'status',
          title: '站点已禁用',
          message: `${existingSiteName} 已禁用，关联账号已全部置为禁用`,
          level: 'warning',
          relatedId: siteId,
          relatedType: 'site',
          createdAt,
        }).run();
      } catch { }
      return;
    }

    await db.update(schema.accounts)
      .set({ status: 'active', updatedAt: now })
      .where(and(eq(schema.accounts.siteId, siteId), eq(schema.accounts.status, 'disabled')))
      .run();

    try {
      const createdAt = formatUtcSqlDateTime(new Date());
      await db.insert(schema.events).values({
        type: 'status',
        title: '站点已启用',
        message: `${existingSiteName} 已启用，关联禁用账号已恢复为活跃`,
        level: 'info',
        relatedId: siteId,
        relatedType: 'site',
        createdAt,
      }).run();
    } catch { }
  }

  function normalizeBatchIds(input: unknown): number[] {
    if (!Array.isArray(input)) return [];
    return input
      .map((item) => Number.parseInt(String(item), 10))
      .filter((id) => Number.isFinite(id) && id > 0);
  }

  // List all sites
  app.get('/api/sites', async () => {
    const siteRows = await db.select().from(schema.sites).all();
    const siteRowsWithApiEndpoints = await attachSiteApiEndpoints(siteRows);
    const accountRows = await db.select({
      siteId: schema.accounts.siteId,
      balance: schema.accounts.balance,
      extraConfig: schema.accounts.extraConfig,
      lastBalanceRefresh: schema.accounts.lastBalanceRefresh,
    }).from(schema.accounts).all();
    // T8.9：站点列表要如实展示每个站点的充值价状态（自动探测 / 手动覆盖 / 未知）。
    const billingProfileRows = await db.select().from(schema.siteBillingProfiles).all();
    const billingProfileBySiteId: Record<number, typeof schema.siteBillingProfiles.$inferSelect> = {};
    for (const row of billingProfileRows) billingProfileBySiteId[row.siteId] = row;

    const totalBalanceBySiteId: Record<number, number> = {};
    const subscriptionBySiteId: Record<number, SiteSubscriptionAggregate | undefined> = {};
    // F8 第 1 期：汇总余额之外还要给出"这个总额到底读没读到过"。
    // 站点行只带 balance 数字，证据在每条连接的 extra_config 里，故在此逐行归并。
    const balanceEvidenceBySiteId: Record<number, Array<ReturnType<typeof getBalanceEvidenceFromExtraConfig>>> = {};
    // 无限配额要单独成态（F8 四态里的"不适用"）：归并函数只返回一个状态，
    // 站点级拿不到"哪些连接是无限配额"，界面就会把 ∞ 和 — 画成同一个破折号。
    const unlimitedQuotaBySiteId: Record<number, boolean> = {};
    // 成功时间戳是最硬的"读到过"证据：有些连接（订阅式站点的副号）余额真的存在，
    // 但从不走余额刷新，只凭证据字段会被判成没读到。
    const balanceReadBySiteId: Record<number, boolean> = {};
    for (const row of accountRows) {
      totalBalanceBySiteId[row.siteId] = roundMetric((totalBalanceBySiteId[row.siteId] || 0) + Number(row.balance || 0));
      subscriptionBySiteId[row.siteId] = aggregateSiteSubscription(subscriptionBySiteId[row.siteId], row.extraConfig);
      const evidence = getBalanceEvidenceFromExtraConfig(row.extraConfig);
      const evidenceList = balanceEvidenceBySiteId[row.siteId] || (balanceEvidenceBySiteId[row.siteId] = []);
      evidenceList.push(evidence);
      if (evidence?.status === 'not-applicable' && evidence.reason === 'unlimited-quota') {
        unlimitedQuotaBySiteId[row.siteId] = true;
      }
      if (row.lastBalanceRefresh) balanceReadBySiteId[row.siteId] = true;
    }

    // attachSiteApiEndpoints 属于泛型包装，返回类型里丢了业务列的推断，这里单独取一份
    const balanceCapabilityBySiteId = new Map(siteRows.map((row) => [row.id, row.balanceCapability ?? null]));

    return siteRowsWithApiEndpoints.map((site) => {
      // F8 第 3 期：用户把站点标成"没有余额接口"时，结论最硬——直接判不适用，
      // 不再看连接证据（证据可能还是上次失败时留下的 unavailable）。
      const siteBalanceCapability = balanceCapabilityBySiteId.get(site.id) ?? null;
      const siteAvailability = siteBalanceCapability === 'none'
        ? 'not-applicable'
        : balanceReadBySiteId[site.id]
          ? 'known'
          : reduceSiteBalanceAvailability(balanceEvidenceBySiteId[site.id] || []);
      // 只有"确实不可得"才带原因，供前端挂 tooltip；读得到或完全没证据时保持 null，不猜。
      const siteAvailabilityReason =
        siteBalanceCapability === 'none'
          ? null
          : siteAvailability === 'unavailable' || siteAvailability === 'not-applicable'
            ? (balanceEvidenceBySiteId[site.id] || [])
                .map((evidence) => evidence?.reason)
                .find((reason): reason is NonNullable<typeof reason> => typeof reason === 'string' && reason.length > 0) || null
            : null;
      return {
        ...site,
        totalBalance: Math.round((totalBalanceBySiteId[site.id] || 0) * 1_000_000) / 1_000_000,
        // 'unknown' 表示这个站点下一条连接都没有（或全是存量老数据），前端据此回落推断链
        balanceAvailability: siteAvailability,
        balanceAvailabilityReason: siteAvailabilityReason,
        // F8：站点下任一连接是无限配额 → 余额格画 ∞ 而不是 —。
        // 只在"确实读不到数字"时生效，否则会把已有余额盖成无限符号。
        balanceUnlimitedQuota: !!unlimitedQuotaBySiteId[site.id] && siteAvailability !== 'known',
        subscriptionSummary: subscriptionBySiteId[site.id] || null,
        billingProfile: (() => {
          const p = billingProfileBySiteId[site.id];
          if (!p) {
            return {
              cnyPerUsd: null, rateSource: null, quotaPerUnit: null, quotaSource: null, capturedAt: null,
              quotaDisplayType: null, customCurrencySymbol: null, customCurrencyExchangeRate: null,
              displaySource: null,
            };
          }
          return {
            cnyPerUsd: p.cnyPerUsd ?? null,
            rateSource: p.rateSource ?? null,
            quotaPerUnit: p.quotaPerUnit ?? null,
            quotaSource: p.quotaSource ?? null,
            capturedAt: p.capturedAt ?? null,
            // 上游展示口径（S6）：让界面标出"同一笔钱上游显示成多少自定义单位"。
            quotaDisplayType: p.quotaDisplayType ?? null,
            customCurrencySymbol: p.customCurrencySymbol ?? null,
            customCurrencyExchangeRate: p.customCurrencyExchangeRate ?? null,
            // 口径来源（auto/manual）：手填与探测要能分辨，否则用户看不出自己填的有没有被覆盖。
            displaySource: p.displaySource ?? null,
          };
        })(),
      };
    });
  });

  // T8.10：计费参数（充值价/标尺）的人工维护与重新探测
  app.post<{ Params: { id: string }; Body: unknown }>('/api/sites/:id/billing-profile', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (Number.isNaN(id)) return reply.code(400).send({ success: false, message: '无效的站点 ID' });
    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    if (!site) return reply.code(404).send({ success: false, message: '站点不存在' });

    const body = (request.body || {}) as Record<string, unknown>;
    const mode = String(body.mode || 'manual').trim().toLowerCase();

    if (mode === 'probe') {
      const { probeAndPersistSiteBillingProfile } = await import('../../services/billing/siteBillingProfileService.js');
      const { withSiteRecordProxyRequestInit } = await import('../../services/siteProxy.js');
      // 用户显式点「探测上游充值价」：overrideManual 让上游值覆盖手动值，
      // 否则手填过充值价的站点会永远探测不动（数字与来源都停在手动）。
      // 走 withSiteRecordProxyRequestInit 与保存后的静默探测保持同一套代理/自定义头，
      // 避免"保存能探到、手动点探测却失败"这类因网络路径不同导致的分歧。
      const profile = await probeAndPersistSiteBillingProfile(
        { id: site.id, url: site.url },
        async (url, init) => {
          const { fetch } = await import('undici');
          const res = await fetch(url, withSiteRecordProxyRequestInit(site, init as any));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        },
        { overrideManual: true },
      );
      return { success: true, profile };
    }

    const { setManualBillingOverrides } = await import('../../services/billing/siteBillingProfileService.js');
    const readOverride = (key: string): number | null | undefined => {
      if (!(key in body)) return undefined;
      const raw = body[key];
      if (raw === null || raw === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    // 字符串口径与数字覆盖的三态不同：键缺失 = 不改（undefined），
    // 空串/null = 清除（null），其它 = 原样字符串（合法性由服务层 normalize 把关）。
    const readStringOverride = (key: string): string | null | undefined => {
      if (!(key in body)) return undefined;
      const raw = body[key];
      if (raw === null) return null;
      if (typeof raw === 'string') return raw.trim() === '' ? null : raw;
      return null;
    };
    const profile = await setManualBillingOverrides({
      siteId: site.id,
      cnyPerUsd: readOverride('cnyPerUsd'),
      quotaPerUnit: readOverride('quotaPerUnit'),
      quotaDisplayType: readStringOverride('quotaDisplayType'),
      customCurrencySymbol: readStringOverride('customCurrencySymbol'),
      customCurrencyExchangeRate: readOverride('customCurrencyExchangeRate'),
    });
    return { success: true, profile };
  });

  // F8 第 3 期：站点级余额策略（是否计入总余额、该站是否压根没有余额接口）。
  app.post<{ Params: { id: string }; Body: unknown }>('/api/sites/:id/balance-capability', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (Number.isNaN(id)) return reply.code(400).send({ success: false, message: '无效的站点 ID' });
    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    if (!site) return reply.code(404).send({ success: false, message: '站点不存在' });

    const body = (request.body || {}) as Record<string, unknown>;
    const updates: { excludeFromTotalBalance?: boolean; balanceCapability?: string | null; perfMetricsCapability?: string | null } = {};

    if (Object.prototype.hasOwnProperty.call(body, 'excludeFromTotalBalance')) {
      const raw = body.excludeFromTotalBalance;
      // 只认真正的布尔与 0/1，别的（"true" 字符串之类）宁可报错也不猜
      const normalized = typeof raw === 'boolean' ? raw : (raw === 0 || raw === 1 ? raw === 1 : null);
      if (normalized === null) {
        return reply.code(400).send({ success: false, message: '排除标记格式无效，应为布尔值' });
      }
      updates.excludeFromTotalBalance = normalized;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'balanceCapability')) {
      const raw = body.balanceCapability;
      if (raw === null || raw === '') {
        updates.balanceCapability = null;
      } else {
        const normalized = String(raw).trim().toLowerCase();
        if (normalized !== 'auto' && normalized !== 'none') {
          return reply.code(400).send({ success: false, message: '余额能力取值无效，应为 auto 或 none' });
        }
        updates.balanceCapability = normalized === 'auto' ? null : 'none';
      }
    }

    // S2-2/3：perf-metrics 能力列守卫，复用权威纯函数（与 S2.5 探测写点同一值域判据，不各写各的）。
    if (Object.prototype.hasOwnProperty.call(body, 'perfMetricsCapability')) {
      const normalizedPerf = normalizePerfMetricsCapabilityInput(body.perfMetricsCapability);
      if (!normalizedPerf.ok) {
        return reply.code(400).send({ success: false, message: '公示指标能力取值无效，应为 public/auth/cred_invalid/none 或留空（未探测）' });
      }
      updates.perfMetricsCapability = normalizedPerf.value;
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ success: false, message: '未提供任何需要修改的字段' });
    }

    await db.update(schema.sites)
      .set({ ...updates, updatedAt: new Date().toISOString() })
      .where(eq(schema.sites.id, id))
      .run();

    // 排除标记会改仪表盘合计、余额能力会改账号证据，两边快照都得失效
    const { clearSnapshotCache } = await import('../../services/snapshotCacheService.js');
    const { deleteAdminSnapshotsByNamespace } = await import('../../services/adminSnapshotStore.js');
    // 内存与落库两份都要清：readSnapshotCache 内存未命中会把库里旧快照读回来复用，
    // 只清内存的话保存后页面仍显示旧合计。
    for (const namespace of ['accounts-snapshot', 'dashboard-summary', 'dashboard-insights', 'site-stats']) {
      clearSnapshotCache(namespace);
      await deleteAdminSnapshotsByNamespace(namespace);
    }
    invalidateSiteCaches();

    const updated = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    return {
      success: true,
      site: {
        id: updated?.id,
        excludeFromTotalBalance: !!updated?.excludeFromTotalBalance,
        balanceCapability: updated?.balanceCapability ?? null,
        perfMetricsCapability: updated?.perfMetricsCapability ?? null,
      },
    };
  });

  // Add a site
  app.post<{ Body: unknown }>('/api/sites', async (request, reply) => {
    const parsedBody = parseSiteCreatePayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error });
    }
    const createBody = parsedBody.data as typeof parsedBody.data & { apiEndpoints?: unknown };
    const {
      name,
      url,
      platform,
      initializationPresetId,
      proxyUrl,
      proxyId,
      useSystemProxy,
      customHeaders,
      externalCheckinUrl,
      status,
      isPinned,
      sortOrder,
      globalWeight,
      apiEndpoints,
    } = createBody;
    const normalizedStatus = normalizeSiteStatus(status);
    if (status !== undefined && !normalizedStatus) {
      return reply.code(400).send({ error: 'Invalid site status. Expected active or disabled.' });
    }
    const normalizedUseSystemProxy = normalizeUseSystemProxyFlag(useSystemProxy);
    if (useSystemProxy !== undefined && normalizedUseSystemProxy === null) {
      return reply.code(400).send({ error: 'Invalid useSystemProxy value. Expected boolean.' });
    }
    const normalizedProxyUrl = parseSiteProxyUrlInput(proxyUrl);
    if (!normalizedProxyUrl.valid) {
      return reply.code(400).send({ error: 'Invalid proxyUrl. Expected a valid http(s)/socks proxy URL.' });
    }
    const normalizedProxyId = parseSiteProxyIdInput(proxyId);
    if (!normalizedProxyId.valid) {
      return reply.code(400).send({ error: 'Invalid proxyId. Expected a positive integer or null.' });
    }
    if (normalizedProxyId.proxyId !== null && !await proxyPoolIdExists(normalizedProxyId.proxyId)) {
      return reply.code(400).send({ error: 'Invalid proxyId. Proxy pool entry not found.' });
    }
    const normalizedExternalCheckinUrl = normalizeOptionalExternalCheckinUrl(externalCheckinUrl);
    if (!normalizedExternalCheckinUrl.valid) {
      return reply.code(400).send({ error: 'Invalid externalCheckinUrl. Expected a valid http(s) URL.' });
    }
    const normalizedPinned = normalizePinnedFlag(isPinned);
    if (isPinned !== undefined && normalizedPinned === null) {
      return reply.code(400).send({ error: 'Invalid isPinned value. Expected boolean.' });
    }
    const normalizedSortOrder = normalizeSortOrder(sortOrder);
    if (sortOrder !== undefined && normalizedSortOrder === null) {
      return reply.code(400).send({ error: 'Invalid sortOrder value. Expected non-negative integer.' });
    }
    const normalizedGlobalWeight = normalizeGlobalWeight(globalWeight);
    if (globalWeight !== undefined && normalizedGlobalWeight === null) {
      return reply.code(400).send({ error: 'Invalid globalWeight value. Expected a positive number.' });
    }
    const normalizedCustomHeaders = parseSiteCustomHeadersInput(customHeaders);
    if (!normalizedCustomHeaders.valid) {
      return reply.code(400).send({ error: normalizedCustomHeaders.error || 'Invalid customHeaders.' });
    }
    const explicitInitializationPreset = initializationPresetId == null || initializationPresetId === ''
      ? null
      : getSiteInitializationPreset(initializationPresetId);
    if (initializationPresetId != null && initializationPresetId !== '' && !explicitInitializationPreset) {
      return reply.code(400).send({ error: 'Invalid initializationPresetId.' });
    }
    const normalizedApiEndpoints = normalizeSiteApiEndpointsInput(apiEndpoints);
    if (!normalizedApiEndpoints.valid) {
      return reply.code(400).send({ error: normalizedApiEndpoints.error || 'Invalid apiEndpoints.' });
    }

    const existingSites = await db.select().from(schema.sites).all();
    const maxSortOrder = existingSites.reduce((max, site) => Math.max(max, site.sortOrder || 0), -1);
    const analyzedPrimarySiteUrl = analyzePrimarySiteUrl(url);
    const canonicalUrl = analyzedPrimarySiteUrl.persistedUrl;
    const detectionUrl = analyzedPrimarySiteUrl.canonicalUrl || canonicalUrl;
    const canonicalPlatform = normalizeSitePlatform(platform);
    let detectedPlatform = canonicalPlatform;
    let responseInitializationPresetId: string | null = explicitInitializationPreset?.id || null;
    if (!detectedPlatform) {
      if (explicitInitializationPreset) {
        detectedPlatform = explicitInitializationPreset.platform;
      } else {
        const detected = await detectSite(detectionUrl);
        detectedPlatform = detected?.platform ?? null;
        responseInitializationPresetId = detected?.initializationPresetId || null;
      }
    }
    if (explicitInitializationPreset && explicitInitializationPreset.platform !== detectedPlatform) {
      return reply.code(400).send({ error: 'initializationPresetId does not match the selected platform.' });
    }
    if (!detectedPlatform) {
      return { error: 'Could not detect platform. Please specify manually.' };
    }
    const conflictingSite = findExistingSiteBinding(existingSites, detectedPlatform, canonicalUrl);
    if (conflictingSite) {
      return sendSiteBindingConflict(reply, detectedPlatform, canonicalUrl);
    }

    let inserted;
    try {
      inserted = await db.transaction(async (tx) => {
        const siteInsert = await tx.insert(schema.sites).values({
          name,
          url: canonicalUrl,
          platform: detectedPlatform,
          proxyUrl: normalizedProxyUrl.proxyUrl,
          proxyId: normalizedProxyId.proxyId,
          useSystemProxy: normalizedUseSystemProxy ?? false,
          customHeaders: normalizedCustomHeaders.customHeaders,
          externalCheckinUrl: normalizedExternalCheckinUrl.url,
          status: normalizedStatus ?? 'active',
          isPinned: normalizedPinned ?? false,
          sortOrder: normalizedSortOrder ?? (maxSortOrder + 1),
          globalWeight: normalizedGlobalWeight ?? 1,
        }).run();
        const siteId = getInsertedRowId(siteInsert);
        if (siteId && normalizedApiEndpoints.present && normalizedApiEndpoints.apiEndpoints.length > 0) {
          await tx.insert(schema.siteApiEndpoints).values(
            normalizedApiEndpoints.apiEndpoints.map((row) => ({
              siteId,
              url: row.url,
              enabled: row.enabled,
              sortOrder: row.sortOrder,
            })),
          ).run();
        }
        return siteInsert;
      });
    } catch (error) {
      if (isSitesPlatformUrlConflict(error)) {
        return sendSiteBindingConflict(reply, detectedPlatform, canonicalUrl);
      }
      throw error;
    }
    const siteId = getInsertedRowId(inserted);
    if (!siteId) {
      return reply.code(500).send({ error: 'Create site failed' });
    }
    const result = await loadSiteWithApiEndpoints(siteId);
    if (!result) {
      return reply.code(500).send({ error: 'Create site failed' });
    }
    invalidateSiteCaches();
    return {
      ...result,
      ...(responseInitializationPresetId ? { initializationPresetId: responseInitializationPresetId } : {}),
    };
  });

  // Update a site
  app.put<{ Params: { id: string }; Body: unknown }>('/api/sites/:id', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (Number.isNaN(id)) {
      return reply.code(400).send({ error: 'Invalid site id' });
    }

    const existingSite = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    if (!existingSite) {
      return reply.code(404).send({ error: 'Site not found' });
    }

    const parsedBody = parseSiteUpdatePayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error });
    }

    const updates: any = {};
    const body = parsedBody.data as typeof parsedBody.data & { apiEndpoints?: unknown };
    const normalizedStatus = normalizeSiteStatus(body.status);
    if (body.status !== undefined && !normalizedStatus) {
      return reply.code(400).send({ error: 'Invalid site status. Expected active or disabled.' });
    }
    const normalizedUseSystemProxy = normalizeUseSystemProxyFlag(body.useSystemProxy);
    if (body.useSystemProxy !== undefined && normalizedUseSystemProxy === null) {
      return reply.code(400).send({ error: 'Invalid useSystemProxy value. Expected boolean.' });
    }
    const normalizedProxyUrl = parseSiteProxyUrlInput(body.proxyUrl);
    if (!normalizedProxyUrl.valid) {
      return reply.code(400).send({ error: 'Invalid proxyUrl. Expected a valid http(s)/socks proxy URL.' });
    }
    const normalizedProxyId = parseSiteProxyIdInput(body.proxyId);
    if (!normalizedProxyId.valid) {
      return reply.code(400).send({ error: 'Invalid proxyId. Expected a positive integer or null.' });
    }
    if (normalizedProxyId.proxyId !== null && !await proxyPoolIdExists(normalizedProxyId.proxyId)) {
      return reply.code(400).send({ error: 'Invalid proxyId. Proxy pool entry not found.' });
    }
    const normalizedExternalCheckinUrl = normalizeOptionalExternalCheckinUrl(body.externalCheckinUrl);
    if (!normalizedExternalCheckinUrl.valid) {
      return reply.code(400).send({ error: 'Invalid externalCheckinUrl. Expected a valid http(s) URL.' });
    }
    const normalizedPinned = normalizePinnedFlag(body.isPinned);
    if (body.isPinned !== undefined && normalizedPinned === null) {
      return reply.code(400).send({ error: 'Invalid isPinned value. Expected boolean.' });
    }
    const normalizedSortOrder = normalizeSortOrder(body.sortOrder);
    if (body.sortOrder !== undefined && normalizedSortOrder === null) {
      return reply.code(400).send({ error: 'Invalid sortOrder value. Expected non-negative integer.' });
    }
    const normalizedGlobalWeight = normalizeGlobalWeight(body.globalWeight);
    if (body.globalWeight !== undefined && normalizedGlobalWeight === null) {
      return reply.code(400).send({ error: 'Invalid globalWeight value. Expected a positive number.' });
    }
    const normalizedCustomHeaders = parseSiteCustomHeadersInput(body.customHeaders);
    if (!normalizedCustomHeaders.valid) {
      return reply.code(400).send({ error: normalizedCustomHeaders.error || 'Invalid customHeaders.' });
    }
    const normalizedApiEndpoints = normalizeSiteApiEndpointsInput(body.apiEndpoints);
    if (!normalizedApiEndpoints.valid) {
      return reply.code(400).send({ error: normalizedApiEndpoints.error || 'Invalid apiEndpoints.' });
    }

    const canonicalPlatform = normalizeSitePlatform(body.platform);
    const nextUrl = body.url !== undefined ? normalizeCanonicalSiteUrl(body.url) : existingSite.url;
    const nextPlatform = body.platform !== undefined
      ? canonicalPlatform
      : existingSite.platform;
    if (body.platform !== undefined && !nextPlatform) {
      return reply.code(400).send({ error: 'Invalid platform. Expected non-empty string.' });
    }
    const siteIdentityChanged = nextUrl !== existingSite.url || nextPlatform !== existingSite.platform;
    if (siteIdentityChanged) {
      const siteRows = await db.select({
        id: schema.sites.id,
        url: schema.sites.url,
        platform: schema.sites.platform,
      }).from(schema.sites).all();
      const conflictingSite = findExistingSiteBinding(siteRows, nextPlatform, nextUrl, id);
      if (conflictingSite) {
        return sendSiteBindingConflict(reply, nextPlatform, nextUrl);
      }
    }

    if (body.name !== undefined) updates.name = body.name;
    if (body.url !== undefined) updates.url = nextUrl;
    if (body.platform !== undefined) updates.platform = nextPlatform;
    if (normalizedProxyUrl.present) updates.proxyUrl = normalizedProxyUrl.proxyUrl;
    if (normalizedProxyId.present) updates.proxyId = normalizedProxyId.proxyId;
    if (body.useSystemProxy !== undefined) updates.useSystemProxy = normalizedUseSystemProxy;
    if (normalizedCustomHeaders.present) updates.customHeaders = normalizedCustomHeaders.customHeaders;
    if (normalizedExternalCheckinUrl.present) updates.externalCheckinUrl = normalizedExternalCheckinUrl.url;
    if (body.status !== undefined) updates.status = normalizedStatus;
    if (body.isPinned !== undefined) updates.isPinned = normalizedPinned;
    if (body.sortOrder !== undefined) updates.sortOrder = normalizedSortOrder;
    if (body.globalWeight !== undefined) updates.globalWeight = normalizedGlobalWeight;
    const anyBody = body as Record<string, unknown>;
    if (anyBody.postRefreshProbeEnabled !== undefined) updates.postRefreshProbeEnabled = anyBody.postRefreshProbeEnabled === true || anyBody.postRefreshProbeEnabled === 1;
    if (anyBody.postRefreshProbeModel !== undefined) updates.postRefreshProbeModel = String(anyBody.postRefreshProbeModel || '').trim();
    if (anyBody.postRefreshProbeScope !== undefined) updates.postRefreshProbeScope = anyBody.postRefreshProbeScope === 'all' ? 'all' : 'single';
    if (anyBody.postRefreshProbeLatencyThresholdMs !== undefined) {
      const ms = Number(anyBody.postRefreshProbeLatencyThresholdMs);
      updates.postRefreshProbeLatencyThresholdMs = Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : 0;
    }
    updates.updatedAt = new Date().toISOString();
    try {
      await db.transaction(async (tx) => {
        await tx.update(schema.sites).set(updates).where(eq(schema.sites.id, id)).run();
        if (normalizedApiEndpoints.present) {
          await tx.delete(schema.siteApiEndpoints)
            .where(eq(schema.siteApiEndpoints.siteId, id))
            .run();
          if (normalizedApiEndpoints.apiEndpoints.length > 0) {
            await tx.insert(schema.siteApiEndpoints).values(
              normalizedApiEndpoints.apiEndpoints.map((row) => ({
                siteId: id,
                url: row.url,
                enabled: row.enabled,
                sortOrder: row.sortOrder,
              })),
            ).run();
          }
        }
      });
    } catch (error) {
      if (isSitesPlatformUrlConflict(error)) {
        return sendSiteBindingConflict(reply, nextPlatform, nextUrl);
      }
      throw error;
    }

    if (body.status !== undefined && normalizedStatus) {
      await applySiteStatusSideEffects(id, existingSite.name, normalizedStatus);
    }

    invalidateSiteCaches();

    // S6 / T8.4：站点保存后异步探测一次计费参数（充值价/标尺）。
    // 失败不影响本次保存结果 —— 探测不到就留 null，界面显示"充值价未知"。
    void import('../../services/billing/siteBillingProfileService.js')
      .then(({ probeAndPersistSiteBillingProfile }) => probeAndPersistSiteBillingProfile(
        { id, url: nextUrl },
        async (probeUrl, init) => {
          const { fetch } = await import('undici');
          const { withSiteRecordProxyRequestInit } = await import('../../services/siteProxy.js');
          // 该 helper 是同步的且吃的是站点记录（含代理与自定义头），不是 URL
          const res = await fetch(probeUrl, withSiteRecordProxyRequestInit(existingSite, init as any));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        },
      ))
      .catch(() => {});

    return await loadSiteWithApiEndpoints(id);
  });

  // Delete a site
  app.delete<{ Params: { id: string } }>('/api/sites/:id', async (request) => {
    const id = parseInt(request.params.id);
    await db.delete(schema.sites).where(eq(schema.sites.id, id)).run();
    invalidateSiteCaches();
    return { success: true };
  });

  app.post<{ Body: unknown }>('/api/sites/batch', async (request, reply) => {
    const parsedBody = parseSiteBatchPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ message: parsedBody.error });
    }

    const ids = normalizeBatchIds(parsedBody.data.ids);
    const action = String(parsedBody.data.action || '').trim();
    if (ids.length === 0) {
      return reply.code(400).send({ message: 'ids is required' });
    }
    if (!['enable', 'disable', 'delete', 'enableSystemProxy', 'disableSystemProxy', 'updateSettings'].includes(action)) {
      return reply.code(400).send({ message: 'Invalid action' });
    }
    const normalizedBatchGlobalWeight = normalizeGlobalWeight(parsedBody.data.globalWeight);
    if (action === 'updateSettings' && parsedBody.data.globalWeight !== undefined && normalizedBatchGlobalWeight === null) {
      return reply.code(400).send({ message: 'Invalid globalWeight value. Expected a positive number.' });
    }
    const normalizedBatchProxyUrl = parseSiteProxyUrlInput(parsedBody.data.proxyUrl);
    if (action === 'updateSettings' && !normalizedBatchProxyUrl.valid) {
      return reply.code(400).send({ message: 'Invalid proxyUrl. Expected a valid http(s)/socks proxy URL.' });
    }
    const normalizedBatchProxyId = parseSiteProxyIdInput(parsedBody.data.proxyId);
    if (action === 'updateSettings' && !normalizedBatchProxyId.valid) {
      return reply.code(400).send({ message: 'Invalid proxyId. Expected a positive integer or null.' });
    }
    if (
      action === 'updateSettings'
      && normalizedBatchProxyId.proxyId !== null
      && !await proxyPoolIdExists(normalizedBatchProxyId.proxyId)
    ) {
      return reply.code(400).send({ message: 'Invalid proxyId. Proxy pool entry not found.' });
    }
    const normalizedBatchUseSystemProxy = normalizeUseSystemProxyFlag(parsedBody.data.useSystemProxy);
    if (action === 'updateSettings' && parsedBody.data.useSystemProxy !== undefined && normalizedBatchUseSystemProxy === null) {
      return reply.code(400).send({ message: 'Invalid useSystemProxy value. Expected boolean.' });
    }
    if (
      action === 'updateSettings'
      && normalizedBatchGlobalWeight === null
      && !normalizedBatchProxyUrl.present
      && !normalizedBatchProxyId.present
      && parsedBody.data.useSystemProxy === undefined
    ) {
      return reply.code(400).send({ message: 'No batch settings provided.' });
    }

    const successIds: number[] = [];
    const failedItems: Array<{ id: number; message: string }> = [];

    for (const id of ids) {
      const existingSite = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
      if (!existingSite) {
        failedItems.push({ id, message: 'Site not found' });
        continue;
      }

      try {
        if (action === 'delete') {
          await db.delete(schema.sites).where(eq(schema.sites.id, id)).run();
        } else if (action === 'enableSystemProxy') {
          await db.update(schema.sites)
            .set({ useSystemProxy: true, updatedAt: new Date().toISOString() })
            .where(eq(schema.sites.id, id))
            .run();
        } else if (action === 'disableSystemProxy') {
          await db.update(schema.sites)
            .set({ useSystemProxy: false, updatedAt: new Date().toISOString() })
            .where(eq(schema.sites.id, id))
            .run();
        } else if (action === 'updateSettings') {
          const updates: Partial<typeof schema.sites.$inferInsert> = {
            updatedAt: new Date().toISOString(),
          };
          if (normalizedBatchGlobalWeight !== null) updates.globalWeight = normalizedBatchGlobalWeight;
          if (normalizedBatchProxyUrl.present) updates.proxyUrl = normalizedBatchProxyUrl.proxyUrl;
          if (normalizedBatchProxyId.present) updates.proxyId = normalizedBatchProxyId.proxyId;
          if (parsedBody.data.useSystemProxy !== undefined) updates.useSystemProxy = normalizedBatchUseSystemProxy;
          await db.update(schema.sites)
            .set(updates)
            .where(eq(schema.sites.id, id))
            .run();
        } else {
          const nextStatus = action === 'enable' ? 'active' : 'disabled';
          await db.update(schema.sites)
            .set({ status: nextStatus, updatedAt: new Date().toISOString() })
            .where(eq(schema.sites.id, id))
            .run();
          await applySiteStatusSideEffects(id, existingSite.name, nextStatus);
        }
        successIds.push(id);
      } catch (error: any) {
        failedItems.push({ id, message: error?.message || 'Batch operation failed' });
      }
    }

    invalidateSiteCaches();
    return {
      success: true,
      successIds,
      failedItems,
    };
  });

  // Get disabled models for a site
  app.get<{ Params: { id: string } }>('/api/sites/:id/disabled-models', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (Number.isNaN(id)) {
      return reply.code(400).send({ error: 'Invalid site id' });
    }
    const existingSite = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    if (!existingSite) {
      return reply.code(404).send({ error: 'Site not found' });
    }
    const rows = await db.select({ modelName: schema.siteDisabledModels.modelName })
      .from(schema.siteDisabledModels)
      .where(eq(schema.siteDisabledModels.siteId, id))
      .all();
    return { siteId: id, models: rows.map((r) => r.modelName) };
  });

  // Update disabled models for a site (full replace)
  app.put<{ Params: { id: string }; Body: unknown }>('/api/sites/:id/disabled-models', async (request, reply) => {
    const parsedBody = parseSiteDisabledModelsPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error });
    }

    const id = parseInt(request.params.id);
    if (Number.isNaN(id)) {
      return reply.code(400).send({ error: 'Invalid site id' });
    }
    const existingSite = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    if (!existingSite) {
      return reply.code(404).send({ error: 'Site not found' });
    }
    const rawModels = parsedBody.data.models;
    if (!Array.isArray(rawModels)) {
      return reply.code(400).send({ error: 'models must be an array of strings' });
    }
    const models = rawModels
      .filter((m): m is string => typeof m === 'string')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    const uniqueModels = Array.from(new Set(models));

    await db.delete(schema.siteDisabledModels)
      .where(eq(schema.siteDisabledModels.siteId, id))
      .run();

    if (uniqueModels.length > 0) {
      await db.insert(schema.siteDisabledModels).values(
        uniqueModels.map((modelName) => ({ siteId: id, modelName })),
      ).run();
    }

    invalidateSiteCaches();
    return { siteId: id, models: uniqueModels };
  });

  // Get all discovered models for a site (from model_availability and token_model_availability)
  app.get<{ Params: { id: string } }>('/api/sites/:id/available-models', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (Number.isNaN(id)) {
      return reply.code(400).send({ error: 'Invalid site id' });
    }
    const existingSite = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    if (!existingSite) {
      return reply.code(404).send({ error: 'Site not found' });
    }

    // Get models from model_availability (account-level)
    const accountModels = await db.select({ modelName: schema.modelAvailability.modelName })
      .from(schema.modelAvailability)
      .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
      .where(
        and(
          eq(schema.accounts.siteId, id),
          eq(schema.modelAvailability.available, true),
        ),
      )
      .all();

    // Get models from token_model_availability (token-level)
    const tokenModels = await db.select({ modelName: schema.tokenModelAvailability.modelName })
      .from(schema.tokenModelAvailability)
      .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .where(
        and(
          eq(schema.accounts.siteId, id),
          eq(schema.tokenModelAvailability.available, true),
        ),
      )
      .all();

    const models = Array.from(new Set([
      ...accountModels.map((r) => r.modelName.trim()),
      ...tokenModels.map((r) => r.modelName.trim()),
    ])).filter((m) => m.length > 0).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    return { siteId: id, models };
  });

  // Manually probe site models now (one-shot JSON)
  app.post<{ Params: { id: string }; Body: unknown }>('/api/sites/:id/probe-now', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (Number.isNaN(id)) {
      return reply.code(400).send({ error: 'Invalid site id' });
    }
    const body = request.body as Record<string, unknown> | null;
    const scope = body?.scope === 'all' ? 'all' : body?.scope === 'single' ? 'single' : undefined;
    const modelName = typeof body?.modelName === 'string' ? body.modelName.trim() : undefined;
    const parsedThresholdBody = Number(body?.latencyThresholdMs ?? 0);
    const latencyThresholdMsBody = Number.isFinite(parsedThresholdBody) && parsedThresholdBody > 0 ? Math.trunc(parsedThresholdBody) : undefined;
    const result = await probeSiteModels(id, { scope, modelName, latencyThresholdMs: latencyThresholdMsBody });
    if (!result.success) {
      return reply.code(422).send({ error: result.error });
    }
    return result;
  });

  // Streaming probe via SSE
  app.get<{ Params: { id: string }; Querystring: { scope?: string; modelName?: string; latencyThresholdMs?: string } }>(
    '/api/sites/:id/probe-stream',
    async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const id = parseInt(request.params.id);
      if (Number.isNaN(id)) {
        sseWrite(reply.raw, 'error', { message: 'Invalid site id' });
        reply.raw.end();
        return;
      }

      const q = request.query;
      const scope = q.scope === 'all' ? 'all' : q.scope === 'single' ? 'single' : undefined;
      const modelName = q.modelName?.trim() || undefined;
      const parsedThreshold = parseInt(q.latencyThresholdMs ?? '', 10);
      const latencyThresholdMs = Number.isFinite(parsedThreshold) && parsedThreshold > 0 ? parsedThreshold : undefined;

      // Propagate client disconnect to the probe worker pool
      const probeAbort = new AbortController();
      reply.raw.on('close', () => probeAbort.abort());

      try {
        const result = await probeSiteModels(id, { scope, modelName, latencyThresholdMs, signal: probeAbort.signal }, (ev) => {
          sseWrite(reply.raw, ev.type, ev);
        });
        if (!probeAbort.signal.aborted) {
          sseWrite(reply.raw, 'complete', result);
        }
      } catch (err: any) {
        sseWrite(reply.raw, 'error', { message: err?.message || '探测失败' });
      }
      reply.raw.end();
    },
  );

  // Detect platform for a URL
  app.post<{ Body: unknown }>('/api/sites/detect', async (request, reply) => {
    const parsedBody = parseSiteDetectPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error });
    }

    const result = await detectSite(parsedBody.data.url);
    return result || { error: 'Could not detect platform' };
  });
}
