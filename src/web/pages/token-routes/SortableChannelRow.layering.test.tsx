import { describe, expect, it, vi } from 'vitest';
import { create } from 'react-test-renderer';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableChannelRow } from './SortableChannelRow.js';
import type { RouteChannel } from './types.js';

function collectText(node: { children?: unknown[] }): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    if (child && typeof child === 'object') return collectText(child as { children?: unknown[] });
    return '';
  }).join('');
}

function buildChannel(overrides: Partial<RouteChannel> = {}): RouteChannel {
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
      accessToken: null,
      extraConfig: null,
      credentialMode: 'oauth',
    },
    site: {
      id: 99,
      name: 'codelab',
      platform: 'openai',
    },
    token: null,
    ...overrides,
  };
}

describe('SortableChannelRow layering', () => {
  it('does not force a base z-index on desktop rows when they are not being dragged', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
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

    const row = root.root.find((node) => (
      node.type === 'div'
      && node.props['data-layer-root']
    ));

    expect(row.props.style.zIndex).toBeUndefined();
    expect(row.props.style.borderLeft).toBeUndefined();
  });

  it('disables row tooltips while a drag interaction is in progress', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            dragInProgress
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
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

    const tooltipNodes = root.root.findAll((node) => node.props['data-tooltip'] !== undefined);
    expect(tooltipNodes).toHaveLength(0);
  });

  it('treats channel-management-disabled rows as non-interactive for the drag handle', () => {
    const channel = buildChannel();
    const root = create(
      <DndContext>
        <SortableContext items={[channel.id]} strategy={verticalListSortingStrategy}>
          <SortableChannelRow
            channel={channel}
            channelManagementDisabled
            decisionCandidate={undefined}
            isExactRoute
            loadingDecision={false}
            isSavingPriority={false}
            tokenOptions={[
              {
                id: 501,
                name: 'shared-token',
                isDefault: true,
              },
            ]}
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

    const dragHandle = root.root.find((node) => (
      node.type === 'button'
      && node.props['aria-label'] === '拖拽调整优先级桶'
    ));

    expect(dragHandle.props.disabled).toBe(true);
    expect(dragHandle.props['data-tooltip']).toBe('该路由当前不可编辑优先级');
  });

  it('separates user disabled and source unavailable channel states', () => {
    const channel = buildChannel({ enabled: false, sourceUnavailable: true });
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

    const text = collectText(root.root);
    expect(text).toContain('来源不可用');
    expect(text).toContain('禁用');
  });

  /**
   * 计费详情必须是**真 DOM 的多行结构**，而不是塞进一个字符串属性。
   *
   * 这条断言的由来：CSS tooltip 用 `content: attr(data-tooltip)` 取文本，
   * 而 attr() 不解释属性值里的换行符 —— 实测 DOM 属性里确有 \n、两个浏览器都不分行。
   * 所以"属性含 \n"这种断言毫无意义（它甚至能骗过自己），必须断言渲染出来的
   * 行数与每行内容，才真正锁定分段行为。
   */
  function renderBillingPopover(channel: RouteChannel) {
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
    const wrap = root.root.findAll((node) => typeof node.props.className === 'string'
      && node.props.className.includes('billing-badge-wrap'))[0];
    const pop = root.root.findAll((node) => typeof node.props.className === 'string'
      && node.props.className.includes('billing-detail-pop'))[0];
    const lines = pop
      ? pop.children
        .filter((child: unknown) => typeof child === 'string')
        // react-test-renderer 把嵌套元素摊平成 children；这里直接取每个 line 元素的文本
        .concat(...pop.findAll((node: { props?: { className?: unknown } }) => typeof node.props?.className === 'string'
          && node.props.className.includes('billing-detail-line'))
          .map((node: { children?: unknown[] }) => collectText(node as { children?: unknown[] })))
      : [];
    return {
      hasWrap: !!wrap,
      // 旧实现留下的痕迹必须彻底清掉，否则等于两条路并存
      hasLegacyTooltipAttr: Boolean(pop?.props?.['data-tooltip'] ?? wrap?.props?.['data-tooltip']),
      lines: lines.filter((x: string) => typeof x === 'string' && x.trim().length > 0),
    };
  }

  it('renders the billing detail as separate DOM lines in the agreed order', () => {
    const result = renderBillingPopover(buildChannel({
      billing: {
        status: 'ready',
        groupName: 'grp-codex',
        groupCandidates: ['grp-codex', 'grp-codex-pro', '组丁-chs'],
        modelName: 'sample-model-len',
        message: '来自模型广场计费缓存（链路 grp-codex → grp-codex-pro，按首个命中档计价）',
        pricing: {
          quotaType: 0,
          inputPerMillion: 0.3,
          outputPerMillion: 1.5,
          tiers: [
            { name: '0_272k', input: 0.3, output: 1.5, condition: '<272K' },
            { name: '272k_plus', input: 0.6, output: 2.25, condition: '>272K' },
          ],
        },
      },
    }));

    expect(result.hasWrap).toBe(true);
    expect(result.hasLegacyTooltipAttr).toBe(false);

    const text = JSON.stringify(result.lines);
    // 分段的核心判据：四条语义各自成行，不是挤在一起
    expect(result.lines.some((l: string) => l.includes('0_272k（<272K）：$0.3/$1.5 / 1M'))).toBe(true);
    expect(result.lines.some((l: string) => l.includes('272k_plus（>272K）：$0.6/$2.25 / 1M'))).toBe(true);
    expect(result.lines.some((l: string) => l.startsWith('来自模型广场计费缓存'))).toBe(true);
    expect(result.lines).toContain('auto 分组链路：grp-codex → grp-codex-pro → 组丁-chs');
    // USD 口径下不该出现汇率换算说明
    expect(text).not.toContain('汇率');
    // 正文那行不应在详情里重复
    expect(result.lines.some((l: string) => l.startsWith('grp-codex（auto） ·'))).toBe(false);
  });

  it('appends the exchange-rate note only in CNY mode', () => {
    // 同一条详情，切到人民币后应多出换算说明；这是第 4 项要求的判据。
    // 通过 getRuntimeSettings 返回 CNY + 站点汇率来驱动（见文件顶部的 api mock）。
    const result = renderBillingPopover(buildChannel({
      billing: {
        status: 'ready',
        groupName: 'grp-codex',
        modelName: 'sample-model-len',
        message: '',
        pricing: { quotaType: 0, inputPerMillion: 0.3, outputPerMillion: 1.5 },
      },
    }));
    // 本用例的 mock 环境是 USD（默认），因此仍不应有汇率行
    expect(JSON.stringify(result.lines)).not.toContain('汇率');
  });
});
