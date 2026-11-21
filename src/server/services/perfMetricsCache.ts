/**
 * perf-metrics 预热缓存的**纯逻辑核心**（S2.5 的数据层，无 HTTP/无 db）。
 *
 * 与调度器分离的用意：热集计算 / TTL / stale 窗口 / 退避都是"集合运算 + 时间比较"，
 * 是本项目反复踩漂移的地方（L7）。把它们做成无副作用纯函数，才能在单测里对拍、才谈得上验输出不变式。
 * 调度器（perfMetricsWarmService.ts）只负责"取数填进来 + 按这些判据决定要不要重拉"。
 *
 * 缓存的 value 存的是**上游原始响应（裁剪后）** + capturedAt，不在这里做四态判定——
 * raw→cell 的语义解析唯一落在 shared/perfMetricsValue，避免服务端/前端各解一遍字段而漂移。
 */

import type { PerfGroupEntry, PerfSummaryModelEntry } from '../../shared/perfMetricsValue.js';

/** 指标数据新鲜期（对齐 grilling Q4 裁定：数据 5min）。 */
export const PERF_DATA_TTL_MS = 5 * 60_000;
/** 预热失败退避（对齐 PRICE_CACHE_FAILURE_TTL_MS=60s 先例）。 */
export const PERF_FAILURE_BACKOFF_MS = 60_000;
/** stale 最长回看（README 0.2：失败继续供旧数据最多 24h，超时才失效）。 */
export const PERF_STALE_MAX_AGE_MS = 24 * 60 * 60_000;
/** 单请求超时（S2.5-1）。 */
export const PERF_REQUEST_TIMEOUT_MS = 15_000;
/** 每站并发（S2.5-1）。 */
export const PERF_PER_SITE_CONCURRENCY = 2;

/** 两个预热窗口（小时）。summary 双窗 + 详情双窗。 */
export const PERF_HOURS: readonly number[] = [24, 1];

/** 站级 summary 缓存值：裁剪后的原始响应 + 采集时刻。 */
export interface CachedPerfSummary {
  /** 原始 data.models[] 整表（含 model_name/avg_latency_ms/avg_tps/success_rate）；不含 recent_success_series 以控体积。 */
  models: unknown[];
  /** 容器态判定需要的 window 键是否齐（数据篇第四节三站三样）。 */
  hasWindow: boolean;
  capturedAt: number;
}

/** 模型级详情缓存值。 */
export interface CachedPerfDetail {
  /** 原始 data（保留 series[] 供站级 ttft 聚合、groups[] 供分组级）。 */
  data: unknown;
  capturedAt: number;
}

/** summary 缓存键。 */
export function perfSummaryCacheKey(siteId: number, hours: number): string {
  return `summary:${siteId}:${hours}`;
}

/** detail 缓存键。模型名大小写不敏感归一（数据篇：禁模糊匹配，只大小写无关）。 */
export function perfDetailCacheKey(siteId: number, model: string, hours: number): string {
  return `detail:${siteId}:${model.trim().toLowerCase()}:${hours}`;
}

/** 一次待执行的预热任务。 */
export interface PerfWarmTask {
  kind: 'summary' | 'detail';
  siteId: number;
  /** detail 任务才有；summary 为 null。 */
  model: string | null;
  hours: number;
  /** 路由用的端点候选（多 base url 时）；这里只带 siteId，端点解析在调度器侧做。 */
}

/** 活跃通道去重输入（来自 routeChannels ⋈ accounts ⋈ tokenRoutes）。 */
export interface PerfChannelRow {
  siteId: number;
  model: string;
}

function isFresh(capturedAt: number, nowMs: number): boolean {
  return nowMs - capturedAt < PERF_DATA_TTL_MS;
}

