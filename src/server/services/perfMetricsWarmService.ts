import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getRunningTaskByDedupeKey, startBackgroundTask } from './backgroundTaskService.js';
import { runWithSiteApiEndpointPool, type SiteApiEndpointTarget } from './siteApiEndpointService.js';
import { withSiteRecordProxyRequestInit } from './siteProxy.js';
import { buildTokenCandidates } from './modelPricingService.js';
import {
  classifyPerfMetricsProbe,
  type PerfMetricsCapability,
} from './perfMetricsCapability.js';
import {
  PERF_DATA_TTL_MS,
  PERF_FAILURE_BACKOFF_MS,
  PERF_REQUEST_TIMEOUT_MS,
  clearPerfCacheFailure,
  computePerfHotSet,
  getPerfCacheState,
  markPerfCacheFailure,
  shouldWarmTask,
  storePerfDetail,
  storePerfSummary,
  type PerfWarmTask,
} from './perfMetricsCache.js';

/**
 * perf-metrics 预热调度器（S2.5）。模式抄 channelRecoveryProbeService / oauthRefreshScheduler。
 *
 * 职责边界（守"raw→cell 只在 web 一处"）：
 * - 只负责**取数 + 缓存原始片段 + 写能力列**；绝不在此解析 avg_tps≥500 / ttft>0 这类数值语义。
 * - 首轮对 capability=未探测(null) 的站跑一次探测，经共用 classifyPerfMetricsProbe 写 perf_metrics_capability
 *   —— 这样 S2 的"探测执行"与 S2.5 的"预热取数"共用同一份端点/凭据/分类代码，不再单造第二个调度器。
 * - 之后每轮（5min）对 capability∈{public,auth} 的站产双窗热集：站级 summary + 活跃通道去重 (site,model) 详情。
 * - S3/S4 只读本模块暴露的只读缓存，**任何渲染路径都不同步等上游**（判据 5）。
 */

type SiteRow = typeof schema.sites.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;

const WARM_SWEEP_INTERVAL_MS = PERF_DATA_TTL_MS; // 5min

let warmSchedulerTimer: ReturnType<typeof setInterval> | null = null;
let warmSweepInFlight: Promise<void> | null = null;

function shouldUnrefTimer(timer: ReturnType<typeof setInterval>) {
  const t = timer as { unref?: () => void };
  if (typeof t.unref === 'function') t.unref();
}

/** 经端点池发一次 perf GET，返回 HTTP 状态 + 解析后的 JSON（连不上/超时由 pool 抛，caller catch）。 */
async function fetchPerfOnce(
  site: SiteRow,
  path: string,
  token: string | undefined,
): Promise<{ status: number; json: unknown }> {
  return runWithSiteApiEndpointPool(site, async (target: SiteApiEndpointTarget) => {
    const url = `${target.baseUrl}${path}`;
    // withSiteRecordProxyRequestInit 返回 undici 形状 init；其 body 泛型与 DOM fetch 的
    // RequestInit 不兼容（本请求无 body，纯类型噪声），转换后传给 fetch。
    const init = withSiteRecordProxyRequestInit(site, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(PERF_REQUEST_TIMEOUT_MS),
    }) as unknown as RequestInit;
    const response = await fetch(url, init);
    const text = await response.text().catch(() => '');
    let json: unknown = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: response.status, json };
  });
}

function isAuthRequired(status: number): boolean {
  return status === 401 || status === 403;
}

/** 一次带"匿名→凭据候选"回退的 perf 拉取。返回最终拿到的 {status, json}；全网络失败则抛。 */
async function fetchPerfWithAuthFallback(
  site: SiteRow,
  account: AccountRow | null,
  path: string,
): Promise<{ status: number; json: unknown; anonStatus?: number; authedStatus?: number }> {
  const anon = await fetchPerfOnce(site, path, undefined);
  if (!isAuthRequired(anon.status)) {
    return { status: anon.status, json: anon.json, anonStatus: anon.status };
  }
  const candidates = account ? buildTokenCandidates({ account }) : [];
  let lastAuthed: { status: number; json: unknown } | null = null;
  for (const token of candidates) {
    const authed = await fetchPerfOnce(site, path, token);
    lastAuthed = authed;
    if (!isAuthRequired(authed.status)) {
      return { status: authed.status, json: authed.json, anonStatus: anon.status, authedStatus: authed.status };
    }
  }
  return {
    status: lastAuthed?.status ?? anon.status,
    json: lastAuthed?.json ?? null,
    anonStatus: anon.status,
    authedStatus: lastAuthed?.status,
  };
}

async function writeCapability(siteId: number, value: PerfMetricsCapability | null): Promise<void> {
  await db.update(schema.sites)
    .set({ perfMetricsCapability: value, updatedAt: new Date().toISOString() })
    .where(eq(schema.sites.id, siteId))
    .run();
}

