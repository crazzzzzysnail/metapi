import { describe, expect, it } from 'vitest';
import {
  CHECKIN_DELAY_DEFAULTS,
  CHECKIN_DELAY_NARROW_HINT_MS,
  assignDelayBands,
  buildDailyAccountOrder,
  delayHashUnit,
  estimateDelayBands,
  intervalAccountOffsetMs,
  normalizeCheckinDelayConfig,
  resolveDelayWindow,
  toDelayMs,
} from './checkinDelayPolicy.js';

/**
 * 本文件的断言全部使用注入的字面量时间戳，不读机器时区、不使用无参 new Date()，
 * 因此在 Linux VPS 与开发机上结果一致。单位一律 epoch 毫秒。
 */

// 2026-11-03 的若干本地时刻对应的毫秒锚点（仅作为字面量参与运算，不做时区换算）。
const ANCHOR = 1_762_137_600_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

describe('toDelayMs', () => {
  it('分钟与小时换算正确', () => {
    expect(toDelayMs(5, 'minute')).toBe(5 * MINUTE_MS);
    expect(toDelayMs(2, 'hour')).toBe(2 * HOUR_MS);
    expect(toDelayMs(0, 'minute')).toBe(0);
  });

  it('非有限数值返回 NaN', () => {
    expect(Number.isNaN(toDelayMs(Number.NaN, 'minute'))).toBe(true);
    expect(Number.isNaN(toDelayMs(Number.POSITIVE_INFINITY, 'hour'))).toBe(true);
  });
});

describe('normalizeCheckinDelayConfig', () => {
  it('正常值按所选单位归一化', () => {
    expect(normalizeCheckinDelayConfig({ enabled: true, min: 10, max: 90, unit: 'minute' })).toEqual({
      enabled: true,
      minMs: 10 * MINUTE_MS,
      maxMs: 90 * MINUTE_MS,
    });
    expect(normalizeCheckinDelayConfig({ enabled: true, min: 1, max: 6, unit: 'hour' })).toEqual({
      enabled: true,
      minMs: HOUR_MS,
      maxMs: 6 * HOUR_MS,
    });
  });

  it('min 大于 max 整体回落默认', () => {
    const fallback = normalizeCheckinDelayConfig({ enabled: true, min: 100, max: 10, unit: 'minute' });
    expect(fallback.enabled).toBe(false);
    expect(fallback.minMs).toBe(CHECKIN_DELAY_DEFAULTS.min * MINUTE_MS);
    expect(fallback.maxMs).toBe(CHECKIN_DELAY_DEFAULTS.max * MINUTE_MS);
  });

  it('负数与非有限数值回落默认', () => {
    expect(normalizeCheckinDelayConfig({ min: -1, max: 10, unit: 'minute' }).maxMs)
      .toBe(CHECKIN_DELAY_DEFAULTS.max * MINUTE_MS);
    expect(normalizeCheckinDelayConfig({ min: Number.NaN, max: 10, unit: 'minute' }).enabled).toBe(false);
    expect(normalizeCheckinDelayConfig({ min: 0, max: '30', unit: 'minute' }).maxMs)
      .toBe(CHECKIN_DELAY_DEFAULTS.max * MINUTE_MS);
  });

  // 关键回归防护：未知单位必须**整体回落**，不能被悄悄当成默认单位采纳。
  // 曾出现的缺陷是 {min:5,max:60,unit:'second'} 被解析成 5–60 分钟（静默错值）。
  it('未知单位整体回落，而不是替换成默认单位后采纳', () => {
    const result = normalizeCheckinDelayConfig({ enabled: true, min: 5, max: 60, unit: 'second' });
    expect(result).toEqual({
      enabled: false,
      minMs: CHECKIN_DELAY_DEFAULTS.min * MINUTE_MS,
      maxMs: CHECKIN_DELAY_DEFAULTS.max * MINUTE_MS,
    });
    expect(result.maxMs).not.toBe(60 * MINUTE_MS);
  });

  it('单位缺省时仍按默认单位正常解析数值', () => {
    expect(normalizeCheckinDelayConfig({ enabled: true, min: 5, max: 20 })).toEqual({
      enabled: true,
      minMs: 5 * MINUTE_MS,
      maxMs: 20 * MINUTE_MS,
    });
  });

  it('空输入与非对象输入回落默认且关闭', () => {
    expect(normalizeCheckinDelayConfig({}).enabled).toBe(false);
    expect(normalizeCheckinDelayConfig(undefined as unknown as Parameters<typeof normalizeCheckinDelayConfig>[0]).enabled)
      .toBe(false);
  });
});

