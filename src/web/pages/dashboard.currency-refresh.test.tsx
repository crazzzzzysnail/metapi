import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import React from 'react';
import { ToastProvider } from '../components/Toast.js';

/**
 * F2 的专项验证：显示货币变化时，仪表盘必须主动拉一次绕过缓存的快照。
 *
 * 为什么单独开这个文件而不是塞进 dashboard.*.test.tsx：
 * 那些用例都没 mock currencyContext，useCurrency() 落到 EMPTY_CONTEXT
 * （currency 恒为 USD），于是"币种变了要刷新"这条分支**根本执行不到**。
 * 全量测试因此对它完全无感 —— 这正是本项目反复踩过的"测试全绿但没测到"。
 *
 * 这里用可变汇率的假 Provider 把币种真实地切一次，断言请求确实发出、
 * 且带上了 refresh 语义（后端 TTL 12s，不带就拿到旧币种的数）。
 */

const { apiMock, currencyState } = vi.hoisted(() => ({
  apiMock: {
    getDashboard: vi.fn(),
    getDashboardSnapshot: vi.fn(),
    getDashboardInsights: vi.fn(),
    getSiteSnapshot: vi.fn(),
    getSiteDistribution: vi.fn(),
    getSiteTrend: vi.fn(),
    getSites: vi.fn(),
    getRuntimeSettings: vi.fn(),
    getCurrencyRates: vi.fn(),
    updateRuntimeSettings: vi.fn(),
  },
  // 由测试手动改值并触发重渲染，模拟顶栏按钮切换后的状态变化
  currencyState: { current: 'USD' as 'USD' | 'CNY' },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

// 只替换 useCurrency，保留真实的 CurrencyProvider 之外的组件不动
vi.mock('../currencyContext.js', async () => {
  const actual = await vi.importActual<typeof import('../currencyContext.js')>('../currencyContext.js');
  return {
    ...actual,
    useCurrency: () => ({
      currency: currencyState.current,
      getSiteRate: () => 7.3,
      // F4：提示链接要用 id 列表，缺失会让 buildUnknownRateSitesPath 直接抛错
      unknownRateSiteCount: 0,
      unknownRateSiteIds: [],
      loaded: true,
      refresh: async () => {},
      toggleCurrency: async () => {},
      toggling: false,
    }),
  };
});

vi.mock('../components/useIsMobile.js', () => ({ useIsMobile: () => false }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn(), useLocation: () => ({ pathname: '/', search: '', hash: '' }) };
});

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  currencyState.current = 'USD';
  const payload = {
    totalBalance: 100, totalUsed: 1, todaySpend: 0, todayReward: 0,
    activeAccounts: 1, totalAccounts: 1,
    todayCheckin: { success: 0, failed: 0, total: 0 },
    proxy24h: { success: 0, failed: 0, total: 0, totalTokens: 0 },
    performance: { windowSeconds: 60, requestsPerMinute: 0, tokensPerMinute: 0 },
    sites: [],
  };
  apiMock.getDashboardSnapshot.mockResolvedValue(payload);
  apiMock.getDashboardInsights.mockResolvedValue({ sites: [], models: [] });
  apiMock.getSiteSnapshot.mockResolvedValue({ sites: [] });
  apiMock.getSites.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dashboard 与显示货币的联动（F2）', () => {
  it('refetches with refresh when the currency changes, and only then', async () => {
    const Dashboard = (await import('./Dashboard.js')).default;

    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(React.createElement(ToastProvider, null, React.createElement(Dashboard)));
    });
    await flush();

    // 挂载时的首次加载：不带 refresh（走缓存是合理的冷启动行为）
    const initialCalls = apiMock.getDashboardSnapshot.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);
    expect(apiMock.getDashboardSnapshot.mock.calls[0][0]).toBeUndefined();

    apiMock.getDashboardSnapshot.mockClear();

    // 币种没变 → 不应重复请求
    await act(async () => { root.update(React.createElement(ToastProvider, null, React.createElement(Dashboard))); });
    await flush();
    expect(apiMock.getDashboardSnapshot).not.toHaveBeenCalled();

    // 切到 CNY → 必须立刻拉一次带 refresh 的快照
    currencyState.current = 'CNY';
    await act(async () => { root.update(React.createElement(ToastProvider, null, React.createElement(Dashboard))); });
    await flush();

    expect(apiMock.getDashboardSnapshot).toHaveBeenCalledTimes(1);
    expect(apiMock.getDashboardSnapshot).toHaveBeenCalledWith({ refresh: true });

    await act(async () => { root.unmount(); });
  });

  it('does not surface an error toast when the background refetch fails', async () => {
    /**
     * 切币种属于后台静默重算：用户没点任何按钮。
     * 复用 load(true) 会 setRefreshing 转圈并在失败时弹 toast —— 那是错的反馈强度。
     * 这条锁住"失败必须静默"。
     */
    const Dashboard = (await import('./Dashboard.js')).default;

    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(ToastProvider, null, React.createElement(Dashboard))); });
    await flush();

    apiMock.getDashboardSnapshot.mockRejectedValueOnce(new Error('boom'));
    apiMock.getDashboardSnapshot.mockClear();

    currencyState.current = 'CNY';
    await act(async () => { root.update(React.createElement(ToastProvider, null, React.createElement(Dashboard))); });
    await flush();

    expect(apiMock.getDashboardSnapshot).toHaveBeenCalledTimes(1);
    // 不应因这次后台失败进入错误态（error 会让整页显示加载失败）
    const rendered = JSON.stringify(root.toJSON?.() ?? '');
    expect(rendered).not.toContain('boom');

    await act(async () => { root.unmount(); });
  });
});
