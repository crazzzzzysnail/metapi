import { describe, expect, it } from 'vitest';
import {
  PERF_TPS_DUBIOUS_THRESHOLD,
  aggregatePerfTtft,
  classifyDetailPayload,
  classifySummaryPayload,
  isPerfSuccessRateNumeric,
  isPerfValuePresent,
  perfEmptyLabel,
  perfWindowLabel,
  readPerfGroupEntry,
  readPerfSummaryModelEntry,
} from './perfMetricsValue.js';

/**
 * perf-metrics 权威解析层单测（S0-3）。
 *
 * 每条规则各配正例 + 负例，并特意安排"负控制真变红"的断言（教训 L5）：
 * - TPS 存疑阈值：`tps=600→dubious` 一旦被改成 `>=1e9` 立刻红；
 * - 两族判据不共用：`isPerfValuePresent(-1000)/（0）` 双向为假，
 *   若有人图省事把成功率判据（>=0）套到测量族，`isPerfValuePresent(0)` 会变真而红。
 */

describe('isPerfValuePresent（测量族：TPS/首字/平均延迟，判据 >0）', () => {
  it('正数算有值', () => {
    expect(isPerfValuePresent(77.17)).toBe(true);
    expect(isPerfValuePresent(1)).toBe(true);
  });

  it('0 是上游"无此值"哨兵，判无', () => {
    expect(isPerfValuePresent(0)).toBe(false);
  });

  it('负数一律判无', () => {
    expect(isPerfValuePresent(-1)).toBe(false);
    expect(isPerfValuePresent(-0.5)).toBe(false);
  });

  it('非有限数与非数字判无', () => {
    expect(isPerfValuePresent(NaN)).toBe(false);
    expect(isPerfValuePresent(Infinity)).toBe(false);
    expect(isPerfValuePresent('77')).toBe(false);
    expect(isPerfValuePresent(null)).toBe(false);
    expect(isPerfValuePresent(undefined)).toBe(false);
  });

  // 两族判据不互认（S0-3 钉死）。frt=-1000 属上游 /api/log/self 的 other.frt，
  // 本库 perf-metrics 链路根本不产生该字段，故这里不去 import 一个不存在的"日志族函数"对照，
  // 而是钉死两族对 **0** 的相反结论——这才是真正的区分器：
  //   测量族 (0)=假、成功率族 (0)=真。若有人把两族合并成一个判据，必有一边翻红。
  // （-1000 只作"非正数皆无值"的补充：它对 >0 与 >=0 都判假，抓不住合并回归，不作为区分器。）
  it('两族判据对 0 结论相反（合并回归的区分器）', () => {
    expect(isPerfValuePresent(0)).toBe(false);
    expect(isPerfSuccessRateNumeric(0)).toBe(true);
  });

  it('测量族对所有非正数判无（含上游 frt 哨兵 -1000 形态）', () => {
    expect(isPerfValuePresent(-1000)).toBe(false);
    expect(isPerfValuePresent(-1)).toBe(false);
  });
});

describe('isPerfSuccessRateNumeric（成功率族：判据 >=0）', () => {
  it('真 0% 是合法读数', () => {
    expect(isPerfSuccessRateNumeric(0)).toBe(true);
  });

  it('正常百分比有效', () => {
    expect(isPerfSuccessRateNumeric(99.1)).toBe(true);
    expect(isPerfSuccessRateNumeric(100)).toBe(true);
  });

  it('负数 / 非有限 / 非数字无效', () => {
    expect(isPerfSuccessRateNumeric(-0.01)).toBe(false);
    expect(isPerfSuccessRateNumeric(NaN)).toBe(false);
    expect(isPerfSuccessRateNumeric('100')).toBe(false);
  });
});