describe('resolveDelayWindow', () => {
  const config = { enabled: true, minMs: 0, maxMs: 6 * HOUR_MS };

  it('窗口未越日终时不压缩', () => {
    const dayEndMs = ANCHOR + 12 * HOUR_MS;
    expect(resolveDelayWindow({ anchorMs: ANCHOR, config, dayEndMs })).toEqual({
      ok: true,
      startMs: ANCHOR,
      endMs: ANCHOR + 6 * HOUR_MS,
      compressed: false,
    });
  });

  it('越过日终时被截断到日终并标记压缩', () => {
    const dayEndMs = ANCHOR + 2 * HOUR_MS + 59_000;
    const result = resolveDelayWindow({ anchorMs: ANCHOR, config, dayEndMs });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.endMs).toBe(dayEndMs);
    expect(result.compressed).toBe(true);
  });

  it('关闭时返回 disabled', () => {
    expect(resolveDelayWindow({
      anchorMs: ANCHOR,
      config: { ...config, enabled: false },
      dayEndMs: ANCHOR + HOUR_MS,
    })).toEqual({ ok: false, reason: 'disabled' });
  });

  it('锚点已达或超过日终时返回 no-remaining-window', () => {
    expect(resolveDelayWindow({ anchorMs: ANCHOR, config, dayEndMs: ANCHOR }))
      .toEqual({ ok: false, reason: 'no-remaining-window' });
    expect(resolveDelayWindow({ anchorMs: ANCHOR, config, dayEndMs: ANCHOR - 1 }))
      .toEqual({ ok: false, reason: 'no-remaining-window' });
  });

  it('min 使起点晚于日终时同样判无剩余窗口', () => {
    expect(resolveDelayWindow({
      anchorMs: ANCHOR,
      config: { enabled: true, minMs: 3 * HOUR_MS, maxMs: 6 * HOUR_MS },
      dayEndMs: ANCHOR + HOUR_MS,
    })).toEqual({ ok: false, reason: 'no-remaining-window' });
  });

  it('非有限的锚点或日终被判为无剩余窗口', () => {
    expect(resolveDelayWindow({ anchorMs: Number.NaN, config, dayEndMs: ANCHOR + HOUR_MS }).ok).toBe(false);
    expect(resolveDelayWindow({ anchorMs: ANCHOR, config, dayEndMs: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });
});

describe('delayHashUnit', () => {
  it('落在 [0,1) 且对同样输入完全确定', () => {
    const input = { seed: 'test-seed', planDateKey: '2026-11-03', accountId: 42, salt: 'order' };
    const first = delayHashUnit(input);
    expect(first).toBe(delayHashUnit(input));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
  });

  it('planDateKey 改变会改变取值（保证每天不同）', () => {
    const base = { seed: 'test-seed', accountId: 7, salt: 'order' };
    expect(delayHashUnit({ ...base, planDateKey: '2026-11-03' }))
      .not.toBe(delayHashUnit({ ...base, planDateKey: '2026-11-04' }));
  });

  it('salt 区分顺序与带内偏移', () => {
    const base = { seed: 'test-seed', planDateKey: '2026-11-03', accountId: 7 };
    expect(delayHashUnit({ ...base, salt: 'order' })).not.toBe(delayHashUnit({ ...base, salt: 'subband' }));
  });
});

describe('buildDailyAccountOrder', () => {
  const ids = Array.from({ length: 10 }, (_, index) => index + 1);

  it('输入顺序不影响输出', () => {
    const forward = buildDailyAccountOrder({ accountIds: ids, planDateKey: '2026-11-03', seed: 'test-seed' });
    const reversed = buildDailyAccountOrder({ accountIds: [...ids].reverse(), planDateKey: '2026-11-03', seed: 'test-seed' });
    expect(forward).toEqual(reversed);
  });

  it('重复 id 去重、非有限值被丢弃', () => {
    const result = buildDailyAccountOrder({
      accountIds: [3, 3, 1, Number.NaN, 2],
      planDateKey: '2026-11-03',
      seed: 'test-seed',
    });
    expect(result).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(result.length).toBe(3);
  });

  it('同一账号集在不同日期得到不同置换', () => {
    const dayA = buildDailyAccountOrder({ accountIds: ids, planDateKey: '2026-11-03', seed: 'test-seed' });
    const dayB = buildDailyAccountOrder({ accountIds: ids, planDateKey: '2026-11-04', seed: 'test-seed' });
    expect(dayA).not.toEqual(dayB);
    // 元素集合相同，只是顺序不同
    expect([...dayA].sort((a, b) => a - b)).toEqual([...dayB].sort((a, b) => a - b));
  });

  it('空输入返回空数组', () => {
    expect(buildDailyAccountOrder({ accountIds: [], planDateKey: '2026-11-03', seed: 'test-seed' })).toEqual([]);
  });
});

describe('assignDelayBands', () => {
  const seed = 'test-seed';
  const planDateKey = '2026-11-03';
  const windowStartMs = ANCHOR;
  const windowEndMs = ANCHOR + 6 * HOUR_MS;

  function run(accountIds: number[], nowMs: number, occupiedBands?: number[]) {
    const ordered = buildDailyAccountOrder({ accountIds, planDateKey, seed });
    return assignDelayBands({
      orderedAccountIds: ordered,
      occupiedBands,
      windowStartMs,
      windowEndMs,
      nowMs,
      planDateKey,
      seed,
    });
  }

  it('100 个账号跨 6 小时：子带互不相同、计划时刻互不相同、均落在窗口内', () => {
    const ids = Array.from({ length: 100 }, (_, index) => index + 1);
    const { items, deferredAccountIds } = run(ids, windowStartMs);

    expect(items.length).toBe(100);
    expect(deferredAccountIds).toEqual([]);

    const bands = items.map((item) => item.bandIndex);
    expect(new Set(bands).size).toBe(100);
    expect(new Set(items.map((item) => item.plannedFireMs)).size).toBe(100);

    const bandWidthMs = (windowEndMs - windowStartMs) / 100;
    for (const item of items) {
      expect(item.plannedFireMs).toBeGreaterThanOrEqual(Math.floor(windowStartMs + item.bandIndex * bandWidthMs));
      expect(item.plannedFireMs).toBeLessThan(windowStartMs + (item.bandIndex + 1) * bandWidthMs);
      expect(item.plannedFireMs).toBeLessThan(windowEndMs);
    }
  });

  it('同样输入两次调用逐字段相等（重启可复现）', () => {
    const ids = Array.from({ length: 30 }, (_, index) => index + 1);
    const first = run(ids, windowStartMs);
    const second = run(ids, windowStartMs);
    expect(first).toEqual(second);
  });

  it('空账号列表安全返回空结果', () => {
    expect(run([], windowStartMs)).toEqual({ items: [], deferredAccountIds: [] });
  });

  it('窗口终点不晚于起点时全部当日延后，且不除零', () => {
    const result = assignDelayBands({
      orderedAccountIds: [1, 2, 3],
      windowStartMs: ANCHOR,
      windowEndMs: ANCHOR,
      nowMs: ANCHOR,
      planDateKey,
      seed,
    });
    expect(result.items).toEqual([]);
    expect(result.deferredAccountIds).toEqual([1, 2, 3]);
  });

  it('已整体过期的子带不再被占用，拿不到未来带的账号进入 deferred', () => {
    // 把「现在」推到窗口最后一条带之后：所有子带尾部都 <= nowMs，全部延后。
    const lateNowMs = windowEndMs + MINUTE_MS;
    const result = run([1, 2, 3], lateNowMs);
    expect(result.items).toEqual([]);
    expect(result.deferredAccountIds.length).toBe(3);
  });

  it('部分过期时从当前时刻起采样，不会安排在过去', () => {
    // 窗口前四分之一已过去：账号应落在 nowMs 之后。
    const nowMs = windowStartMs + (windowEndMs - windowStartMs) / 4;
    const { items } = run([1, 2, 3], nowMs);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.plannedFireMs).toBeGreaterThanOrEqual(nowMs);
    }
  });

  it('occupiedBands 指定后账号避开这些子带', () => {
    const ids = [1, 2, 3];
    const withOccupied = assignDelayBands({
      orderedAccountIds: buildDailyAccountOrder({ accountIds: ids, planDateKey, seed }),
      occupiedBands: [0],
      windowStartMs,
      windowEndMs,
      nowMs: windowStartMs,
      planDateKey,
      seed,
    });
    // 3 个账号但第 0 带被占：仍能各得一个不同的空闲带（总数 3 带 -> 用掉 1 带后剩 2 带，故必有 1 个延后）
    const usedBands = withOccupied.items.map((item) => item.bandIndex);
    expect(new Set(usedBands).size).toBe(usedBands.length);
    expect(usedBands).not.toContain(0);
    expect(withOccupied.deferredAccountIds.length).toBe(1);
  });

  it('越界的 occupiedBands 序号被忽略而不抛错', () => {
    expect(() => assignDelayBands({
      orderedAccountIds: [1],
      occupiedBands: [-5, 99, Number.NaN],
      windowStartMs,
      windowEndMs,
      nowMs: windowStartMs,
      planDateKey,
      seed,
    })).not.toThrow();
  });
});

