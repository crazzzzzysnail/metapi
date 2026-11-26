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

// 负控制：旧「单条系统代理」卡片的入口必须彻底消失——留着两套编辑面，
// 用户改了旧卡片会以为生效，实际权威已在池默认条目那边。
describe('Settings legacy system proxy card is removed', () => {
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
      systemProxyUrl: 'http://***@127.0.0.1:7890',
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
    apiMock.getProxyPool.mockResolvedValue({ items: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('no longer renders the legacy proxy input and buttons', async () => {
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

      expect(collectText(root.root)).not.toContain('保存系统代理');
      expect(collectText(root.root)).not.toContain('测试系统代理');
      // 旧卡片的地址输入框（占位符带完整 URL 示例）也不再出现
      const legacyInputs = root.root.findAll((node) => (
        node.type === 'input'
        && String(node.props.placeholder || '').startsWith('系统代理 URL')
      ));
      expect(legacyInputs).toHaveLength(0);
      expect(apiMock.testSystemProxy).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });
});
