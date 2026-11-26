import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Sites from './Sites.js';

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getProxyPool: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

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

describe('Sites proxy badge jump', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getProxyPool.mockResolvedValue({
      items: [
        { id: 7, name: '池甲', url: 'http://127.0.0.1:7890', hasCredentials: false, isDefault: false },
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('navigates to the site editor proxy field when the badge is clicked', async () => {
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'Site A',
        url: 'https://a.example.com',
        platform: 'new-api',
        status: 'active',
        proxyId: 7,
        useSystemProxy: false,
      },
    ]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      // 桌面表格 + 移动卡片两处徽标，取第一个
      const badge = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.className === 'string'
        && node.props.className.includes('billing-rate-badge')
        && collectText(node).includes('代理池')
      ))[0];
      expect(badge).toBeTruthy();
      // 池模式徽标带上条目名，用户才知道这条引用指向哪一条
      expect(collectText(badge)).toContain('池甲');

      await act(async () => {
        badge.props.onClick();
      });

      expect(navigateMock).toHaveBeenCalledWith('/sites?focusSiteId=1&editTarget=site&editField=proxy');
    } finally {
      root?.unmount();
    }
  });

  it('labels a direct-connect site without claiming a proxy is in use', async () => {
    apiMock.getSites.mockResolvedValue([
      {
        id: 2,
        name: 'Site B',
        url: 'https://b.example.com',
        platform: 'new-api',
        status: 'active',
        useSystemProxy: false,
      },
    ]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      // 汇率徽标共用同一 class，必须按文案锁定代理徽标
      const badge = root.root.findAll((node) => (
        node.type === 'button'
        && typeof node.props.className === 'string'
        && node.props.className.includes('billing-rate-badge')
        && collectText(node).includes('直连')
      ))[0];
      expect(badge).toBeTruthy();

      await act(async () => {
        badge.props.onClick();
      });
      // 直连也要能直达编辑区，否则用户无从改起
      expect(navigateMock).toHaveBeenCalledWith('/sites?focusSiteId=2&editTarget=site&editField=proxy');
    } finally {
      root?.unmount();
    }
  });
});
