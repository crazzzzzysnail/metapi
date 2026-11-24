import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'react-test-renderer';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableChannelRow } from './SortableChannelRow.js';
import type { RouteChannel } from './types.js';

/**
 * 通道余额的币种分支（F3 遗留项，2026-11-13 补）。
 *
 * 此前 `RouteCard.test.tsx` 只断言了美元口径的 `余额：$12.34`，
 * 而这行代码真正的复杂处全在人民币分支上：有汇率要乘、充值价未知要标注且不乘。
 * 两种错法（用 1 当汇率、拿 7.2 兜底）在美元用例里都看不出来。
 *
 * 为什么单独开文件：`useCurrency()` 在没包 Provider 时落到 EMPTY_CONTEXT（恒 USD），
 * 全量测试里人民币分支根本执行不到。这里覆写 useCurrency 让币种与汇率可控。
 */

const { currencyState } = vi.hoisted(() => ({
  currencyState: {
    current: 'USD' as 'USD' | 'CNY',
    rate: 7.3 as number | null,
  },
}));

vi.mock('../../currencyContext.js', async () => {
  const actual = await vi.importActual<typeof import('../../currencyContext.js')>('../../currencyContext.js');
  return {
    ...actual,
    useCurrency: () => ({
      currency: currencyState.current,
      getSiteRate: () => currencyState.rate,
      unknownRateSiteCount: 0,
      unknownRateSiteIds: [],
      loaded: true,
      refresh: async () => {},
      toggleCurrency: async () => {},
      toggling: false,
    }),
  };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('../../api.js', () => ({
  api: {
    updateRouteChannelToken: vi.fn(),
    getModelCatalog: vi.fn().mockResolvedValue({ groups: [] }),
  },
}));

function collectText(node: { children?: unknown[] }): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    if (child && typeof child === 'object') return collectText(child as { children?: unknown[] });
    return '';
  }).join('');
}

function buildChannel(balance: number | null, overrides: Partial<RouteChannel> = {}): RouteChannel {
  return {
    id: 301,
    routeId: 88,
    accountId: 7,
    tokenId: null,
    sourceModel: 'gpt-4.1',
    priority: 0,
    weight: 100,
    enabled: true,
    sourceUnavailable: false,
    manualOverride: true,
    successCount: 12,
    failCount: 1,
    cooldownUntil: null,
    account: {
      username: 'cc',
      balance,
      accessToken: null,
      extraConfig: null,
      credentialMode: 'oauth',
    },
    site: { id: 99, name: 'codelab', platform: 'openai' },
    token: null,
    ...overrides,
  };
}

function renderRow(channel: RouteChannel): string {
  const root = create(
    <DndContext>
      <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
        <SortableChannelRow
          channel={channel}
          decisionCandidate={undefined}
          isExactRoute
          loadingDecision={false}
          isSavingPriority={false}
          tokenOptions={[]}
          activeTokenId={0}
          isUpdatingToken={false}
          onTokenDraftChange={vi.fn()}
          onSaveToken={vi.fn()}
          onDeleteChannel={vi.fn()}
          onToggleEnabled={vi.fn()}
          onSiteBlockModel={vi.fn()}
        />
      </SortableContext>
    </DndContext>,
  );
  return collectText(root.root);
}

describe('通道余额按站点汇率换算', () => {
  beforeEach(() => {
    currencyState.current = 'USD';
    currencyState.rate = 7.3;
  });

  it('美元口径直接显示原值', () => {
    expect(renderRow(buildChannel(12.34))).toContain('余额：$12.34');
  });

  it('人民币口径按站点汇率换算后加 ¥', () => {
    currencyState.current = 'CNY';
    // 12.34 * 7.3 = 90.082 → 两位小数
    expect(renderRow(buildChannel(12.34))).toContain('余额：¥90.08');
  });

  it('充值价未知时保留美元并标注，不拿 1 或 7.2 冒充换算', () => {
    currencyState.current = 'CNY';
    currencyState.rate = null;
    const text = renderRow(buildChannel(12.34));
    expect(text).toContain('余额：$12.34（充值价未知）');
    expect(text).not.toContain('¥');
  });

  it('余额缺失按 0 显示（该处不是余额可得性三态的入口）', () => {
    expect(renderRow(buildChannel(null))).toContain('余额：$0.00');
  });
});
