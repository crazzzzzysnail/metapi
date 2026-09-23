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

  // B5.1（勾选制改版）：勾选"批量设置站点代理"后默认即"使用系统代理"，验证 payload 形态
  // system 模式同时下发 proxyUrl=''：运行优先级为"自定义地址非空即用"，必须清空才能避免旧地址架空系统代理
  it('submits "use system proxy" via the batch settings modal and clears any custom proxyUrl', async () => {
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

      // 勾选代理开关；proxyMode 默认即 system，不再点选项
      const proxyApplyCheckbox = root.root.findAllByType('input')
        .find((node) => node.props['aria-label'] === '启用批量设置站点代理');
      await act(async () => {
        proxyApplyCheckbox!.props.onChange({ target: { checked: true } });
      });
      await flushMicrotasks();

      const applyButton = root.root.findAll((node) => node.type === 'button' && collectText(node).includes('应用到所选站点'))[0];
      await act(async () => {
        applyButton.props.onClick();
      });
      await flushMicrotasks();

      const payload = apiMock.batchUpdateSites.mock.calls.at(-1)?.[0];
      expect(payload).toEqual({
        ids: [1, 2],
        action: 'updateSettings',
        proxyUrl: '',
        useSystemProxy: true,
      });
    } finally {
      root?.unmount();
    }
  });

  // 未勾选代理开关：仅权重下发，不含任何代理字段（"保持现状"由开关承担）
  it('omits proxy fields entirely when the proxy checkbox is unchecked', async () => {
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
      await act(async () => {
        checkboxA.props.onChange({ target: { checked: true } });
      });

      const batchSettingsButton = root.root.find((node) => node.props['data-testid'] === 'sites-batch-settings');
      await act(async () => {
        batchSettingsButton.props.onClick();
      });
      await flushMicrotasks();

      const inputs = root.root.findAllByType('input');
      const weightApplyCheckbox = inputs.find((node) => node.props['aria-label'] === '启用批量设置权重');
      const weightInput = inputs.find((node) => node.props.placeholder === '站点全局权重（默认 1）');
      await act(async () => {
        weightApplyCheckbox!.props.onChange({ target: { checked: true } });
        weightInput!.props.onChange({ target: { value: '1.5' } });
      });

      const applyButton = root.root.findAll((node) => node.type === 'button' && collectText(node).includes('应用到所选站点'))[0];
      await act(async () => {
        applyButton.props.onClick();
      });
      await flushMicrotasks();

      const payload = apiMock.batchUpdateSites.mock.calls.at(-1)?.[0];
      expect(payload).toEqual({
        ids: [1],
        action: 'updateSettings',
        globalWeight: 1.5,
      });
      expect(payload).not.toHaveProperty('proxyUrl');
      expect(payload).not.toHaveProperty('useSystemProxy');
    } finally {
      root?.unmount();
    }
  });

  // B5.2（勾选制改版）：自定义代理模式 → 校验后下发 proxyUrl + useSystemProxy=false；权重同批下发
  it('submits batch weight and custom proxy settings for selected sites', async () => {
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
      const proxyApplyCheckbox = inputs.find((node) => node.props['aria-label'] === '启用批量设置站点代理');
      await act(async () => {
        weightApplyCheckbox!.props.onChange({ target: { checked: true } });
        weightInput!.props.onChange({ target: { value: '2.5' } });
        proxyApplyCheckbox!.props.onChange({ target: { checked: true } });
      });
      await flushMicrotasks();

      const modeSelect = root.root.find((node) => node.props['data-testid'] === 'sites-batch-proxy-mode');
      const customOption = modeSelect.findAll((node) => (
        node.type === 'button'
        && typeof node.props.className === 'string'
        && node.props.className.includes('modern-select-option')
        && collectText(node).includes('自定义代理')
      ))[0];
      await act(async () => {
        customOption.props.onClick();
      });
      await flushMicrotasks();

      const proxyInput = root.root.findAllByType('input').find((node) => String(node.props.placeholder || '').includes('socks5'));
      await act(async () => {
        proxyInput!.props.onChange({ target: { value: 'http://127.0.0.1:7890' } });
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
        useSystemProxy: false,
      });
    } finally {
      root?.unmount();
    }
  });

  // B5.2：非法自定义地址被前端校验拦截，不发出请求
  it('rejects an invalid custom proxy address before submitting', async () => {
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
      await act(async () => {
        checkboxA.props.onChange({ target: { checked: true } });
      });

      const batchSettingsButton = root.root.find((node) => node.props['data-testid'] === 'sites-batch-settings');
      await act(async () => {
        batchSettingsButton.props.onClick();
      });
      await flushMicrotasks();

      const proxyApplyCheckbox = root.root.findAllByType('input')
        .find((node) => node.props['aria-label'] === '启用批量设置站点代理');
      await act(async () => {
        proxyApplyCheckbox!.props.onChange({ target: { checked: true } });
      });
      await flushMicrotasks();

      const modeSelect = root.root.find((node) => node.props['data-testid'] === 'sites-batch-proxy-mode');
      const customOption = modeSelect.findAll((node) => (
        node.type === 'button'
        && typeof node.props.className === 'string'
        && node.props.className.includes('modern-select-option')
        && collectText(node).includes('自定义代理')
      ))[0];
      await act(async () => {
        customOption.props.onClick();
      });
      await flushMicrotasks();

      const proxyInput = root.root.findAllByType('input').find((node) => String(node.props.placeholder || '').includes('socks5'));
      await act(async () => {
        proxyInput!.props.onChange({ target: { value: 'not-a-proxy-url' } });
      });

      const applyButton = root.root.findAll((node) => node.type === 'button' && collectText(node).includes('应用到所选站点'))[0];
      await act(async () => {
        applyButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.batchUpdateSites).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });
});