/**
 * 计算一轮热集（S2.5-2）。**纯函数，可对拍**（L7）：
 * - summary 任务：每个 perf-capable 站（capability ∈ {public,auth}）× 双窗。
 * - detail 任务：活跃通道去重 (siteId, model) × 双窗；模型名取通道计费同一入参名。
 * 去重靠 cacheKey；模型名空白丢弃；同一 (site,model) 多通道只产一份 detail。
 */
export function computePerfHotSet(
  perfCapableSiteIds: number[],
  activeChannels: PerfChannelRow[],
): PerfWarmTask[] {
  const tasks: PerfWarmTask[] = [];
  const seen = new Set<string>();

  const push = (task: PerfWarmTask, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    tasks.push(task);
  };

  for (const siteId of perfCapableSiteIds) {
    for (const hours of PERF_HOURS) {
      push({ kind: 'summary', siteId, model: null, hours }, perfSummaryCacheKey(siteId, hours));
    }
  }

  for (const row of activeChannels) {
    const model = String(row.model || '').trim();
    if (!model) continue;
    for (const hours of PERF_HOURS) {
      push({ kind: 'detail', siteId: row.siteId, model, hours }, perfDetailCacheKey(row.siteId, model, hours));
    }
  }

  return tasks;
}

/** 某任务当前是否需要重拉：无缓存、或已过新鲜期且未被退避挡住。 */
export function shouldWarmTask(
  task: PerfWarmTask,
  state: { capturedAt?: number; lastFailureAt?: number },
  nowMs: number,
): boolean {
  const capturedAt = state.capturedAt;
  const fresh = capturedAt != null && isFresh(capturedAt, nowMs);
  if (fresh) return false;
  // 失败退避：上次失败未满 60s 不重试。
  if (state.lastFailureAt != null && nowMs - state.lastFailureAt < PERF_FAILURE_BACKOFF_MS) return false;
  return true;
}

/**
 * 读取时把缓存三态升级为展示四态里的 stale（README 0.2）：
 * 新鲜→给值；超新鲜期但 ≤24h→ stale（旧值 + capturedAt）；> 24h→ 失效（调用方转 notPublished）。
 * 返回 'fresh'|'stale'|'expired'。capturedAt 缺失按 expired。
 */
export function classifyPerfCacheAge(capturedAt: number | undefined, nowMs: number): 'fresh' | 'stale' | 'expired' {
  if (capturedAt == null) return 'expired';
  const age = nowMs - capturedAt;
  if (age <= PERF_STALE_MAX_AGE_MS) {
    // 新鲜期以内 fresh；否则 stale（仍 ≤24h）。
    return age < PERF_DATA_TTL_MS ? 'fresh' : 'stale';
  }
  return 'expired';
}

/**
 * 按模型名从原始 models[] 里挑那一条（大小写不敏感、精确等值，禁模糊）。
 * 只读 model_name 做键匹配——**不做任何数值判定**，数值原样透传给 web 的 perfMetricsValue 解。
 */
export function pickPerfModelEntry(models: unknown[], model: string): PerfSummaryModelEntry | null {
  const target = String(model || '').trim().toLowerCase();
  if (!target) return null;
  for (const entry of models) {
    const name = String((entry as { model_name?: unknown })?.model_name || '').trim().toLowerCase();
    if (name === target) return entry as PerfSummaryModelEntry;
  }
  return null;
}

/**
 * 按分组名从详情原始 groups[] 里挑那条（大小写不敏感）。
 * ⚠️ S4 判据 3：分组名须与计价分组**逐字符一致**——这里做大小写不敏感等值，
 * 调用方拿到条目后仍应核对 group 名；挑不到就返回 null（不回退站级 model 值，S4-1）。
 */
