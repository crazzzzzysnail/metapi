import React from 'react';
import { tr } from '../../i18n.js';
import {
  type PerfDisplayState,
  type PerfMetricCell,
  type PerfSnapshot,
  perfEmptyLabel,
  perfWindowLabel,
} from '../../../shared/perfMetricsValue.js';

/**
 * 上游公示指标的统一出口（S0-4）。
 *
 * 定位：S0-2 的 `perfMetricsValue` 是"解析与判据"权威层；本文件是其上唯一的**展示**出口。
 * 两块界面（模型广场站点行 + 路由通道行）都只经这里产出 chip/tooltip，杜绝各写各的文案与配色
 * （AGENTS.md「one source of truth」；README 第 0 节三条铁律）。
 *
 * 页面**不得**在此之外直接解析 perf 原始字段、也不得自行判 `==0` 拼 tooltip（S0-5 架构测守卫）。
 */

// 跨层 wire 契约（PerfSnapshot/PerfDisplayState）复用 shared 的单一来源——
// server 端 perfMetricsSnapshot.ts 产出、本文件消费；两处各定义一份=漂移源。
// re-export 保持 `import ... from './upstreamMetricsPresentation'` 的既有路径不断。
export type { PerfDisplayState, PerfSnapshot } from '../../../shared/perfMetricsValue.js';

/** 单个公示指标的展示规格键。 */
export type PerfMetricKind = 'tps' | 'ttft' | 'latency' | 'success24' | 'success1h';

// 用户 2026-11-20 改判：chip 标签去除"上游公示"前缀，来源只写进 tooltip（见 buildPerfTooltip）。
// 这与 README 铁律 2 / 判据 4 相悖（裸名 chip 与本机列名同屏有误读风险），该风险由用户明示自担。
// 用户 2026-11-21 改判：TPS 单位从 label 移到读数后（TPS 200 tok/s）；
// "首字延迟/平均延迟"→"首字耗时/平均耗时"（仅上游公示族，本机 proxy_logs 的"平均延迟"不改）。
const KIND_META: Record<PerfMetricKind, { label: string; window: '24h' | '1h' | null; unit: 'tps' | 'ms' | 'pct' }> = {
  tps: { label: 'TPS', window: null, unit: 'tps' },
  ttft: { label: '首字耗时', window: null, unit: 'ms' },
  latency: { label: '平均耗时', window: null, unit: 'ms' },
  success24: { label: '24h成功率', window: '24h', unit: 'pct' },
  success1h: { label: '1h成功率', window: '1h', unit: 'pct' },
};

/**
 * 成功率读数格式化：小数超过 2 位才四舍五入到 2 位（用户 2026-11-21）——
 * 100→'100%'、55.5→'55.5%'、66.666→'66.67%'。TPS 存疑、延迟换算各走各的，
 * 成功率两处消费（chip 正文 + 分组徽章 tooltip）必须共用本函数，否则又是一对会漂移的匹配器（L7）。
 */
export function formatPerfSuccessRate(value: number): string {
  // 先按 2 位四舍五入再回比：99.1*100 的浮点噪声（9910.000000000002）经 round 复原为 9910，
  // 不会把 ≤2 位小数的原始读数误判成"需要补零/进位"。
  const rounded = Math.round(value * 100) / 100;
  return rounded === value ? `${value}%` : `${value.toFixed(2)}%`;
}

