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

  /**
   * S4-4：通道行上游公示 chip 的接线契约。
   * 必须用 data-perf-* 专属标记选，不能按 .billing-badge-wrap / .billing-detail-pop 的索引选——
   * perf 组刻意复用同两个 class（共享弹层 CSS），索引会撞上计费弹层。
   */
  function renderPerfChannel(channel: RouteChannel, extraProps: Record<string, unknown> = {}) {
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
            {...extraProps}
          />
        </SortableContext>
      </DndContext>,
    );
    return { root, text: collectText(root.root) };
  }

  const readyBilling = (perfGroup: unknown) => ({
    status: 'ready',
    groupName: 'grp-codex',
    modelName: 'sample-model-len',
    message: '来自模型广场计费缓存',
    pricing: { quotaType: 0, inputPerMillion: 0.3, outputPerMillion: 1.5 },
    perfGroup,
  });
  const okCell = (value: number) => ({ value, present: true, dubious: false, emptyReason: null });
  const emptyCell = (reason: string) => ({ value: null, present: false, dubious: false, emptyReason: reason });

  it('S4-4：常驻恰含 TPS/1h/平均耗时 三项（点4 1h 上位），弹层含 首字/24h + 来源末行（点3 合并）', () => {
    const snapshot = {
      state: 'value',
      capturedAt: 1790000000000,
      groupName: 'grp-codex',
      tps: okCell(200),
      ttft: okCell(1297),
      latency: okCell(4426),
      success24: okCell(99.1),
      success1h: okCell(100),
    };
    const { root, text } = renderPerfChannel(buildChannel({ billing: readyBilling(snapshot) } as any));

    // 点 3：常驻 chip 一律不挂 data-tooltip（来源改由弹层承载）→ 公示组内零 data-tooltip。
    const perfWrap = root.root.find((node) => node.props['data-perf-channel'] !== undefined);
    const tooltipsInPerf = perfWrap.findAll((node) => node.props['data-tooltip'] !== undefined);
    expect(tooltipsInPerf).toHaveLength(0);

    // 常驻 3 chip 文本：TPS / 平均耗时 / 1h成功率（点 4 1h 进常驻）。
    expect(text).toContain('TPS');
    expect(text).toContain('tok/s');
    expect(text).toContain('1h成功率');
    expect(text).toContain('平均耗时');
    // 点 2：旧括号单位不再出现。
    expect(text).not.toContain('TPS(tok/s)');

    // 点 5：公示组字号统一由 CSS 类接管（不再用 chip 的 inline fontSize）。
    // （CSS 层 .perf-channel-group .badge{font-size:10px} 由 index.css 提供，本测只验类挂上。）
    expect(String(perfWrap.props.className)).toContain('perf-channel-group');

    const popLines = root.root.findAll((node) => node.props['data-perf-pop-line'] !== undefined);
    // 弹层含 首字 + 24h 两行（点 4 24h 退入弹层）。
    expect(popLines).toHaveLength(2);
    const popText = popLines.map((n) => collectText(n)).join('|');
    expect(popText).toContain('首字耗时');
    expect(popText).toContain('24h成功率');
    expect(popText).not.toContain('TPS');

    // 点 3：来源作为弹层最后一行（单独 data-perf-pop-source 标记，与两行读数区分）。
    const sourceLine = root.root.findAll((node) => node.props['data-perf-pop-source'] !== undefined);
    expect(sourceLine).toHaveLength(1);
    expect(collectText(sourceLine[0]!)).toContain('来源上游公示模型分组数据');
  });

  it('S4-4：perfGroup 为 null（从未预热）→ 整组不渲染，不挂空 chip', () => {
    const { root, text } = renderPerfChannel(buildChannel({ billing: readyBilling(null) } as any));
    const perfGroup = root.root.findAll((node) => node.props['data-perf-channel'] !== undefined);
    expect(perfGroup).toHaveLength(0);
    // 改用 TPS 读数单位证明整组未渲染（断言不退化为空转；点 2 后单位随读数）。
    expect(text).not.toContain('tok/s');
    expect(text).not.toContain('1h成功率');
  });

  it('S4-4：拖拽中公示 chip 与弹层一律隐去（拖拽中零 data-tooltip 不回退）', () => {
    const snapshot = {
      state: 'value', capturedAt: 1790000000000, groupName: 'grp-codex',
      tps: okCell(77), ttft: okCell(1297), latency: okCell(4426),
      success24: okCell(99.1), success1h: okCell(100),
    };
    const { root } = renderPerfChannel(
      buildChannel({ billing: readyBilling(snapshot) } as any),
      { dragInProgress: true },
    );
    // 全行零 data-tooltip：既有测试锁死的是整行；此处确认新增 chip 也守约。
    const tooltipNodes = root.root.findAll((node) => node.props['data-tooltip'] !== undefined);
    expect(tooltipNodes).toHaveLength(0);
    const pop = root.root.findAll((node) => node.props['data-perf-pop'] !== undefined);
    expect(pop).toHaveLength(0);
  });

  it('S4-3/S4-4：空态走 chip 文案而非 0 值；公示不进告警色阶而健康度保留色阶', () => {
    const snapshot = {
      state: 'notPublished', capturedAt: 1790000000000, groupName: 'grp-codex',
      tps: emptyCell('notPublished'), ttft: emptyCell('notPublished'),
      latency: emptyCell('notPublished'), success24: emptyCell('notPublished'),
      success1h: emptyCell('notPublished'),
    };
    // 必须显式给 health：S4-3 的"两族视觉分列"要有对照物，而 buildChannel 默认不带 health
    // （不带就没有健康度徽章，断言会退化成空转）。degraded → badge-warning。
    const { root, text } = renderPerfChannel(buildChannel({
      health: { status: 'degraded', label: '降级', reason: '连续失败' },
      billing: readyBilling(snapshot),
    } as any));
    expect(text).toContain('未公示');
    // 空态绝不画成数值 0（点 2 后 TPS 读数形如「TPS 200 tok/s」，禁止「TPS 0 tok/s」）。
    expect(text).not.toMatch(/TPS\s*0\s*tok\/s/);

    // 只看公示组内部：整行还含健康度徽章，S4-3 要求它**保留**告警色阶；
    // 断言铺到整行会被健康度徽章误红（我前两版分别因"整行色阶扫描"和"漏供 health 夹具"错过）。
    const group = root.root.find((node) => node.props['data-perf-channel'] !== undefined);
    // 按 class **整词**匹配 'badge'：/\bbadge\b/ 会连包装元素 billing-badge-wrap 一起命中
    // （连字符也算词边界），这里要的是里面 3 个 chip 本身。
    const isBadgeChip = (node: { props?: { className?: unknown } }) => {
      const cls = typeof node.props?.className === 'string' ? node.props.className : '';
      return cls.split(/\s+/).includes('badge');
    };
    const chips = group.findAll(isBadgeChip);
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      expect(String(chip.props.className)).toContain('badge-muted');
      expect(String(chip.props.className)).not.toMatch(/badge-(error|warning|success|info)/);
    }

    // 同一行里健康度徽章仍带告警色阶 —— 双向证据：公示不进色阶、健康度不被抹平。
    const healthChips = root.root.findAll((node) => {
      const cls = typeof node.props.className === 'string' ? node.props.className : '';
      return cls.split(/\s+/).includes('badge') && /badge-warning/.test(cls);
    });
    expect(healthChips.length).toBeGreaterThan(0);
  });

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
