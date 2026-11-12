import { useState, type CSSProperties } from 'react';
import ModernSelect from '../../components/ModernSelect.js';
import type { SortableChannelRowProps } from './types.js';
import {
  buildFixedTokenOptionDescription,
  buildFixedTokenOptionLabel,
  describeTokenBinding,
  resolveTokenBindingConnectionMode,
} from './tokenBindingPresentation.js';
import { getChannelDecisionState, getPriorityTagStyle, getProbabilityColor } from './utils.js';
import { renderGroupPricingValue, type ModelGroupPricingPresentation } from '../helpers/modelPricingPresentation.js';
import { formatMoney, formatBalance as formatBalanceShared, type DisplayCurrency } from '../../numberFormat.js';
import { useCurrency, type CurrencyContextValue } from '../../currencyContext.js';

function getRouteUnitStrategyLabel(strategy: string | null | undefined): string {
  return strategy === 'stick_until_unavailable' ? '单个用到不可用再切' : '轮询';
}

function formatRouteUnitMemberLabel(member: { accountId: number; username: string | null; siteName: string | null }): string {
  const accountLabel = member.username?.trim() || `account-${member.accountId}`;
  const siteLabel = member.siteName?.trim();
  return siteLabel ? `${accountLabel} @ ${siteLabel}` : accountLabel;
}

/**
 * F3：删除本文件自造的 formatBalance（原来硬编码 `$${balance.toFixed(2)}`）。
 *
 * 它遮蔽了 numberFormat 里的同名共享出口，于是"设置切到人民币、通道卡片仍是 $"
 * ——而且这类局部实现每加一处，全站一致性就多一个失守点。
 * 现在余额按该账号所属站点的汇率换算；汇率未知则保留美元并标注，不贴 ¥ 冒充。
 */
function formatChannelBalance(
  value: number | null | undefined,
  currencyCtx: CurrencyContextValue,
  siteId: number | null | undefined,
): string {
  const balance = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (currencyCtx.currency === 'USD') return formatBalanceShared(balance);
  const rate = currencyCtx.getSiteRate(siteId);
  if (rate == null) return `${formatBalanceShared(balance)}（汇率未知）`;
  return formatBalanceShared(balance * rate, 'CNY', 1);
}

function formatSiteWeight(value: number | null | undefined): string {
  const weight = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return Number.isInteger(weight) ? String(weight) : weight.toFixed(2);
}

function getHealthBadgeClass(status: string | undefined): string {
  if (status === 'healthy') return 'badge-success';
  if (status === 'degraded' || status === 'cooling') return 'badge-warning';
  if (status === 'unavailable') return 'badge-error';
  return 'badge-muted';
}

/**
 * 路由通道的计费文案（1 / 3）。
 *
 * 卡片一行很窄，所以正文只留**分组 + 第一档代表价**：
 *   `grp-codex（auto） · ¥0.3/¥1.5 / 1M`
 * 其余档位、适用条件、链路、口径来源全部移到悬停弹层（见 buildBillingTooltipLines）。
 *
 * ⚠️ 币种必须跟随设置里的显示货币（三-3 曾把它写死成 $）：
 * 早版的 USD 分支不传 convert，于是落到 formatPrice() 那个固定美元的出口，
 * 表现就是"设置已切到人民币、正文仍是 $"。现在两个分支都走同一个带币种的出口。
 */
