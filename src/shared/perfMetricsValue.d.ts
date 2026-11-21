/**
 * perf-metrics 权威解析层的类型契约（实现见 perfMetricsValue.js）。
 * shared 层被服务端引用的模块均为"手写 .js + 伴生 .d.ts"（服务端 rootDir 罩不住 .ts 源）。
 */

/** perf-metrics 解析三态；第四态 `stale` 由缓存层贴，不在本层。 */
export type PerfMetricState = 'value' | 'noWindowTraffic' | 'notPublished';

/**
 * 展示层四态：在解析三态之上叠加缓存层（S2.5）据 capturedAt 贴入的 `stale`。
 * 这是 server→web 的**线契约**：服务端读预热缓存时算好 state，前端只渲染、不再判时间戳。
 */
export type PerfDisplayState = PerfMetricState | 'stale';

/**
 * 单个指标位点的解析结果。
 * - present=true：有有效读数（value 非空）。
 * - present=false：这一位在当前 payload 里没有有效值（缺键、哨兵 0、或整站无该字段），
 *   具体呈现为"空态 / 上游未公示"由 emptyReason 决定，绝不画成 0。
 */
export interface PerfMetricCell {
  /** 解析后的数值；无有效值时为 null。 */
  value: number | null;
  /** 是否有有效读数。false 时 value 必为 null。 */
  present: boolean;
  /** TPS 专用：数值 ≥ 存疑阈值时置真（仍展示，但带"数据存疑"标记）。 */
  dubious: boolean;
  /** present=false 时的空态归因，供 UI 分文案（"窗口内无调用" vs "上游未公示"）。 */
  emptyReason: 'noWindowTraffic' | 'notPublished' | 'fieldAbsent' | null;
}

/**
 * 一份公示指标快照（**跨层 wire 契约**，纯数据）。
 * server 端 perfMetricsSnapshot.ts 产出、web 端 upstreamMetricsPresentation 消费，
 * 单一来源避免两侧各定义一份而漂移。
 */
export interface PerfSnapshot {
  /** 容器四态（含缓存层贴的 stale）。 */
  state: PerfDisplayState;
  /** 预热成功时刻（毫秒）。stale/数据截至 tooltip 用。 */
  capturedAt?: number | null;
  /** 连续预热失败次数（≥1 才标"预热失败 N 次"）。 */
  failCount?: number;
  /** 分组级快照的分组名（S4 一致性校验用）；站级/模型级快照省略。 */
  groupName?: string | null;
  tps?: PerfMetricCell;
  ttft?: PerfMetricCell;
  latency?: PerfMetricCell;
  success24?: PerfMetricCell;
  success1h?: PerfMetricCell;
}

/** summary 端点的逐模型条目（models[] 里的一条）。 */
export interface PerfSummaryModelEntry {
  model_name?: unknown;
  avg_latency_ms?: unknown;
  avg_tps?: unknown;
  success_rate?: unknown;
  recent_success_series?: unknown;
}

/** 详情端点 `groups[]` 单条解析的前置形状。 */
export interface PerfGroupEntry {
  group?: unknown;
  avg_ttft_ms?: unknown;
  avg_latency_ms?: unknown;
  avg_tps?: unknown;
  success_rate?: unknown;
}

/** 详情端点 series 逐点（只用得到 ttft 聚合）。 */
export interface PerfSeriesPoint {
  avg_ttft_ms?: unknown;
}

export declare const PERF_TPS_DUBIOUS_THRESHOLD: number;

/** 测量族判据（TPS/首字/平均延迟）：有限数且 >0。与成功率族物理分离（L2）。 */
export declare function isPerfValuePresent(raw: unknown): boolean;

/** 成功率族判据：有限数且 >=0（真 0% 是合法读数）。 */
export declare function isPerfSuccessRateNumeric(raw: unknown): boolean;

export declare function readPerfSummaryModelEntry(
  entry: PerfSummaryModelEntry | null | undefined,
  state?: PerfMetricState,
): {
  state: PerfMetricState;
  tps: PerfMetricCell;
  latency: PerfMetricCell;
  successRate: PerfMetricCell;
};

export declare function readPerfGroupEntry(
  entry: PerfGroupEntry | null | undefined,
  state?: PerfMetricState,
): {
  state: PerfMetricState;
  groupName: string | null;
  tps: PerfMetricCell;
  ttft: PerfMetricCell;
  latency: PerfMetricCell;
  successRate: PerfMetricCell;
};

export declare function aggregatePerfTtft(
  series: PerfSeriesPoint[] | null | undefined,
  state: PerfMetricState,
): PerfMetricCell;

export declare function classifySummaryPayload(raw: unknown): {
  state: PerfMetricState;
  models: PerfSummaryModelEntry[];
};

export declare function classifyDetailPayload(raw: unknown): {
  state: PerfMetricState;
  series: PerfSeriesPoint[];
  groups: PerfGroupEntry[];
};

/** 空态文案归一：noWindowTraffic→"无调用"，其余→"未公示"（来源只进 tooltip）。 */
export declare function perfEmptyLabel(reason: PerfMetricCell['emptyReason']): string;

/** 时间窗标注（hours → "24h"/"1h"）。 */
export declare function perfWindowLabel(hours: number): string;
