import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    batchUpdateAccounts: vi.fn(),
    getProxyPool: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
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

async function selectFirstAccountAndOpenBatchProxy(root: WebTestRenderer) {
  const checkbox = root.root.find((node) => node.props['data-testid'] === 'account-select-1');
  await act(async () => {
    checkbox.props.onChange({ target: { checked: true } });
  });

  const batchProxyButton = root.root.find((node) => node.props['data-testid'] === 'accounts-batch-proxy');
  await act(async () => {
    batchProxyButton.props.onClick();
  });
  await flushMicrotasks();
}

async function pickOption(root: WebTestRenderer, testId: string, includesText: string) {
  const select = root.root.find((node) => node.props['data-testid'] === testId);
  const option = select.findAll((node) => (
    node.type === 'button'
    && typeof node.props.className === 'string'
    && node.props.className.includes('modern-select-option')
    && collectText(node).includes(includesText)
  ))[0];
  await act(async () => {
    option.props.onClick();
  });
  await flushMicrotasks();
}

describe('Accounts batch proxy settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
    apiMock.getSites.mockResolvedValue([
      { id: 1, name: 'Site A', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        siteId: 1,
        username: 'alpha',
        accessToken: 'session-alpha',
        status: 'active',
        site: { id: 1, name: 'Site A', status: 'active', platform: 'new-api' },
      },
    ]);
    apiMock.batchUpdateAccounts.mockResolvedValue({ success: true, successIds: [1], failedItems: [] });
    apiMock.getProxyPool.mockResolvedValue({
      items: [
        { id: 7, name: '池甲', url: 'http://127.0.0.1:7890', hasCredentials: false, isDefault: false },
        { id: 8, name: '池乙', url: 'socks5://127.0.0.1:1080', hasCredentials: false, isDefault: true },
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('submits a pool reference and clears the other two cells', async () => {
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
      await selectFirstAccountAndOpenBatchProxy(root);

      // 批量弹窗默认 proxyMode=clear 且 applyProxy=true（按钮打开时预置）
      await pickOption(root, 'accounts-batch-proxy-mode', '代理池');
      await pickOption(root, 'accounts-batch-proxy-pool', '池甲');

      const applyButton = root.root.findAll(
        (node) => node.type === 'button' && collectText(node).includes('应用到所选连接'),
      )[0];
      await act(async () => {
        applyButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateAccounts).toHaveBeenCalledWith({
        ids: [1],
        action: 'updateSettings',
        proxyUrl: '',
        proxyId: 7,
        useSystemProxy: false,
      });
    } finally {
      root?.unmount();
    }
  });

  it('submits system proxy mode with the other cells cleared', async () => {
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
      await selectFirstAccountAndOpenBatchProxy(root);

      await pickOption(root, 'accounts-batch-proxy-mode', '使用系统代理');

      const applyButton = root.root.findAll(
        (node) => node.type === 'button' && collectText(node).includes('应用到所选连接'),
      )[0];
      await act(async () => {
        applyButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateAccounts).toHaveBeenCalledWith({
        ids: [1],
        action: 'updateSettings',
        proxyUrl: '',
        proxyId: null,
        useSystemProxy: true,
      });
    } finally {
      root?.unmount();
    }
  });

  it('refuses to submit pool mode without choosing an entry', async () => {
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
      await selectFirstAccountAndOpenBatchProxy(root);

      await pickOption(root, 'accounts-batch-proxy-mode', '代理池');

      const applyButton = root.root.findAll(
        (node) => node.type === 'button' && collectText(node).includes('应用到所选连接'),
      )[0];
      await act(async () => {
        applyButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateAccounts).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });

  it('refuses to submit a custom mode with an invalid url', async () => {
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
      await selectFirstAccountAndOpenBatchProxy(root);

      await pickOption(root, 'accounts-batch-proxy-mode', '自定义代理');
      const proxyInput = root.root.findAllByType('input')
        .find((node) => String(node.props.placeholder || '').includes('socks5'));
      await act(async () => {
        proxyInput!.props.onChange({ target: { value: 'not-a-proxy-url' } });
      });

      const applyButton = root.root.findAll(
        (node) => node.type === 'button' && collectText(node).includes('应用到所选连接'),
      )[0];
      await act(async () => {
        applyButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateAccounts).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });
});