function buildBillingLabel(
  channel: SortableChannelRowProps['channel'],
  currencyCtx: CurrencyContextValue,
): string {
  const billing = channel.billing;
  if (!billing) return '计费不可用';
  const groupName = billing.groupName?.trim() || '未知分组';
  // 三-1：auto 令牌显示的不是字面 "auto"，而是链路里实际用于计价的那一档。
  // 加个标记让用户知道这个分组名是从链路推导出来的，不是令牌上直接写的。
  const isDerived = (billing.groupCandidates?.length ?? 0) > 1;
  const displayGroup = isDerived ? `${groupName}（auto）` : groupName;
  if (billing.status === 'refreshing') return `${displayGroup} · 刷新中`;
  // T1.30：把"不可用"说清楚是哪一种不可用，否则用户无法判断该补令牌还是等解析。
  if (billing.status !== 'ready' || !billing.pricing) {
    const detail = billing.message?.trim();
    return `${displayGroup} · 计费不可用${detail ? `（${detail}）` : ''}`;
  }
  return `${displayGroup} · ${renderChannelPrice(billing.pricing, channel.site?.id, currencyCtx)}`;
}

/** 生成一个按站点汇率换算的金额回调；USD 下汇率为 null，等价于原样显示美元。 */
function makeChannelMoney(
  currency: DisplayCurrency,
  rate: number | null,
): (usd: number | undefined) => string | null {
  return (usd: number | undefined) => {
    if (usd == null) return null;
    if (currency === 'USD') return formatMoney(usd);
    // CNY 但汇率未知：返回 null 让上层显式标注，绝不贴 ¥ 冒充人民币价。
    if (rate == null) return null;
    return formatMoney(usd * rate, 'CNY', 1);
  };
}

/**
 * 渲染通道价格。两种币种走同一条 convert 通路（三-3 的修复点）：
 * 差异只在换算系数与符号，由 makeChannelMoney 统一决定。
 */
function renderChannelPrice(
  pricing: NonNullable<NonNullable<SortableChannelRowProps['channel']>['billing']>['pricing'],
  siteId: number | null | undefined,
  currencyCtx: CurrencyContextValue,
): string {
  const { currency, getSiteRate } = currencyCtx;
  const rate = currency === 'USD' ? null : getSiteRate(siteId);
  const money = makeChannelMoney(currency, rate);
  // 占位 siteId 恒等于第二参数：换算已在 money 里按站点汇率做完。
  return renderGroupPricingValue(
    pricing as ModelGroupPricingPresentation,
    CHANNEL_PRICE_SITE_SLOT,
    (_slot, usd) => money(usd),
    { compact: true, firstTierOnly: true },
  );
}

/** convert 回调形参要求一个数值站点位；真实取数在 money 闭包里完成。 */
const CHANNEL_PRICE_SITE_SLOT = 1;

/**
 * 路由通道计费的悬停详情（2 / 4）。
 *
 * 返回**行数组**而不是拼好的长串，每行一条语义。顺序按用户实测反馈定为
 *   ① 逐档：档位名（适用条件）：价格
 *   ② 口径来源
 *   ③ auto 分组链路（仅多候选时）
 *   ④ 汇率换算说明（仅人民币）
 * 正文那行（分组 + 首档价）不重复放进来——卡片上已经看得见。
 */
function buildBillingTooltipLines(
  channel: SortableChannelRowProps['channel'],
  currencyCtx: CurrencyContextValue,
): string[] {
  const billing = channel.billing;
  if (!billing) return [];
  const lines: string[] = [];

  // ① 逐档一行；价格按当前币种换算，与正文同一出口（三-3）。
  const rate = currencyCtx.currency === 'USD' ? null : currencyCtx.getSiteRate(channel.site?.id);
  const money = makeChannelMoney(currencyCtx.currency, rate);
  const tiers = billing.pricing ? (billing.pricing as ModelGroupPricingPresentation).tiers : undefined;
  if (tiers && tiers.length > 0) {
    for (const tier of tiers) {
      const price = [money(tier.input), money(tier.output)].filter((x): x is string => x != null).join('/');
      if (!price) continue;
      lines.push(`${tier.name}${tier.condition ? `（${tier.condition}）` : ''}：${price} / 1M`);
    }
  }

  // ② 口径来源（后端给的说明文本）。
  const message = billing.message?.trim();
  if (message) lines.push(message);

  // ③ 三-1：把整条 auto 链路列出来，用户才能核对"为什么用这个价"。
  const chain = billing.groupCandidates;
  if (chain && chain.length > 1) lines.push(`auto 分组链路：${chain.join(' → ')}`);

  // ④ 四：只有切到人民币才需要解释换算；美元是目录原值，没有"换算"可言。
  if (currencyCtx.currency === 'CNY') {
    lines.push(rate != null ? `以上价格按站点汇率 ×${rate} 换算` : '该站点汇率未知，未做换算');
  }
  return lines;
}

