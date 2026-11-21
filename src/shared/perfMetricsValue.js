/**
 * 上游公示指标（perf-metrics）的**权威解析层**（S0-2）。
 *
 * 形态说明：与 src/shared 下被服务端引用的全部模块（sitePrimaryUrl 等）一致，
 * 采用"手写 .js + 伴生 .d.ts"入库——服务端 tsconfig 的 rootDir 只罩 src/server，
 * 不能 import 共享层的 .ts 源；构建时整个 src/shared 拷入 dist/shared。
 * 类型契约见 perfMetricsValue.d.ts。
 *
 * 定位：纯函数、无 React、无 fetch、无时间戳。所有"脏值/空态/存疑"判定集中在这里产出，
 * 页面不得自行 `==0` 判空（教训 L3）。规则来源见
 * `docs/plans/2026-11-16-upstream-model-metrics/model-square-perf-metrics.md` 第五/六/七节。
 *
 * 三组硬规矩（动工前由更强模型复核钉死，纠正了初稿两处写歪的规则）：
 *
 * 1. **两套有效性判据物理分离**（数据篇第七节第 3 条，教训 L2）：
 *    - 测量类（TPS / 首字延迟 / 平均延迟）：`> 0` 才算有值。上游用 `0` 作"无此值"哨兵
 *      （`avg_ttft_ms==0` 前端 `e<=0→"—"`），所以 `0` 与负数都判无。
 *      `isPerfValuePresent` 是这一族的唯一入口。
 *    - 成功率：`>= 0` 且**该口径有数据点**才算有值。真 0% 是合法读数（"有调用但全失败"，
 *      数据篇第七节第 1 条），绝不能按 `>0` 判成"无"。
 *    两族判据是不同函数，互不调用、互不共用。
 *
 * 2. **站点级 summary 结构禁令**（数据篇第七节第 2 条）：`data.summary`（无论 summary 端点
 *    还是详情端点的顶层汇总）是**跨模型全站聚合**，会被恒 0% 的 embedding 类拉穿
 *    （实测某站全站成功率仅 11.59%），且"是否仅含非对话类别"无法从一个标量反推。
 *    ⇒ 本模块**不提供任何读取 summary 标量的入口**：chip 只认
 *    `models[]` 逐条（模型级）与 `groups[]` 逐条（分组级）。这是"由构造强制"的禁令，
 *    不是一条需要启发式判断的检查。
 *
 * 3. **capturedAt / stale 不在本层**：`notPublished / noWindowTraffic / value` 可从 payload
 *    形状推出；而 stale 的唯一输入是 capturedAt，raw 里没有它。把 capturedAt 塞进纯函数签名
 *    =邀请调用方各传时间戳=本项目反复踩的"两套匹配器漂移"。故本层只出三态，
 *    缓存层（S2.5 的 perfMetricsWarmService）按 capturedAt 是否超窗把三态升为第四态 stale。
 */

/**
 * TPS 存疑阈值。数据篇第五节实测：4431 个采样单元里 `avg_tps>=500` 有 102 个、
 * `>=5000` 有 15 个（最大 3,020,584 tok/s），500~3M 连续分布、没有干净边界。
 * 故取保守下界 500 判"存疑"，切不准就承认切不准——只标疑、不删值、不外推。
 * 写成常量并指向本节，便于产品日后调整。
 */
export const PERF_TPS_DUBIOUS_THRESHOLD = 500;

/**
 * 测量类判据（TPS / 首字延迟 / 平均延迟共用）：必须是有限数且 `> 0`。
 *
 * ⚠️ 这是 perf-metrics 一族的判据，与上游"账号自日志"链路的另一个负值哨兵、
 * 以及 metapi 本库 proxy_logs 的 first_byte_latency_ms **都不是同一条链路**，各用各的判据。
 * 测量族这里非正值一律判无：那个负千级哨兵在这里只因为 `>0` 不成立而落无值，
 * 纯属"非正值皆无值"，不是对它的专门识别（数据篇第七节第 3 条、S0-3 钉死，教训 L2）。
 * 本函数**绝不**出现"若等于某个负千级值则……"这类日志族专门的判据分支——
 * 两族判据合并过就会串味，S0-5 架构守卫正拦这个。
 */
