import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cronStopMock = vi.fn();
const scheduleMock = vi.fn(() => ({
  stop: cronStopMock,
}));
const validateMock = vi.fn(() => true);
const allMock = vi.fn();
/** interval 候选查询的行数据出口，缺省空集（逐字保持既有用例行为）。 */
const allRowsMock = vi.fn(() => [] as unknown[]);

vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: unknown[]) => scheduleMock(...args),
    validate: (...args: unknown[]) => validateMock(...args),
  },
}));

vi.mock('../db/index.js', () => {
  const queryChain = {
    where: () => queryChain,
    get: () => undefined,
    // interval 的候选查询走 all()；用可控桩，缺省返回空集以逐字保持既有用例的行为。
    all: () => allRowsMock(),
    from: () => queryChain,
    innerJoin: () => queryChain,
  };

  return {
    db: {
      select: () => queryChain,
    },
    schema: {
      settings: { key: 'key' },
      // interval 的候选查询按列选取（见 listIntervalCheckinCandidates），这几列必须是对象成员，
      // 否则 db.select({...}) 的入参会变成 undefined。
      accounts: { id: 'id', checkinEnabled: 'checkinEnabled', status: 'status', lastCheckinAt: 'lastCheckinAt', siteId: 'siteId' },
      sites: { id: 'id', status: 'status' },
    },
  };
});

vi.mock('./checkinService.js', () => ({
  checkinAll: (...args: unknown[]) => allMock(...args),
}));

// 延迟派发器整体打桩。两个理由：
// 1) 本文件不 mock '../db/index.js' 的写路径，真派发器会去读设置表、甚至建兜底扫描的 setInterval，
//    那样下面「setInterval 只被调用一次」这类断言会随 .env 里的 CHECKIN_DELAY_ENABLED 而飘。
// 2) 派发器自身的算法与状态机由 checkinDelayDispatcher.test.ts / checkinDelayPolicy.test.ts 覆盖，
//    这里只关心调度器怎么和它接线。
// 工厂必须列出调度器 import 的全部具名导出，缺一项就会在加载时报「No "xxx" export is defined on the mock」。
const delayEnabledMock = vi.fn(async () => ({ enabled: false, minMs: 0, maxMs: 360 * 60_000 }));
const scheduleDelayedRunMock = vi.fn(async () => ({ ok: false, reason: 'disabled' }));
const listPlanOwnedMock = vi.fn(() => [] as number[]);
const ensureSweepMock = vi.fn();
const stopRuntimeMock = vi.fn();
/** S3 新增：interval 重挂钩子的注册动作，用它可以断言「切模式时钩子被摘/挂」。 */
const setResyncHookMock = vi.fn();
const resetDelayStateMock = vi.fn();

vi.mock('./checkinDelayDispatcher.js', () => ({
  loadCheckinDelayConfig: () => delayEnabledMock(),
  scheduleDelayedCheckinRun: (...args: unknown[]) => scheduleDelayedRunMock(...args),
  listPlanOwnedAccountIds: () => listPlanOwnedMock(),
  ensureCheckinDelaySweep: (...args: unknown[]) => ensureSweepMock(...args),
  stopCheckinDelayRuntime: (...args: unknown[]) => stopRuntimeMock(...args),
  // 以下三项是 S3（interval 收敛事件驱动）新增的依赖。vi.mock 工厂必须列出被测模块
  // import 的全部具名导出，缺一项就会在加载期硬报 No "xxx" export is defined on the mock。
  ensureSeed: async () => 'test-seed',
  setCheckinIntervalResyncHook: (...args: unknown[]) => setResyncHookMock(...args),
  resetCheckinDelayState: (...args: unknown[]) => resetDelayStateMock(...args),
  __resetCheckinDelayDispatcherForTests: vi.fn(),
}));