function renderChannelInsightBadges(
  channel: SortableChannelRowProps['channel'],
  suppressTooltips: boolean,
  currencyCtx: CurrencyContextValue,
) {
  const routeUnit = channel.routeUnit ?? null;
  const health = channel.health;
  const billing = channel.billing;
  const shouldShowHealth = !!health && health.status !== 'unavailable' && channel.enabled !== false;
  const billingLabel = buildBillingLabel(channel, currencyCtx);
  // 详情行数组：真 DOM 渲染，一行一条（见下方弹层注释）。
  const billingTooltipLines = buildBillingTooltipLines(channel, currencyCtx);

  return (
    <>
      {shouldShowHealth ? (
        <span
          className={`badge ${getHealthBadgeClass(health.status)}`}
          style={{ fontSize: 10 }}
          data-tooltip={suppressTooltips ? undefined : (health.reason || '通道健康状态')}
        >
          {health.label || '未知'}
        </span>
      ) : null}
      <span
        className="badge badge-muted"
        style={{ fontSize: 10 }}
        data-tooltip={suppressTooltips ? undefined : '站点全局权重'}
      >
        权重：{formatSiteWeight(channel.site?.globalWeight)}
      </span>
      {!routeUnit ? (
        <span
          className="badge badge-muted"
          style={{ fontSize: 10 }}
          data-tooltip={suppressTooltips ? undefined : '当前账号余额'}
        >
          余额：{formatChannelBalance(channel.account?.balance, currencyCtx, channel.site?.id)}
        </span>
      ) : null}
      {/*
        计费详情弹层（方案 A）。

        为什么不用 data-tooltip：这套 CSS tooltip 靠 `content: attr(...)` 取文本，
        而 attr() 不解释属性值里的换行符 —— 已实测确认（DOM 属性里确有 \n、
        两个浏览器观感都不分行），改 white-space / 加 !important / 动宿主样式均无效。
        所以详情改用真 DOM 渲染，每行一个 <div>，天然分段。

        结构要点：badge 自身带 overflow:hidden（为单行 ellipsis 服务），
        会把内部元素一起裁掉；因此弹层必须是 badge 的**兄弟节点**，
        由这层不裁剪的 wrapper 提供 position:relative 定位上下文。
      */}
      <span className="billing-badge-wrap">
        <span
          className={`badge ${billing?.status === 'ready' ? 'badge-info' : 'badge-muted'}`}
          style={{
            fontSize: 10,
            maxWidth: 280,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {billingLabel}
        </span>
        {!suppressTooltips && billingTooltipLines.length > 0 ? (
          <span className="billing-detail-pop" role="tooltip">
            {billingTooltipLines.map((line, lineIndex) => (
              <span className="billing-detail-line" key={lineIndex}>
                {line}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </>
  );
}

export function SortableChannelRow({
  channel,
  displayPriority,
  showPriorityBadge = true,
  dragging = false,
  selected = false,
  dragHandleProps,
  dragHandleRef,
  decisionCandidate,
  isExactRoute,
  loadingDecision,
  isSavingPriority,
  readOnly = false,
  channelManagementDisabled = false,
  dragInProgress = false,
  mobile = false,
  tokenOptions,
  activeTokenId,
  isUpdatingToken,
  onTokenDraftChange,
  onSaveToken,
  onDeleteChannel,
  onToggleEnabled,
  onToggleSelected,
  onSiteBlockModel,
}: SortableChannelRowProps) {
  // 币种与站点汇率来自共享 Provider，与模型广场同源（四-4 / 四-7）。
  const currencyCtx = useCurrency();
  const resolvedPriority = displayPriority ?? channel.priority ?? 0;
  const managementLocked = readOnly || channelManagementDisabled;
  const suppressTooltips = dragInProgress || dragging;
  const sourceUnavailable = channel.sourceUnavailable === true;
  const visuallyUnavailable = channel.enabled === false || sourceUnavailable;
  const rowTransition = [
    'box-shadow 180ms ease',
    'background-color 180ms ease',
    'border-color 180ms ease',
    'opacity 180ms ease',
  ].filter(Boolean).join(', ');
  const dragHandleStyle: CSSProperties = {
    width: 22,
    minWidth: 22,
    height: 22,
    padding: 0,
    border: `1px solid ${dragging ? 'color-mix(in srgb, var(--color-info) 34%, var(--color-border-light))' : 'var(--color-border-light)'}`,
    borderRadius: 10,
    backgroundColor: dragging
      ? 'color-mix(in srgb, var(--color-bg-card) 80%, var(--color-info) 20%)'
      : 'color-mix(in srgb, var(--color-bg-card) 90%, white 10%)',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.62)',
    color: dragging ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
    cursor: isSavingPriority || managementLocked ? 'not-allowed' : 'grab',
    opacity: managementLocked ? 0.65 : 1,
    transition: 'background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, color 0.16s ease',
  };

  const rowStyle: CSSProperties = {
    transition: rowTransition || undefined,
    opacity: dragging ? 0.92 : visuallyUnavailable ? 0.56 : 1,
    display: 'grid',
    gridTemplateColumns: managementLocked || mobile ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) auto auto auto',
    alignItems: mobile ? 'stretch' : 'center',
    gap: mobile ? 8 : 6,
    padding: mobile ? '8px 9px' : '5px 8px',
    border: `1px solid ${dragging ? 'color-mix(in srgb, var(--color-info) 38%, var(--color-border-light))' : 'color-mix(in srgb, var(--color-border-light) 92%, transparent)'}`,
    borderRadius: 14,
    backgroundColor: dragging
      ? 'color-mix(in srgb, var(--color-bg-card) 82%, var(--color-info) 18%)'
      : selected
        ? 'color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-card))'
      : 'color-mix(in srgb, var(--color-bg-card) 96%, white 4%)',
    boxShadow: dragging
      ? '0 18px 34px rgba(15, 23, 42, 0.12)'
      : '0 10px 22px rgba(15, 23, 42, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.7)',
  };

  const decisionState = getChannelDecisionState(decisionCandidate, channel, isExactRoute, loadingDecision);
  const tokenBinding = describeTokenBinding(
    tokenOptions,
    activeTokenId,
    channel.token?.name ?? null,
    {
      connectionMode: resolveTokenBindingConnectionMode(channel.account),
      accountName: channel.account?.username || `account-${channel.accountId}`,
    },
  );
  const routeUnit = channel.routeUnit ?? null;
  const routeUnitName = routeUnit?.name?.trim() || 'OAuth 路由池';
  const routeUnitStrategyLabel = routeUnit ? getRouteUnitStrategyLabel(routeUnit.strategy) : '';
  const routeUnitMemberSummary = routeUnit?.members?.length
    ? routeUnit.members.map((member) => formatRouteUnitMemberLabel(member)).join('、')
    : null;
  const routeUnitMemberSummaryText = routeUnitMemberSummary ? `成员：${routeUnitMemberSummary}` : null;

  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);

  if (mobile) {
    return (
      <div data-layer-root style={{ ...rowStyle, display: 'block' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          {onToggleSelected ? (
            <button
              type="button"
              onClick={onToggleSelected}
              className={`btn btn-ghost ${selected ? 'btn-primary' : ''}`}
              style={{
                width: 22,
                minWidth: 22,
                height: 22,
                padding: 0,
                border: '1px solid var(--color-border-light)',
                borderRadius: 8,
                marginTop: 2,
              }}
              aria-label={selected ? '取消选择通道' : '选择通道'}
            >
              <span style={{ fontSize: 11, fontWeight: 700 }}>{selected ? '✓' : '+'}</span>
            </button>
          ) : null}
          <button
            type="button"
            ref={dragHandleRef}
            {...dragHandleProps}
            disabled={isSavingPriority || managementLocked}
            className="btn btn-ghost"
            style={{
              marginTop: 2,
              ...dragHandleStyle,
            }}
            data-tooltip={suppressTooltips ? undefined : (managementLocked ? '该路由当前不可编辑优先级' : '拖拽调整优先级桶')}
            aria-label="拖拽调整优先级桶"
          >
            <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12" aria-hidden>
              <circle cx="3" cy="2" r="1" />
              <circle cx="9" cy="2" r="1" />
              <circle cx="3" cy="6" r="1" />
              <circle cx="9" cy="6" r="1" />
              <circle cx="3" cy="10" r="1" />
              <circle cx="9" cy="10" r="1" />
            </svg>
          </button>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              {showPriorityBadge ? (
                <span
                  className="badge"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.1,
                    ...getPriorityTagStyle(resolvedPriority),
                  }}
                >
                  P{resolvedPriority}
                </span>
              ) : null}

              <span style={{ fontWeight: 600, color: 'var(--color-text-primary)', fontSize: 14, minWidth: 0 }}>
                {channel.account?.username || `account-${channel.accountId}`}
              </span>

              <span className="badge badge-muted" style={{ fontSize: 10 }}>
                {channel.site?.name || 'unknown'}
              </span>

              <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
                成功/失败 <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{channel.successCount || 0}</span>
                <span style={{ color: 'var(--color-text-muted)', margin: '0 2px' }}>/</span>
                <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>{channel.failCount || 0}</span>
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <span
                className="badge"
                style={{
                  fontSize: 10,
                  background: tokenBinding.badgeTone === 'info'
                    ? 'color-mix(in srgb, var(--color-info) 15%, transparent)'
                    : 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
                  color: tokenBinding.badgeTone === 'info' ? 'var(--color-info)' : 'var(--color-warning)',
                }}
              >
                {tokenBinding.bindingModeLabel}
              </span>

              <span
                className="badge"
                style={{
                  fontSize: 10,
                  background: 'var(--color-info-soft)',
                  color: 'var(--color-info)',
                  maxWidth: 220,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                data-tooltip={suppressTooltips ? undefined : `当前生效：${tokenBinding.effectiveTokenName}`}
              >
                当前生效：{tokenBinding.effectiveTokenName}
              </span>

              {channel.sourceModel ? (
                <span className="badge badge-info" style={{ fontSize: 10 }}>
                  {channel.sourceModel}
                </span>
              ) : null}

              {channel.manualOverride ? (
                <span
                  className="badge badge-warning"
                  style={{ fontSize: 10 }}
                  data-tooltip={suppressTooltips ? undefined : '该通道由用户手动添加，而非系统自动生成'}
                >
                  手动配置
                </span>
              ) : null}

              {sourceUnavailable ? (
                <span
                  className="badge badge-muted"
                  style={{ fontSize: 10 }}
                  data-tooltip={suppressTooltips ? undefined : '模型刷新后发现该来源暂不可用，恢复后会自动重新参与路由'}
                >
                  来源不可用
                </span>
              ) : null}

              {renderChannelInsightBadges(channel, suppressTooltips, currencyCtx)}

              {routeUnit ? (
                <>
                  <span className="badge badge-muted" style={{ fontSize: 10 }}>
                    OAuth 路由池
                  </span>
                  <span className="badge badge-info" style={{ fontSize: 10 }}>
                    {routeUnitName}
                  </span>
                  <span className="badge badge-muted" style={{ fontSize: 10 }}>
                    {routeUnit.memberCount} 成员
                  </span>
                  <span className="badge badge-muted" style={{ fontSize: 10 }}>
                    {routeUnitStrategyLabel}
                  </span>
                </>
              ) : null}
            </div>

            {routeUnitMemberSummaryText ? (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                  成员摘要（{routeUnit?.memberCount || 0} 个成员 · {routeUnitStrategyLabel}）
                </span>
                <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
                  {routeUnitMemberSummaryText}
                </span>
              </div>
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>选中概率</span>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 96 }}>
                <div
                  data-tooltip={suppressTooltips ? undefined : (decisionState.probability <= 0 ? decisionState.reasonText : undefined)}
                  style={{
                    width: 60,
                    height: 4,
                    background: 'color-mix(in srgb, var(--color-border) 88%, white 12%)',
                    borderRadius: 999,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(0, Math.min(100, decisionState.probability))}%`,
                      height: '100%',
                      background: getProbabilityColor(decisionState.probability),
                      borderRadius: 999,
                      transition: 'width 0.24s ease, background-color 0.18s ease',
                    }}
                  />
                </div>
                <span
                  data-tooltip={suppressTooltips ? undefined : (decisionState.probability <= 0 ? decisionState.reasonText : undefined)}
                  style={{
                    fontSize: 11,
                    color: decisionState.probability > 0 ? 'var(--color-text-secondary)' : decisionState.reasonColor,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {decisionState.probability.toFixed(1)}%
                </span>
              </div>

              {!managementLocked && (
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => setMobileDetailsOpen((current) => !current)}
                  style={{ marginLeft: 'auto' }}
                >
                  {mobileDetailsOpen ? '收起配置' : '配置通道'}
                </button>
              )}
            </div>

            {!managementLocked && mobileDetailsOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6, borderTop: '1px solid var(--color-border-light)' }}>
                <div style={{ width: '100%' }}>
                  <ModernSelect
                    size="sm"
                    value={String(activeTokenId || 0)}
                    onChange={(nextValue) => onTokenDraftChange(channel.id, Number.parseInt(nextValue, 10) || 0)}
                    disabled={isUpdatingToken}
                    options={[
                      {
                        value: '0',
                        label: tokenBinding.followOptionLabel,
                        description: tokenBinding.followOptionDescription,
                      },
                      ...tokenOptions.map((token) => ({
                        value: String(token.id),
                        label: buildFixedTokenOptionLabel(token, { includeDefaultTag: true }),
                        description: buildFixedTokenOptionDescription(token),
                      })),
                    ]}
                    placeholder="选择令牌绑定方式"
                  />
                  <div style={{ marginTop: 3, fontSize: 10.5, color: 'var(--color-text-muted)', lineHeight: 1.35 }}>
                    {tokenBinding.helperText}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    onClick={onSaveToken}
                    disabled={isUpdatingToken}
                    className="btn btn-link btn-link-info"
                  >
                    {isUpdatingToken ? <span className="spinner spinner-sm" /> : '保存'}
                  </button>

                  <button
                    onClick={() => onToggleEnabled(channel.enabled === false)}
                    className={`btn btn-link ${channel.enabled === false ? 'btn-link-info' : 'btn-link-warning'}`}
                  >
                    {channel.enabled === false ? '启用' : '禁用'}
                  </button>

                  {onSiteBlockModel && channel.site?.id ? (
                    <button
                      onClick={onSiteBlockModel}
                      className="btn btn-link btn-link-warning"
                    >
                      站点屏蔽
                    </button>
                  ) : null}

                  <button
                    onClick={onDeleteChannel}
                    className="btn btn-link btn-link-danger"
                  >
                    移除
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-layer-root style={rowStyle}>
      <div style={{ display: 'flex', alignItems: mobile ? 'stretch' : 'center', flexDirection: mobile ? 'column' : 'row', gap: 6, fontSize: 12, flexWrap: 'wrap', minWidth: 0 }}>
        {onToggleSelected ? (
          <button
            type="button"
            onClick={onToggleSelected}
            className={`btn btn-ghost ${selected ? 'btn-primary' : ''}`}
            style={{
              width: 22,
              minWidth: 22,
              height: 22,
              padding: 0,
              border: '1px solid var(--color-border-light)',
              borderRadius: 8,
              alignSelf: mobile ? 'flex-start' : undefined,
            }}
            aria-label={selected ? '取消选择通道' : '选择通道'}
          >
            <span style={{ fontSize: 11, fontWeight: 700 }}>{selected ? '✓' : '+'}</span>
          </button>
        ) : null}
        <button
          type="button"
          ref={dragHandleRef}
          {...dragHandleProps}
          disabled={isSavingPriority || managementLocked}
          className="btn btn-ghost"
          style={dragHandleStyle}
          data-tooltip={suppressTooltips ? undefined : (managementLocked ? '该路由当前不可编辑优先级' : '拖拽调整优先级桶')}
          aria-label="拖拽调整优先级桶"
        >
          <svg width="12" height="12" fill="currentColor" viewBox="0 0 12 12" aria-hidden>
            <circle cx="3" cy="2" r="1" />
            <circle cx="9" cy="2" r="1" />
            <circle cx="3" cy="6" r="1" />
            <circle cx="9" cy="6" r="1" />
            <circle cx="3" cy="10" r="1" />
            <circle cx="9" cy="10" r="1" />
          </svg>
        </button>

        {showPriorityBadge ? (
          <span
            className="badge"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.1,
              ...getPriorityTagStyle(resolvedPriority),
            }}
          >
            P{resolvedPriority}
          </span>
        ) : null}

        <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
          {channel.account?.username || `account-${channel.accountId}`}
        </span>

        <span className="badge badge-muted" style={{ fontSize: 10 }}>
          {channel.site?.name || 'unknown'}
        </span>

        <span
          className="badge"
          style={{
            fontSize: 10,
            background: tokenBinding.badgeTone === 'info'
              ? 'color-mix(in srgb, var(--color-info) 15%, transparent)'
              : 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
            color: tokenBinding.badgeTone === 'info' ? 'var(--color-info)' : 'var(--color-warning)',
          }}
        >
          {tokenBinding.bindingModeLabel}
        </span>

        <span
          className="badge"
          style={{
            fontSize: 10,
            background: 'var(--color-info-soft)',
            color: 'var(--color-info)',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          data-tooltip={suppressTooltips ? undefined : `当前生效：${tokenBinding.effectiveTokenName}`}
        >
          当前生效：{tokenBinding.effectiveTokenName}
        </span>

        {channel.sourceModel ? (
          <span className="badge badge-info" style={{ fontSize: 10 }}>
            {channel.sourceModel}
          </span>
        ) : null}

        {channel.manualOverride ? (
          <span
            className="badge badge-warning"
            style={{ fontSize: 10 }}
            data-tooltip={suppressTooltips ? undefined : '该通道由用户手动添加，而非系统自动生成'}
          >
            手动配置
          </span>
        ) : null}

        {sourceUnavailable ? (
          <span
            className="badge badge-muted"
            style={{ fontSize: 10 }}
            data-tooltip={suppressTooltips ? undefined : '模型刷新后发现该来源暂不可用，恢复后会自动重新参与路由'}
          >
            来源不可用
          </span>
        ) : null}

        {channel.enabled === false ? (
          <span className="badge badge-muted" style={{ fontSize: 10 }}>禁用</span>
        ) : null}

        {renderChannelInsightBadges(channel, suppressTooltips, currencyCtx)}

        {routeUnit ? (
          <>
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              OAuth 路由池
            </span>
            <span className="badge badge-info" style={{ fontSize: 10 }}>
              {routeUnitName}
            </span>
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              {routeUnit.memberCount} 成员
            </span>
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              {routeUnitStrategyLabel}
            </span>
          </>
        ) : null}

        {routeUnitMemberSummaryText ? (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
              成员摘要（{routeUnit?.memberCount || 0} 个成员 · {routeUnitStrategyLabel}）
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', lineHeight: 1.45 }}>
              {routeUnitMemberSummaryText}
            </span>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', marginTop: mobile ? 0 : 1, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>选中概率</span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 96 }}>
            <div
              data-tooltip={suppressTooltips ? undefined : (decisionState.probability <= 0 ? decisionState.reasonText : undefined)}
              style={{
                width: 60,
                height: 4,
                background: 'color-mix(in srgb, var(--color-border) 88%, white 12%)',
                borderRadius: 999,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, decisionState.probability))}%`,
                  height: '100%',
                  background: getProbabilityColor(decisionState.probability),
                  borderRadius: 999,
                  transition: 'width 0.24s ease, background-color 0.18s ease',
                }}
              />
            </div>
            <span
              data-tooltip={suppressTooltips ? undefined : (decisionState.probability <= 0 ? decisionState.reasonText : undefined)}
              style={{
                fontSize: 11,
                color: decisionState.probability > 0 ? 'var(--color-text-secondary)' : decisionState.reasonColor,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}
            >
              {decisionState.probability.toFixed(1)}%
            </span>
          </div>

          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>成功/失败</span>
          <span style={{ fontSize: 11 }}>
            <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{channel.successCount || 0}</span>
            <span style={{ color: 'var(--color-text-muted)', margin: '0 2px' }}>/</span>
            <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>{channel.failCount || 0}</span>
          </span>
        </div>
      </div>

      {!managementLocked ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ minWidth: 220, flex: 1 }}>
              <ModernSelect
                size="sm"
                value={String(activeTokenId || 0)}
                onChange={(nextValue) => onTokenDraftChange(channel.id, Number.parseInt(nextValue, 10) || 0)}
                disabled={isUpdatingToken}
                options={[
                  {
                    value: '0',
                    label: tokenBinding.followOptionLabel,
                    description: tokenBinding.followOptionDescription,
                  },
                  ...tokenOptions.map((token) => ({
                    value: String(token.id),
                    label: buildFixedTokenOptionLabel(token, { includeDefaultTag: true }),
                    description: buildFixedTokenOptionDescription(token),
                  })),
                ]}
                placeholder="选择令牌绑定方式"
              />
              <div style={{ marginTop: 3, fontSize: 10.5, color: 'var(--color-text-muted)', lineHeight: 1.35 }}>
                {tokenBinding.helperText}
              </div>
            </div>
            <button
              onClick={onSaveToken}
              disabled={isUpdatingToken}
              className="btn btn-link btn-link-info"
            >
              {isUpdatingToken ? <span className="spinner spinner-sm" /> : '保存'}
            </button>
          </div>

          <button
            onClick={() => onToggleEnabled(channel.enabled === false)}
            className={`btn btn-link ${channel.enabled === false ? 'btn-link-info' : 'btn-link-warning'}`}
            data-tooltip={suppressTooltips ? undefined : (channel.enabled === false ? '启用此通道' : '禁用此通道')}
          >
            {channel.enabled === false ? '启用' : '禁用'}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {onSiteBlockModel && channel.site?.id ? (
              <button
                onClick={onSiteBlockModel}
                className="btn btn-link btn-link-warning"
                data-tooltip={suppressTooltips ? undefined : `将此模型加入站点「${channel.site?.name || '未知'}」的禁用列表，rebuild 后该站点的此模型通道将不再生成`}
              >
                站点屏蔽
              </button>
            ) : null}

            <button
              onClick={onDeleteChannel}
              className="btn btn-link btn-link-danger"
            >
              移除
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
