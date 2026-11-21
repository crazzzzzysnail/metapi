import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Models from './Models.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getModelsMarketplace: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => {
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

describe('Models marketplace text', () => {
  const originalDocument = globalThis.document;
  const originalMutationObserver = globalThis.MutationObserver;
  const originalWindow = globalThis.window;
  const originalMatchMedia = globalThis.matchMedia;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.document = {
      documentElement: {
        getAttribute: () => 'light',
      },
    } as unknown as Document;
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof MutationObserver;
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'gpt-4o',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 320,
          successRate: 98,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 1,
              site: 'Demo Site',
              username: 'tester',
              latency: 320,
              balance: 12.5,
              tokens: [{ id: 1, name: 'default', isDefault: true }],
            },
          ],
        },
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    globalThis.document = originalDocument;
    globalThis.MutationObserver = originalMutationObserver;
    globalThis.window = originalWindow;
    globalThis.matchMedia = originalMatchMedia;
  });

  it('renders readable Chinese labels and fallback descriptions for marketplace models', async () => {
    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const initialText = collectText(root!.root);
      expect(initialText).toContain('品牌');
      expect(initialText).toContain('排序方式');
      expect(initialText).toContain('模型广场');

      const cards = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('model-card')
        && typeof node.props.onClick === 'function'
      ));
      expect(cards.length).toBeGreaterThan(0);

      await act(async () => {
        cards[0]!.props.onClick();
      });
      await flushMicrotasks();

      const expandedText = collectText(root!.root);
      expect(expandedText).toContain('当前上游仅返回模型 ID，未返回描述字段。');
      expect(expandedText).toContain('基础信息');
      expect(expandedText).toContain('站点');
      expect(expandedText).toContain('余额');
    } finally {
      root?.unmount();
    }
  });

  it('shows newly recognized brands in the marketplace filter panel', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'nvidia/vila',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 210,
          successRate: 97,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 1,
              site: '公益站 A',
              username: 'tester',
              latency: 210,
              balance: 6.5,
              tokens: [{ id: 1, name: 'default', isDefault: true }],
            },
          ],
        },
        {
          name: 'deepl-zh-en',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 160,
          successRate: 99,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 2,
              site: '公益站 B',
              username: 'tester',
              latency: 160,
              balance: 8.8,
              tokens: [{ id: 2, name: 'default', isDefault: true }],
            },
          ],
        },
      ],
    });

    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root!.root);
      expect(text).toContain('NVIDIA');
      expect(text).toContain('DeepL');
      expect(text).not.toContain('其他未归类的模型');
    } finally {
      root?.unmount();
    }
  });

  it('shows newly added provider fallback brands without losing vendor brands in the filter panel', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'openrouter/openrouter-auto',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 180,
          successRate: 99,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 1,
              site: '平台站 A',
              username: 'tester',
              latency: 180,
              balance: 9.9,
              tokens: [{ id: 1, name: 'default', isDefault: true }],
            },
          ],
        },
        {
          name: 'deepinfra/meta-llama/llama-3.3-70b-instruct',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 240,
          successRate: 98,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 2,
              site: '平台站 B',
              username: 'tester',
              latency: 240,
              balance: 7.2,
              tokens: [{ id: 2, name: 'default', isDefault: true }],
            },
          ],
        },
        {
          name: 'groq/compound-beta',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 95,
          successRate: 99,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 3,
              site: '平台站 C',
              username: 'tester',
              latency: 95,
              balance: 5.1,
              tokens: [{ id: 3, name: 'default', isDefault: true }],
            },
          ],
        },
      ],
    });

    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root!.root);
      expect(text).toContain('OpenRouter');
      expect(text).toContain('Meta');
      expect(text).toContain('Groq');
      expect(text).not.toContain('其他未归类的模型');
    } finally {
      root?.unmount();
    }
  });

  it('shows user-reported recognizable brands in the marketplace filter panel', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'xiaomi/mimo-v2-pro',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 180,
          successRate: 99,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 1,
              site: '平台站 A',
              username: 'tester',
              latency: 180,
              balance: 9.9,
              tokens: [{ id: 1, name: 'default', isDefault: true }],
            },
          ],
        },
        {
          name: 'arcee-ai/trinity-mini',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 240,
          successRate: 98,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 2,
              site: '平台站 B',
              username: 'tester',
              latency: 240,
              balance: 7.2,
              tokens: [{ id: 2, name: 'default', isDefault: true }],
            },
          ],
        },
        {
          name: 'amazon/nova-premier-v1',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 95,
          successRate: 99,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 3,
              site: '平台站 C',
              username: 'tester',
              latency: 95,
              balance: 5.1,
              tokens: [{ id: 3, name: 'default', isDefault: true }],
            },
          ],
        },
        {
          name: 'LongCat-Flash-Lite',
          accountCount: 1,
          tokenCount: 1,
          avgLatency: 95,
          successRate: 99,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 4,
              site: '平台站 D',
              username: 'tester',
              latency: 95,
              balance: 5.1,
              tokens: [{ id: 4, name: 'default', isDefault: true }],
            },
          ],
        },
      ],
    });

    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const text = collectText(root!.root);
      expect(text).toContain('Xiaomi MiMo');
      expect(text).toContain('Arcee');
      expect(text).toContain('Amazon Nova');
      expect(text).toContain('LongCat');
      expect(text).not.toContain('其他未归类的模型');
    } finally {
      root?.unmount();
    }
  });

  it('keeps a visible mobile filter entry on small screens', async () => {
    const nextWindow = (originalWindow ? { ...originalWindow } : {}) as Window & typeof globalThis;
    nextWindow.innerWidth = 768;
    nextWindow.addEventListener = nextWindow.addEventListener || (() => {});
    nextWindow.removeEventListener = nextWindow.removeEventListener || (() => {});
    nextWindow.matchMedia = (() => ({
      matches: true,
      media: '(max-width: 768px)',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    globalThis.window = nextWindow;
    globalThis.matchMedia = nextWindow.matchMedia;

    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(collectText(root!.root)).toContain('筛选');
    } finally {
      root?.unmount();
    }
  });

  it('keeps the mobile filter entry visible even while the first screen is still loading', async () => {
    globalThis.window = {
      innerWidth: 768,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Window & typeof globalThis;
    apiMock.getModelsMarketplace.mockImplementation(() => new Promise(() => {}));

    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });

      expect(collectText(root!.root)).toContain('筛选');
    } finally {
      root?.unmount();
    }
  });

  it('limits expanded account and pricing detail to the selected site filter', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'gpt-4o',
          accountCount: 2,
          tokenCount: 3,
          avgLatency: 500,
          successRate: 96,
          description: 'demo model',
          tags: ['chat'],
          supportedEndpointTypes: ['openai'],
          pricingSources: [
            {
              siteId: 1,
              siteName: '站点 A',
              accountId: 1,
              username: 'user-a',
              ownerBy: null,
              enableGroups: [],
              groupPricing: {
                default: {
                  quotaType: 0,
                  inputPerMillion: 1,
                  outputPerMillion: 2,
                },
              },
            },
            {
              siteId: 2,
              siteName: '站点 B',
              accountId: 2,
              username: 'user-b',
              ownerBy: null,
              enableGroups: [],
              groupPricing: {
                default: {
                  quotaType: 0,
                  inputPerMillion: 3,
                  outputPerMillion: 4,
                },
              },
            },
          ],
          accounts: [
            {
              id: 1,
              site: '站点 A',
              username: 'user-a',
              latency: 320,
              balance: 12.5,
              tokens: [
                { id: 1, name: 'token-a-1', isDefault: true },
                { id: 2, name: 'token-a-2', isDefault: false },
              ],
            },
            {
              id: 2,
              site: '站点 B',
              username: 'user-b',
              latency: 680,
              balance: 8.4,
              tokens: [
                { id: 3, name: 'token-b-1', isDefault: true },
              ],
            },
          ],
        },
      ],
    });

    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const siteFilterItem = root!.root.find((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('filter-item')
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('站点 A')
      ));

      await act(async () => {
        siteFilterItem.props.onClick();
      });
      await flushMicrotasks();

      const cards = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('model-card')
        && typeof node.props.onClick === 'function'
      ));
      expect(cards.length).toBeGreaterThan(0);

      await act(async () => {
        cards[0]!.props.onClick();
      });
      await flushMicrotasks();

      const expandedSections = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('model-card-expand')
      ));
      expect(expandedSections.length).toBe(1);

      const expandedText = collectText(expandedSections[0]!);
      expect(expandedText).toContain('站点 A');
      expect(expandedText).toContain('user-a');
      expect(expandedText).toContain('token-a-1');
      expect(expandedText).not.toContain('站点 B');
      expect(expandedText).not.toContain('user-b');
      expect(expandedText).not.toContain('token-b-1');
    } finally {
      root?.unmount();
    }
  });

  it('re-sorts models using site-scoped counts after selecting a site filter', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'gpt-4o',
          accountCount: 4,
          tokenCount: 4,
          avgLatency: 300,
          successRate: 98,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 1,
              site: '站点 A',
              username: 'user-a-1',
              latency: 300,
              balance: 8,
              tokens: [{ id: 1, name: 'token-a-1', isDefault: true }],
            },
            {
              id: 2,
              site: '站点 B',
              username: 'user-b-1',
              latency: 200,
              balance: 8,
              tokens: [{ id: 2, name: 'token-b-1', isDefault: true }],
            },
            {
              id: 3,
              site: '站点 B',
              username: 'user-b-2',
              latency: 250,
              balance: 8,
              tokens: [{ id: 3, name: 'token-b-2', isDefault: true }],
            },
            {
              id: 4,
              site: '站点 B',
              username: 'user-b-3',
              latency: 260,
              balance: 8,
              tokens: [{ id: 4, name: 'token-b-3', isDefault: true }],
            },
          ],
        },
        {
          name: 'claude-3-5-sonnet',
          accountCount: 2,
          tokenCount: 2,
          avgLatency: 420,
          successRate: 95,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 5,
              site: '站点 A',
              username: 'user-a-2',
              latency: 410,
              balance: 9,
              tokens: [{ id: 5, name: 'token-a-2', isDefault: true }],
            },
            {
              id: 6,
              site: '站点 A',
              username: 'user-a-3',
              latency: 430,
              balance: 9,
              tokens: [{ id: 6, name: 'token-a-3', isDefault: true }],
            },
          ],
        },
      ],
    });

    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const siteFilterItem = root!.root.find((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('filter-item')
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('站点 A')
      ));

      await act(async () => {
        siteFilterItem.props.onClick();
      });
      await flushMicrotasks();

      const cards = root!.root.findAll((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.split(' ').includes('model-card')
        && typeof node.props.onClick === 'function'
      ));

      expect(cards.length).toBe(2);
      expect(collectText(cards[0]!)).toContain('claude-3-5-sonnet');
      expect(collectText(cards[1]!)).toContain('gpt-4o');
    } finally {
      root?.unmount();
    }
  });

  it('renders unknown latency instead of falling back to another site latency', async () => {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'gpt-4o',
          accountCount: 2,
          tokenCount: 2,
          avgLatency: 680,
          successRate: 93,
          description: null,
          tags: [],
          supportedEndpointTypes: [],
          pricingSources: [],
          accounts: [
            {
              id: 1,
              site: '站点 A',
              username: 'user-a',
              latency: null,
              balance: 12,
              tokens: [{ id: 1, name: 'token-a', isDefault: true }],
            },
            {
              id: 2,
              site: '站点 B',
              username: 'user-b',
              latency: 680,
              balance: 12,
              tokens: [{ id: 2, name: 'token-b', isDefault: true }],
            },
          ],
        },
      ],
    });

    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/models']}>
            <ToastProvider>
              <Models />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const siteFilterItem = root!.root.find((node) => (
        node.type === 'div'
        && typeof node.props.className === 'string'
        && node.props.className.includes('filter-item')
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('站点 A')
      ));

      await act(async () => {
        siteFilterItem.props.onClick();
      });
      await flushMicrotasks();

      const latencyBadge = root!.root.find((node) => (
        node.type === 'span'
        && node.props['data-tooltip'] === '本机测活探测上游的单次往返耗时均值'
      ));

      expect(String(latencyBadge.props.className || '')).toContain('badge-muted');
      expect(collectText(latencyBadge)).toContain('延迟');
      expect(collectText(latencyBadge)).toContain('—');
      expect(collectText(root!.root)).not.toContain('680ms');
    } finally {
      root?.unmount();
    }
  });

  /**
   * S5-1/S5-2 页面接线：展开态分组徽章内的**分组级**双窗成功率。
   *
   * 锁三件事（都是 helper 纯函数测覆盖不到的）：
   * 1. 徽章行读的是 `source.groupPerf[group]`，按计价分组逐字符取档（不是拿站级 perf 凑）；
   * 2. 表里缺键（该站该模型从未预热）→ 该分组徽章**不挂**公示行，计价文本照常；
   * 3. `groupPerf` 整体缺省（旧响应/未探测）→ 页面不炸，且不出现任何公示行。
   * 卡片与表格两处刻意同形，这里走默认的卡片分支。
   */
  async function renderExpandedWithGroupPerf(source: Record<string, unknown>) {
    apiMock.getModelsMarketplace.mockResolvedValue({
      models: [
        {
          name: 'gpt-4o',
          accountCount: 1,
          tokenCount: 0,
          avgLatency: 500,
          successRate: 96,
          description: 'demo model',
          tags: ['chat'],
          supportedEndpointTypes: ['openai'],
          pricingSources: [source],
          accounts: [],
        },
      ],
    });

    const root = create(
      <MemoryRouter initialEntries={['/models']}>
        <ToastProvider>
          <Models />
        </ToastProvider>
      </MemoryRouter>,
    );
    await flushMicrotasks();

    const cards = root.root.findAll((node) => (
      node.type === 'div'
      && typeof node.props.className === 'string'
      && node.props.className.includes('model-card')
      && typeof node.props.onClick === 'function'
    ));
    expect(cards.length).toBeGreaterThan(0);
    await act(async () => {
      cards[0]!.props.onClick();
    });
    await flushMicrotasks();

    const expanded = root.root.findAll((node) => (
      node.type === 'div'
      && typeof node.props.className === 'string'
      && node.props.className.includes('model-card-expand')
    ));
    expect(expanded.length).toBe(1);
    return {
      root,
      text: collectText(expanded[0]!),
      perfNodes: root.root.findAll((node) => node.props['data-group-perf'] !== undefined),
    };
  }

  const okCell = (value: number) => ({ value, present: true, dubious: false, emptyReason: null });

  it('挂载分组级公示行：每个计价分组取自己那一档，缺键分组不挂', async () => {
    let result!: Awaited<ReturnType<typeof renderExpandedWithGroupPerf>>;
    try {
      result = await renderExpandedWithGroupPerf({
        siteId: 1,
        siteName: '站点 A',
        accountId: 1,
        username: 'user-a',
        ownerBy: null,
        enableGroups: ['grp-codex', '组甲'],
        groupPricing: {
          'grp-codex': { quotaType: 0, inputPerMillion: 0.3, outputPerMillion: 1.5 },
          '组甲': { quotaType: 0, inputPerMillion: 0.6, outputPerMillion: 2.25 },
        },
        // grp-codex 双窗齐；组甲=null → 从未预热，该徽章不挂公示行。
        groupPerf: {
          'grp-codex': {
            state: 'value',
            groupName: 'grp-codex',
            capturedAt: 1790000000000,
            success24: okCell(99.1),
            success1h: okCell(100),
          },
        },
      });

      expect(result.perfNodes).toHaveLength(1);
      expect(result.perfNodes[0]!.props['data-group-perf']).toBe('grp-codex');
      // 点 4：分组公示不再进徽章正文，改为徽章 data-tooltip 单行 · 拼接；成功率两位小数。
      const tip = String(result.perfNodes[0]!.props['data-tooltip']);
      expect(tip).toContain('来源上游公示模型分组数据');
      expect(tip).toContain('分组 grp-codex');
      expect(tip).toContain('24h成功率 99.1%');
      expect(tip).toContain('1h成功率 100%');
      // 计价分组本身照常渲染（不能被公示行吞掉）。
      expect(result.text).toContain('组甲');
    } finally {
      result?.root?.unmount();
    }
  });

  it('groupPerf 缺省（旧响应/未探测）→ 不挂任何公示行且不报错', async () => {
    let result!: Awaited<ReturnType<typeof renderExpandedWithGroupPerf>>;
    try {
      result = await renderExpandedWithGroupPerf({
        siteId: 1,
        siteName: '站点 A',
        accountId: 1,
        username: 'user-a',
        ownerBy: null,
        enableGroups: ['default'],
        groupPricing: {
          default: { quotaType: 0, inputPerMillion: 1, outputPerMillion: 2 },
        },
      });
      expect(result.perfNodes).toHaveLength(0);
      expect(result.text).not.toContain('上游公示');
      expect(result.text).toContain('default');
    } finally {
      result?.root?.unmount();
    }
  });
});
