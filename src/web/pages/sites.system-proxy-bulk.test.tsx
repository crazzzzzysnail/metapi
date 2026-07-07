import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Sites from './Sites.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    batchUpdateSites: vi.fn(),
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

describe('Sites system proxy bulk actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'Site A',
        url: 'https://a.example.com',
        platform: 'new-api',
        status: 'active',
        useSystemProxy: false,
      },
      {
        id: 2,
        name: 'Site B',
        url: 'https://b.example.com',
        platform: 'new-api',
        status: 'active',
        useSystemProxy: false,
      },
    ]);
    apiMock.batchUpdateSites.mockResolvedValue({
      success: true,
      successIds: [1, 2],
      failedItems: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends selected site ids to enable system proxy', async () => {
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

      const checkboxA = root.root.find((node) => node.props['data-testid'] === 'site-select-1');
      const checkboxB = root.root.find((node) => node.props['data-testid'] === 'site-select-2');

      await act(async () => {
        checkboxA.props.onChange({ target: { checked: true } });
        checkboxB.props.onChange({ target: { checked: true } });
      });

      const batchButton = root.root.find((node) => node.props['data-testid'] === 'sites-batch-enable-system-proxy');
      await act(async () => {
        batchButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateSites).toHaveBeenCalledWith({
        ids: [1, 2],
        action: 'enableSystemProxy',
      });
    } finally {
      root?.unmount();
    }
  });

  it('selects a site when clicking the row instead of only the checkbox', async () => {
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

      const row = root.root.find((node) => node.props['data-testid'] === 'site-row-1');
      await act(async () => {
        row.props.onClick({ target: { closest: () => null } });
      });
      await flushMicrotasks();

      const checkbox = root.root.find((node) => node.props['data-testid'] === 'site-select-1');
      expect(checkbox.props.checked).toBe(true);
    } finally {
      root?.unmount();
    }
  });

  it('submits batch weight and site proxy settings for selected sites', async () => {
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

      const checkboxA = root.root.find((node) => node.props['data-testid'] === 'site-select-1');
      const checkboxB = root.root.find((node) => node.props['data-testid'] === 'site-select-2');
      await act(async () => {
        checkboxA.props.onChange({ target: { checked: true } });
        checkboxB.props.onChange({ target: { checked: true } });
      });

      const batchSettingsButton = root.root.find((node) => node.props['data-testid'] === 'sites-batch-settings');
      await act(async () => {
        batchSettingsButton.props.onClick();
      });
      await flushMicrotasks();

      const inputs = root.root.findAllByType('input');
      const weightApplyCheckbox = inputs.find((node) => node.props['aria-label'] === '启用批量设置权重');
      const weightInput = inputs.find((node) => node.props.placeholder === '站点全局权重（默认 1）');
      const proxyCheckbox = inputs.find((node) => node.props['aria-label'] === '启用批量设置站点代理');
      const proxyInput = inputs.find((node) => node.props.placeholder === '站点代理（留空并勾选表示清空）');
      await act(async () => {
        weightApplyCheckbox!.props.onChange({ target: { checked: true } });
        weightInput!.props.onChange({ target: { value: '2.5' } });
        proxyCheckbox!.props.onChange({ target: { checked: true } });
        proxyInput!.props.onChange({ target: { value: 'http://127.0.0.1:7890' } });
      });

      const systemProxyLabel = root.root.findAll((node) => node.type === 'label' && collectText(node).includes('使用系统代理'))[0];
      const systemProxyCheckbox = systemProxyLabel.findByType('input');
      await act(async () => {
        systemProxyCheckbox!.props.onChange({ target: { checked: true } });
      });

      const applyButton = root.root.findAll((node) => node.type === 'button' && collectText(node).includes('应用到所选站点'))[0];
      await act(async () => {
        applyButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateSites).toHaveBeenCalledWith({
        ids: [1, 2],
        action: 'updateSettings',
        globalWeight: 2.5,
        proxyUrl: 'http://127.0.0.1:7890',
        useSystemProxy: true,
      });
    } finally {
      root?.unmount();
    }
  });
});