describe('checkinScheduler', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    // 延迟运行时同步走模块级串行队列：上一条用例排队的同步此刻仍是待处理微任务。
    // 必须先把它们冲掉、再清计数，否则下面 toHaveBeenCalledTimes(1) 这类断言会被跨用例残留污染。
    await import('./checkinScheduler.js');
    await vi.advanceTimersByTimeAsync(0);
    cronStopMock.mockReset();
    scheduleMock.mockClear();
    validateMock.mockClear();
    allMock.mockReset();
    allRowsMock.mockReset();
    allRowsMock.mockImplementation(() => []);
    // 派发器桩一律恢复成「功能关闭」：新用例改过 mockResolvedValue 后不得影响后续用例。
    delayEnabledMock.mockReset();
    delayEnabledMock.mockResolvedValue({ enabled: false, minMs: 0, maxMs: 360 * 60_000 });
    scheduleDelayedRunMock.mockReset();
    scheduleDelayedRunMock.mockResolvedValue({ ok: false, reason: 'disabled' });
    listPlanOwnedMock.mockReset();
    listPlanOwnedMock.mockReturnValue([]);
    ensureSweepMock.mockReset();
    stopRuntimeMock.mockReset();
    setResyncHookMock.mockReset();
    resetDelayStateMock.mockReset();
  });

  afterEach(async () => {
    const scheduler = await import('./checkinScheduler.js');
    scheduler.__resetCheckinSchedulerForTests();
    vi.useRealTimers();
  });

  it('switches from cron mode to interval mode and back', async () => {
    // S3（定稿第 14 节）之后，interval 不再建周期轮询：断言从「setInterval 恰好一次」
    // 翻成「setInterval 一次都不许有」——留着旧断言就等于允许那 1440 次/天的无 where 全表扫描复活。
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '0 8 * * *',
      intervalHours: 6,
    });
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'interval',
      intervalHours: 6,
    });
    expect(cronStopMock).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    // 关键回归防线：interval 通路不得再有任何周期轮询（定稿第 14 节删除了 60 秒全表扫描）。

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '5 9 * * *',
      intervalHours: 6,
    });
    // updateCheckinSchedule 走的是模块级串行队列（void queue...），断言前必须先排空，
    // 否则这里看到的是「上一次同步还没跑」的空计数 —— 这是接线时序，不是功能缺陷。
    await vi.advanceTimersByTimeAsync(0);
    // 切回 cron 必须摘掉 interval 的重挂钩子，免得派发器回调一条已无人维护的路径。
    expect(setResyncHookMock).toHaveBeenCalledWith(null);
    expect(scheduleMock).toHaveBeenCalledTimes(2);
  });

  it('interval 到期后由唤醒定时器发起，且全程不建周期轮询（定稿第 14 节）', async () => {
    const scheduler = await import('./checkinScheduler.js');
    allRowsMock.mockImplementation(() => [
      { id: 1, lastCheckinAt: '2026-03-20T00:00:00.000Z', siteStatus: 'active' },
      { id: 2, lastCheckinAt: '2026-03-20T00:00:00.000Z', siteStatus: 'active' },
    ]);
    allMock.mockResolvedValue([
      { accountId: 1, result: { success: true } },
      { accountId: 2, result: { success: true } },
    ]);

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    scheduler.updateCheckinSchedule({ mode: 'interval', intervalHours: 6 });

    // 到期的账号被带走，并带上 interval 的 scheduleMode ——
    // checkinService.ts:203 靠它决定「成功才推进时间戳」，填错会连带破坏失败重试语义。
    // checkinService.ts:203 靠它决定「成功才推进时间戳」，填错会连带破坏失败重试语义。
    await vi.waitFor(() => expect(allMock).toHaveBeenCalled());
    expect(allMock.mock.calls[0][0]).toMatchObject({ scheduleMode: 'interval' });
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('interval 在一个候选账号都没有时仍留一只低频兜底拍，不留永久停摆窗口', async () => {
    const scheduler = await import('./checkinScheduler.js');
    allRowsMock.mockImplementation(() => []);   // 库里当前没有可签到账号
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    scheduler.updateCheckinSchedule({ mode: 'interval', intervalHours: 6 });

    // 兜底拍的量级必须比被删除的 60 秒轮询低两个数量级：不小于 5 分钟。
    await vi.waitFor(() => expect(
      setTimeoutSpy.mock.calls.some((call) => typeof call[1] === 'number' && (call[1] as number) >= 5 * 60_000),
    ).toBe(true));
  });

  it('延迟关闭时 interval 偏移为 0，到期判据与改造前逐字等价', async () => {
    const scheduler = await import('./checkinScheduler.js');
    delayEnabledMock.mockResolvedValue({ enabled: false, minMs: 0, maxMs: 360 * 60_000 });
    const now = new Date('2026-03-20T12:00:00.000Z');
    const rows = [{ id: 1, lastCheckinAt: '2026-03-20T05:00:00.000Z' }]; // 距上次签到恰好 7 小时

    // 不传偏移回调时，判据与改造前逐字等价：满 6 小时即到期。
    expect(scheduler.selectDueIntervalCheckinAccountIds(rows, 6, now)).toEqual([1]);
    // 偏移是「抬高门槛」而不是改写到期规则：门槛 = intervalMs + offset。
    // 实际间隔 7 小时，故偏移取 2 小时把门槛抬到 8 小时才会判未到期；
    // 若只取 1 小时则门槛恰好等于 7 小时，按源码的 `<` 判据仍然到期（边界值不能用来证明推后）。
    const withOffset = scheduler.selectDueIntervalCheckinAccountIds(rows, 6, now, new Map(), () => 2 * 60 * 60_000);
    expect(withOffset).toEqual([]);
  });
  it('selects due accounts from the last successful checkin time', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date('2026-03-20T12:00:00.000Z');

    expect(scheduler.selectDueIntervalCheckinAccountIds([
      { id: 1, lastCheckinAt: null },
      { id: 2, lastCheckinAt: '2026-03-20T05:59:59.000Z' },
      { id: 3, lastCheckinAt: '2026-03-20T06:30:00.000Z' },
    ], 6, now)).toEqual([1, 2]);
  });

  // 延迟开关是 cron 通路唯一的分岔点：开着就必须走排期、且绝不整批齐发；
  // 关着就必须逐字走原有的 checkinAll 路径（这是「默认行为零变化」的机器证明）。
  it('runs the delayed plan instead of a batch when random delay is enabled', async () => {
    delayEnabledMock.mockResolvedValue({ enabled: true, minMs: 0, maxMs: 360 * 60_000 });
    scheduleDelayedRunMock.mockResolvedValue({ ok: true, total: 3, lastPlannedMs: Date.now() + 60_000 });
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateCheckinSchedule({ mode: 'cron', cronExpr: '0 8 * * *', intervalHours: 6 });
    const cronCallback = scheduleMock.mock.calls[0][1] as () => Promise<void>;
    await cronCallback();

    expect(scheduleDelayedRunMock).toHaveBeenCalledTimes(1);
    const input = scheduleDelayedRunMock.mock.calls[0][0] as { mode: string; anchorMs: number };
    expect(input.mode).toBe('cron');
    expect(typeof input.anchorMs).toBe('number');
    expect(allMock).not.toHaveBeenCalled();
  });

  it('keeps the original batch path when random delay is disabled', async () => {
    delayEnabledMock.mockResolvedValue({ enabled: false, minMs: 0, maxMs: 360 * 60_000 });
    allMock.mockResolvedValue([]);
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateCheckinSchedule({ mode: 'cron', cronExpr: '0 8 * * *', intervalHours: 6 });
    const cronCallback = scheduleMock.mock.calls[0][1] as () => Promise<void>;
    await cronCallback();

    expect(scheduleDelayedRunMock).not.toHaveBeenCalled();
    expect(allMock).toHaveBeenCalledTimes(1);
    expect(allMock).toHaveBeenCalledWith({ scheduleMode: 'cron' });
  });

  it('invalidates the delay runtime when the schedule mode switches to interval', async () => {
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateCheckinSchedule({ mode: 'interval', intervalHours: 6 });
    // interval 通路保留自己的到期与失败重试语义，不装载延迟运行时，并把残留的当日计划丢弃。
    // 装载走的是串行队列（一个微任务链），用 advanceTimersByTimeAsync(0) 把微任务冲干净再断言。
    await vi.advanceTimersByTimeAsync(0);
    expect(stopRuntimeMock).toHaveBeenCalledTimes(1);
    expect(ensureSweepMock).not.toHaveBeenCalled();
  });
});
