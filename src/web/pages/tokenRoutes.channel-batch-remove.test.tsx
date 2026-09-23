import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import TokenRoutes from './TokenRoutes.js';

// B4.3：通道批量移除从原生 confirm 升级为 DeleteConfirmModal（组件档确认）。
// 采用移动端形态驱动（既有 tokenRoutes.mobile.test.tsx 验证过该路径可触达通道控件）。
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
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

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (node: unknown) => node,
  };
});

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => true,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  hashColor: () => 'linear-gradient(135deg,#4f46e5,#818cf8)',
  normalizeBrandIconKey: (icon: string) => icon,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

function findButtonByText(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).includes(text)
  ));
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TokenRoutes channel batch-remove modal (B4.3)', () => {
  const originalIntersectionObserver = globalThis.IntersectionObserver;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.IntersectionObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof IntersectionObserver;

    apiMock.getRoutesSummary.mockResolvedValue([
      {
        id: 1, modelPattern: 'gpt-4o-mini', displayName: 'gpt-4o-mini', displayIcon: null,
        modelMapping: null, routeMode: 'pattern', routingStrategy: 'weighted', enabled: true,
        channelCount: 2, enabledChannelCount: 2, siteNames: ['site-a'],
        decisionSnapshot: null, decisionRefreshedAt: null,
      },
    ]);
    apiMock.getRouteChannels.mockResolvedValue([
      {
        id: 11, routeId: 1, accountId: 101, tokenId: 1001, sourceModel: 'gpt-4o-mini',
        priority: 0, weight: 1, enabled: true, manualOverride: false, successCount: 0, failCount: 0,
        account: { username: 'user_a' }, site: { name: 'site-a' },
        token: { id: 1001, name: 'token-a', accountId: 101, enabled: true, isDefault: true },
      },
      {
        id: 12, routeId: 1, accountId: 102, tokenId: 1002, sourceModel: 'gpt-4o-mini',
        priority: 0, weight: 1, enabled: true, manualOverride: false, successCount: 0, failCount: 0,
        account: { username: 'user_b' }, site: { name: 'site-a' },
        token: { id: 1002, name: 'token-b', accountId: 102, enabled: true, isDefault: false },
      },
    ]);
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
    apiMock.getRouteDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.getRouteWideDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.batchUpdateRoutes.mockResolvedValue({ success: true, updatedCount: 1 });
    apiMock.updateRoute.mockResolvedValue({});
    apiMock.updateChannel.mockResolvedValue({});
    apiMock.deleteChannel.mockResolvedValue({});
    apiMock.addRoute.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
    globalThis.IntersectionObserver = originalIntersectionObserver;
  });

  it('批量移除先弹组件档模态（含加粗副作用文案），确认后逐通道调用 deleteChannel', async () => {
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

      // 展开卡片加载通道
      await act(async () => {
        findButtonByText(root.root, '详情').props.onClick();
      });
      await flushMicrotasks();

      // 勾选第一个通道（两通道 → 两个选择按钮，用 findAll 避免 find 的多匹配抛错）
      const channelToggles = root.root.findAll((node) => (
        node.type === 'button'
        && String(node.props['aria-label'] || '').includes('选择通道')
      ));
      expect(channelToggles.length).toBeGreaterThan(0);
      await act(async () => {
        channelToggles[0].props.onClick();
      });
      await flushMicrotasks();

      // 点击「批量移除」——应打开模态，而不是调用 deleteChannel / confirm
      await act(async () => {
        findButtonByText(root.root, '批量移除').props.onClick();
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('确认批量移除通道');
      expect(text).toContain('此操作不可撤销');
      // 加粗副作用句在 alert 区域内
      const bold = root.root.find((node) => (
        node.type === 'strong' && collectText(node).includes('如果移除最后一个通道')
      ));
      expect(bold).toBeTruthy();
      expect(apiMock.deleteChannel).not.toHaveBeenCalled();

      // 模态内确认：找到 danger 按钮（确认移除）
      const confirmButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.className === 'string'
        && node.props.className.includes('btn-danger')
        && collectText(node).includes('确认移除')
      ));
      await act(async () => {
        confirmButton.props.onClick();
      });
      await flushMicrotasks();
      await flushMicrotasks();

      expect(apiMock.deleteChannel).toHaveBeenCalledTimes(1);
      // 不锁定具体通道 id（移动/桌面双份行结构的先后不影响本用例语义）
      expect(apiMock.deleteChannel.mock.calls[0][0]).toBeGreaterThan(0);
    } finally {
      root?.unmount();
    }
  });
});