export function isPerfValuePresent(raw) {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0;
}

/**
 * 成功率有效性判据（与测量类物理分离）：`>= 0` 的有限数即为"上游给了成功率数字"，
 * 真 0% 算有效读数。但光有数字还不够——必须叠加"该口径有数据点"，
 * 才能把"真 0%（有调用全失败）"与"窗口无流量（压根没请求）"分开。
 */
export function isPerfSuccessRateNumeric(raw) {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0;
}

/** 空 cell 的统一构造。 */
function emptyCell(reason) {
  return { value: null, present: false, dubious: false, emptyReason: reason };
}

function valueCell(value, dubious = false) {
  return { value, present: true, dubious, emptyReason: null };
}

/**
 * 测量位点解析：present>0→value，否则按 state 归因空态。
 * @param allowDubious 仅 TPS 传 true（存疑阈值只对吞吐有意义）；
 *                     延迟/首字绝不套用——实测正常延迟 7087ms 远超 500，若共用会全员误标。
 */
function readMetric(raw, state, allowDubious) {
  if (isPerfValuePresent(raw)) {
    const dubious = allowDubious && raw >= PERF_TPS_DUBIOUS_THRESHOLD;
    return valueCell(raw, dubious);
  }
  if (state === 'noWindowTraffic') return emptyCell('noWindowTraffic');
  if (state === 'notPublished') return emptyCell('notPublished');
  return emptyCell('fieldAbsent');
}

/**
 * 成功率位点解析。
 *
 * 调用前提：**这条 entry 来自一个已判定为 value 的容器**（models[]/groups[] 非空、或该条本身存在）。
 * 数据点的"有没有"已由 classifySummaryPayload / classifyDetailPayload 把关——
 * 它们把 models:[]/series:[]&groups:[] 全空的窗口判成 noWindowTraffic，根本不会走到这里读 success_rate。
 * 故进入本函数且 state=value 时，"该口径有数据点"已成立，`success_rate===0` 就是真 0%（数据篇第七节第 1 条），
 * 直接当有效读数，绝不当"无"。这样把"有数据点"的判定收敛在上游容器层，避免每个调用点各判一次（L7 集合类漂移）。
 */
function readSuccessRate(raw, state) {
  if (state === 'noWindowTraffic') return emptyCell('noWindowTraffic');
  if (state === 'notPublished') return emptyCell('notPublished');
  // 容器已是 value：条目存在=有数据点，数值 >=0（含真 0%）即有效读数。
  if (isPerfSuccessRateNumeric(raw)) return valueCell(raw);
  return emptyCell('fieldAbsent');
}

/** summary 端点 `data.models[]` 单条解析 → 模型级（无 ttft，summary 不含首字）。 */
export function readPerfSummaryModelEntry(entry, state = 'value') {
  const e = entry ?? {};
  // summary 端点只把"窗口内有过调用"的模型放进 models[]，条目存在本身即数据点信号；
  // hours=1 无流量时返回的是 models:[]（整条不存在），调用方按 noWindowTraffic 传 state。
  // 故对一条已存在的 models[] 记录（state=value），success_rate=0 是真 0%。
  return {
    state,
    tps: readMetric(e.avg_tps, state, true),
    latency: readMetric(e.avg_latency_ms, state, false),
    successRate: readSuccessRate(e.success_rate, state),
  };
}

/** 详情端点 `groups[]` 单条解析 → 分组级（含 ttft）。 */
export function readPerfGroupEntry(entry, state = 'value') {
  const e = entry ?? {};
  const rawName = typeof e.group === 'string' ? e.group.trim() : '';
  return {
    state,
    groupName: rawName || null,
    // 分组级 ttft 直接来自 groups[] 条目顶层字段（数据篇示例：groups[] 每条带 avg_ttft_ms）。
    tps: readMetric(e.avg_tps, state, true),
    ttft: readMetric(e.avg_ttft_ms, state, false),
    latency: readMetric(e.avg_latency_ms, state, false),
    // 分组条目存在=该分组窗口内有调用，允许真 0%（判据收敛在容器层，见 readSuccessRate 注释）。
    successRate: readSuccessRate(e.success_rate, state),
  };
}

