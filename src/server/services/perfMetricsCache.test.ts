import { describe, expect, it } from 'vitest';
import {
  PERF_DATA_TTL_MS,
  PERF_FAILURE_BACKOFF_MS,
  PERF_HOURS,
  PERF_STALE_MAX_AGE_MS,
  classifyPerfCacheAge,
  computePerfHotSet,
  perfDetailCacheKey,
  perfSummaryCacheKey,
  pickPerfGroupEntry,
  pickPerfModelEntry,
  shouldWarmTask,
} from './perfMetricsCache.js';

/**
 * 预热缓存纯逻辑单测（S2.5-7）。
 * 重点验 L7（集合类改动必须验输出不变式）：热集是"去重 + 交叉积"，
 * 必须钉住「同一(site,model)多通道只产一份 detail」「能力站才产 summary」「空白模型丢弃」。
 */

const HOUR = 60 * 60_000;

describe('computePerfHotSet（热集计算，L7 集合运算）', () => {
  it('每能力站产 summary 双窗、每去重(site,model)产 detail 双窗', () => {
    const tasks = computePerfHotSet([1, 2], [
      { siteId: 1, model: 'gpt-4o' },
      { siteId: 1, model: 'gpt-4o' }, // 重复通道
      { siteId: 1, model: 'claude-x' },
      { siteId: 2, model: 'gpt-4o' },
    ]);
    // summary: 2 站 × 2 窗 = 4；detail: 去重后 (1,gpt-4o)(1,claude-x)(2,gpt-4o)=3 组 × 2 窗 = 6。
    expect(tasks.filter((t) => t.kind === 'summary')).toHaveLength(4);
    expect(tasks.filter((t) => t.kind === 'detail')).toHaveLength(6);
  });

  it('同一 (site,model) 多通道只产一份 detail（去重不变式）', () => {
    const tasks = computePerfHotSet([], [
      { siteId: 1, model: 'gpt-4o' },
      { siteId: 1, model: 'GPT-4O' }, // 大小写不同 = 同一模型（归一后去重）
      { siteId: 1, model: 'gpt-4o ' }, // 尾空格 = 同一
    ]);
    const detail = tasks.filter((t) => t.kind === 'detail');
    expect(detail).toHaveLength(PERF_HOURS.length); // 只 24h/1h 两条，不重复
  });

  it('空白模型丢弃，但仍产 summary；空输入产出空集', () => {
    const tasks = computePerfHotSet([1], [{ siteId: 1, model: '   ' }, { siteId: 1, model: '' }]);
    expect(tasks.every((t) => t.kind === 'summary')).toBe(true);
    expect(tasks).toHaveLength(PERF_HOURS.length);
    expect(computePerfHotSet([], [])).toEqual([]);
  });

  it('summary 任务 model 恒为 null，detail 带归一前原样 model', () => {
    const tasks = computePerfHotSet([1], [{ siteId: 1, model: 'DeepSeek-V4' }]);
    const summary = tasks.find((t) => t.kind === 'summary');
    const detail = tasks.find((t) => t.kind === 'detail');
    expect(summary?.model).toBeNull();
    expect(detail?.model).toBe('DeepSeek-V4');
  });
});

describe('缓存键归一（大小写不敏感对齐 perf，禁模糊）', () => {
  it('detail 键大小写/空白无关', () => {
    expect(perfDetailCacheKey(1, 'GPT-4o', 24)).toBe(perfDetailCacheKey(1, ' gpt-4O ', 24));
  });
  it('summary 键带 hours', () => {
    expect(perfSummaryCacheKey(1, 24)).not.toBe(perfSummaryCacheKey(1, 1));
  });
});

describe('shouldWarmTask（新鲜期 + 失败退避）', () => {
  const now = 1_000_000_000_000;
  it('无缓存 → 需要拉', () => {
    expect(shouldWarmTask({ kind: 'summary', siteId: 1, model: null, hours: 24 }, {}, now)).toBe(true);
  });
  it('新鲜期内 → 不拉', () => {
    expect(shouldWarmTask({ kind: 'summary', siteId: 1, model: null, hours: 24 }, { capturedAt: now - 1000 }, now)).toBe(false);
  });
  it('过新鲜期且无失败 → 拉', () => {
    expect(shouldWarmTask({ kind: 'summary', siteId: 1, model: null, hours: 24 }, { capturedAt: now - PERF_DATA_TTL_MS - 1 }, now)).toBe(true);
  });
  it('过新鲜期但在失败退避(60s)内 → 不拉', () => {
    expect(shouldWarmTask(
      { kind: 'summary', siteId: 1, model: null, hours: 24 },
      { capturedAt: now - PERF_DATA_TTL_MS - 1, lastFailureAt: now - PERF_FAILURE_BACKOFF_MS / 2 },
      now,
    )).toBe(false);
  });
  it('过新鲜期且退避已过 → 拉', () => {
    expect(shouldWarmTask(
      { kind: 'summary', siteId: 1, model: null, hours: 24 },
      { capturedAt: now - PERF_DATA_TTL_MS - 1, lastFailureAt: now - PERF_FAILURE_BACKOFF_MS - 1 },
      now,
    )).toBe(true);
  });
});

describe('classifyPerfCacheAge（stale 24h 窗口）', () => {
  const now = 100 * HOUR;
  it('缺失 capturedAt → expired', () => {
    expect(classifyPerfCacheAge(undefined, now)).toBe('expired');
  });
  it('新鲜期内 → fresh', () => {
    expect(classifyPerfCacheAge(now - 60_000, now)).toBe('fresh'); // 1min < 5min TTL
  });
  it('超新鲜但 ≤24h → stale（供旧值 + 标截至）', () => {
    expect(classifyPerfCacheAge(now - 3 * HOUR, now)).toBe('stale');
    expect(classifyPerfCacheAge(now - PERF_STALE_MAX_AGE_MS, now)).toBe('stale');
  });
  it('> 24h → expired（转未公示，不无限供旧值）', () => {
    expect(classifyPerfCacheAge(now - PERF_STALE_MAX_AGE_MS - 1, now)).toBe('expired');
  });
});

describe('pickPerfModelEntry / pickPerfGroupEntry（结构性选取，不做数值判定）', () => {
  it('按 model_name 精确(大小写无关)命中，原样返回条目', () => {
    const models = [
      { model_name: 'GPT-4o', avg_tps: 3_000_000, success_rate: 0 },
      { model_name: 'other', avg_tps: 1 },
    ];
    const hit = pickPerfModelEntry(models, 'gpt-4o') as { avg_tps: number };
    // 数值原样透传（3 百万不在这儿判存疑——那属 web perfMetricsValue）。
    expect(hit?.avg_tps).toBe(3_000_000);
  });
  it('挑不到 → null（不回退）', () => {
    expect(pickPerfModelEntry([], 'x')).toBeNull();
    expect(pickPerfModelEntry([{ model_name: 'a' }], 'b')).toBeNull();
  });
  it('分组按 group 名大小写无关命中', () => {
    const data = { groups: [{ group: '组甲', success_rate: 99 }, { group: 'default', success_rate: 50 }] };
    expect((pickPerfGroupEntry(data, '组甲') as { success_rate: number }).success_rate).toBe(99);
  });
  it('groups 缺失/非数组 → null；空组名 → null', () => {
    expect(pickPerfGroupEntry({ }, 'x')).toBeNull();
    expect(pickPerfGroupEntry({ groups: 'notarray' }, 'x')).toBeNull();
    expect(pickPerfGroupEntry({ groups: [{ group: 'a' }] }, '  ')).toBeNull();
  });
});
