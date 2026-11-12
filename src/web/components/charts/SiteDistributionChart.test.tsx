import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import SiteDistributionChart from './SiteDistributionChart.js';

vi.mock('@visactor/react-vchart', () => ({
  VChart: () => null,
}));

describe('SiteDistributionChart', () => {
  const originalDocument = globalThis.document;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const originalMutationObserver = globalThis.MutationObserver;

  beforeEach(() => {
    globalThis.document = {
      documentElement: {
        getAttribute: vi.fn(),
      },
    } as unknown as Document;
    Reflect.deleteProperty(globalThis as typeof globalThis & Record<string, unknown>, 'getComputedStyle');
    Reflect.deleteProperty(globalThis as typeof globalThis & Record<string, unknown>, 'MutationObserver');
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalGetComputedStyle;
    globalThis.MutationObserver = originalMutationObserver;
  });

  it('renders with fallback label color when browser theme APIs are unavailable', async () => {
    let renderer!: WebTestRenderer;

    await expect(act(async () => {
      renderer = create(
        <SiteDistributionChart
          data={[
            {
              siteName: 'Demo Site',
              platform: 'demo',
              totalBalance: 12.34,
              totalSpend: 1.23,
              accountCount: 2,
            },
          ]}
        />,
      );
    })).resolves.toBeUndefined();

    renderer.unmount();
  });

  /**
   * F3：分布图金额必须按各站汇率换算，且不再有硬编码 $。
   *
   * ⚠️ 这条用例刻意把 currency mock 成 CNY —— 如果只测 USD，
   * 「硬编码 $」和「正确换算」两种实现都会通过，等于没测。
   * 这是本会话反复踩过的坑（测试全绿但覆盖不到分支），这里明确避开。
   *
   * 锁两件事：
   *   ① 有汇率的站按该站汇率换算出 ¥ 值；
   *   ② 汇率未知的站**保留美元并标注**，不乘 1、不贴 ¥ 冒充人民币。
   */
  it('converts each site value by that site rate and flags unknown rates', async () => {
    const captured: any[] = [];
    vi.doMock('../../currencyContext.js', () => ({
      useCurrency: () => ({
        currency: 'CNY',
        // 站点 1 有汇率 7.3；站点 2 未维护（返回 null）
        getSiteRate: (siteId: number | null | undefined) => (Number(siteId) === 1 ? 7.3 : null),
        loaded: true,
        unknownRateSiteCount: 1,
        unknownRateSiteIds: [2],
        refresh: async () => {},
        toggleCurrency: async () => {},
        toggling: false,
      }),
    }));
    vi.doMock('@visactor/react-vchart', () => ({
      VChart: (props: any) => { captured.push(props?.spec); return null; },
    }));

    // 清掉模块缓存，让上面的 doMock 生效
    vi.resetModules();
    const { default: Chart } = await import('./SiteDistributionChart.js');

    await act(async () => {
      create(
        <Chart
          data={[
            { siteId: 1, siteName: 'RateKnown', platform: 'new-api', totalBalance: 7.5, totalSpend: 0, accountCount: 1, cnyPerUsd: 7.3 },
            { siteId: 2, siteName: 'RateUnknown', platform: 'new-api', totalBalance: 9, totalSpend: 0, accountCount: 1, cnyPerUsd: null },
          ]}
        />,
      );
    });

    const tooltipValue = captured[captured.length - 1]?.tooltip?.mark?.content?.[0]?.value;
    expect(typeof tooltipValue).toBe('function');

    const known = tooltipValue({ source: { siteId: 1, cnyPerUsd: 7.3 }, value: 7.5 });
    const unknown = tooltipValue({ source: { siteId: 2, cnyPerUsd: null }, value: 9 });

    // ① 7.5 × 7.3 = 54.75，必须是 ¥ 且数值正确
    expect(known).toBe('¥54.75');
    // ② 汇率未知：仍是美元数额，但明确标注；绝不能变成 ¥9 或 ¥65.7
    expect(unknown).toContain('$9.00');
    expect(unknown).toContain('汇率未知');
    expect(unknown).not.toContain('¥');
    // 不应残留任何 toFixed(2) 之外的硬编码美元形态
    expect(known).not.toMatch(/^\$\d+\.\d{4,}/);
  });
});