/**
 * 站级/模型级首字延迟自聚合（S3 用）。
 *
 * 关键实测：summary 端点和详情端点的顶层 summary **都没有 avg_ttft_ms 字段**，
 * ttft 只在 `series[]`（和 `groups[]`）逐点里。故站级首字要自己按 series[] 聚合。
 * 某站可整窗 ttft 全 0（coarena 实测 20/20）⇒ 聚合后无正点 → 空态，绝不报 0ms。
 *
 * @param series  详情端点 data.series[]；缺键或非数组按"无点"处理。
 * @param state   容器三态（决定空态归因）。
 */
export function aggregatePerfTtft(series, state) {
  const points = Array.isArray(series) ? series : [];
  const ttftValues = points
    .map((p) => (p && typeof p === 'object' ? p.avg_ttft_ms : undefined))
    .filter((v) => isPerfValuePresent(v));
  if (ttftValues.length === 0) {
    // 无任何正 ttft 点：按容器态归因。value 态但全 0 → fieldAbsent（上游给了该模型却没首字数据）。
    if (state === 'noWindowTraffic') return emptyCell('noWindowTraffic');
    if (state === 'notPublished') return emptyCell('notPublished');
    return emptyCell('fieldAbsent');
  }
  const mean = ttftValues.reduce((sum, v) => sum + v, 0) / ttftValues.length;
  return valueCell(Math.round(mean));
}

/**
 * 从 summary 端点整体 payload 判定容器三态。
 *
 * 数据篇第四节实测无数据形态三站三样，必须全可选链：
 * - 404 / success=false / 无 data → `notPublished`（该站不公示 / 凭据失效由上层能力列区分）。
 * - `data.models` 缺失或为空数组 → `noWindowTraffic`（窗口内无调用，window_* 仍在）。
 * - 有 models → `value`。
 */
export function classifySummaryPayload(raw) {
  const data = raw && typeof raw === 'object' ? raw.data : null;
  if (data === null || typeof data !== 'object' || data === undefined) {
    return { state: 'notPublished', models: [] };
  }
  const models = Array.isArray(data.models) ? data.models : [];
  if (models.length === 0) {
    return { state: 'noWindowTraffic', models: [] };
  }
  return { state: 'value', models };
}

/**
 * 从详情端点整体 payload 判定容器三态（不含分组取数，分组走 readPerfGroupEntry）。
 *
 * 详情端点更碎：siteC 形 `data` 只有 model_name/series_schema/groups 三键，
 * summary/series/window_* **整个不存在**。故：
 * - 无 data / data 非对象 → `notPublished`。
 * - 有 groups[] 非空 → `value`（分组级可用）。
 * - series[] 非空 → `value`（首字可聚合）。
 * - 两者都空、但 data 存在 → `noWindowTraffic`。
 */
export function classifyDetailPayload(raw) {
  const data = raw && typeof raw === 'object' ? raw.data : null;
  if (data === null || typeof data !== 'object' || data === undefined) {
    return { state: 'notPublished', series: [], groups: [] };
  }
  const series = Array.isArray(data.series) ? data.series : [];
  const groups = Array.isArray(data.groups) ? data.groups : [];
  if (series.length === 0 && groups.length === 0) {
    return { state: 'noWindowTraffic', series: [], groups: [] };
  }
  return { state: 'value', series, groups };
}

/**
 * 空态文案：把 emptyReason 归一成 UI 文案。集中在此，页面不各写各的（L3/L7）。
 * 用户 2026-11-20 点 1 改判：精简为短词，来源（"上游公示"）只写进 tooltip，不再进空态文案。
 * - `noWindowTraffic` → "无调用"
 * - `notPublished` / `fieldAbsent` → "未公示"
 */
export function perfEmptyLabel(reason) {
  return reason === 'noWindowTraffic' ? '无调用' : '未公示';
}

/** 时间窗标注文案（hours → "24h"/"1h"），供 tooltip 集中产出。 */
export function perfWindowLabel(hours) {
  return `${hours}h`;
}
