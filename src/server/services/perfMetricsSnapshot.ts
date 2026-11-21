import {
  aggregatePerfTtft,
  readPerfGroupEntry,
  readPerfSummaryModelEntry,
  type PerfDisplayState,
  type PerfSeriesPoint,
  type PerfSnapshot,
} from '../../shared/perfMetricsValue.js';
import {
  classifyPerfCacheAge,
  pickPerfGroupEntry,
  pickPerfModelEntry,
  type CachedPerfDetail,
  type CachedPerfSummary,
} from './perfMetricsCache.js';

/**
 * perf-metrics 快照组装（S3-1/S4-1/S5 的服务端公共层）。
 *
 * 定位：把"读预热缓存 → 结构性挑条 → 交 shared 权威层判值 → 拼成跨层 PerfSnapshot"
 * 收敛成一处纯函数。stats.ts / tokens.ts 只把缓存片段递进来，**不碰 perf 原始字段名**
 * （字段解析唯一住在 shared/perfMetricsValue.ts，S0-5 守卫强制）。
 *
 * 状态语义（判据 2/5 的落点）：
 * - **所有相关缓存都不存在 → 返回 null**（从未预热：无 perf 能力的站/首轮未跑/上游无此模型）。
 *   调用方据此整组不渲染——不给没数据的行挂一排空 chip（S2 的立场：界面按能力位决定显不显）。
 * - 缓存 age=stale（超 5min 新鲜期但 ≤24h）→ state='stale'，**数值照常给**（chip 不消失，
 *   tooltip 标"数据截至"）；age=expired（>24h）→ 仍返回快照、state=notPublished
 *   （判据 5 的超时转"上游未公示"：让用户能区分"这站公示过但现在断了"与"根本没这功能"）。
 * - summary 有缓存但 models[] 里挑不到该模型 → 'noWindowTraffic'（窗口内无调用，正当空态）。
 * - 1h 窗独立判定：24h 有值、1h 无流量很常见（数据篇 hours=1 实测 n=0），各字段各归各的空态。
 */

function notPublishedCell() {
  return { value: null, present: false, dubious: false, emptyReason: 'notPublished' as const };
}

function emptySnapshot(state: 'notPublished', capturedAt: number | null, groupName?: string): PerfSnapshot {
  return {
    state,
    capturedAt,
    // 分组级空快照也要带组名：S4 tooltip 与"计价分组逐字符一致"校验需要知道"缺的是哪档的数"。
    ...(groupName ? { groupName } : {}),
    tps: notPublishedCell(),
    ttft: notPublishedCell(),
    latency: notPublishedCell(),
    success24: notPublishedCell(),
    success1h: notPublishedCell(),
  };
}

/**
 * 模型级快照（广场站点行 5 chip 的数据源，S3-1）。
 * ttft 来自详情 series[] 自聚合（summary 两端点顶层都无 ttft，数据篇实测）。
 */
export function buildModelPerfSnapshot(input: {
  modelName: string;
  summary24: CachedPerfSummary | null;
  summary1: CachedPerfSummary | null;
  detail24: CachedPerfDetail | null;
  nowMs: number;
}): PerfSnapshot | null {
  const { modelName, summary24, summary1, detail24, nowMs } = input;
  const capturedAt = summary24?.capturedAt ?? summary1?.capturedAt ?? null;

  // 两窗都没缓存=该站该模型从未被预热（无能力/未探测/首轮未跑）→ null：调用方整组不渲染，
  // 不给没数据的行挂一排"上游未公示"（那是断供的专属文案，判据 5）。
  if (!summary24 && !summary1) return null;

  const age24 = summary24 ? classifyPerfCacheAge(summary24.capturedAt, nowMs) : 'expired';
  const age1 = summary1 ? classifyPerfCacheAge(summary1.capturedAt, nowMs) : 'expired';
  // 唯一有缓存的窗已过期 → 不供旧值。
  if (age24 === 'expired' && age1 === 'expired') return emptySnapshot('notPublished', capturedAt);

  const usable24 = age24 === 'fresh' || age24 === 'stale' ? summary24 : null;
  const usable1 = age1 === 'fresh' || age1 === 'stale' ? summary1 : null;

  const entry24 = usable24 ? pickPerfModelEntry(usable24.models, modelName) : null;
  const entry1 = usable1 ? pickPerfModelEntry(usable1.models, modelName) : null;
  // 归因分三种：窗可用且挑到模型=value；窗可用但挑不到=窗口内无调用；窗不可用(过期/缺失)=未公示。
  const presence24 = usable24 ? (entry24 ? 'value' : 'noWindowTraffic') : 'notPublished';
  const presence1 = usable1 ? (entry1 ? 'value' : 'noWindowTraffic') : 'notPublished';
  const cells24 = readPerfSummaryModelEntry(entry24, presence24);
  const cells1 = readPerfSummaryModelEntry(entry1, presence1);

  // 首字延迟：详情缓存（含 series[]）自聚合；无详情缓存=上游未公示该模型详情（含 siteC 形整键缺失）。
  const detailAge = detail24 ? classifyPerfCacheAge(detail24.capturedAt, nowMs) : 'expired';
  const usableDetail = detailAge === 'fresh' || detailAge === 'stale' ? detail24 : null;
  const series = Array.isArray((usableDetail?.data as { series?: unknown } | null)?.series)
    ? ((usableDetail!.data as { series: PerfSeriesPoint[] }).series)
    : null;
  const ttft = usableDetail
    ? aggregatePerfTtft(series, 'value')
    : notPublishedCell();

  // 容器态：stale 优先上抛（tooltip 标"数据截至"）；否则以 24h 窗归因为准——
  // 窗不可用(过期/缺失)=notPublished，窗可用但挑不到模型=noWindowTraffic。
  const state: PerfDisplayState = age24 === 'stale' || age1 === 'stale'
    ? 'stale'
    : presence24;

  return {
    state,
    capturedAt,
    tps: cells24.tps,
    ttft,
    latency: cells24.latency,
    success24: cells24.successRate,
    success1h: cells1.successRate,
  };
}

