import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PerfMetricCell } from '../../../shared/perfMetricsValue.js';
import {
  CHANNEL_INLINE_PERF_KINDS,
  CHANNEL_POPOVER_PERF_KINDS,
  PerfBadge,
  PerfChannelGroup,
  PerfChipsSquare,
  buildPerfTooltip,
  formatGroupPerfBadgeText,
  formatPerfSuccessRate,
  perfChipLabel,
  type PerfSnapshot,
} from './upstreamMetricsPresentation.js';

/**
 * 上游公示展示出口单测（S0-4）。
 * 用户 2026-11-20 改判：chip 标签去"上游公示"前缀、空态短词（无调用/未公示）、成功率两位小数、
 * 弹层精简为来源句（模型/分组分流），降级信息（数据截至/存疑）保留为附加项。
 * 运行环境为 zh（tr 返回原文），故断言中文串。
 */

function cell(value: number | null, present: boolean, dubious = false): PerfMetricCell {
  return { value, present, dubious, emptyReason: present ? null : 'fieldAbsent' };
}

const ready: PerfSnapshot = {
  state: 'value',
  capturedAt: Date.parse('2026-11-18T09:30:00'),
  tps: cell(77.17, true),
  ttft: cell(1297, true),
  latency: cell(4426, true),
  success24: cell(99.1, true),
  success1h: cell(100, true),
};

// 分组级快照（带 groupName）走"模型分组数据"来源句。
const readyGroup: PerfSnapshot = { ...ready, groupName: 'grp-codex' };

describe('formatPerfSuccessRate', () => {
  // 用户 2026-11-21：小数超过 2 位才四舍五入到 2 位；≤2 位原样、整数不带小数。
  it('小数>2位才四舍五入（66.67%），1~2位原样（55.5%/99.1%），整数无小数（100%）', () => {
    expect(formatPerfSuccessRate(66.666)).toBe('66.67%');
    expect(formatPerfSuccessRate(99.1)).toBe('99.1%');
    expect(formatPerfSuccessRate(100)).toBe('100%');
    expect(formatPerfSuccessRate(55.5)).toBe('55.5%');
    expect(formatPerfSuccessRate(0)).toBe('0%');
    expect(formatPerfSuccessRate(99.12)).toBe('99.12%');
    // 浮点噪声（0.1+0.2）不应误判为需补位。
    expect(formatPerfSuccessRate(33.3)).toBe('33.3%');
  });
});

describe('perfChipLabel', () => {
  // 用户 2026-11-21：TPS 单位移进读数（TPS 200 tok/s）；首字/平均延迟改"耗时"（仅上游公示族）。
  it('TPS label 不再带单位；首字/平均为"耗时"', () => {
    expect(perfChipLabel('tps')).toBe('TPS');
    expect(perfChipLabel('latency')).toBe('平均耗时');
    expect(perfChipLabel('ttft')).toBe('首字耗时');
    expect(perfChipLabel('success24')).toBe('24h成功率');
    expect(perfChipLabel('success1h')).toBe('1h成功率');
  });
});

describe('buildPerfTooltip', () => {
  it('模型级（无 groupName）来源句=模型24h内数据', () => {
    expect(buildPerfTooltip('tps', ready)).toContain('来源上游公示模型24h内数据');
  });

  it('分组级（有 groupName）来源句=模型分组数据且带分组名（判据 3 同源核对）', () => {
    const tip = buildPerfTooltip('success24', { ...ready, groupName: '组甲' });
    expect(tip).toContain('来源上游公示模型分组数据');
    expect(tip).toContain('组甲');
  });

  it('TPS 存疑时带告警', () => {
    expect(buildPerfTooltip('tps', { ...ready, tps: cell(5500, true, true) }))
      .toContain('吞吐数值存疑');
  });

  it('stale 带数据截至时刻与失败次数（附加项，判据 5）', () => {
    const tip = buildPerfTooltip('tps', { state: 'stale', capturedAt: Date.parse('2026-11-18T08:05:00'), failCount: 3, tps: cell(77, true) });
    expect(tip).toContain('来源上游公示模型24h内数据');
    expect(tip).toContain('数据截至 08:05');
    expect(tip).toContain('预热失败 3');
  });

  it('绝不出现"样本数"字样', () => {
    expect(buildPerfTooltip('tps', ready)).not.toContain('样本');
  });
});