describe('readPerfSummaryModelEntry（summary 端点 models[] 逐条，模型级无 ttft）', () => {
  it('正常值全部落 present', () => {
    const r = readPerfSummaryModelEntry({
      model_name: 'sample-model-len',
      avg_latency_ms: 4426,
      avg_tps: 77.17,
      success_rate: 100,
    });
    expect(r.tps.present).toBe(true);
    expect(r.tps.value).toBe(77.17);
    expect(r.tps.dubious).toBe(false);
    expect(r.latency.value).toBe(4426);
    expect(r.successRate.present).toBe(true);
    expect(r.successRate.value).toBe(100);
  });

  it('TPS=600 判存疑（负控制：阈值改 1e9 则此断言红）', () => {
    const r = readPerfSummaryModelEntry({ avg_tps: 600, avg_latency_ms: 500, success_rate: 99 });
    expect(r.tps.dubious).toBe(true);
    expect(r.tps.present).toBe(true);
    expect(r.tps.value).toBe(600);
  });

  it('阈值边界：恰好 500 存疑，499 不存疑', () => {
    expect(PERF_TPS_DUBIOUS_THRESHOLD).toBe(500);
    expect(readPerfSummaryModelEntry({ avg_tps: 500 }).tps.dubious).toBe(true);
    expect(readPerfSummaryModelEntry({ avg_tps: 499 }).tps.dubious).toBe(false);
  });

  it('平均延迟即使 >500 也绝不套 TPS 存疑（判据不共用）', () => {
    // 实测正常延迟 7087ms 远超 500，若误用存疑判据到延迟，这里会变 dubious 而红。
    const r = readPerfSummaryModelEntry({ avg_latency_ms: 7087 });
    expect(r.latency.dubious).toBe(false);
    expect(r.latency.present).toBe(true);
  });

  it('success_rate=0 且条目存在 = 真 0%（不当无值）', () => {
    const r = readPerfSummaryModelEntry({ avg_latency_ms: 3761, success_rate: 0 });
    expect(r.successRate.present).toBe(true);
    expect(r.successRate.value).toBe(0);
    expect(r.successRate.emptyReason).toBeNull();
  });

  it('tps=0 归 fieldAbsent（哨兵，非 0 吞吐）', () => {
    const r = readPerfSummaryModelEntry({ avg_tps: 0 });
    expect(r.tps.present).toBe(false);
    expect(r.tps.emptyReason).toBe('fieldAbsent');
  });

  it('整键缺失全空', () => {
    const r = readPerfSummaryModelEntry({});
    expect(r.tps.present).toBe(false);
    expect(r.latency.present).toBe(false);
    expect(r.successRate.present).toBe(false);
  });
});

describe('readPerfGroupEntry（详情端点 groups[] 逐条，分组级含 ttft）', () => {
  it('分组名 + 四项齐全', () => {
    const r = readPerfGroupEntry({
      group: '组乙',
      avg_ttft_ms: 1297,
      avg_latency_ms: 7087,
      avg_tps: 99.71,
      success_rate: 94.44,
    });
    expect(r.groupName).toBe('组乙');
    expect(r.ttft.value).toBe(1297);
    expect(r.latency.value).toBe(7087);
    expect(r.successRate.value).toBe(94.44);
  });

  it('ttft=0（coarena 形哨兵）判空、归 fieldAbsent', () => {
    const r = readPerfGroupEntry({ group: 'default', avg_ttft_ms: 0, success_rate: 100 });
    expect(r.ttft.present).toBe(false);
    expect(r.ttft.emptyReason).toBe('fieldAbsent');
  });

  it('group 名缺失/空白 → null', () => {
    expect(readPerfGroupEntry({ group: '  ' }).groupName).toBeNull();
    expect(readPerfGroupEntry({}).groupName).toBeNull();
  });
});