/**
 * 显式 bandCount 的回归分组。
 *
 * 场景来自「冻结当日置换 + 新账号只占空位」这条核心不变量：当天已排定的账号绝不重排，
 * 增量添加新账号时窗口必须仍按冻结时的份数等分，新账号只能领取空闲带。
 * 窗口统一取 [0, 3600000)（1 小时），份数 5/4/100 的带边界都是整数毫秒，可用字面量精确断言。
 */
describe('assignDelayBands（显式 bandCount：冻结置换上的增量入带）', () => {
  const seed = 'test-seed';
  const planDateKey = '2026-11-03';

  /** 固定窗口 [0, 3600000) 的入参包装，避免每条用例重复写窗口与日键。 */
  type FrozenWindowInput = Omit<
    Parameters<typeof assignDelayBands>[0],
    'windowStartMs' | 'windowEndMs' | 'planDateKey' | 'seed'
  >;

  function assignFrozen(input: FrozenWindowInput) {
    return assignDelayBands({
      ...input,
      windowStartMs: 0,
      windowEndMs: 3_600_000,
      planDateKey,
      seed,
    });
  }

  // A. 冻结置换增量。带宽 = (3600000 - 0) / 5 = 720000
  //    带 0=[0,720000) 带 1=[720000,1440000) 带 2=[1440000,2160000)
  //    带 3=[2160000,2880000) 带 4=[2880000,3600000)
  it('老账号占带 0/1/2 时，新账号只能领空闲的带 3 与带 4', () => {
    const result = assignFrozen({
      orderedAccountIds: [11, 22],
      occupiedBands: [0, 1, 2],
      bandCount: 5,
      nowMs: 0,
    });

    expect(result.items.map((item) => item.accountId)).toEqual([11, 22]);
    expect(result.items.map((item) => item.bandIndex)).toEqual([3, 4]);
    expect(result.deferredAccountIds).toEqual([]);

    expect(result.items[0].plannedFireMs).toBeGreaterThanOrEqual(2_160_000);
    expect(result.items[0].plannedFireMs).toBeLessThan(2_880_000);
    expect(result.items[1].plannedFireMs).toBeGreaterThanOrEqual(2_880_000);
    expect(result.items[1].plannedFireMs).toBeLessThan(3_600_000);

    // 两个新账号的时刻都不早于带 2 的带尾 2160000，因此与老账号占用的 [0, 2160000) 无重叠，
    // 不可能出现「同一秒出发」。
    for (const item of result.items) {
      expect(item.plannedFireMs).toBeGreaterThanOrEqual(2_160_000);
    }
    expect(new Set(result.items.map((item) => item.plannedFireMs)).size).toBe(2);
  });

  // B. 无空位则延后。bandCount=3 且带 0/1/2 全被占 -> 无任何可用带。
  it('冻结置换没有空位时，新账号全部当日延后，绝不抢注已占用带', () => {
    const result = assignFrozen({
      orderedAccountIds: [11, 22],
      occupiedBands: [0, 1, 2],
      bandCount: 3,
      nowMs: 0,
    });
    expect(result.items).toEqual([]);
    expect(result.deferredAccountIds).toEqual([11, 22]);
  });

  // C. 缺省等价。bandCount 省略与显式传入账号数必须逐字段相同（3 账号 3 带 -> 带宽 = 3600000/3 = 1200000）。
  it('省略 bandCount 与显式传入账号数得到完全相同的结果（硬性回归约束）', () => {
    const shared: FrozenWindowInput = {
      orderedAccountIds: [11, 22, 33],
      occupiedBands: [1],
      nowMs: 0,
    };
    const omitted = assignFrozen(shared);
    const explicit = assignFrozen({ ...shared, bandCount: shared.orderedAccountIds.length });

    expect(explicit).toEqual(omitted);
    // 顺带钉住缺省路径的既有语义：带 1 被占，账号 11 领带 0、账号 22 领带 2，账号 33 无位延后。
    expect(omitted.items.map((item) => item.bandIndex)).toEqual([0, 2]);
    expect(omitted.deferredAccountIds).toEqual([33]);
  });

  // D. 非法 bandCount 回落为账号数。
  it('非法 bandCount（0、负数、NaN、±Infinity、小数）不抛错且行为等同省略', () => {
    const shared: FrozenWindowInput = {
      orderedAccountIds: [11, 22],
      occupiedBands: [0],
      nowMs: 0,
    };
    const omitted = assignFrozen(shared);
    // 小数只取 2.5：它的截断值恰等于账号数 2，因此「整体回落」与「截断采纳」两种理解都得到同一结果，
    // 本条断言刻意不锁定该分歧。
    const illegalValues = [0, -3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2.5];
    for (const bandCount of illegalValues) {
      expect(() => assignFrozen({ ...shared, bandCount })).not.toThrow();
      expect(assignFrozen({ ...shared, bandCount })).toEqual(omitted);
    }
    // 省略路径（=2 带，带宽 1800000）：带 0 被占 -> 账号 11 领带 1，账号 22 无位延后。
    expect(omitted.items.map((item) => item.bandIndex)).toEqual([1]);
    expect(omitted.deferredAccountIds).toEqual([22]);
  });

  // E. 越界 occupiedBands 被忽略。带宽 = 3600000/4 = 900000
  //    带 0=[0,900000) 带 1=[900000,1800000) 带 2=[1800000,2700000) 带 3=[2700000,3600000)
  it('越界的 occupiedBands（负数、不小于 bandCount、非有限）被忽略，不影响分配', () => {
    const result = assignFrozen({
      orderedAccountIds: [11, 22],
      occupiedBands: [-7, 4, 9, Number.NaN, 1],
      bandCount: 4,
      nowMs: 0,
    });
    // 只有带 1 真正被占用；-7、4（等于 bandCount）、9、NaN 全部忽略。
    expect(result.items.map((item) => item.bandIndex)).toEqual([0, 2]);
    expect(result.deferredAccountIds).toEqual([]);
    expect(result.items[0].plannedFireMs).toBeGreaterThanOrEqual(0);
    expect(result.items[0].plannedFireMs).toBeLessThan(900_000);
    expect(result.items[1].plannedFireMs).toBeGreaterThanOrEqual(1_800_000);
    expect(result.items[1].plannedFireMs).toBeLessThan(2_700_000);
  });

  // F. bandCount 远大于账号数。带宽 = 3600000/100 = 36000
  //    带 0=[0,36000) 带 1=[36000,72000)
  it('bandCount 远大于账号数时窗口仍按份数铺满，账号领带 0 与 1 且时刻互不相同', () => {
    const result = assignFrozen({
      orderedAccountIds: [11, 22],
      bandCount: 100,
      nowMs: 0,
    });
    expect(result.items.map((item) => item.bandIndex)).toEqual([0, 1]);
    expect(result.deferredAccountIds).toEqual([]);
    expect(result.items[0].plannedFireMs).toBeGreaterThanOrEqual(0);
    expect(result.items[0].plannedFireMs).toBeLessThan(36_000);
    expect(result.items[1].plannedFireMs).toBeGreaterThanOrEqual(36_000);
    expect(result.items[1].plannedFireMs).toBeLessThan(72_000);
    expect(new Set(result.items.map((item) => item.plannedFireMs)).size).toBe(2);
  });

  // G. 过期带在显式 bandCount 下同样不占用。带宽 = 3600000/4 = 900000
  //    带 0 带尾 = 1*900000 = 900000；带 1 带尾 = 2*900000 = 1800000。
  //    nowMs 取 1800000 -> 带 0/1 带尾 <= nowMs 整体过期；带 2=[1800000,2700000)、带 3=[2700000,3600000) 可用。
  it('整体过期的带在显式 bandCount 下同样不被占用', () => {
    const result = assignFrozen({
      orderedAccountIds: [11, 22],
      occupiedBands: [],
      bandCount: 4,
      nowMs: 1_800_000,
    });
    expect(result.items.map((item) => item.bandIndex)).toEqual([2, 3]);
    expect(result.deferredAccountIds).toEqual([]);
    expect(result.items[0].plannedFireMs).toBeGreaterThanOrEqual(1_800_000);
    expect(result.items[0].plannedFireMs).toBeLessThan(2_700_000);
    expect(result.items[1].plannedFireMs).toBeGreaterThanOrEqual(2_700_000);
    expect(result.items[1].plannedFireMs).toBeLessThan(3_600_000);
    // 部分/整体过期的既有语义：计划时刻不早于当前时刻。
    for (const item of result.items) {
      expect(item.plannedFireMs).toBeGreaterThanOrEqual(1_800_000);
    }
  });

  // H. bandCount 小于待分配账号数是合法输入。带宽 = 900000；带 0 被占 -> 空闲带 1、2、3。
  it('bandCount 小于待分配账号数时先分配者拿最小空闲带，余者延后且不抛错', () => {
    const result = assignFrozen({
      orderedAccountIds: [11, 22, 33, 44],
      occupiedBands: [0],
      bandCount: 4,
      nowMs: 0,
    });
    expect(result.items.map((item) => item.accountId)).toEqual([11, 22, 33]);
    expect(result.items.map((item) => item.bandIndex)).toEqual([1, 2, 3]);
    expect(result.deferredAccountIds).toEqual([44]);
    expect(result.items[0].plannedFireMs).toBeGreaterThanOrEqual(900_000);
    expect(result.items[0].plannedFireMs).toBeLessThan(1_800_000);
    expect(result.items[1].plannedFireMs).toBeGreaterThanOrEqual(1_800_000);
    expect(result.items[1].plannedFireMs).toBeLessThan(2_700_000);
    expect(result.items[2].plannedFireMs).toBeGreaterThanOrEqual(2_700_000);
    expect(result.items[2].plannedFireMs).toBeLessThan(3_600_000);
  });

  // I. 带内子偏移只由哈希决定，与 bandCount 无关。
  it('同一账号在同一带内的相对位置与 bandCount 无关', () => {
    // 同一账号在 bandCount=1 与 bandCount=4 下都领到带 0；带宽分别 3600000 与 900000。
    const wide = assignFrozen({ orderedAccountIds: [11], bandCount: 1, nowMs: 0 });
    const narrow = assignFrozen({ orderedAccountIds: [11], bandCount: 4, nowMs: 0 });
    expect(wide.items[0].bandIndex).toBe(0);
    expect(narrow.items[0].bandIndex).toBe(0);
    const wideRatio = wide.items[0].plannedFireMs / 3_600_000;
    const narrowRatio = narrow.items[0].plannedFireMs / 900_000;
    // 毫秒取整与带尾钳制造成的相对误差上界为 1/3600000 + 1/900000 < 2e-6，
    // toBeCloseTo 精度 5（阈值 5e-6）足够容纳。
    expect(wideRatio).toBeCloseTo(narrowRatio, 5);
  });

  it('显式 bandCount 不改变「窗口终点不晚于起点时全部延后」的既有短路', () => {
    expect(assignDelayBands({
      orderedAccountIds: [11, 22],
      occupiedBands: [0],
      bandCount: 4,
      windowStartMs: ANCHOR,
      windowEndMs: ANCHOR,
      nowMs: ANCHOR,
      planDateKey,
      seed,
    })).toEqual({ items: [], deferredAccountIds: [11, 22] });
  });

  it('空账号列表带显式 bandCount 仍安全返回空结果', () => {
    expect(assignFrozen({
      orderedAccountIds: [],
      occupiedBands: [0],
      bandCount: 5,
      nowMs: 0,
    })).toEqual({ items: [], deferredAccountIds: [] });
  });

  it('显式 bandCount 下重算可复现（两次调用逐字段相等）', () => {
    const first = assignFrozen({ orderedAccountIds: [11, 22], occupiedBands: [0, 1, 2], bandCount: 5, nowMs: 0 });
    const second = assignFrozen({ orderedAccountIds: [11, 22], occupiedBands: [0, 1, 2], bandCount: 5, nowMs: 0 });
    expect(second).toEqual(first);
  });

  // M. 缺省路径的行为表征（对应「省略时与既有行为逐字等价」这条硬约束，不是认可的正确排布）。
  //    冻结置换为 5 份、老账号占用带 3 与带 4（时刻都在 [2160000, 3600000) 内）：
  //    省略 bandCount 时份数被压成账号数 2，带宽 3600000/2 = 1800000，
  //    occupiedBands 的 3、4 因越界被丢弃，于是带 1 区间 [1800000, 3600000) 与老账号区间重叠。
  it('省略 bandCount 时份数被压成账号数，新账号时刻区间会与冻结带重叠（既有行为表征）', () => {
    const legacy = assignFrozen({ orderedAccountIds: [11, 22], occupiedBands: [3, 4], nowMs: 0 });
    expect(legacy.items.map((item) => item.bandIndex)).toEqual([0, 1]);
    expect(legacy.deferredAccountIds).toEqual([]);
    expect(legacy.items[1].plannedFireMs).toBeGreaterThanOrEqual(1_800_000);
    expect(legacy.items[1].plannedFireMs).toBeLessThan(3_600_000);

    // 同一输入显式传入冻结份数 5：带宽 3600000/5 = 720000，带 0/1 区间为 [0,720000)、[720000,1440000)，
    // 两个新账号的时刻严格早于老账号（< 2160000），杜绝同秒出发。
    const frozen = assignFrozen({ orderedAccountIds: [11, 22], occupiedBands: [3, 4], bandCount: 5, nowMs: 0 });
    expect(frozen.items.map((item) => item.bandIndex)).toEqual([0, 1]);
    expect(frozen.items[1].plannedFireMs).toBeLessThan(1_440_000);
  });
});