/**
 * 分组级快照表（S5-1 的服务端公共层）。
 *
 * 契约：**逐个复用 buildGroupPerfSnapshot**，绝不另开第二条 groups[] 挑条路径——
 * 同一模型下的 N 个分组共享同一对双窗详情片段，另写挑条=分叉 L7 集合/时间判定 bug 族。
 *
 * 值语义（判据 2/5 在分组维度的落点）：
 * - 双窗都没有该 (site,model) 详情缓存（从未预热/该站无公示能力）→ **null**，
 *   徽章不挂公示成功率（空值不混进表里，调用方按 key 是否存在决定显不显）。
 * - 有过详情但分组名挑不到 → noWindowTraffic 快照（窗口内该分组无调用，正当空态），
 *   **不回退站级/模型级值**（S4-1 立的分组名一致性铁律在 S5 同样生效）。
 * - 有过详情但全过期 → notPublished 快照（诚实断供，"上游未公示"）。
 */
export function buildGroupPerfSnapshotMap(input: {
  groups: string[];
  detail24: CachedPerfDetail | null;
  detail1: CachedPerfDetail | null;
  nowMs: number;
}): Record<string, PerfSnapshot | null> {
  const { groups, detail24, detail1, nowMs } = input;
  const out: Record<string, PerfSnapshot | null> = {};
  for (const raw of groups) {
    const group = String(raw || '').trim();
    if (!group) continue;
    const snap = buildGroupPerfSnapshot({ group, detail24, detail1, nowMs });
    if (snap) out[group] = snap;
  }
  return out;
}

/**
 * 分组级快照（通道 chip / 展开态分组徽章的数据源，S4-1/S5）。
 * 分组名与计价分组**逐字符同源**由调用方保证（挑不到同名条目→空快照，绝不回退站级值）。
 */
export function buildGroupPerfSnapshot(input: {
  group: string;
  detail24: CachedPerfDetail | null;
  detail1: CachedPerfDetail | null;
  nowMs: number;
}): PerfSnapshot | null {
  const { group, detail24, detail1, nowMs } = input;
  const capturedAt = detail24?.capturedAt ?? detail1?.capturedAt ?? null;
  // 从未预热该 (site,model) → null（通道行整组不渲染）；有过详情但全过期 → notPublished 快照（诚实断供）。
  if (!detail24 && !detail1) return null;

  const age24 = detail24 ? classifyPerfCacheAge(detail24.capturedAt, nowMs) : 'expired';
  const age1 = detail1 ? classifyPerfCacheAge(detail1.capturedAt, nowMs) : 'expired';
  if (age24 === 'expired' && age1 === 'expired') return emptySnapshot('notPublished', capturedAt, group);

  const usable24 = age24 === 'fresh' || age24 === 'stale' ? detail24 : null;
  const usable1 = age1 === 'fresh' || age1 === 'stale' ? detail1 : null;

  const entry24 = usable24 ? pickPerfGroupEntry(usable24.data, group) : null;
  const presence24 = usable24 ? (entry24 ? 'value' : 'noWindowTraffic') : 'notPublished';
  const cells24 = readPerfGroupEntry(entry24, presence24);

  const entry1 = usable1 ? pickPerfGroupEntry(usable1.data, group) : null;
  const presence1 = usable1 ? (entry1 ? 'value' : 'noWindowTraffic') : 'notPublished';
  const cells1 = readPerfGroupEntry(entry1, presence1);

  // 容器态同模型级：stale 优先；否则以 24h 窗归因为准（notPublished/noWindowTraffic/value）。
  const state: PerfDisplayState = age24 === 'stale' || age1 === 'stale'
    ? 'stale'
    : presence24;

  return {
    state,
    capturedAt,
    groupName: group,
    tps: cells24.tps,
    ttft: cells24.ttft,
    latency: cells24.latency,
    success24: cells24.successRate,
    success1h: cells1.successRate,
  };
}
