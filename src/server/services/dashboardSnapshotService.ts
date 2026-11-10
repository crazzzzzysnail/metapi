import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { buildModelAnalysisFromDailyUsage } from "./modelAnalysisService.js";
import { parseCheckinRewardAmount } from "./checkinRewardParser.js";
import {
  formatUtcSqlDateTime,
  getLocalDayRangeUtc,
  getLocalHourAnchor,
  getLocalHourRangeStartUtc,
  getLocalRangeStartDayKey,
} from "./localTimeService.js";
import {
  readSnapshotCache,
  type SnapshotEnvelope,
} from "./snapshotCacheService.js";
import {
  buildSiteAvailabilitySummariesFromHourlyAggregates,
  proxyCostSqlExpression,
  type SiteAvailabilitySiteRow,
  toRoundedMicroNumber,
} from "./statsShared.js";
import { estimateRewardWithTodayIncomeFallback } from "./todayIncomeRewardService.js";
import { createAdminSnapshotPersistence } from "./adminSnapshotStore.js";
import { runUsageAggregationProjectionPass } from "./usageAggregationService.js";
import { summarizeByCurrency } from "./billing/currencySplit.js";

export type DashboardSummaryPayload = {
  totalBalance: number;
  /**
   * S6 / T8.8：人民币口径（逐站换算，汇率未知的站点已排除）。
   * 可选字段 —— 老快照里没有该键，读取方须按"未知"处理而不是当成 0。
   */
  totalBalanceCny?: number;
  /** 被排除出 CNY 合计的站点数；前端必须提示，不得静默少算。 */
  balanceExcludedSiteCount?: number;
  totalUsed: number;
  todaySpend: number;
  todayReward: number;
  activeAccounts: number;
  totalAccounts: number;
  todayCheckin: { success: number; failed: number; total: number };
  proxy24h: {
    success: number;
    failed: number;
    total: number;
    totalTokens: number;
  };
  performance: {
    windowSeconds: number;
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
};

export type DashboardInsightsPayload = {
  siteAvailability: ReturnType<
    typeof buildSiteAvailabilitySummariesFromHourlyAggregates
  >;
  modelAnalysis: ReturnType<typeof buildModelAnalysisFromDailyUsage>;
};

const DASHBOARD_SUMMARY_TTL_MS = 12_000;
const DASHBOARD_INSIGHTS_TTL_MS = 20_000;
const SITE_AVAILABILITY_BUCKET_COUNT = 24;
const dashboardSummaryPersistence =
  createAdminSnapshotPersistence<DashboardSummaryPayload>({
    namespace: "dashboard-summary",
    key: "default",
  });
const dashboardInsightsPersistence =
  createAdminSnapshotPersistence<DashboardInsightsPayload>({
    namespace: "dashboard-insights",
    key: "default",
  });

async function loadDashboardSummaryPayload(): Promise<DashboardSummaryPayload> {
  await runUsageAggregationProjectionPass();

  const accountRows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.sites.status, "active"))
    .all();
  const accounts = accountRows.map((row) => row.accounts);
  const totalBalance = accounts.reduce(
    (sum, account) => sum + (account.balance || 0),
    0,
  );
  // S6 / T8.8：双轨口径 —— USD 合计保持不变，另按站点逐笔换算出 CNY 合计。
  // 汇率未知的站点不进 CNY，但必须计入 excludedSiteCount 供前端提示（R7）。
  const billingProfileRowsForSummary = await db.select().from(schema.siteBillingProfiles).all();
  const cnyRateBySiteId = new Map<number, number | null>();
  for (const row of billingProfileRowsForSummary) {
    const rate = Number(row.cnyPerUsd);
    cnyRateBySiteId.set(row.siteId, Number.isFinite(rate) && rate > 0 ? rate : null);
  }
  const balanceBySiteForCurrency = new Map<number, number>();
  for (const row of accountRows) {
    balanceBySiteForCurrency.set(
      row.sites.id,
      (balanceBySiteForCurrency.get(row.sites.id) || 0) + (row.accounts.balance || 0),
    );
  }
  const currencySplit = summarizeByCurrency(
    Array.from(balanceBySiteForCurrency.entries()).map(([siteId, usd]) => ({
      siteId,
      usd,
      cnyPerUsd: cnyRateBySiteId.get(siteId) ?? null,
    })),
  );
  const activeCount = accounts.filter(
    (account) => account.status === "active",
  ).length;

  const {
    localDay: today,
    startUtc: todayStartUtc,
    endUtc: todayEndUtc,
  } = getLocalDayRangeUtc();
  const nowTs = Date.now();
  const last24hDate = formatUtcSqlDateTime(new Date(nowTs - 86_400_000));
  const lastMinuteDate = formatUtcSqlDateTime(new Date(nowTs - 60_000));

  const [
    todayCheckinRows,
    totalUsedRow,
    proxy24hRow,
    proxyPerformanceRow,
    todaySpendRow,
  ] = await Promise.all([
    db
      .select()
      .from(schema.checkinLogs)
      .innerJoin(
        schema.accounts,
        eq(schema.checkinLogs.accountId, schema.accounts.id),
      )
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.checkinLogs.createdAt, todayStartUtc),
          lt(schema.checkinLogs.createdAt, todayEndUtc),
          eq(schema.sites.status, "active"),
        ),
      )
      .all(),
    db
      .select({
        totalUsed: sql<number>`coalesce(sum(coalesce(${schema.siteDayUsage.totalSiteSpend}, 0)), 0)`,
      })
      .from(schema.siteDayUsage)
      .innerJoin(schema.sites, eq(schema.siteDayUsage.siteId, schema.sites.id))
      .where(eq(schema.sites.status, "active"))
      .get(),
    db
      .select({
        total: sql<number>`count(*)`,
        success: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
        failed: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 0 else 1 end), 0)`,
        totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
      })
      .from(schema.proxyLogs)
      .innerJoin(
        schema.accounts,
        eq(schema.proxyLogs.accountId, schema.accounts.id),
      )
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.proxyLogs.createdAt, last24hDate),
          eq(schema.sites.status, "active"),
        ),
      )
      .get(),
    db
      .select({
        total: sql<number>`count(*)`,
        totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
      })
      .from(schema.proxyLogs)
      .innerJoin(
        schema.accounts,
        eq(schema.proxyLogs.accountId, schema.accounts.id),
      )
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.proxyLogs.createdAt, lastMinuteDate),
          eq(schema.sites.status, "active"),
        ),
      )
      .get(),
    db
      .select({
        todaySpend: sql<number>`coalesce(sum(coalesce(${schema.siteDayUsage.totalSiteSpend}, 0)), 0)`,
      })
      .from(schema.siteDayUsage)
      .innerJoin(schema.sites, eq(schema.siteDayUsage.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.siteDayUsage.localDay, today),
          eq(schema.sites.status, "active"),
        ),
      )
      .get(),
  ]);

  const todayCheckins = todayCheckinRows.map((row) => row.checkin_logs);
  const checkinFailed = todayCheckins.filter(
    (checkin) => checkin.status === "failed",
  ).length;
  const checkinSuccess = todayCheckins.length - checkinFailed;
  const rewardByAccount: Record<number, number> = {};
  const successCountByAccount: Record<number, number> = {};
  const parsedRewardCountByAccount: Record<number, number> = {};
  for (const row of todayCheckinRows) {
    const checkin = row.checkin_logs;
    if (checkin.status !== "success") continue;
    const accountId = row.accounts.id;
    successCountByAccount[accountId] =
      (successCountByAccount[accountId] || 0) + 1;
    const rewardValue =
      parseCheckinRewardAmount(checkin.reward) ||
      parseCheckinRewardAmount(checkin.message);
    if (rewardValue <= 0) continue;
    rewardByAccount[accountId] =
      (rewardByAccount[accountId] || 0) + rewardValue;
    parsedRewardCountByAccount[accountId] =
      (parsedRewardCountByAccount[accountId] || 0) + 1;
  }

  const proxySuccess = Number(proxy24hRow?.success || 0);
  const proxyFailed = Number(proxy24hRow?.failed || 0);
  const proxyTotal = Number(proxy24hRow?.total || 0);
  const totalTokens = Number(proxy24hRow?.totalTokens || 0);
  const requestsPerMinute = Number(proxyPerformanceRow?.total || 0);
  const tokensPerMinute = Number(proxyPerformanceRow?.totalTokens || 0);
  const totalUsed = Number(totalUsedRow?.totalUsed || 0);
  const todaySpend = Number(todaySpendRow?.todaySpend || 0);
  const todayReward = accounts.reduce(
    (sum, account) =>
      sum +
      estimateRewardWithTodayIncomeFallback({
        day: today,
        successCount: successCountByAccount[account.id] || 0,
        parsedRewardCount: parsedRewardCountByAccount[account.id] || 0,
        rewardSum: rewardByAccount[account.id] || 0,
        extraConfig: account.extraConfig,
      }),
    0,
  );

  return {
    totalBalance,
    // S6：CNY 口径与排除计数（USD 字段语义不变，两者并存供前端按开关选择）
    totalBalanceCny: currencySplit.cnyTotal,
    balanceExcludedSiteCount: currencySplit.excludedSiteCount,
    totalUsed: toRoundedMicroNumber(totalUsed),
    todaySpend: toRoundedMicroNumber(todaySpend),
    todayReward: toRoundedMicroNumber(todayReward),
    activeAccounts: activeCount,
    totalAccounts: accounts.length,
    todayCheckin: {
      success: checkinSuccess,
      failed: checkinFailed,
      total: todayCheckins.length,
    },
    proxy24h: {
      success: proxySuccess,
      failed: proxyFailed,
      total: proxyTotal,
      totalTokens,
    },
    performance: {
      windowSeconds: 60,
      requestsPerMinute,
      tokensPerMinute,
    },
  };
}

async function loadDashboardInsightsPayload(): Promise<DashboardInsightsPayload> {
  const siteAvailabilityNow = getLocalHourAnchor();
  const siteAvailabilitySinceUtc = getLocalHourRangeStartUtc(
    SITE_AVAILABILITY_BUCKET_COUNT,
    siteAvailabilityNow,
  );
  const modelAnalysisSinceDay = getLocalRangeStartDayKey(7);
  await runUsageAggregationProjectionPass();

  const [activeSites, siteAvailabilityRows, modelDayRows] =
    await Promise.all([
      db
        .select({
          id: schema.sites.id,
          name: schema.sites.name,
          url: schema.sites.url,
          platform: schema.sites.platform,
          sortOrder: schema.sites.sortOrder,
          isPinned: schema.sites.isPinned,
        })
        .from(schema.sites)
        .where(eq(schema.sites.status, "active"))
        .all(),
      db
        .select()
        .from(schema.siteHourUsage)
        .where(gte(schema.siteHourUsage.bucketStartUtc, siteAvailabilitySinceUtc))
        .all(),
      db
        .select()
        .from(schema.modelDayUsage)
        .where(gte(schema.modelDayUsage.localDay, modelAnalysisSinceDay))
        .all(),
    ]);

  const sortedSites = activeSites.sort(
    (left: SiteAvailabilitySiteRow, right: SiteAvailabilitySiteRow) => {
      const leftPinned = left.isPinned ? 1 : 0;
      const rightPinned = right.isPinned ? 1 : 0;
      if (leftPinned !== rightPinned) return rightPinned - leftPinned;
      const leftOrder = Number(left.sortOrder || 0);
      const rightOrder = Number(right.sortOrder || 0);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.name || "").localeCompare(String(right.name || ""));
    },
  );
  const activeSiteIdSet = new Set(sortedSites.map((site) => site.id));

  return {
    siteAvailability: buildSiteAvailabilitySummariesFromHourlyAggregates(
      sortedSites,
      siteAvailabilityRows
        .filter((row) => activeSiteIdSet.has(row.siteId))
        .map((row) => ({
          siteId: row.siteId,
          hourStartUtc: row.bucketStartUtc,
          totalRequests: row.totalCalls,
          successCount: row.successCalls,
          failedCount: row.failedCalls,
          totalLatencyMs: row.totalLatencyMs,
          latencyCount: row.latencyCount,
        })),
      siteAvailabilityNow,
    ),
    modelAnalysis: buildModelAnalysisFromDailyUsage(
      modelDayRows
        .filter((row) => activeSiteIdSet.has(row.siteId))
        .map((row) => ({
          localDay: row.localDay,
          model: row.model,
          totalCalls: row.totalCalls,
          successCalls: row.successCalls,
          totalTokens: row.totalTokens,
          totalSpend: row.totalSpend,
          totalLatencyMs: row.totalLatencyMs,
        })),
      { days: 7 },
    ),
  };
}

export async function getDashboardSummarySnapshot(options?: {
  forceRefresh?: boolean;
}): Promise<SnapshotEnvelope<DashboardSummaryPayload>> {
  return readSnapshotCache({
    namespace: "dashboard-summary",
    key: "default",
    ttlMs: DASHBOARD_SUMMARY_TTL_MS,
    forceRefresh: options?.forceRefresh,
    persistence: dashboardSummaryPersistence,
    loader: loadDashboardSummaryPayload,
  });
}

export async function getDashboardInsightsSnapshot(options?: {
  forceRefresh?: boolean;
}): Promise<SnapshotEnvelope<DashboardInsightsPayload>> {
  return readSnapshotCache({
    namespace: "dashboard-insights",
    key: "default",
    ttlMs: DASHBOARD_INSIGHTS_TTL_MS,
    forceRefresh: options?.forceRefresh,
    persistence: dashboardInsightsPersistence,
    loader: loadDashboardInsightsPayload,
  });
}