describe('estimateDelayBands', () => {
  it('小时级窗口配百级账号不算过窄', () => {
    expect(estimateDelayBands({ windowMs: 6 * HOUR_MS, accountCount: 100 }).tooNarrow).toBe(false);
    expect(estimateDelayBands({ windowMs: HOUR_MS, accountCount: 100 }).tooNarrow).toBe(false);
  });

  // 600ms 平均带宽下计划**毫秒值**仍全唯一（实测见 evidence/s1-verification.md 第 29 行），
  // 但毫秒唯一不等于秒不唯一：100 个号铺在 60 秒里，必然有秒桶落进两个号。
  // 缺省判据问的是「会不会同秒」，带宽不足 1 秒就可能，所以这里必须是 tooNarrow=true。
  it('60 秒窗口 / 100 账号带宽 600ms：毫秒值唯一，但仍可能同秒，因此判过窄', () => {
    const result = estimateDelayBands({ windowMs: MINUTE_MS, accountCount: 100 });
    expect(result.avgBandMs).toBeCloseTo(600, 0);
    expect(result.tooNarrow).toBe(true);
  });

  it('亚毫秒带宽判为过窄', () => {
    expect(estimateDelayBands({ windowMs: 10, accountCount: 100 }).tooNarrow).toBe(true);
  });

  it('账号数为 0 不算过窄，避免误导提示', () => {
    expect(estimateDelayBands({ windowMs: 0, accountCount: 0 })).toEqual({ avgBandMs: 0, tooNarrow: false });
    expect(estimateDelayBands({ windowMs: HOUR_MS, accountCount: 0 }).tooNarrow).toBe(false);
  });

  it('账号数非有限时按 0 处理，平均宽度为 0 且不算过窄', () => {
    expect(estimateDelayBands({ windowMs: HOUR_MS, accountCount: Number.NaN }).avgBandMs).toBe(0);
    expect(estimateDelayBands({ windowMs: HOUR_MS, accountCount: Number.NaN }).tooNarrow).toBe(false);
  });

  // 两条判据必须是两条线，混用会让提示要么没用要么误导：
  // 1 秒回答「会不会同秒碰撞」，60 秒（定稿 8.2）回答「分散效果够不够好」。
  it('缺省阈值仍是防同秒碰撞的 1 秒线，不会因为提示用的 60 秒线而改变', () => {
    // 平均带宽 30 秒：对分散效果偏挤，但远不至同秒碰撞，缺省判据必须说不算过窄。
    expect(estimateDelayBands({ windowMs: 10 * MINUTE_MS, accountCount: 20 }).tooNarrow).toBe(false);
  });

  it('传入 60 秒提示线后，同一配置判为「分散效果有限」（仅提示，不参与分配决策）', () => {
    const input = { windowMs: 10 * MINUTE_MS, accountCount: 20, minBandMs: CHECKIN_DELAY_NARROW_HINT_MS };
    const result = estimateDelayBands(input);
    expect(result.avgBandMs).toBe(30_000);
    expect(result.tooNarrow).toBe(true);
  });

  it('提示线取到整分钟刚好等于 60 秒时不算过窄（严格小于才提示）', () => {
    expect(estimateDelayBands({
      windowMs: HOUR_MS,
      accountCount: 60,
      minBandMs: CHECKIN_DELAY_NARROW_HINT_MS,
    }).tooNarrow).toBe(false);
  });

  it('非法 minBandMs（0、负数、非有限）一律回落缺省的 1 秒碰撞线，绝不因参数脏而误报', () => {
    // 平均带宽 30 秒：按 60 秒提示线算挤，按缺省的 1 秒碰撞线算不挤。
    // 用这个配置才能证明「回落」落回的是 1 秒线而不是别的阈值。
    const base = { windowMs: 10 * MINUTE_MS, accountCount: 20 };
    expect(estimateDelayBands(base).tooNarrow).toBe(false);
    expect(estimateDelayBands({ ...base, minBandMs: 0 }).tooNarrow).toBe(false);
    expect(estimateDelayBands({ ...base, minBandMs: -60_000 }).tooNarrow).toBe(false);
    expect(estimateDelayBands({ ...base, minBandMs: Number.NaN }).tooNarrow).toBe(false);
    expect(estimateDelayBands({ ...base, minBandMs: Number.POSITIVE_INFINITY }).tooNarrow).toBe(false);
  });
});

