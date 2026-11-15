import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter, useLocation } from 'react-router-dom';
import SearchModal from './SearchModal.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    search: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../i18n.js', () => ({
  useI18n: () => ({
    t: (value: string) => value,
  }),
  // helpers/balanceAvailability 里的悬停文案走模块级 tr（无 hook），mock 必须一起给
  tr: (value: string) => value,
}));

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

function LocationProbe() {
  const location = useLocation();
  return <div id="location-probe">{`${location.pathname}${location.search}`}</div>;
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SearchModal results', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    Object.defineProperty(globalThis, 'window', {
      value: globalThis,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders account token results and navigates API key accounts to the apikey segment', async () => {
    apiMock.search.mockResolvedValue({
      models: [],
      sites: [],
      checkinLogs: [],
      proxyLogs: [],
      accounts: [
        {
          id: 8,
          username: '',
          balance: 0,
          segment: 'apikey',
          site: { name: 'Key Search Site' },
        },
      ],
      accountTokens: [
        {
          id: 15,
          name: 'search-token',
          tokenGroup: 'default',
          accountId: 8,
          account: { username: '' },
          site: { name: 'Key Search Site' },
        },
      ],
    });

    const onClose = vi.fn();
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/']}>
            <LocationProbe />
            <SearchModal open onClose={onClose} />
          </MemoryRouter>,
        );
      });

      const input = root.root.findByType('input');
      await act(async () => {
        input.props.onChange({ target: { value: 'search' } });
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('账号令牌');
      expect(rendered).toContain('search-token');
      expect(rendered).toContain('API Key 连接');

      const buttons = root.root.findAll((node) => node.type === 'button');
      const accountButton = buttons.find((node) => collectText(node).includes('API Key 连接'));
      expect(accountButton).toBeTruthy();

      await act(async () => {
        accountButton!.props.onClick();
      });
      const locationAfterAccountClick = root.root.find((node) => node.props?.id === 'location-probe');
      expect(collectText(locationAfterAccountClick)).toBe('/accounts?segment=apikey&focusAccountId=8');
    } finally {
      root?.unmount();
    }
  });

  /**
   * F8：搜索结果也要区分"余额 0"与"从没读到"。
   * 修之前这里写的是 `a.balance || 0`，从未读到余额的连接在搜索里一样显示 $0.00。
   */
  it('从没读到余额的连接显示破折号，非零余额照常显示', async () => {
    apiMock.search.mockResolvedValue({
      models: [],
      sites: [],
      checkinLogs: [],
      proxyLogs: [],
      accounts: [
        {
          id: 21,
          username: 'never-read',
          balance: 0,
          segment: 'apikey',
          lastBalanceRefresh: null,
          balanceEvidence: { status: 'unavailable', reason: 'malformed-payload', source: 'apikey-telemetry' },
          site: { id: 5, name: 'siteA' },
        },
        {
          id: 22,
          username: 'has-balance',
          balance: 15,
          segment: 'session',
          lastBalanceRefresh: null,
          balanceEvidence: { status: 'unavailable', reason: 'all-sources-failed', source: 'session' },
          site: { id: 6, name: 'siteB' },
        },
      ],
      accountTokens: [],
    });

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/']}>
            <SearchModal open onClose={vi.fn()} />
          </MemoryRouter>,
        );
      });

      const input = root.root.findByType('input');
      await act(async () => {
        input.props.onChange({ target: { value: 'bal' } });
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });
      await flushMicrotasks();

      const rows = root.root.findAll((node) => node.type === 'button')
        .filter((node) => collectText(node).includes('余额'));
      const neverReadRow = rows.find((node) => collectText(node).includes('never-read'));
      const hasBalanceRow = rows.find((node) => collectText(node).includes('has-balance'));
      expect(neverReadRow).toBeTruthy();
      expect(hasBalanceRow).toBeTruthy();
      expect(collectText(neverReadRow!)).toContain('余额 —');
      expect(collectText(neverReadRow!)).not.toContain('$0.00');
      expect(collectText(hasBalanceRow!)).toContain('余额 $15.00');
      // 悬停说明只在真的出破折号时挂上
      const hintNode = neverReadRow!.findAll((node) => node.props?.title === '上游返回的数据无法解析');
      expect(hintNode.length).toBeGreaterThan(0);
    } finally {
      root?.unmount();
    }
  });
});