describe('PerfBadge', () => {
  it('有值走 badge-info，不进告警色阶；TPS 单位随读数（TPS 77 tok/s）', () => {
    const html = renderToStaticMarkup(<PerfBadge kind="tps" snapshot={ready} />);
    expect(html).toContain('badge-info');
    expect(html).not.toContain('badge-error');
    expect(html).not.toContain('badge-warning');
    expect(html).toContain('TPS');
    expect(html).toContain('77');
    expect(html).toContain('tok/s');
    expect(html).not.toContain('TPS(tok/s)');
  });

  it('成功率 ≤2 位原样（99.1→99.1%）', () => {
    const html = renderToStaticMarkup(<PerfBadge kind="success24" snapshot={ready} />);
    expect(html).toContain('99.1%');
  });

  it('延迟毫秒→秒格式化（4426→4.4s）', () => {
    const html = renderToStaticMarkup(<PerfBadge kind="latency" snapshot={ready} />);
    expect(html).toContain('4.4s');
  });

  it('TPS 存疑落"存疑"字样，绝不回显天文数字', () => {
    const html = renderToStaticMarkup(<PerfBadge kind="tps" snapshot={{ ...ready, tps: cell(3020584, true, true) }} />);
    expect(html).toContain('存疑');
    expect(html).not.toContain('3020584');
    expect(html).not.toContain('3,020,584');
  });

  it('容器 noWindowTraffic 时字段串味不误报"未公示"（容器态优先）', () => {
    // 单字段归因 fieldAbsent，但容器是 noWindowTraffic → 文案必须是"无调用"。
    const html = renderToStaticMarkup(
      <PerfBadge kind="tps" snapshot={{ ...ready, state: 'noWindowTraffic', tps: cell(null, false) }} />,
    );
    expect(html).toContain('无调用');
    expect(html).not.toContain('未公示');
  });

  it('notPublished 落"未公示"且用 badge-muted', () => {
    const html = renderToStaticMarkup(<PerfBadge kind="ttft" snapshot={{ ...ready, ttft: cell(null, false), state: 'notPublished' }} />);
    expect(html).toContain('未公示');
    expect(html).toContain('badge-muted');
  });

  it('noWindowTraffic 落"无调用"', () => {
    const html = renderToStaticMarkup(<PerfBadge kind="success24" snapshot={{ ...ready, success24: cell(null, false), state: 'noWindowTraffic' }} />);
    expect(html).toContain('无调用');
  });
});

describe('PerfChipsSquare', () => {
  it('渲染全部 5 项（2026-11-21 文案：TPS 无括号单位、首字/平均耗时）', () => {
    const html = renderToStaticMarkup(<PerfChipsSquare snapshot={ready} />);
    for (const label of ['TPS', '首字耗时', '平均耗时', '24h成功率', '1h成功率']) {
      expect(html).toContain(label);
    }
    // 旧带前缀的 chip 标签串不得再出现（正文去前缀；来源只进 tooltip，故只查标签形态）。
    for (const oldLabel of ['上游公示TPS', '上游公示首字', '上游公示延迟', '上游公示24h', '上游公示1h']) {
      expect(html).not.toContain(oldLabel);
    }
    // 2026-11-21 点 2/3 改名后的旧形态不得残留。
    expect(html).not.toContain('TPS(tok/s)');
    expect(html).not.toContain('首字延迟');
    expect(html).not.toContain('平均延迟');
  });

  // S3-4 负控制：喂三种"脏形"快照（等价于 buildModelPerfSnapshot 对脏上游的产物），
  // 钉 chip 落点。测的是"snapshot→chip 接线"这一层，纯函数测覆盖不到。
  it('脏形1 tps=600(存疑) → chip 落"存疑"，绝不回显 600', () => {
    const snap: PerfSnapshot = { state: 'value', capturedAt: Date.now(), tps: cell(600, true, true) };
    const html = renderToStaticMarkup(<PerfBadge kind="tps" snapshot={snap} />);
    expect(html).toContain('存疑');
    expect(html).not.toContain('600');
  });

  it('脏形2 ttft=0 哨兵(fieldAbsent) → 空态"未公示"，绝不画 0ms', () => {
    const snap: PerfSnapshot = { state: 'value', capturedAt: Date.now(), ttft: cell(null, false) };
    const html = renderToStaticMarkup(<PerfBadge kind="ttft" snapshot={snap} />);
    expect(html).toContain('未公示');
    expect(html).not.toContain('0ms');
  });

  it('脏形3 整键缺失(notPublished 容器、cells 全 undefined) → 5 chip 全落"未公示"', () => {
    const snap: PerfSnapshot = { state: 'notPublished', capturedAt: null };
    const html = renderToStaticMarkup(<PerfChipsSquare snapshot={snap} />);
    expect((html.match(/未公示/g) || []).length).toBe(5);
  });
});

describe('通道 chip 3+2 划分', () => {
  // 用户 2026-11-21 点 4：24h 与 1h 互换，默认优先显 1h（常驻）。
  it('常驻 3 项 = TPS/平均耗时/1h成功率', () => {
    expect(CHANNEL_INLINE_PERF_KINDS).toEqual(['tps', 'latency', 'success1h']);
  });

  it('弹层 = 首字耗时 + 24h成功率（来源另占末行，见 PerfChannelGroup）', () => {
    expect(CHANNEL_POPOVER_PERF_KINDS).toEqual(['ttft', 'success24']);
  });
});