/** 首轮能力探测：打 summary 双窗探针，分类写列；命中则顺手填 24h summary 缓存。 */
async function probeAndCacheSite(site: SiteRow, account: AccountRow | null, nowMs: number): Promise<PerfMetricsCapability | null> {
  const path = '/api/perf-metrics/summary?hours=24';
  try {
    const result = await fetchPerfWithAuthFallback(site, account, path);
    const cap = classifyPerfMetricsProbe({
      anonStatus: result.anonStatus,
      authedStatus: result.authedStatus,
      transportError: false,
    });
    if (cap) await writeCapability(site.id, cap);
    if (result.status === 200) {
      const data = (result.json as { data?: { models?: unknown[]; window_start?: unknown } })?.data;
      if (data) storePerfSummary(site.id, 24, data.models ?? [], !!data.window_start, nowMs);
    }
    return cap;
  } catch {
    // 连不上：保持原列（transportError → classify 返 null），绝不因抖动把 public 洗成 none。
    return null;
  }
}

/**
 * 预热任务执行（缓存命中新鲜期直接跳过，失败进退避）。
 * force=true（手动刷新）时跳过"新鲜期不重拉"，但**不跳过失败退避**——
 * 上游挂着时连点手动按钮不该把 15s 超时的请求风暴再放一遍。
 */
async function warmTask(task: PerfWarmTask, site: SiteRow, account: AccountRow | null, nowMs: number, force = false): Promise<void> {
  const state = getPerfCacheState(task.kind, task.siteId, task.model, task.hours);
  if (!force && !shouldWarmTask(task, state, nowMs)) return;
  if (state.lastFailureAt != null && nowMs - state.lastFailureAt < PERF_FAILURE_BACKOFF_MS) return;

  const path = task.kind === 'summary'
    ? `/api/perf-metrics/summary?hours=${task.hours}`
    : `/api/perf-metrics?model=${encodeURIComponent(task.model || '')}&hours=${task.hours}`;
  try {
    const result = await fetchPerfWithAuthFallback(site, account, path);
    if (result.status !== 200) {
      markPerfCacheFailure(task.kind, task.siteId, task.model, task.hours, nowMs);
      // 预热撞 401 且带凭据候选全部仍 401/403 → 会话可能挂了，升能力列 cred_invalid
      // （S2.5-3 与首轮共用分类语义；下一轮 sweep 会对 cred_invalid 重探，autoRelogin 修好后自愈）。
      if (isAuthRequired(result.anonStatus ?? 0) && result.authedStatus != null && isAuthRequired(result.authedStatus)) {
        const current = await db.select({ perfMetricsCapability: schema.sites.perfMetricsCapability })
          .from(schema.sites).where(eq(schema.sites.id, task.siteId)).get();
        if (current?.perfMetricsCapability === 'auth') await writeCapability(task.siteId, 'cred_invalid');
      }
      return;
    }
    clearPerfCacheFailure(task.kind, task.siteId, task.model, task.hours);
    if (task.kind === 'summary') {
      const data = (result.json as { data?: { models?: unknown[]; window_start?: unknown } })?.data;
      storePerfSummary(task.siteId, task.hours, data?.models ?? [], !!data?.window_start, nowMs);
    } else {
      storePerfDetail(task.siteId, task.model || '', task.hours, (result.json as { data?: unknown })?.data ?? null, nowMs);
    }
  } catch {
    markPerfCacheFailure(task.kind, task.siteId, task.model, task.hours, nowMs);
  }
}

function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const safe = Math.max(1, Math.min(items.length || 1, Math.trunc(concurrency || 1)));
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx] as T);
    }
  };
  return Promise.all(Array.from({ length: safe }, run)).then(() => undefined);
}

/** 读 active 站 + 每站一个 active 代表账号（供凭据候选）。 */
async function loadSitesWithRepAccount(): Promise<Array<{ site: SiteRow; account: AccountRow | null }>> {
  const sites = await db.select().from(schema.sites).where(eq(schema.sites.status, 'active')).all();
  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.status, 'active')).all();
  const bySite = new Map<number, AccountRow>();
  for (const a of accounts) if (!bySite.has(a.siteId)) bySite.set(a.siteId, a);
  return sites.map((site) => ({ site, account: bySite.get(site.id) ?? null }));
}

/** 活跃路由通道去重输入：(siteId, model)。 */
async function loadActiveChannelModels(): Promise<Array<{ siteId: number; model: string }>> {
  const rows = await db.select()
    .from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
    .where(and(
      eq(schema.routeChannels.enabled, true),
      eq(schema.accounts.status, 'active'),
    ))
    .all();
  return rows.flatMap((row) => {
    const model = String(row.route_channels.sourceModel || row.token_routes.modelPattern || '').trim();
    if (!model) return [];
    return [{ siteId: row.accounts.siteId, model }];
  });
}