function formatMs(ms: number): string {
  if (ms >= 1000) {
    const s = ms / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

/** 指标读数格式化。 */
function formatMetricText(kind: PerfMetricKind, cell: PerfMetricCell): string {
  const meta = KIND_META[kind];
  const v = cell.value;
  if (v == null) return '';
  if (meta.unit === 'ms') return formatMs(v);
  if (meta.unit === 'pct') return formatPerfSuccessRate(v);
  // tps：存疑时绝不回显天文数字（数据篇第五节"禁止原样展示"，实测达 302 万），落"存疑"字样。
  if (cell.dubious) return tr('存疑');
  // 用户 2026-11-21：单位从 label 移到读数后 → 正文形如「TPS 200 tok/s」。
  return `${Math.round(v)} ${tr('tok/s')}`;
}

function formatCaptured(capturedAt: number | string | null | undefined): string | null {
  if (capturedAt == null) return null;
  const d = new Date(capturedAt);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 来源声明句（chip tooltip / 分组徽章 tooltip / 通道弹层共用，单一来源防漂移）。
 * 用户 2026-11-20 改判：弹层精简为一句"来源"声明，按快照粒度分流——
 *   分组级（带 groupName）→「来源上游公示模型分组数据 · 分组 名」；名保留供"计价分组逐字符一致"核对（判据 3）。
 *   模型级（广场站点行 5 chip）→「来源上游公示模型24h内数据」。
 */
function perfSourceLead(snapshot: PerfSnapshot): string {
  if (snapshot.groupName) return `${tr('来源上游公示模型分组数据')} · ${tr('分组')} ${snapshot.groupName}`;
  return tr('来源上游公示模型24h内数据');
}

/**
 * 滞后告警段（判据 5 的"保留为附加项"）：stale→「数据截至 HH:mm（预热失败 N 次）」。
 * 非 stale 返回空数组，调用方 spread 进 parts。
 */
function perfStaleNotes(snapshot: PerfSnapshot): string[] {
  if (snapshot.state !== 'stale') return [];
  const at = formatCaptured(snapshot.capturedAt);
  if (!at) return [tr('数据已过期')];
  const failNote = snapshot.failCount && snapshot.failCount > 0
    ? `，${tr('预热失败')} ${snapshot.failCount} ${tr('次')}`
    : '';
  return [`${tr('数据截至')} ${at}${failNote}`];
}

/**
 * 单个指标 chip / 通道弹层行的 tooltip。集中在此产出（页面不得自拼，S0-5 铁律）。
 * ⚠️ 不承诺"样本数"——perf-metrics 实测无任何 count/total 字段（grilling 自查修正 1）。
 * ⚠️ tr() 参数一律是固定字面量；数字/时刻/分组名在 tr() 之外拼接（英文模式漏翻陷阱）。
 */
export function buildPerfTooltip(kind: PerfMetricKind, snapshot: PerfSnapshot): string {
  const cell = snapshot[kind];
  const parts: string[] = [perfSourceLead(snapshot)];
  if (cell?.dubious) parts.push(tr('吞吐数值存疑（上游 TPS 算法不稳定）'));
  parts.push(...perfStaleNotes(snapshot));
  return parts.join(' · ');
}

/** chip 短标签（徽章正文用）。TPS 单位不在 label，已随读数拼成「200 tok/s」（见 formatMetricText）。 */
export function perfChipLabel(kind: PerfMetricKind): string {
  return tr(KIND_META[kind].label);
}

/**
 * 单个位点的"该画什么文本"。空态归因以**容器态优先**：整窗没流量/整站未公示时，
 * 不许字段级归因串味（否则 noWindowTraffic 容器配 fieldAbsent 字段会误报"上游未公示"）。
 * PerfBadge 与通道弹层共用——同一位点文案只有一处实现（L3）。
 */
function perfCellText(kind: PerfMetricKind, snapshot: PerfSnapshot): { text: string; hasValue: boolean } {
  const cell = snapshot[kind];
  const containerEmpty: 'noWindowTraffic' | 'notPublished' | null =
    snapshot.state === 'noWindowTraffic' ? 'noWindowTraffic'
      : snapshot.state === 'notPublished' ? 'notPublished'
        : null;
  const hasValue = !!cell?.present && containerEmpty === null;
  // 空态文案由纯函数层产出中文原文（S0-2 不依赖 i18n），展示层负责 tr()。
  const text = hasValue && cell
    ? formatMetricText(kind, cell)
    : tr(perfEmptyLabel(containerEmpty ?? cell?.emptyReason ?? 'notPublished'));
  return { text, hasValue };
}

/**
 * 单个公示 chip。中性配色（`badge-muted`），**不进告警色阶**（0.1 配色铁律）。
 * 有值→badge-info；空态/未公示→badge-muted + 空态文案。badge 上无 onClick（Q7：弹层可达性靠 hover 模拟）。
 *
 * suppressTooltip 有两层含义（用户 2026-11-21 点 3 合并弹层后）：
 *  - 拖拽中置真：不挂 data-tooltip（SortableChannelRow.layering 锁死"拖拽中零 data-tooltip"）；
 *  - **路由通道 chip 恒置真**：来源/存疑/截至改由本组共用的弹层详情承载（见 PerfChannelGroup），
 *    每个 chip 不再各挂一份相同 tooltip——消除与弹层同时弹出的"双弹层冲突"。
 *    模型广场站点行仍传 false，保留每 chip 的 hover 来源句。
 * @param suppressTooltip 见上。
 */
export function PerfBadge({
  kind,
  snapshot,
  suppressTooltip = false,
}: {
  kind: PerfMetricKind;
  snapshot: PerfSnapshot;
  suppressTooltip?: boolean;
}) {
  const { text, hasValue } = perfCellText(kind, snapshot);
  const className = `badge ${hasValue ? 'badge-info' : 'badge-muted'}`;
  return (
    <span
      className={className}
      style={{ fontVariantNumeric: 'tabular-nums' }}
      data-tooltip={suppressTooltip ? undefined : buildPerfTooltip(kind, snapshot)}
    >
      {perfChipLabel(kind)} {text}
    </span>
  );
}

/** 广场站点行用：全 5 项常驻（方案①）。 */
export function PerfChipsSquare({ snapshot }: { snapshot: PerfSnapshot }) {
  return (
    <>
      <PerfBadge kind="tps" snapshot={snapshot} />
      <PerfBadge kind="ttft" snapshot={snapshot} />
      <PerfBadge kind="latency" snapshot={snapshot} />
      <PerfBadge kind="success24" snapshot={snapshot} />
      <PerfBadge kind="success1h" snapshot={snapshot} />
    </>
  );
}

/**
 * 路由通道行用：3 常驻 + 2 弹层。
 * 用户 2026-11-21 点 4：24h 与 1h 位置互换，**默认优先显 1h**（常驻），24h 退入弹层。
 *   常驻 = TPS / 平均耗时 / 1h成功率；弹层 = 首字耗时 / 24h成功率。
 * 常驻部分在此渲染；弹层部分复用调用方的 `billing-badge-wrap` 结构（S4 内联），
 * 本出口只保证 chip 文案/配色/tooltip 同源。
 */
export const CHANNEL_INLINE_PERF_KINDS: PerfMetricKind[] = ['tps', 'latency', 'success1h'];
export const CHANNEL_POPOVER_PERF_KINDS: PerfMetricKind[] = ['ttft', 'success24'];

/** 通道弹层来源行的存疑后缀（沿用 buildPerfTooltip 的同一句，单一来源防漂移）。 */
function perfChannelSourceLine(snapshot: PerfSnapshot): string {
  const dubious = snapshot.tps?.dubious ? ` · ${tr('吞吐数值存疑（上游 TPS 算法不稳定）')}` : '';
  return `${perfSourceLead(snapshot)}${dubious}`;
}

/**
 * S4-2 / 用户 2026-11-21 点 3、5：通道行的公示组 = 常驻 3 chip + 悬停弹层（首字 / 24h + **末行来源**）。
 * - **来源并入弹层最后一行**：常驻 chip 一律 suppressTooltip=true，不再各挂 data-tooltip，
 *   彻底消除"chip tooltip + 弹层"同时弹出的双弹层冲突；来源/存疑/数据截至集中在弹层末行（真 DOM，可分行）；
 * - 弹层复用 `billing-badge-wrap`/`billing-detail-pop` 结构：badge 上无 onClick，
 *   移动端靠浏览器 hover 模拟点按可开（Q7 用户实测）；
 * - `data-perf-channel` 标记让测试能把它与计费弹层分开选（S4-4：弹层含且仅含 首字/24h + 来源）；
 * - suppressTooltip 拖拽中整组隐去 tooltip/弹层（layering 测试锁死"拖拽中零 data-tooltip"）；
 * - 快照为 null（从未预热该站该模型）→ 整组不渲染：不给没数据的行挂空 chip。
 * - 字号统一见 index.css `.perf-channel-group .badge`（点 6，与计费等 badge 同为 10px）。
 */
export function PerfChannelGroup({
  snapshot,
  suppressTooltip = false,
}: {
  snapshot: PerfSnapshot | null | undefined;
  suppressTooltip?: boolean;
}) {
  if (!snapshot) return null;
  // 弹层末行来源：数据截至（stale）附加项与来源同行（attr 时代不能分行才拆两条，真 DOM 弹层可合并）。
  const staleNotes = perfStaleNotes(snapshot);
  const sourceLine = staleNotes.length > 0
    ? `${perfChannelSourceLine(snapshot)} · ${staleNotes.join(' · ')}`
    : perfChannelSourceLine(snapshot);
  return (
    <span
      className="billing-badge-wrap perf-channel-group"
      data-perf-channel
      style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}
    >
      {CHANNEL_INLINE_PERF_KINDS.map((kind) => (
        // 点 3：通道 chip 恒 suppressTooltip —— 来源只走下面合并了来源行的弹层，避免双弹层。
        <PerfBadge key={kind} kind={kind} snapshot={snapshot} suppressTooltip />
      ))}
      {!suppressTooltip ? (
        <span className="billing-detail-pop" role="tooltip" data-perf-pop>
          {CHANNEL_POPOVER_PERF_KINDS.map((kind) => {
            const { text } = perfCellText(kind, snapshot);
            return (
              <span className="billing-detail-line" key={kind} data-perf-pop-line>
                {perfChipLabel(kind)}：{text}
              </span>
            );
          })}
          {/* 来源并入弹层最后一行（点 3）。 */}
          <span className="billing-detail-line" data-perf-pop-source>
            {sourceLine}
          </span>
        </span>
      ) : null}
    </span>
  );
}

export { perfWindowLabel };

/**
 * S5-2 / 用户 2026-11-20 点 4 改判：展开态分组徽章的"分组级双窗成功率"。
 * 公示数据不再内联进徽章正文，改为并入徽章的悬停弹层详情（data-tooltip，attr 型不分行，故单行 · 拼接）。
 *
 * 文案与空态归因一律走本出口（与 PerfBadge 同源，L3）：页面只把返回串塞进徽章的 data-tooltip，
 * 不得自行读 snapshot 原始字段、不得自行判 `==0`、不得自行拼成功率小数位（统一走 formatPerfSuccessRate）。
 *
 * 返回值语义：
 * - null → 该分组**没有任何公示数据**（从未预热该站该模型）。调用方不挂公示弹层（与 S4"整组不渲染"同一立场）。
 * - 非 null → tooltip 为单行串：来源句 · 双窗成功率（1h 在前、≤2 位原样，缺窗则省略）·（全空时落空态文案）· 存疑 · 数据截至。
 *   hasValue=false 表示预热过但读不出数（窗口内无调用 / 未公示 / 全过期断供），调用方仍展示但用次要色。
 */
export function formatGroupPerfBadgeText(
  snapshot: PerfSnapshot | null | undefined,
): { tooltip: string; hasValue: boolean } | null {
  if (!snapshot) return null;
  const s24 = snapshot.success24;
  const s1h = snapshot.success1h;
  // 标签统一走 perfChipLabel（i18n 同源）；小数位统一走 formatPerfSuccessRate。
  // 用户 2026-11-21 点 4：默认优先显 1h，故 1h 排在 24h 之前（与通道常驻同一立场）。
  const windowParts: string[] = [];
  if (s1h?.present && s1h.value != null) windowParts.push(`${perfChipLabel('success1h')} ${formatPerfSuccessRate(s1h.value)}`);
  if (s24?.present && s24.value != null) windowParts.push(`${perfChipLabel('success24')} ${formatPerfSuccessRate(s24.value)}`);
  const hasValue = windowParts.length > 0;
  // 双窗都没读数 → 容器态优先归因空态文案（与 perfCellText 同规矩，noWindowTraffic/notPublished 各有专属）。
  const body = hasValue
    ? windowParts.join(' · ')
    : (() => {
        const reason: NonNullable<PerfMetricCell['emptyReason']> = snapshot.state === 'noWindowTraffic'
          ? 'noWindowTraffic'
          : snapshot.state === 'notPublished'
            ? 'notPublished'
            : (s24?.emptyReason ?? s1h?.emptyReason ?? 'notPublished');
        return tr(perfEmptyLabel(reason));
      })();
  const parts: string[] = [perfSourceLead(snapshot), body];
  parts.push(...perfStaleNotes(snapshot));
  return { tooltip: parts.join(' · '), hasValue };
}
