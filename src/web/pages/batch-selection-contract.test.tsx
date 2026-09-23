import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import TokenRoutes from './TokenRoutes.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

// 共享 api mock：两个页面都用同一 `api` 模块，用例内按需覆写返回值
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    // Accounts
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    batchUpdateAccounts: vi.fn(),
    refreshAccountHealth: vi.fn(),
    // TokenRoutes
    getRoutesSummary: vi.fn(),
    getRouteChannels: vi.fn(),
    getModelTokenCandidates: vi.fn(),
    getRouteDecisionsBatch: vi.fn(),
    getRouteWideDecisionsBatch: vi.fn(),
    batchUpdateRoutes: vi.fn(),
    batchUpdateChannels: vi.fn(),
    updateRoute: vi.fn(),
    updateChannel: vi.fn(),
    deleteChannel: vi.fn(),
    addRoute: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  hashColor: () => 'linear-gradient(135deg,#4f46e5,#818cf8)',
  normalizeBrandIconKey: (icon: string) => icon,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collectText(node: any): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  const children = node.children || node.props?.children || [];
  return (Array.isArray(children) ? children : [children]).map(collectText).join('');
}

function findButtonByText(root: any, text: string) {
  return root.find((node: any) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).includes(text)
  ));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('confirm', vi.fn(() => true));
  // TokenRoutes 的分块懒加载 effect 依赖 IntersectionObserver（抄 tokenRoutes.mobile.test 的桩）
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('B3 选择集契约 · Accounts 跨分段后缀', () => {
  const accountsFixture = [
    {
      id: 1, siteId: 1, username: 'alpha', accessToken: 'session-alpha', apiToken: '', credentialMode: 'session',
      status: 'active', site: { id: 1, name: 'Site A', status: 'active', platform: 'new-api' },
    },
    {
      id: 2, siteId: 1, username: 'beta', accessToken: 'session-beta', apiToken: '', credentialMode: 'session',
      status: 'active', site: { id: 1, name: 'Site A', status: 'active', platform: 'new-api' },
    },
  ];

  beforeEach(() => {
    installAccountsSnapshotCompat(apiMock);
    apiMock.getSites.mockResolvedValue([{ id: 1, name: 'Site A', platform: 'new-api', status: 'active' }]);
    apiMock.getAccounts.mockResolvedValue(accountsFixture);
    apiMock.batchUpdateAccounts.mockResolvedValue({ success: true, successIds: [], failedItems: [] });
    apiMock.refreshAccountHealth.mockResolvedValue({ success: true });
  });

  it('session 段勾选 2 条后切到 apikey 段：显示隐藏计数后缀并出现「只保留可见项」，点击后清空选择', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      // find 在 0 匹配时会抛错，存在性判断一律用 findAll
      const mobileSelectAll = root.root.findAll((node) => node.props['data-testid'] === 'accounts-mobile-select-all');
      // 桌面形态：逐行勾选当前分段可见项（复用 accounts.batch-actions.test 已验证的 testid）
      const checkboxA = root.root.find((node) => node.props['data-testid'] === 'account-select-1');
      const checkboxB = root.root.find((node) => node.props['data-testid'] === 'account-select-2');
      await act(async () => {
        checkboxA.props.onChange({ target: { checked: true } });
        checkboxB.props.onChange({ target: { checked: true } });
      });
      await flushMicrotasks();

      // 未切换分段前无后缀（可见=全量）
      expect(collectText(root.root)).toContain('已选 2 项');
      expect(collectText(root.root)).not.toContain('不在当前筛选内');
      expect(mobileSelectAll).toHaveLength(0); // 非移动端，无 mobile-select-all 按钮

      // 点击「API Key管理」分段：路由参数切换会重挂载组件，因此必须走页内分段按钮
      const apikeySegmentButton = root.root.findAll((node) => (
        node.type === 'button' && collectText(node).trim() === 'API Key管理'
      ))[0];
      expect(apikeySegmentButton).toBeDefined();
      await act(async () => {
        apikeySegmentButton.props.onClick();
      });
      await flushMicrotasks();

      // 切段后：选择集未被自动收缩（方案 A 契约），后缀显式提示不可见数量
      const text = collectText(root.root);
      expect(text).toContain('已选 2 项');
      expect(text).toContain('其中 2 项不在当前筛选内');

      // 「只保留可见项」按钮出现
      const keepVisible = findButtonByText(root.root, '只保留可见项');
      await act(async () => {
        keepVisible.props.onClick();
      });
      await flushMicrotasks();

      // apikey 段可见集为空 → 保留后可见集合 = ∅ → 选择整体清空 → 批量栏消失
      expect(collectText(root.root)).not.toContain('只保留可见项');
    } finally {
      root?.unmount();
    }
  });
});

describe('B3 选择集契约 · TokenRoutes updatedCount 回执', () => {
  const routeFixture = [
    {
      id: 1, modelPattern: 'gpt-4o-mini', displayName: 'gpt-4o-mini', displayIcon: null,
      modelMapping: null, routeMode: 'pattern', routingStrategy: 'weighted', enabled: true,
      channelCount: 1, enabledChannelCount: 1, siteNames: ['site-a'],
      decisionSnapshot: null, decisionRefreshedAt: null,
    },
    {
      id: 2, modelPattern: 'gpt-4o', displayName: 'gpt-4o', displayIcon: null,
      modelMapping: null, routeMode: 'pattern', routingStrategy: 'weighted', enabled: true,
      channelCount: 1, enabledChannelCount: 1, siteNames: ['site-a'],
      decisionSnapshot: null, decisionRefreshedAt: null,
    },
    {
      id: 3, modelPattern: 'o1', displayName: 'o1', displayIcon: null,
      modelMapping: null, routeMode: 'pattern', routingStrategy: 'weighted', enabled: true,
      channelCount: 1, enabledChannelCount: 1, siteNames: ['site-a'],
      decisionSnapshot: null, decisionRefreshedAt: null,
    },
  ];

  beforeEach(() => {
    apiMock.getRoutesSummary.mockResolvedValue(routeFixture);
    apiMock.getRouteChannels.mockResolvedValue([]);
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
    apiMock.getRouteDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.getRouteWideDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.updateRoute.mockResolvedValue({});
    apiMock.addRoute.mockResolvedValue({});
    apiMock.batchUpdateChannels.mockResolvedValue({ success: true, channels: [] });
    apiMock.deleteChannel.mockResolvedValue({});
    apiMock.updateChannel.mockResolvedValue({});
    // 权威 updatedCount=2，勾选 3 条 → 差额 1
    apiMock.batchUpdateRoutes.mockResolvedValue({ success: true, updatedCount: 2 });
  });

  it('批量启用回执读 updatedCount，差额显式提示', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      // 进入批量模式
      await act(async () => {
        findButtonByText(root.root, '批量操作').props.onClick();
      });
      await flushMicrotasks();

      for (const routeId of [1, 2, 3]) {
        const checkbox = root.root.find((node) => (
          node.type === 'input'
          && node.props.type === 'checkbox'
          && node.props['data-testid'] === `route-select-${routeId}`
        ));
        await act(async () => {
          checkbox.props.onChange({ target: { checked: true } });
        });
        await flushMicrotasks();
      }

      await act(async () => {
        findButtonByText(root.root, '批量启用').props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateRoutes).toHaveBeenCalledWith({ ids: [1, 2, 3], action: 'enable' });
      expect(collectText(root.root)).toContain('已批量启用 2 条路由');
      expect(collectText(root.root)).toContain('1 条已不存在或状态未变化');
    } finally {
      root?.unmount();
    }
  });
});
