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
import { maxExcludedSiteCount, splitMetricBySite, summarizeByCurrency } from "./billing/currencySplit.js";
import { listSiteCurrencyRates } from "./billing/siteBillingProfileService.js";
import { getBalanceEvidenceFromExtraConfig, reduceSiteBalanceAvailability } from "./accountExtraConfig.js";

export type DashboardSummaryPayload = {
  totalBalance: number;
  /**
   * S6 / T8.8：人民币口径（逐站换算，充值价未知的站点已排除）。
   * 可选字段 —— 老快照里没有该键，读取方须按"未知"处理而不是当成 0。
   */
  totalBalanceCny?: number;
  /** 被排除出 CNY 合计的站点数；前端必须提示，不得静默少算。 */
  balanceExcludedSiteCount?: number;
  /**
   * F8 第 3 期：被用户显式标记「不计入总余额」的站点数（USD/CNY 合计都已剔除）。
   * 与 balanceExcludedSiteCount 语义不同 —— 后者是"充值价未知、算不出来"，
   * 这里是"用户要求不算"，两者都要提示，否则合计会静默偏小。
   */
  balanceOptOutSiteCount?: number;
  totalUsed: number;
  todaySpend: number;
  todayReward: number;
  /**
   * B2：消耗/收入三个指标的人民币口径（逐站换算，充值价未知的站点已排除）。
   * 与 USD 字段并列存在，读取方按显示货币择一使用；缺键须当作"未知"而不是 0。
   */
  totalUsedCny?: number;
  todaySpendCny?: number;
  todayRewardCny?: number;
  /**
   * 因充值价未知被排除出 CNY 合计的站点数（取四个指标的最大值，非相加）。
   * 前端在 CNY 模式下必须提示，否则总额会"看起来正常地偏小"。
   */
  currencyExcludedSiteCount?: number;
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
  // F8 第 3 期：站点被标记"不计入总余额"时，整站余额从合计里剔除（USD 与 CNY 都剔）。
  // 与"读不到余额"不同——那是数据缺失，这是用户显式决定的统计口径，必须照办并给提示。
  const excludedBalanceSiteIds = new Set<number>();
  const balanceEligibleAccountRows = accountRows.filter((row) => {
    if (row.sites.excludeFromTotalBalance) {
      excludedBalanceSiteIds.add(row.sites.id);
      return false;
    }
    return true;
  });
  const balanceEligibleAccounts = balanceEligibleAccountRows.map((row) => row.accounts);
  const totalBalance = balanceEligibleAccounts.reduce(
    (sum, account) => sum + (account.balance || 0),
    0,
  );
  // S6 / T8.8：双轨口径 —— USD 合计保持不变，另按站点逐笔换算出 CNY 合计。
  // 充值价未知的站点不进 CNY，但必须计入 excludedSiteCount 供前端提示（R7）。
  const billingProfileRowsForSummary = await db.select().from(schema.siteBillingProfiles).all();
  const cnyRateBySiteId = new Map<number, number | null>();
  for (const row of billingProfileRowsForSummary) {
    const rate = Number(row.cnyPerUsd);
    cnyRateBySiteId.set(row.siteId, Number.isFinite(rate) && rate > 0 ? rate : null);
  }
  const balanceBySiteForCurrency = new Map<number, number>();
  for (const row of balanceEligibleAccountRows) {
    balanceBySiteForCurrency.set(
      row.sites.id,
      (balanceBySiteForCurrency.get(row.sites.id) || 0) + (row.accounts.balance || 0),
    );
  }
  // F8：余额「从未读到」的站点也要进 CNY 排除集，理由与缺充值价同构（R7）。
  // accounts.balance 有 schema 默认 0，一条从没刷新成功的连接在这里贡献的是 0 美元，
  // 换算成人民币同样贡献 0 —— 数字上无害，但总额会"看起来正常地偏小"而没有任何说明。
  // 判据与 /api/sites 的 balanceAvailability 完全一致（时间戳最硬 → 证据归并），
  // 两处若口径不同，站点页会说"读不到"而仪表盘不说。
  const balanceReadSites = new Set<number>();
  const balanceEvidenceBySiteId = new Map<number, Array<ReturnType<typeof getBalanceEvidenceFromExtraConfig>>>();
  for (const row of balanceEligibleAccountRows) {
    if (row.accounts.lastBalanceRefresh) {
      balanceReadSites.add(row.sites.id);
      continue;
    }
    const list = balanceEvidenceBySiteId.get(row.sites.id) || [];
    list.push(getBalanceEvidenceFromExtraConfig(row.accounts.extraConfig));
    balanceEvidenceBySiteId.set(row.sites.id, list);
  }
  const balanceUnreadSiteIds = new Set<number>();
  for (const siteId of balanceBySiteForCurrency.keys()) {
    if (balanceReadSites.has(siteId)) continue;
    const availability = reduceSiteBalanceAvailability(balanceEvidenceBySiteId.get(siteId) || []);
    // 只排除**有明确 unavailable 证据**的站点。三种状态各有归属，不能一把抓：
    // - 'known'          → 读到了（上面 balanceReadSites 已拦，或归并结果为 known）
    // - 'unavailable'    → 确认这次没读到，进排除集，让提示如实说"N 个未计入"
    // - 'not-applicable' → 无限配额 / 无余额接口，是"这站没有余额概念"而非"总额不完整"，
    //                      混进同一句提示会夸大问题规模
    // - 'unknown'        → 完全没有证据（存量老数据）。它既不能证明读到过、也不能证明
    //                      读不到，据此改合计口径会把大量正常站点误伤，界面上它们也仍然
    //                      显示数字（formatBalanceOrDash 只在金额为 0 时出占位符）。
    // ⚠️ 这里吃过一次教训：曾把 unknown 一并纳入排除集，于是每个从未刷新过的站都被剔出
    // CNY，totalBalanceCny 直接归 0、提示虚增到全站 —— 而单看这一段逻辑完全"合理"，
    // 只有把 currencySplit 的实际返回值打出来才看出来。判据收紧回只认 unavailable。
    if (availability === 'unavailable') balanceUnreadSiteIds.add(siteId);
  }
  const currencySplit = summarizeByCurrency(
    Array.from(balanceBySiteForCurrency.entries()).map(([siteId, usd]) => ({
      siteId,
      usd,
      // 充值价未知优先；否则按余额不可得排除。
      // ⚠️ cnyPerUsd 的类型是 number | null，而 Map.get 可能返回 undefined ——
      // 直接写三元很容易让"读到过充值价的站点"掉进 undefined 分支，被
      // summarizeByCurrency 当成充值价未知整批排除（且 totalBalanceCny 静默归 0）。
      // 这里必须显式收敛成 null，不要依赖 ?? 之外的隐式兜底。
      cnyPerUsd: balanceUnreadSiteIds.has(siteId) ? null : (cnyRateBySiteId.get(siteId) ?? null),
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
    totalUsedRows,
    proxy24hRow,
    proxyPerformanceRow,
    todaySpendRows,
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
    // S6 / T8.8 → B2：改成按站点分组返回，USD 合计由这些行求和得出（与旧的
    // 单值 SUM 等价），同时让 CNY 能逐站乘各自充值价。缺这一步的话累计消耗
    // 只能显示美元，会和同一张卡上已换算的余额自相矛盾。
    db
      .select({
        siteId: schema.siteDayUsage.siteId,
        usdSpend: sql<number>`coalesce(sum(coalesce(${schema.siteDayUsage.totalSiteSpend}, 0)), 0)`,
      })
      .from(schema.siteDayUsage)
      .innerJoin(schema.sites, eq(schema.siteDayUsage.siteId, schema.sites.id))
      .where(eq(schema.sites.status, "active"))
      .groupBy(schema.siteDayUsage.siteId)
      .all(),
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
    // B2：同上，今日支出也要按站点分组才能逐站换算。
    db
      .select({
        siteId: schema.siteDayUsage.siteId,
        usdSpend: sql<number>`coalesce(sum(coalesce(${schema.siteDayUsage.totalSiteSpend}, 0)), 0)`,
      })
      .from(schema.siteDayUsage)
      .innerJoin(schema.sites, eq(schema.siteDayUsage.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.siteDayUsage.localDay, today),
          eq(schema.sites.status, "active"),
        ),
      )
      .groupBy(schema.siteDayUsage.siteId)
      .all(),
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

  /**
   * B2：四个金额指标统一走"逐站汇总 → 双币拆分"（判据见 currencySplit）。
   *
   * USD 合计仍等于全部站点之和（含充值价未知站点 —— 美元不需要充值价），
   * 与改造前的单值 SUM 等价；CNY 只累计充值价已知的站点，并单独交出被排除数。
   */
  const usedBySite = (totalUsedRows ?? []).map((row) => ({
    siteId: Number(row?.siteId),
    usd: Number(row?.usdSpend || 0),
  }));
  const todaySpendBySite = (todaySpendRows ?? []).map((row) => ({
    siteId: Number(row?.siteId),
    usd: Number(row?.usdSpend || 0),
  }));
  // 今日收入原本就是 accounts 逐个算的，这里改成先按站点归集再换算。
  const rewardBySite = new Map<number, number>();
  for (const row of accountRows) {
    const account = row.accounts;
    const reward = estimateRewardWithTodayIncomeFallback({
      day: today,
      successCount: successCountByAccount[account.id] || 0,
      parsedRewardCount: parsedRewardCountByAccount[account.id] || 0,
      rewardSum: rewardByAccount[account.id] || 0,
      extraConfig: account.extraConfig,
    });
    rewardBySite.set(
      row.sites.id,
      (rewardBySite.get(row.sites.id) || 0) + reward,
    );
  }
  const rewardAmounts = Array.from(rewardBySite.entries()).map(([siteId, usd]) => ({ siteId, usd }));

  const usedSplit = splitMetricBySite(usedBySite, cnyRateBySiteId);
  const todaySpendSplit = splitMetricBySite(todaySpendBySite, cnyRateBySiteId);
  const rewardSplit = splitMetricBySite(rewardAmounts, cnyRateBySiteId);

  const totalUsed = usedSplit.usdSum;
  const todaySpend = todaySpendSplit.usdSum;
  const todayReward = rewardSplit.usdSum;

  // 方案 a1：四个指标各算一次排除数，UI 只取最大值提示一句「N 个站点未计入」。
  // 取最大值而不是相加：缺充值价通常就是同几个站四处都缺，相加会重复计数、
  // 反而夸大问题规模。
  // F8 起余额这一路还包含"余额从未读到"的站点（见上方 balanceUnreadSiteIds），
  // 与缺充值价共用同一句提示 —— 两者对用户是同一个后果：这个 CNY 总额不完整。
  const currencyExcludedSiteCount = maxExcludedSiteCount(
    currencySplit.excludedSiteCount,
    usedSplit.excludedSiteCount,
    todaySpendSplit.excludedSiteCount,
    rewardSplit.excludedSiteCount,
  );

  return {
    totalBalance,
    // S6：CNY 口径与排除计数（USD 字段语义不变，两者并存供前端按开关选择）
    totalBalanceCny: currencySplit.cnyTotal,
    balanceExcludedSiteCount: currencySplit.excludedSiteCount,
    balanceOptOutSiteCount: excludedBalanceSiteIds.size,
    totalUsed: toRoundedMicroNumber(totalUsed),
    todaySpend: toRoundedMicroNumber(todaySpend),
    todayReward: toRoundedMicroNumber(todayReward),
    // B2：四个指标的 CNY 口径。可选字段 —— 老读取方按"未知"处理，不作 0。
    totalUsedCny: toRoundedMicroNumber(usedSplit.cnyTotal),
    todaySpendCny: toRoundedMicroNumber(todaySpendSplit.cnyTotal),
    todayRewardCny: toRoundedMicroNumber(rewardSplit.cnyTotal),
    /**
     * 因充值价未知被排除出 CNY 合计的站点数（四个指标取最大值，见上方注释）。
     * 前端在 CNY 模式下必须提示这个数 —— 否则总额会"看起来正常地偏小"，
     * 用户会当成 bug 报回来。
     */
    currencyExcludedSiteCount,
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

  const [activeSites, siteAvailabilityRows, modelDayRows, currencyRateRows] =
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
      // F3：模型数据分析要出人民币轨道，所以这里也要充值价。
      // 复用站点档案读取（同一实现、同一语义），避免在 insights 里再抄一遍解析规则。
      listSiteCurrencyRates(),
    ]);

  // 与 summary 侧同样的"只认正有限值"规则；缺键即视为未知，不乘 1。
  const insightCnyRateBySiteId = new Map<number, number | null>();
  for (const row of currencyRateRows) {
    insightCnyRateBySiteId.set(row.siteId, row.cnyPerUsd);
  }

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
          // F3：带上站点标识，换算才能在聚合前按站进行
          siteId: row.siteId,
        })),
      { days: 7, cnyRateBySiteId: insightCnyRateBySiteId },
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
