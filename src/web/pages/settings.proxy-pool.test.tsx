import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Settings from './Settings.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAuthInfo: vi.fn(),
    getRuntimeSettings: vi.fn(),
    getDownstreamApiKeys: vi.fn(),
    getRoutesLite: vi.fn(),
    getRuntimeDatabaseConfig: vi.fn(),
    getBrandList: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    testSystemProxy: vi.fn(),
    getModelTokenCandidates: vi.fn(),
    getProxyPool: vi.fn(),
    createProxyPoolEntry: vi.fn(),
    updateProxyPoolEntry: vi.fn(),
    updateProxyPoolEntryUrl: vi.fn(),
    deleteProxyPoolEntry: vi.fn(),
    setDefaultProxyPoolEntry: vi.fn(),
    getProxyPoolUsage: vi.fn(),
    revealProxyPoolEntry: vi.fn(),
    testProxyPoolEntry: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  normalizeBrandIconKey: (icon: string) => icon,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Settings renders the system proxy pool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAuthInfo.mockResolvedValue({ masked: 'sk-****' });
    apiMock.getRuntimeSettings.mockResolvedValue({
      checkinCron: '0 8 * * *',
      balanceRefreshCron: '0 * * * *',
      logCleanupCron: '0 6 * * *',
      logCleanupUsageLogsEnabled: false,
      logCleanupProgramLogsEnabled: false,
      logCleanupRetentionDays: 30,
      routingFallbackUnitCost: 1,
      routingWeights: {},
      adminIpAllowlist: [],
      systemProxyUrl: '',
    });
    apiMock.getDownstreamApiKeys.mockResolvedValue({ items: [] });
    apiMock.getRoutesLite.mockResolvedValue([]);
    apiMock.getBrandList.mockResolvedValue({ brands: [] });
    apiMock.getRuntimeDatabaseConfig.mockResolvedValue({
      active: { dialect: 'sqlite', connection: '(default sqlite path)', ssl: false },
      saved: null,
      restartRequired: false,
    });
    apiMock.updateRuntimeSettings.mockResolvedValue({ success: true });
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
    apiMock.getProxyPool.mockResolvedValue({
      items: [
        { id: 1, name: '池甲', url: 'http://***@127.0.0.1:7890', hasCredentials: true, isDefault: true },
        { id: 2, name: '池乙', url: 'socks5://127.0.0.1:1080', hasCredentials: false, isDefault: false },
      ],
    });
    apiMock.getProxyPoolUsage.mockResolvedValue({ siteCount: 0, accountCount: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('replaces the single system proxy editor with the pool card', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('系统代理池');
      expect(text).toContain('池甲');
      expect(text).toContain('池乙');
      // 旧卡片的「保存系统代理 / 测试系统代理」入口已整体移除
      expect(text).not.toContain('保存系统代理');
      expect(text).not.toContain('测试系统代理');
    } finally {
      root?.unmount();
    }
  });

  it('shows only the redacted url the server sent down', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root.root);
      expect(text).toContain('http://***@127.0.0.1:7890');
      expect(text).not.toContain('userA');
      // 带凭据的条目才给出揭示入口（图标按钮，无障碍标签承载文案）
      const revealButton = root.root.find((node) => (
        node.type === 'button' && node.props['aria-label'] === '显示完整地址'
      ));
      expect(revealButton).toBeTruthy();
    } finally {
      root?.unmount();
    }
  });
});
