import {
  formatLocalDate,
  parseStoredUtcDateTime,
  type StoredUtcDateTimeInput,
} from './localTimeService.js';
import { tokensToUsd } from './billing/quotaScale.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface ProxyLogLike {
  createdAt: StoredUtcDateTimeInput;
  modelActual: string | null;
  modelRequested: string | null;
  status: string | null;
  latencyMs: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  // 站点平台，用于缺省费用时的额度标尺换算；缺省按 new-api 口径处理。
  sitePlatform?: string | null;
}

/**
 * 双轨金额：USD 原值 + 人民币换算值。
 *
 * 为什么要同时给两个数而不是"按需返回一个"：
 *   - 显示币种是前端运行时开关，后端不该为它预先决定口径；
 *   - `unconvertedUsdSpend` 记录**因汇率未知而没能换算的那部分美元额**。
 *     少了它，CNY 数字会"看起来正常地偏小"，用户与排障者都无从判断。
 * 三个字段恒为满足：spendCny + unconvertedUsdSpend ≈ spend（仅在多站混合且
 * 部分站缺汇率时才有未换算部分）。
 */
interface SpendTracks {
  /** 美元原值（所有站点，不受汇率影响）。 */
  spend: number;
  /** 已按各站汇率换算并累加的人民币值。 */
  spendCny: number;
  /** 汇率未知、因此没进 spendCny 的那部分美元额。 */
  unconvertedUsdSpend: number;
}

interface ModelAnalysisResult {
  window: {
    start: string;
    end: string;
    days: number;
  };
  totals: {
    calls: number;
    tokens: number;
    spend: number;
    spendCny: number;
    unconvertedUsdSpend: number;
  };
  spendDistribution: Array<{
    model: string;
    spend: number;
    calls: number;
    spendCny: number;
    unconvertedUsdSpend: number;
  }>;
  spendTrend: Array<{
    day: string;
    spend: number;
    spendCny: number;
    unconvertedUsdSpend: number;
  }>;
  callsDistribution: Array<{
    model: string;
    calls: number;
    share: number;
  }>;
  callRanking: Array<{
    model: string;
    calls: number;
    successRate: number;
    avgLatencyMs: number;
    spend: number;
    spendCny: number;
    unconvertedUsdSpend: number;
    tokens: number;
  }>;
}

interface BuildOptions {
  now?: Date;
  days?: number;
  maxModels?: number;
  /**
   * 站点 → 人民币汇率（F3：模型数据分析跟随显示货币）。
   * 不传或某站缺键时，该站的成本只进 USD 轨道，并计入 unconvertedUsdSpend ——
   * 绝不乘 1、也不借别站的汇率。
   */
  cnyRateBySiteId?: Map<number, number | null>;
}

export interface ModelAnalysisDailyUsageRow {
  localDay: string;
  model: string;
  totalCalls: number;
  successCalls: number;
  totalTokens: number;
  totalSpend: number;
  totalLatencyMs: number;
  /**
   * 站点标识。model_day_usage 唯一键是 (localDay, siteId, model)，
   * 即同一模型同一天可能来自多个站点，而汇率逐站维护 ——
   * 所以换算必须发生在"按模型聚合之前"，聚合后统一乘一次汇率是错的。
   * 可选以兼容既有调用方与测试。
   */
  siteId?: number;
}

interface MutableModelStats extends SpendTracks {
  model: string;
  calls: number;
  success: number;
  latencyTotal: number;
  tokens: number;
}

function startOfLocalDay(value: Date): Date {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
    0,
    0,
    0,
    0,
  );
}

function dayKey(value: Date): string {
  return formatLocalDate(value);
}

function toSafeNumber(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return value;
}