export async function runPerfWarmSweep(options: { nowMs?: number; force?: boolean; siteIds?: number[] } = {}): Promise<void> {
  if (warmSweepInFlight) { await warmSweepInFlight; return; }
  const nowMs = options.nowMs ?? Date.now();
  const force = !!options.force;
  // 手动刷新（S2.5-6）可指定站集；缺省全量。指定时探测步与预热步都只看这些站。
  const only = options.siteIds?.length ? new Set(options.siteIds) : null;
  warmSweepInFlight = (async () => {
    const allSites = await loadSitesWithRepAccount();
    const sitesWithAccount = only ? allSites.filter((x) => only.has(x.site.id)) : allSites;
    const siteById = new Map(sitesWithAccount.map((x) => [x.site.id, x]));

    // 1) 对"未探测(null)"与"凭据失效(cred_invalid)"的站跑探测：前者是首轮，后者是
    //    autoRelogin 修好会话后的自愈通道（cred_invalid 站不在热集里，没人替它重验凭据）。
    for (const { site, account } of sitesWithAccount) {
      if (site.perfMetricsCapability == null || site.perfMetricsCapability === 'cred_invalid') {
        await probeAndCacheSite(site, account, nowMs);
      }
    }

    // 2) 预热集：capability∈{public,auth} 的站 → summary 双窗 + 活跃通道 detail 双窗。
    const reloaded = await db.select().from(schema.sites).where(eq(schema.sites.status, 'active')).all();
    const scoped = only ? reloaded.filter((s) => only.has(s.id)) : reloaded;
    const perfCapable = scoped
      .filter((s) => s.perfMetricsCapability === 'public' || s.perfMetricsCapability === 'auth')
      .map((s) => s.id);
    if (perfCapable.length === 0) return;

    const capableSet = new Set(perfCapable);
    const channels = (await loadActiveChannelModels()).filter((c) => capableSet.has(c.siteId));
    const tasks = computePerfHotSet(perfCapable, channels);

    // 每站并发限流（站间并行、站内任务串行限 2）。
    const bySite = new Map<number, PerfWarmTask[]>();
    for (const task of tasks) {
      const list = bySite.get(task.siteId) || [];
      list.push(task);
      bySite.set(task.siteId, list);
    }
    await mapWithConcurrency([...bySite.entries()], 2, async ([siteId, siteTasks]) => {
      const holder = siteById.get(siteId);
      const account = holder?.account ?? null;
      const site = holder?.site ?? await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
      if (!site) return;
      await mapWithConcurrency(siteTasks, 2, (task) => warmTask(task, site as SiteRow, account, nowMs, force));
    });
  })().finally(() => { warmSweepInFlight = null; });
  await warmSweepInFlight;
}

export function startPerfMetricsWarmScheduler(intervalMs = WARM_SWEEP_INTERVAL_MS) {
  stopPerfMetricsWarmScheduler();
  const safe = Math.max(60_000, Math.trunc(intervalMs || 0));
  warmSchedulerTimer = setInterval(() => {
    void runPerfWarmSweep().catch((e) => console.warn('[perf-warm] sweep failed', e));
  }, safe);
  shouldUnrefTimer(warmSchedulerTimer);
  void runPerfWarmSweep().catch((e) => console.warn('[perf-warm] initial sweep failed', e));
  return { enabled: true, intervalMs: safe };
}

export function stopPerfMetricsWarmScheduler() {
  if (warmSchedulerTimer) {
    clearInterval(warmSchedulerTimer);
    warmSchedulerTimer = null;
  }
}

/**
 * 未热模型的单飞补拉（S2.5-5）：广场翻页翻到没缓存的 (site,model) 时，API 侧触发一次
 * 后台补拉并立即返回，**绝不在渲染路径同步等上游**（判据 5）。
 * dedupeKey=`perf-warm:{site}:{model}`。返回 true=已触发或已有在跑；false=空模型名。
 */
export function requestPerfDetailWarm(siteId: number, model: string): boolean {
  const trimmed = String(model || '').trim();
  if (!trimmed) return false;
  const dedupeKey = `perf-warm:${siteId}:${trimmed.toLowerCase()}`;
  if (getRunningTaskByDedupeKey(dedupeKey)) return true;
  startBackgroundTask(
    {
      type: 'perf-metrics-warm',
      title: '补拉上游公示指标',
      dedupeKey,
      keepMs: 10 * 60 * 1000,
      silentEvents: true,
      notifyOnFailure: false,
      successMessage: '公示指标补拉完成',
      failureMessage: (t) => `公示指标补拉失败：${t.error || 'unknown error'}`,
    },
    async () => {
      const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
      if (!site) return { warmed: false };
      const accounts = await db.select().from(schema.accounts)
        .where(and(eq(schema.accounts.siteId, siteId), eq(schema.accounts.status, 'active'))).all();
      const nowMs = Date.now();
      for (const hours of [24, 1]) {
        await warmTask({ kind: 'detail', siteId, model: trimmed, hours },
          site as SiteRow, accounts[0] ?? null, nowMs);
      }
      return { warmed: true };
    },
  );
  return true;
}

/** S3/S4 只读缓存入口（绝不触发网络）。age 由调用方用 classifyPerfCacheAge 判。 */
// 缓存存储已重定位到 perfMetricsCache（纯层，mock 免疫）；此处 re-export
// 保持 warmService 作为"预热域"门面可被 console/测试直接引用。
export { getCachedPerfDetail, getCachedPerfSummary, __resetPerfMetricsCacheForTests } from './perfMetricsCache.js';