describe('aggregatePerfTtft（站级首字自聚合 series[]，数据篇：顶层无 ttft）', () => {
  it('对正 ttft 点取均值（忽略 0 哨兵点）', () => {
    const r = aggregatePerfTtft([
      { avg_ttft_ms: 0 },
      { avg_ttft_ms: 100 },
      { avg_ttft_ms: 300 },
    ], 'value');
    expect(r.present).toBe(true);
    expect(r.value).toBe(200);
  });

  it('整窗全 0（coarena 20/20）→ 空态 fieldAbsent，绝不报 0ms', () => {
    const r = aggregatePerfTtft(
      Array.from({ length: 20 }, () => ({ avg_ttft_ms: 0 })),
      'value',
    );
    expect(r.present).toBe(false);
    expect(r.value).toBeNull();
    expect(r.emptyReason).toBe('fieldAbsent');
  });

  it('series 非空但容器=noWindowTraffic → 归 noWindowTraffic', () => {
    expect(aggregatePerfTtft([], 'noWindowTraffic').emptyReason).toBe('noWindowTraffic');
  });

  it('容器=notPublished → 归 notPublished', () => {
    expect(aggregatePerfTtft(null, 'notPublished').emptyReason).toBe('notPublished');
  });
});

describe('classifySummaryPayload（无数据三态）', () => {
  it('data 缺失 / 非对象 → notPublished', () => {
    expect(classifySummaryPayload({}).state).toBe('notPublished');
    expect(classifySummaryPayload(null).state).toBe('notPublished');
    expect(classifySummaryPayload({ data: null }).state).toBe('notPublished');
  });

  it('models:[] → noWindowTraffic', () => {
    const r = classifySummaryPayload({ data: { window_start: 1, window_end: 2, models: [] } });
    expect(r.state).toBe('noWindowTraffic');
  });

  it('models 键整个不存在 → noWindowTraffic（可选链，数据篇第四节）', () => {
    expect(classifySummaryPayload({ data: {} }).state).toBe('noWindowTraffic');
  });

  it('models 非空 → value', () => {
    const r = classifySummaryPayload({ data: { models: [{ model_name: 'm' }] } });
    expect(r.state).toBe('value');
    expect(r.models).toHaveLength(1);
  });
});

describe('classifyDetailPayload（详情端点更碎，siteC 形只有三键）', () => {
  it('data 非对象 → notPublished', () => {
    expect(classifyDetailPayload({}).state).toBe('notPublished');
    expect(classifyDetailPayload({ data: null }).state).toBe('notPublished');
  });

  it('siteC 形：无 summary/series 键、仅 groups 非空 → value', () => {
    const r = classifyDetailPayload({
      data: { model_name: 'm', series_schema: 'dbcd0a3c', groups: [{ group: '组甲', success_rate: 100 }] },
    });
    expect(r.state).toBe('value');
    expect(r.groups).toHaveLength(1);
    expect(r.series).toHaveLength(0);
  });

  it('groups:[] 且 series:[] → noWindowTraffic', () => {
    const r = classifyDetailPayload({ data: { model_name: 'm', series: [], groups: [] } });
    expect(r.state).toBe('noWindowTraffic');
  });

  it('series 非空、groups 缺失 → value', () => {
    expect(classifyDetailPayload({ data: { series: [{ avg_ttft_ms: 0 }] } }).state).toBe('value');
  });
});

describe('文案集中产出（L3：页面不得自判 ==0）', () => {
  // 用户 2026-11-20 点 1：空态短词化，"上游公示"前缀只写进 tooltip，不进空态。
  it('noWindowTraffic → 无调用', () => {
    expect(perfEmptyLabel('noWindowTraffic')).toBe('无调用');
  });

  it('notPublished / fieldAbsent → 未公示', () => {
    expect(perfEmptyLabel('notPublished')).toBe('未公示');
    expect(perfEmptyLabel('fieldAbsent')).toBe('未公示');
    expect(perfEmptyLabel(null)).toBe('未公示');
  });

  it('窗口标注', () => {
    expect(perfWindowLabel(24)).toBe('24h');
    expect(perfWindowLabel(1)).toBe('1h');
  });
});