function toPositiveInt(value: unknown): number {
  return Math.max(0, Math.round(toSafeNumber(value)));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function resolveModelName(log: ProxyLogLike): string {
  const raw = (log.modelActual || log.modelRequested || '').trim();
  return raw.length > 0 ? raw : 'unknown';
}

export function resolveModelAnalysisSpend(
  log: Pick<ProxyLogLike, 'estimatedCost'>,
  tokens: number,
  platform?: string | null,
): number {
  const explicit = toSafeNumber(log.estimatedCost);
  if (explicit > 0) return explicit;
  if (tokens <= 0) return 0;
  // 标尺统一走 quotaScale；缺省平台沿用 new-api 口径（500_000），与历史行为一致。
  return tokensToUsd(tokens, platform ?? 'new-api');
}

/**
 * 组装双轨输出。
 *
 * ⚠️ 排序一律按 **USD** 值，不按 CNY：两种币种下同一模型的相对名次可能不同
 * （各站汇率不一样），若按当前展示币种排序，用户切换货币时排行榜会重排，
 * 看起来像数据变了，其实只是换了标尺。金额跟着变、次序不变，才是可解释的。
 */
function finalizeModelAnalysis(
  stats: MutableModelStats[],
  dayKeys: string[],
  spendTrendMap: Map<string, SpendTracks>,
  maxModels: number,
): ModelAnalysisResult {
  const totalCalls = stats.reduce((sum, item) => sum + item.calls, 0);
  const totalTokens = stats.reduce((sum, item) => sum + item.tokens, 0);
  const totalSpend = round(stats.reduce((sum, item) => sum + item.spend, 0), 6);
  const totalSpendCny = round(stats.reduce((sum, item) => sum + item.spendCny, 0), 6);
  const totalUnconverted = round(stats.reduce((sum, item) => sum + item.unconvertedUsdSpend, 0), 6);

  const spendDistribution = [...stats]
    .sort((a, b) => b.spend - a.spend)
    .slice(0, maxModels)
    .map((item) => ({
      model: item.model,
      spend: round(item.spend, 6),
      calls: item.calls,
      spendCny: round(item.spendCny, 6),
      unconvertedUsdSpend: round(item.unconvertedUsdSpend, 6),
    }));

  const callsDistribution = [...stats]
    .sort((a, b) => b.calls - a.calls)
    .slice(0, maxModels)
    .map((item) => ({
      model: item.model,
      calls: item.calls,
      share: totalCalls > 0 ? round((item.calls / totalCalls) * 100, 2) : 0,
    }));

  const callRanking = [...stats]
    .sort((a, b) => b.calls - a.calls)
    .slice(0, maxModels)
    .map((item) => ({
      model: item.model,
      calls: item.calls,
      successRate: item.calls > 0 ? round((item.success / item.calls) * 100, 2) : 0,
      avgLatencyMs: item.calls > 0 ? Math.round(item.latencyTotal / item.calls) : 0,
      spend: round(item.spend, 6),
      spendCny: round(item.spendCny, 6),
      unconvertedUsdSpend: round(item.unconvertedUsdSpend, 6),
      tokens: item.tokens,
    }));

  const spendTrend = dayKeys.map((day) => {
    const track = spendTrendMap.get(day) ?? { spend: 0, spendCny: 0, unconvertedUsdSpend: 0 };
    return {
      day,
      spend: round(track.spend, 6),
      spendCny: round(track.spendCny, 6),
      unconvertedUsdSpend: round(track.unconvertedUsdSpend, 6),
    };
  });

  return {
    window: {
      start: dayKeys[0],
      end: dayKeys[dayKeys.length - 1],
      days: dayKeys.length,
    },
    totals: {
      calls: totalCalls,
      tokens: totalTokens,
      spend: totalSpend,
      spendCny: totalSpendCny,
      unconvertedUsdSpend: totalUnconverted,
    },
    spendDistribution,
    spendTrend,
    callsDistribution,
    callRanking,
  };
}

export function buildModelAnalysis(
  logs: ProxyLogLike[],
  options: BuildOptions = {},
): ModelAnalysisResult {
  const now = options.now ?? new Date();
  const days = Math.max(1, options.days ?? 7);
  const maxModels = Math.max(1, options.maxModels ?? 10);

  const endDay = startOfLocalDay(now);
  const startDay = new Date(endDay.getTime() - (days - 1) * DAY_MS);
  const dayKeys: string[] = [];
  for (let i = 0; i < days; i += 1) {
    dayKeys.push(dayKey(new Date(startDay.getTime() + i * DAY_MS)));
  }

  const daySet = new Set(dayKeys);
  // 三条轨道同 buildModelAnalysisFromDailyUsage（见 SpendTracks）
  const trendZero = (): SpendTracks => ({ spend: 0, spendCny: 0, unconvertedUsdSpend: 0 });
  const spendTrendMap = new Map<string, SpendTracks>(dayKeys.map((key) => [key, trendZero()]));
  const modelMap = new Map<string, MutableModelStats>();

  for (const log of logs) {
    if (!log?.createdAt) continue;
    const createdAt = parseStoredUtcDateTime(log.createdAt);
    if (!createdAt) continue;

    const createdAtDay = dayKey(createdAt);
    if (!daySet.has(createdAtDay)) continue;

    const model = resolveModelName(log);
    const tokens = toPositiveInt(log.totalTokens);
    const spend = Math.max(0, resolveModelAnalysisSpend(log, tokens, log.sitePlatform));
    const latency = toPositiveInt(log.latencyMs);
    const isSuccess = (log.status || '').toLowerCase() === 'success';

    /**
     * 这个入口按代理日志逐条统计，**没有站点汇率维度**（log 上只有 sitePlatform），
     * 所以只能填 USD 轨道：CNY 记 0、美元额全部算作"未换算"。
     *
     * 为什么不假装换算：拿不到逐站汇率却乘一个统一系数，会得到一个看起来精确
     * 但没有依据的人民币数 —— 这比承认"未换算"危险得多。
     * 前端读到 unconvertedUsdSpend > 0 会显式提示，不会静默显示 ¥0。
     */
    const stat = modelMap.get(model) ?? {
      model,
      calls: 0,
      success: 0,
      latencyTotal: 0,
      tokens: 0,
      spend: 0,
      spendCny: 0,
      unconvertedUsdSpend: 0,
    };

    stat.calls += 1;
    stat.success += isSuccess ? 1 : 0;
    stat.latencyTotal += latency;
    stat.tokens += tokens;
    stat.spend += spend;
    // 无汇率维度：全部计入"未换算"，CNY 轨道保持 0
    stat.unconvertedUsdSpend += spend;
    modelMap.set(model, stat);

    const trend = spendTrendMap.get(createdAtDay) ?? trendZero();
    trend.spend += spend;
    trend.unconvertedUsdSpend += spend;
    spendTrendMap.set(createdAtDay, trend);
  }

  return finalizeModelAnalysis(Array.from(modelMap.values()), dayKeys, spendTrendMap, maxModels);
}

export function buildModelAnalysisFromDailyUsage(
  rows: ModelAnalysisDailyUsageRow[],
  options: BuildOptions = {},
): ModelAnalysisResult {
  const now = options.now ?? new Date();
  const days = Math.max(1, options.days ?? 7);
  const maxModels = Math.max(1, options.maxModels ?? 10);

  const endDay = startOfLocalDay(now);
  const startDay = new Date(endDay.getTime() - (days - 1) * DAY_MS);
  const dayKeys: string[] = [];
  for (let i = 0; i < days; i += 1) {
    dayKeys.push(dayKey(new Date(startDay.getTime() + i * DAY_MS)));
  }

  const daySet = new Set(dayKeys);
  // 趋势也要双轨：每个日期分别累计 USD / CNY / 未换算额（见 SpendTracks）
  const zeroTrack = (): SpendTracks => ({ spend: 0, spendCny: 0, unconvertedUsdSpend: 0 });
  const spendTrendMap = new Map<string, SpendTracks>(dayKeys.map((key) => [key, zeroTrack()]));
  const modelMap = new Map<string, MutableModelStats>();

  for (const row of rows) {
    const aggregateDay = String(row.localDay || '').trim();
    if (!daySet.has(aggregateDay)) continue;

    const model = String(row.model || '').trim() || 'unknown';
    const calls = toPositiveInt(row.totalCalls);
    const successCount = toPositiveInt(row.successCalls);
    const tokens = toPositiveInt(row.totalTokens);
    /**
     * F3：人民币按**行**（即按该行的站点）换算后再累加，USD 原值同时保留。
     *
     * 不在聚合完统一乘汇率的原因：同一模型同一天可能来自多个站点（实测
     * deepseek-flash 走 2 个站），而汇率逐站维护。统一乘等于假设所有站一致 ——
     * 目前各站恰好都填 1 所以看不出来，一旦某站填了真实汇率就会静默算错整张图。
     *
     * 汇率未知的行只进 USD 轨道并计入 unconvertedUsdSpend，绝不乘 1 或借别站的数；
     * 这样界面能如实说明"还有一部分没换算"，而不是让 CNY 数字悄悄偏小。
     */
    const usdSpend = Math.max(0, toSafeNumber(row.totalSpend));
    const rate = options.cnyRateBySiteId?.get(Number(row.siteId));
    const hasRate = typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
    const cnySpend = hasRate ? usdSpend * (rate as number) : 0;
    const unconverted = hasRate ? 0 : usdSpend;
    const latencyTotal = toPositiveInt(row.totalLatencyMs);

    const stat = modelMap.get(model) ?? {
      model,
      calls: 0,
      success: 0,
      latencyTotal: 0,
      tokens: 0,
      spend: 0,
      spendCny: 0,
      unconvertedUsdSpend: 0,
    };

    stat.calls += calls;
    stat.success += successCount;
    stat.latencyTotal += latencyTotal;
    stat.tokens += tokens;
    stat.spend += usdSpend;
    stat.spendCny += cnySpend;
    stat.unconvertedUsdSpend += unconverted;
    modelMap.set(model, stat);

    const trend = spendTrendMap.get(aggregateDay) ?? zeroTrack();
    trend.spend += usdSpend;
    trend.spendCny += cnySpend;
    trend.unconvertedUsdSpend += unconverted;
    spendTrendMap.set(aggregateDay, trend);
  }

  return finalizeModelAnalysis(Array.from(modelMap.values()), dayKeys, spendTrendMap, maxModels);
}