describe('intervalAccountOffsetMs（定稿第 6 节第 59 行：interval 每账户到期偏移）', () => {
  const cfg = (minMs: number, maxMs: number, enabled = true) => ({ enabled, minMs, maxMs });
  const base = { seed: 'test-seed', accountId: 7 };

  it('关闭时偏移恒为 0，判据退回改造前行为', () => {
    const off = intervalAccountOffsetMs({
      ...base, roundPlanDateKey: '2026-11-04', config: cfg(0, 6 * 3600_000, false),
    });
    expect(off).toBe(0);
  });

  it('偏移恒落在 [minMs, maxMs) 内，且绝不早于 minMs', () => {
    const minMs = 3600_000;
    const maxMs = 4 * 3600_000;
    for (let accountId = 1; accountId <= 500; accountId += 1) {
      for (const key of ['2026-11-04', '2026-11-05']) {
        const off = intervalAccountOffsetMs({
          ...base, accountId, roundPlanDateKey: key, config: cfg(minMs, maxMs),
        });
        expect(off).toBeGreaterThanOrEqual(minMs);
        expect(off).toBeLessThan(maxMs);
      }
    }
  });

  it('min == max 时取该定值（不除零、不随机）', () => {
    expect(intervalAccountOffsetMs({
      ...base, roundPlanDateKey: '2026-11-04', config: cfg(2 * 3600_000, 2 * 3600_000),
    })).toBe(2 * 3600_000);
  });

  it('配置非法一律退化为 0，绝不抛错也绝不给负偏移', () => {
    for (const bad of [cfg(Number.NaN, 1000), cfg(-5, 1000), cfg(10_000, 1000), cfg(Infinity, Infinity)]) {
      expect(intervalAccountOffsetMs({ ...base, roundPlanDateKey: '2026-11-04', config: bad })).toBe(0);
    }
  });

  it('同一账号同一轮起算日重启后同值；换日必换值', () => {
    const a = intervalAccountOffsetMs({ ...base, roundPlanDateKey: '2026-11-04', config: cfg(0, 6 * 3600_000) });
    const b = intervalAccountOffsetMs({ ...base, roundPlanDateKey: '2026-11-04', config: cfg(0, 6 * 3600_000) });
    expect(a).toBe(b);
    // 日键参与哈希是「每天不一样」的根据。这里用足够宽的窗口保证不同日键不会偶然撞出同值。
    const c = intervalAccountOffsetMs({ ...base, roundPlanDateKey: '2026-11-05', config: cfg(0, 6 * 3600_000) });
    expect(c).not.toBe(a);
  });

  it('用的是第三个独立 salt：不与 order / subband 的哈希值同源', () => {
    // 若 interval 复用了上面两个 salt 之一，「当天排第几」与「晚多久到期」就会完全相关，
    // 等于给账号序号开了一个上游可观测的后门。这里以另一账号的同名哈希作对照。
    const offsetValue = intervalAccountOffsetMs({
      seed: 'test-seed', roundPlanDateKey: '2026-11-04', accountId: 42, config: cfg(0, 2 ** 31),
    });
    const orderUnit = delayHashUnit({ seed: 'test-seed', planDateKey: '2026-11-04', accountId: 42, salt: 'order' });
    const subBandUnit = delayHashUnit({ seed: 'test-seed', planDateKey: '2026-11-04', accountId: 42, salt: 'subband' });
    expect(offsetValue).not.toBe(Math.floor(orderUnit * 2 ** 31));
    expect(offsetValue).not.toBe(Math.floor(subBandUnit * 2 ** 31));
  });

  it('同一天多账号铺满窗口（分散性），而非集体取同一个值', () => {
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    const values = new Set(ids.map((accountId) => intervalAccountOffsetMs({
      seed: 'test-seed', roundPlanDateKey: '2026-11-04', accountId, config: cfg(0, 6 * 3600_000),
    })));
    expect(values.size).toBeGreaterThan(40);
  });
});