describe('PerfChannelGroup（点 3 合并弹层 / 点 6 字号）', () => {
  const groupSnap: PerfSnapshot = {
    state: 'value',
    capturedAt: 1790000000000,
    groupName: 'grp-codex',
    tps: cell(200, true),
    ttft: cell(1297, true),
    latency: cell(4426, true),
    success24: cell(99.123, true),
    success1h: cell(100, true),
  };

  it('常驻 chip 一律不挂 data-tooltip（消除双弹层冲突）', () => {
    const html = renderToStaticMarkup(<PerfChannelGroup snapshot={groupSnap} />);
    expect(html).not.toContain('data-tooltip');
  });

  it('来源并入弹层最后一行', () => {
    const html = renderToStaticMarkup(<PerfChannelGroup snapshot={groupSnap} />);
    // 弹层应含来源声明句（合并进最后一行）。
    expect(html).toContain('来源上游公示模型分组数据');
    expect(html).toContain('grp-codex');
  });

  it('整组带 perf-channel-group 类（字号统一由 CSS 接管，点 6）', () => {
    const html = renderToStaticMarkup(<PerfChannelGroup snapshot={groupSnap} />);
    expect(html).toContain('perf-channel-group');
  });

  it('快照为 null → 整组不渲染', () => {
    expect(renderToStaticMarkup(<PerfChannelGroup snapshot={null} />)).toBe('');
  });
});

/**
 * S5-2 / 点 4：展开态分组徽章的公示信息并入 data-tooltip（单行 · 拼接）。
 * 返回值现为 { tooltip, hasValue }（不再有内联 .text）。
 */
describe('formatGroupPerfBadgeText', () => {
  it('双窗都有值 → tooltip 含来源句 + 双窗（1h 在前，≤2 位原样）', () => {
    const out = formatGroupPerfBadgeText(readyGroup)!;
    expect(out.hasValue).toBe(true);
    expect(out.tooltip).toContain('来源上游公示模型分组数据');
    expect(out.tooltip).toContain('24h成功率 99.1%');
    expect(out.tooltip).toContain('1h成功率 100%');
    // 点 4：1h 优先，排在 24h 之前。
    expect(out.tooltip.indexOf('1h成功率')).toBeLessThan(out.tooltip.indexOf('24h成功率'));
  });

  it('只有 24h 有值（1h 窗口内无调用）→ 只画 24h 段，绝不画 1h 段', () => {
    const out = formatGroupPerfBadgeText({
      ...readyGroup,
      success1h: { value: null, present: false, dubious: false, emptyReason: 'noWindowTraffic' },
    })!;
    expect(out.hasValue).toBe(true);
    expect(out.tooltip).toContain('24h成功率 99.1%');
    expect(out.tooltip).not.toContain('1h成功率');
  });

  it('容器 noWindowTraffic → 空态"无调用"，hasValue=false（容器态优先，不串成"未公示"）', () => {
    const out = formatGroupPerfBadgeText({
      state: 'noWindowTraffic',
      capturedAt: ready.capturedAt,
      groupName: '组甲',
      success24: { value: null, present: false, dubious: false, emptyReason: 'noWindowTraffic' },
      success1h: { value: null, present: false, dubious: false, emptyReason: 'noWindowTraffic' },
    })!;
    expect(out.hasValue).toBe(false);
    expect(out.tooltip).toContain('无调用');
    expect(out.tooltip).not.toContain('未公示');
  });

  it('容器 notPublished（有过缓存但全过期）→ "未公示"', () => {
    const out = formatGroupPerfBadgeText({
      state: 'notPublished',
      capturedAt: ready.capturedAt,
      groupName: 'grp-codex',
      success24: { value: null, present: false, dubious: false, emptyReason: 'notPublished' },
      success1h: { value: null, present: false, dubious: false, emptyReason: 'notPublished' },
    })!;
    expect(out.hasValue).toBe(false);
    expect(out.tooltip).toContain('未公示');
  });

  it('stale：数值照常给，且 tooltip 标"数据截至"（附加项）', () => {
    const out = formatGroupPerfBadgeText({ ...readyGroup, state: 'stale' })!;
    expect(out.hasValue).toBe(true);
    expect(out.tooltip).toContain('24h成功率 99.1%');
    expect(out.tooltip).toContain('数据截至');
  });

  it('快照为 null（从未预热该站该模型）→ 返回 null：调用方不挂公示弹层', () => {
    expect(formatGroupPerfBadgeText(null)).toBeNull();
    expect(formatGroupPerfBadgeText(undefined)).toBeNull();
  });

  it('真 0% 是合法读数 → 画 "24h成功率 0%"（整数不带小数），不落空态文案', () => {
    const out = formatGroupPerfBadgeText({
      ...readyGroup,
      success24: { value: 0, present: true, dubious: false, emptyReason: null },
      success1h: { value: 0, present: true, dubious: false, emptyReason: null },
    })!;
    expect(out.hasValue).toBe(true);
    expect(out.tooltip).toContain('24h成功率 0%');
    expect(out.tooltip).not.toContain('无调用');
  });
});