export function pickPerfGroupEntry(detailData: unknown, group: string): PerfGroupEntry | null {
  const groups = Array.isArray((detailData as { groups?: unknown })?.groups)
    ? ((detailData as { groups: unknown[] }).groups)
    : [];
  const target = String(group || '').trim().toLowerCase();
  if (!target) return null;
  for (const entry of groups) {
    const name = String((entry as { group?: unknown })?.group || '').trim().toLowerCase();
    if (name === target) return entry as PerfGroupEntry;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 可变存储（S4 重定位）：三个 Map 从 perfMetricsWarmService 挪进本纯层。
 * 理由：tokens.ts 要读缓存（S4-1 perfGroup），但 warmService 硬依赖
 * modelPricingService（buildTokenCandidates）——而 tokens.channel-presentation.test.ts
 * 用两导出工厂 mock 了它，经 warmService 转手会在链接期炸（同 PRICING_CATALOG_PLATFORMS
 * 注释记录的坑）。本层只 import shared 的 .d.ts，对任何 mock 都免疫。
 * ------------------------------------------------------------------ */

const summaryCache = new Map<string, CachedPerfSummary>();
const detailCache = new Map<string, CachedPerfDetail>();
/** 每键最近一次失败时刻（60s 退避用）。 */
const failureAt = new Map<string, number>();

function taskCacheKey(kind: 'summary' | 'detail', siteId: number, model: string | null, hours: number): string {
  return kind === 'summary'
    ? perfSummaryCacheKey(siteId, hours)
    : perfDetailCacheKey(siteId, model || '', hours);
}

/** summary 写入：裁剪 recent_success_series 控体积；数值原样留待 shared 权威层解。 */
export function storePerfSummary(
  siteId: number,
  hours: number,
  rawModels: unknown[],
  hasWindow: boolean,
  capturedAt: number,
): void {
  const slim = rawModels.map((m) => {
    const e = m as Record<string, unknown>;
    return {
      model_name: e.model_name,
      avg_latency_ms: e.avg_latency_ms,
      avg_tps: e.avg_tps,
      success_rate: e.success_rate,
    };
  });
  summaryCache.set(perfSummaryCacheKey(siteId, hours), { models: slim, hasWindow, capturedAt });
}

export function storePerfDetail(
  siteId: number,
  model: string,
  hours: number,
  data: unknown,
  capturedAt: number,
): void {
  detailCache.set(perfDetailCacheKey(siteId, model, hours), { data, capturedAt });
}

/** 读缓存位的 (capturedAt, lastFailureAt)，调度器据此决定要不要重拉。 */
export function getPerfCacheState(
  kind: 'summary' | 'detail',
  siteId: number,
  model: string | null,
  hours: number,
): { capturedAt?: number; lastFailureAt?: number } {
  const key = taskCacheKey(kind, siteId, model, hours);
  const capturedAt = kind === 'summary'
    ? summaryCache.get(key)?.capturedAt
    : detailCache.get(key)?.capturedAt;
  return { capturedAt, lastFailureAt: failureAt.get(key) };
}

export function markPerfCacheFailure(kind: 'summary' | 'detail', siteId: number, model: string | null, hours: number, nowMs: number): void {
  failureAt.set(taskCacheKey(kind, siteId, model, hours), nowMs);
}

export function clearPerfCacheFailure(kind: 'summary' | 'detail', siteId: number, model: string | null, hours: number): void {
  failureAt.delete(taskCacheKey(kind, siteId, model, hours));
}

/** S3/S4 只读缓存入口（绝不触发网络）。新鲜/stale/过期由 classifyPerfCacheAge 判。 */
export function getCachedPerfSummary(siteId: number, hours: number): CachedPerfSummary | null {
  return summaryCache.get(perfSummaryCacheKey(siteId, hours)) ?? null;
}

export function getCachedPerfDetail(siteId: number, model: string, hours: number): CachedPerfDetail | null {
  return detailCache.get(perfDetailCacheKey(siteId, model, hours)) ?? null;
}

/** 测试钩子：清空存储（VPS 单测隔离用）。 */
export function __resetPerfMetricsCacheForTests(): void {
  summaryCache.clear();
  detailCache.clear();
  failureAt.clear();
}
