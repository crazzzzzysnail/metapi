import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checkinAllMock = vi.fn();
const checkinAccountMock = vi.fn();

vi.mock('../../services/checkinService.js', () => ({
  checkinAll: (...args: unknown[]) => checkinAllMock(...args),
  checkinAccount: (...args: unknown[]) => checkinAccountMock(...args),
}));

const reanchorDelayRunMock = vi.fn();

vi.mock('../../services/checkinScheduler.js', () => ({
  updateCheckinSchedule: vi.fn(),
  // 全量签到路由现在会先问一次「能否按随机延迟重锚」。默认回「本功能不适用」，
  // 让被测通路落在原有的整批背景任务分支上 —— 本文件测的就是那条分支的去重语义。
  // 必须列出路由 import 的全部具名导出：vi.mock 工厂缺项会在加载时报
  // 「No "xxx" export is defined on the mock」。
  reanchorCheckinDelayRun: (...args: unknown[]) => reanchorDelayRunMock(...args),
}));

vi.mock('../../db/index.js', () => {
  const insertChain = {
    values: () => insertChain,
    onConflictDoUpdate: () => insertChain,
    run: () => ({ changes: 1 }),
  };

  const queryChain = {
    where: () => queryChain,
    all: () => [],
    limit: () => queryChain,
    offset: () => queryChain,
    orderBy: () => queryChain,
    innerJoin: () => queryChain,
    from: () => queryChain,
  };

  return {
    db: {
      insert: () => insertChain,
      select: () => queryChain,
    },
    hasProxyLogStreamTimingColumns: async () => false,
    schema: {
      settings: { key: 'key' },
      checkinLogs: { accountId: 'accountId', createdAt: 'createdAt' },
      accounts: { id: 'id' },
      events: { id: 'id' },
    },
  };
});

describe('POST /api/checkin/trigger background task dedupe', () => {
  beforeEach(async () => {
    checkinAllMock.mockReset();
    checkinAccountMock.mockReset();
    checkinAccountMock.mockResolvedValue({ success: true, message: 'ok' });
    // 默认「随机延迟不适用」，让每条用例都从原有的整批通路起步；
    // 需要测延迟分支的用例在自己内部覆盖它。
    reanchorDelayRunMock.mockReset();
    reanchorDelayRunMock.mockResolvedValue({ handled: false, ok: false, reason: 'disabled' });
    const { __resetBackgroundTasksForTests } = await import('../../services/backgroundTaskService.js');
    __resetBackgroundTasksForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reuses the same background task while checkin-all is already running', async () => {
    let resolveFirst: (value: Array<unknown>) => void = () => {};
    const firstRun = new Promise<Array<unknown>>((resolve) => {
      resolveFirst = resolve;
    });
    checkinAllMock.mockImplementation(() => firstRun);

    const { checkinRoutes } = await import('./checkin.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const firstResponse = await app.inject({ method: 'POST', url: '/api/checkin/trigger' });
    expect(firstResponse.statusCode).toBe(202);
    const firstBody = firstResponse.json() as { success: boolean; queued: boolean; jobId: string };
    expect(firstBody.success).toBe(true);
    expect(firstBody.queued).toBe(true);
    expect(typeof firstBody.jobId).toBe('string');
    expect(firstBody.jobId.length).toBeGreaterThan(10);

    const secondResponse = await app.inject({ method: 'POST', url: '/api/checkin/trigger' });
    expect(secondResponse.statusCode).toBe(202);
    const secondBody = secondResponse.json() as { reused: boolean; jobId: string };
    expect(secondBody.reused).toBe(true);
    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect(checkinAllMock).toHaveBeenCalledTimes(1);

    resolveFirst([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.close();
  });

  // 定稿第 19 节：两个全量按钮点击后不再瞬时齐发，而是以点击时刻重锚出一份当日计划。
  // 这里只验路由与派发层的接线与文案，排期算法本身由 checkinDelayPolicy/dispatcher 的测试覆盖。
  it('returns the delayed plan summary instead of running a batch when re-anchor succeeds', async () => {
    reanchorDelayRunMock.mockResolvedValue({ handled: true, ok: true, total: 3, lastPlannedMs: Date.now() + 3_600_000 });

    const { checkinRoutes } = await import('./checkin.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const response = await app.inject({ method: 'POST', url: '/api/checkin/trigger' });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { success: boolean; scheduled: boolean; total: number; message: string };
    expect(body.scheduled).toBe(true);
    expect(body.total).toBe(3);
    // 时刻按进程本地时区渲染，不断言具体时分，只断言它是 HH:MM（避免用例随 TZ 漂移）。
    expect(body.message).toContain('已按随机延迟排期 3 个账号');
    expect(body.message).toMatch(/最迟 \d{2}:\d{2} 完成/);
    expect(checkinAllMock).not.toHaveBeenCalled();

    await app.close();
  });

  // 这条是「同日两次请求」回归哨兵：延迟功能生效但今日已无待发账号时，
  // 绝不能回落到原有的整批背景任务 —— 那会让当天已签到成功的账号再被打一遍。
  it('does not fall back to the immediate batch when delay applied but scheduled nothing', async () => {
    reanchorDelayRunMock.mockResolvedValue({ handled: true, ok: false, reason: 'nothing-pending' });

    const { checkinRoutes } = await import('./checkin.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const response = await app.inject({ method: 'POST', url: '/api/checkin/trigger' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { success: boolean; scheduled: boolean; message: string };
    expect(body.scheduled).toBe(false);
    expect(body.message).toContain('本次没有需要排期的账号');
    expect(checkinAllMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('accepts the legacy cron-only schedule payload', async () => {
    const { checkinRoutes } = await import('./checkin.js');
    const schedulerModule = await import('../../services/checkinScheduler.js');
    const app = Fastify();
    await app.register(checkinRoutes);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/checkin/schedule',
      payload: { cron: '0 8 * * *' },
    });

    expect(response.statusCode).toBe(200);
    expect((schedulerModule as any).updateCheckinSchedule).toHaveBeenCalledWith({
      mode: 'cron',
      cronExpr: '0 8 * * *',
      intervalHours: undefined,
    });
    await app.close();
  });
});
