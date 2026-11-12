import { describe, expect, it } from 'vitest';
import { buildModelAnalysis, buildModelAnalysisFromDailyUsage } from './modelAnalysisService.js';
import { formatLocalDate } from './localTimeService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('buildModelAnalysis', () => {
  it('aggregates spend/calls data in a rolling day window', () => {
    const logs = [
      {
        createdAt: '2026-02-24T02:00:00.000Z',
        modelActual: 'gpt-4o',
        modelRequested: null,
        status: 'success',
        latencyMs: 800,
        totalTokens: 1000,
        estimatedCost: 1.25,
      },
      {
        createdAt: '2026-02-24T06:00:00.000Z',
        modelActual: null,
        modelRequested: 'gpt-4o',
        status: 'failed',
        latencyMs: 1200,
        totalTokens: 300,
        estimatedCost: 0.25,
      },
      {
        createdAt: '2026-02-23T08:00:00.000Z',
        modelActual: 'claude-3-5-sonnet',
        modelRequested: null,
        status: 'success',
        latencyMs: 500,
        totalTokens: 2000,
        estimatedCost: 2,
      },
      {
        createdAt: '2026-02-19T10:00:00.000Z',
        modelActual: 'gpt-4.1-mini',
        modelRequested: null,
        status: 'success',
        latencyMs: 200,
        totalTokens: 120,
        estimatedCost: 0.08,
      },
    ];

    const now = new Date('2026-02-24T12:00:00.000Z');
    const result = buildModelAnalysis(logs, {
      now,
      days: 3,
    });

    const endDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const startDay = new Date(endDay.getTime() - 2 * DAY_MS);
    const dayKeys = Array.from({ length: 3 }, (_, index) =>
      formatLocalDate(new Date(startDay.getTime() + index * DAY_MS)),
    );
    const daySet = new Set(dayKeys);
    const spendByDay = new Map<string, number>(dayKeys.map((key) => [key, 0]));
    for (const log of logs) {
      const createdAt = new Date(log.createdAt);
      const dayKey = formatLocalDate(createdAt);
      if (!daySet.has(dayKey)) continue;
      spendByDay.set(dayKey, (spendByDay.get(dayKey) ?? 0) + (log.estimatedCost ?? 0));
    }

    expect(result.window).toEqual({
      start: dayKeys[0],
      end: dayKeys[dayKeys.length - 1],
      days: 3,
    });
    expect(result.totals.calls).toBe(3);
    expect(result.totals.tokens).toBe(3300);
    expect(result.totals.spend).toBe(3.5);
    // F3 双轨后 spendTrend 每条多出 spendCny / unconvertedUsdSpend；
    // 这个入口没有站点汇率维度，所以美元额全部计入"未换算"。
    expect(result.spendTrend).toEqual(dayKeys.map((day) => ({
      day,
      spend: spendByDay.get(day) ?? 0,
      spendCny: 0,
      unconvertedUsdSpend: spendByDay.get(day) ?? 0,
    })));
    expect(result.callRanking[0]).toMatchObject({
      model: 'gpt-4o',
      calls: 2,
      successRate: 50,
    });
  });

  it('normalizes unknown model names and invalid numbers', () => {
    const logs = [
      {
        createdAt: '2026-02-24T12:00:00.000Z',
        modelActual: null,
        modelRequested: null,
        status: 'success',
        latencyMs: null,
        totalTokens: null,
        estimatedCost: null,
      },
      {
        createdAt: 'invalid-date',
        modelActual: 'gpt-4o',
        modelRequested: null,
        status: 'success',
        latencyMs: 10,
        totalTokens: 10,
        estimatedCost: 1,
      },
    ];

    const result = buildModelAnalysis(logs, {
      now: new Date('2026-02-24T12:00:00.000Z'),
      days: 1,
    });

    // F3 双轨后 totals 增加 spendCny / unconvertedUsdSpend；此入口无站点汇率维度，
    // 故 CNY 为 0、美元额全部记作"未换算"（不假装换算）。
    expect(result.totals).toEqual({
      calls: 1,
      tokens: 0,
      spend: 0,
      spendCny: 0,
      unconvertedUsdSpend: 0,
    });
    expect(result.callsDistribution[0]).toMatchObject({
      model: 'unknown',
      calls: 1,
      share: 100,
    });
  });

  it('falls back to token-based spend estimation when estimatedCost is missing', () => {
    const logs = [
      {
        createdAt: '2026-02-24T12:30:00.000Z',
        modelActual: 'gpt-4o-mini',
        modelRequested: null,
        status: 'success',
        latencyMs: 120,
        totalTokens: 1000,
        estimatedCost: null,
      },
    ];

    const result = buildModelAnalysis(logs, {
      now: new Date('2026-02-24T12:00:00.000Z'),
      days: 1,
    });

    expect(result.totals.spend).toBe(0.002);
    expect(result.spendDistribution[0]).toMatchObject({
      model: 'gpt-4o-mini',
      spend: 0.002,
      calls: 1,
    });
  });

  it('accepts Date-backed createdAt values from external database drivers', () => {
    const logs = [
      {
        createdAt: new Date('2026-02-24T12:30:00.000Z') as unknown as string,
        modelActual: 'gpt-4o',
        modelRequested: null,
        status: 'success',
        latencyMs: 250,
        totalTokens: 800,
        estimatedCost: 1.6,
      },
    ];

    const result = buildModelAnalysis(logs, {
      now: new Date('2026-02-24T12:00:00.000Z'),
      days: 1,
    });

    // 同上：无汇率维度时 CNY 为 0，美元额进"未换算"轨道
    expect(result.totals).toEqual({
      calls: 1,
      tokens: 800,
      spend: 1.6,
      spendCny: 0,
      unconvertedUsdSpend: 1.6,
    });
    expect(result.callRanking[0]).toMatchObject({
      model: 'gpt-4o',
      calls: 1,
      successRate: 100,
      avgLatencyMs: 250,
    });
  });

  /**
   * F3：人民币必须**逐行（逐站）换算后再累加**。
   *
   * 这条用例盯的是我一开始写错的方向：聚合完再统一乘一个汇率。
   * model_day_usage 的唯一键含 siteId，同一模型同一天可以来自多个站点，
   * 而汇率逐站维护 —— 下面这个 fixture 就是那种情况（两个站、7.3 与 1）。
   * 正确结果 83；"聚合后乘 7.3"会得到 146，两者差近一倍，很好分辨。
   */
  describe('buildModelAnalysisFromDailyUsage 双轨金额', () => {
    // 窗口必须覆盖这行数据的日期，否则会被 daySet 过滤掉（第一次写时漏了 now）
    const now = new Date(2026, 1, 25, 12, 0, 0);
    const day = formatLocalDate(now);
    const rowOf = (siteId: number, spend: number) => ({
      localDay: day,
      model: 'm-cross-site',
      siteId,
      totalCalls: 1,
      successCalls: 1,
      totalTokens: 10,
      totalSpend: spend,
      totalLatencyMs: 100,
    });

    it('按各站汇率分别换算后累加，而不是聚合后乘一次', () => {
      const result = buildModelAnalysisFromDailyUsage(
        [rowOf(1, 10), rowOf(2, 10)],
        { now, days: 30, cnyRateBySiteId: new Map([[1, 7.3], [2, 1]]) },
      );
      expect(result.totals.spend).toBe(20);          // USD 轨道不受汇率影响
      expect(result.totals.spendCny).toBeCloseTo(83, 6); // 10×7.3 + 10×1，不是 20×7.3=146
      expect(result.totals.unconvertedUsdSpend).toBe(0);
    });

    it('汇率未知时不换算、不乘 1，而是计入未换算额', () => {
      // 只给了无关站 9 的汇率 → 站 1、2 都算未知
      const result = buildModelAnalysisFromDailyUsage(
        [rowOf(1, 10), rowOf(2, 10)],
        { now, days: 30, cnyRateBySiteId: new Map([[9, 7.3]]) },
      );
      expect(result.totals.spendCny).toBe(0);
      expect(result.totals.unconvertedUsdSpend).toBe(20);
    });

    it('非法汇率（0 / 负数）同样视为未知', () => {
      const result = buildModelAnalysisFromDailyUsage([rowOf(1, 10)], {
        now,
        days: 30,
        cnyRateBySiteId: new Map([[1, 0]]),
      });
      expect(result.totals.spendCny).toBe(0);
      expect(result.totals.unconvertedUsdSpend).toBe(10);
    });

    it('spendCny + unconvertedUsdSpend 恒等于 USD 原值', () => {
      const mixed = buildModelAnalysisFromDailyUsage(
        [rowOf(1, 10), rowOf(2, 10), rowOf(3, 5)],
        { now, days: 30, cnyRateBySiteId: new Map([[1, 7.3], [2, 1]]) }, // 站 3 无汇率
      );
      // USD 总额 = 已换算站的美元额 + 未换算美元额（两条轨道同源，可直接对账）
      expect(mixed.totals.spend).toBe(25);
      expect(mixed.spendDistribution[0]?.spend).toBe(25);
      expect(mixed.totals.unconvertedUsdSpend).toBe(5);
      expect(mixed.spendTrend[mixed.spendTrend.length - 1]).toMatchObject({ unconvertedUsdSpend: 5 });
    });

    it('未传汇率表时保持纯 USD 语义（兼容既有调用方）', () => {
      const result = buildModelAnalysisFromDailyUsage([rowOf(1, 10)], { now, days: 30 });
      expect(result.totals.spend).toBe(10);
      expect(result.totals.spendCny).toBe(0);
      expect(result.totals.unconvertedUsdSpend).toBe(10);
    });

    it('排序按 USD 值，切换币种不会重排排行榜', () => {
      // A 模型走高汇率站、B 模型走低汇率站：若按 CNY 排序名次会互换
      const rows = [
        { localDay: day, model: 'A', siteId: 1, totalCalls: 5, successCalls: 5, totalTokens: 10, totalSpend: 2, totalLatencyMs: 10 },
        { localDay: day, model: 'B', siteId: 2, totalCalls: 5, successCalls: 5, totalTokens: 10, totalSpend: 2, totalLatencyMs: 10 },
      ] as any;
      const result = buildModelAnalysisFromDailyUsage(rows, {
        now,
        days: 30,
        cnyRateBySiteId: new Map([[1, 1], [2, 9]]),
      });
      // USD 相同则按稳定顺序；关键是不得用 spendCny 参与排序判定
      expect(result.spendDistribution.map((item) => item.spend)).toEqual([2, 2]);
    });
  });
});
