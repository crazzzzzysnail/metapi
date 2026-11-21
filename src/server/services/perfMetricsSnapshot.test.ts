import { describe, expect, it } from 'vitest';
import type { CachedPerfDetail, CachedPerfSummary } from './perfMetricsCache.js';
import { buildGroupPerfSnapshot, buildGroupPerfSnapshotMap, buildModelPerfSnapshot } from './perfMetricsSnapshot.js';

/**
 * 快照组装单测（S3-4 / S4-1 / S5 共用层的归因契约）。
 *
 * 这里不重复测 shared 的判值（那属 perfMetricsValue.test），只测"缓存片段 → PerfSnapshot"
 * 的**状态归因**：容器态怎么在混合窗口下选定、空态文案落哪种、过期是否停止供旧值。
 * 这些是判据 2/5 的落点，且是 L7 反复踩的集合/时间判定，必须有正/负例。
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_790_000_000_000;

function summary(models: unknown[], capturedAt = NOW - MIN): CachedPerfSummary {
  return { models, hasWindow: true, capturedAt };
}
function detail(data: unknown, capturedAt = NOW - MIN): CachedPerfDetail {
  return { data, capturedAt };
}
function cellOf(snap: NonNullable<ReturnType<typeof buildModelPerfSnapshot>>, k: 'tps' | 'ttft' | 'latency' | 'success24' | 'success1h') {
  return snap[k]!;
}

describe('buildModelPerfSnapshot', () => {
  it('两窗都无缓存（从未预热）→ null：调用方整组不渲染，绝不给无数据行挂空 chip', () => {
    const snap = buildModelPerfSnapshot({ modelName: 'm', summary24: null, summary1: null, detail24: null, nowMs: NOW });
    expect(snap).toBeNull();
  });

  it('两窗新鲜且模型都在 → state=value，24h/1h 各取各窗值', () => {
    const snap = buildModelPerfSnapshot({
      modelName: 'gpt-4o',
      summary24: summary([{ model_name: 'gpt-4o', avg_tps: 77, avg_latency_ms: 4426, success_rate: 99.1 }]),
      summary1: summary([{ model_name: 'gpt-4o', avg_tps: 80, avg_latency_ms: 4200, success_rate: 100 }]),
      detail24: null,
      nowMs: NOW,
    });
    expect(snap.state).toBe('value');
    expect(cellOf(snap, 'tps').value).toBe(77);
    expect(cellOf(snap, 'success24').value).toBe(99.1);
    expect(cellOf(snap, 'success1h').value).toBe(100);
  });

  it('24h 满、1h 无该模型 → state=value，success1h 落"窗口内无调用"（不影响其余 cell）', () => {
    const snap = buildModelPerfSnapshot({
      modelName: 'gpt-4o',
      summary24: summary([{ model_name: 'gpt-4o', avg_tps: 77, avg_latency_ms: 4426, success_rate: 99 }]),
      summary1: summary([{ model_name: 'other', avg_tps: 1 }]),
      detail24: null,
      nowMs: NOW,
    });
    expect(snap.state).toBe('value');
    expect(cellOf(snap, 'tps').value).toBe(77);
    expect(cellOf(snap, 'success1h').present).toBe(false);
    expect(cellOf(snap, 'success1h').emptyReason).toBe('noWindowTraffic');
  });

  it('两窗可用但都挑不到模型 → state=noWindowTraffic，所有 cell 落"窗口内无调用"', () => {
    const snap = buildModelPerfSnapshot({
      modelName: 'missing-model',
      summary24: summary([{ model_name: 'a' }, { model_name: 'b' }]),
      summary1: summary([{ model_name: 'a' }]),
      detail24: null,
      nowMs: NOW,
    });
    expect(snap.state).toBe('noWindowTraffic');
    expect(cellOf(snap, 'tps').emptyReason).toBe('noWindowTraffic');
  });

  it('24h 超新鲜但 ≤24h → state=stale，数值照常给（供旧值）', () => {
    const stale = NOW - 3 * HOUR;
    const snap = buildModelPerfSnapshot({
      modelName: 'gpt-4o',
      summary24: summary([{ model_name: 'gpt-4o', avg_tps: 77, avg_latency_ms: 4426, success_rate: 99 }], stale),
      summary1: summary([{ model_name: 'gpt-4o', success_rate: 100 }], stale),
      detail24: null,
      nowMs: NOW,
    });
    expect(snap.state).toBe('stale');
    expect(snap.capturedAt).toBe(stale);
    expect(cellOf(snap, 'tps').value).toBe(77);
  });

  it('两窗都 >24h 过期 → notPublished（不无限供旧值）', () => {
    const dead = NOW - 25 * HOUR;
    const snap = buildModelPerfSnapshot({
      modelName: 'gpt-4o',
      summary24: summary([{ model_name: 'gpt-4o', avg_tps: 77 }], dead),
      summary1: summary([{ model_name: 'gpt-4o' }], dead),
      detail24: null,
      nowMs: NOW,
    });
    expect(snap.state).toBe('notPublished');
  });

  // 负控制核心：混合过期不许误标 noWindowTraffic。
  it('24h 已过期、1h 仍新鲜 → state=notPublished（绝非 noWindowTraffic）', () => {
    const snap = buildModelPerfSnapshot({
      modelName: 'gpt-4o',
      summary24: summary([{ model_name: 'gpt-4o', avg_tps: 77 }], NOW - 25 * HOUR),
      summary1: summary([{ model_name: 'gpt-4o', success_rate: 88 }], NOW - MIN),
      detail24: null,
      nowMs: NOW,
    });
    // 容器以 24h 窗为准 → notPublished；不能因为"1h 挑到了"就当 value，也不能当"窗口无调用"。
    expect(snap.state).toBe('notPublished');
    expect(snap.state).not.toBe('noWindowTraffic');
  });

  it('ttft 来自 detail series[] 正点自聚合；无 detail → 未公示（绝不当 0ms）', () => {
    const withDetail = buildModelPerfSnapshot({
      modelName: 'gpt-4o',
      summary24: summary([{ model_name: 'gpt-4o', avg_tps: 77 }]),
      summary1: summary([{ model_name: 'gpt-4o' }]),
      detail24: detail({ series: [{ avg_ttft_ms: 0 }, { avg_ttft_ms: 100 }, { avg_ttft_ms: 300 }] }),
      nowMs: NOW,
    });
    expect(cellOf(withDetail, 'ttft').value).toBe(200);

    const noDetail = buildModelPerfSnapshot({
      modelName: 'gpt-4o',
      summary24: summary([{ model_name: 'gpt-4o', avg_tps: 77 }]),
      summary1: summary([{ model_name: 'gpt-4o' }]),
      detail24: null,
      nowMs: NOW,
    });
    expect(cellOf(noDetail, 'ttft').present).toBe(false);
    expect(cellOf(noDetail, 'ttft').emptyReason).toBe('notPublished');
  });

  // coarena 判据 2：整窗 ttft 全 0 → 空态"未公示"，不报 0ms。
  it('ttft 整窗全 0（coarena 形）→ 空态、绝不画 0ms', () => {
    const snap = buildModelPerfSnapshot({
      modelName: 'gpt-4o',
      summary24: summary([{ model_name: 'gpt-4o', avg_tps: 77 }]),
      summary1: summary([{ model_name: 'gpt-4o' }]),
      detail24: detail({ series: Array.from({ length: 20 }, () => ({ avg_ttft_ms: 0 })) }),
      nowMs: NOW,
    });
    const ttft = cellOf(snap, 'ttft');
    expect(ttft.present).toBe(false);
    expect(ttft.value).toBeNull();
    expect(ttft.emptyReason).toBe('fieldAbsent');
  });

  it('avg_tps=300万 → present 但 dubious（存疑标记，仍交展示层判文案）', () => {
    const snap = buildModelPerfSnapshot({
      modelName: 'gpt-4o',
      summary24: summary([{ model_name: 'gpt-4o', avg_tps: 3_020_584, avg_latency_ms: 4000, success_rate: 99 }]),
      summary1: summary([{ model_name: 'gpt-4o' }]),
      detail24: null,
      nowMs: NOW,
    });
    expect(cellOf(snap, 'tps').present).toBe(true);
    expect(cellOf(snap, 'tps').dubious).toBe(true);
    // 延迟即使 4000 也不该被 TPS 存疑阈值误标。
    expect(cellOf(snap, 'latency').dubious).toBe(false);
  });

  it('success_rate=0 且条目存在 → 真 0%（present，不当无值）', () => {
    const snap = buildModelPerfSnapshot({
      modelName: 'bge-m3',
      summary24: summary([{ model_name: 'bge-m3', avg_tps: 0, avg_latency_ms: 100, success_rate: 0 }]),
      summary1: summary([{ model_name: 'bge-m3' }]),
      detail24: null,
      nowMs: NOW,
    });
    expect(cellOf(snap, 'success24').present).toBe(true);
    expect(cellOf(snap, 'success24').value).toBe(0);
  });
});

describe('buildGroupPerfSnapshot', () => {
  it('无详情缓存（从未预热）→ null：调用方整组不渲染', () => {
    const snap = buildGroupPerfSnapshot({ group: '组甲', detail24: null, detail1: null, nowMs: NOW });
    expect(snap).toBeNull();
  });

  it('有过详情但全过期 >24h → notPublished 快照（诚实断供，chip 显"上游未公示"）', () => {
    const snap = buildGroupPerfSnapshot({
      group: '组甲',
      detail24: detail({ groups: [{ group: '组甲', success_rate: 100 }] }, NOW - 25 * HOUR),
      detail1: detail({ groups: [{ group: '组甲', success_rate: 100 }] }, NOW - 25 * HOUR),
      nowMs: NOW,
    });
    expect(snap).not.toBeNull();
    expect(snap!.state).toBe('notPublished');
    expect(snap!.groupName).toBe('组甲');
  });

  it('双窗同名分组 → 各取各窗 ttft/成功率', () => {
    const snap = buildGroupPerfSnapshot({
      group: '组甲',
      detail24: detail({ groups: [{ group: '组甲', avg_ttft_ms: 13790, avg_latency_ms: 13793, avg_tps: 5500, success_rate: 100 }] }),
      detail1: detail({ groups: [{ group: '组甲', avg_ttft_ms: 12000, avg_latency_ms: 12000, avg_tps: 50, success_rate: 94.44 }] }),
      nowMs: NOW,
    });
    expect(snap).not.toBeNull();
    expect(snap!.state).toBe('value');
    expect(cellOf(snap!, 'ttft').value).toBe(13790);
    expect(cellOf(snap!, 'success1h').value).toBe(94.44);
    // 5500 ≥ 500 → 存疑。
    expect(cellOf(snap!, 'tps').dubious).toBe(true);
  });

  it('分组名在 groups[] 里挑不到 → noWindowTraffic（绝不错拿别的分组）', () => {
    const snap = buildGroupPerfSnapshot({
      group: '组丙',
      detail24: detail({ groups: [{ group: '组甲', success_rate: 100 }] }),
      detail1: detail({ groups: [{ group: '组甲', success_rate: 100 }] }),
      nowMs: NOW,
    });
    expect(snap).not.toBeNull();
    expect(snap!.state).toBe('noWindowTraffic');
    expect(cellOf(snap!, 'success24').emptyReason).toBe('noWindowTraffic');
  });
});

/**
 * S5-1 分组级快照表：展开态分组徽章的数据源。
 * 这里锁的是**表的形状契约**——调用方（stats.ts）按 Object.keys(groupPricing) 喂组名，
 * 期望"键逐个回来、未热整表为空、绝不夹 null"。判值的细节归上面的 buildGroupPerfSnapshot。
 */
describe('buildGroupPerfSnapshotMap', () => {
  const twoGroups = detail({
    groups: [
      { group: '组甲', avg_ttft_ms: 900, avg_latency_ms: 4000, avg_tps: 60, success_rate: 99.1 },
      { group: 'grp-codex', avg_ttft_ms: 1200, avg_latency_ms: 5000, avg_tps: 40, success_rate: 88 },
    ],
  });

  it('多分组模型 → 每个组名各取各档，键与入参逐字符一致', () => {
    const map = buildGroupPerfSnapshotMap({
      groups: ['组甲', 'grp-codex'],
      detail24: twoGroups,
      detail1: null,
      nowMs: NOW,
    });
    expect(Object.keys(map)).toEqual(['组甲', 'grp-codex']);
    expect(map['组甲']!.success24!.value).toBe(99.1);
    expect(map['grp-codex']!.success24!.value).toBe(88);
    expect(map['grp-codex']!.ttft!.value).toBe(1200);
  });

  it('计价分组在公示里挑不到 → 该键给 noWindowTraffic 空态快照（仍留在表内，不回退站级值）', () => {
    const map = buildGroupPerfSnapshotMap({
      groups: ['组甲', '组乙'],
      detail24: twoGroups,
      detail1: null,
      nowMs: NOW,
    });
    expect(map['组乙']).not.toBeNull();
    expect(map['组乙']!.state).toBe('noWindowTraffic');
    expect(map['组乙']!.success24!.present).toBe(false);
    // 仍带组名：徽章 tooltip 要说"缺的是哪档的数"。
    expect(map['组乙']!.groupName).toBe('组乙');
  });

  it('双窗都没有详情缓存（从未预热）→ 空表：徽章整段不挂，不混一排空 chip', () => {
    const map = buildGroupPerfSnapshotMap({
      groups: ['组甲', 'grp-codex'],
      detail24: null,
      detail1: null,
      nowMs: NOW,
    });
    expect(map).toEqual({});
  });

  it('有过详情但全过期 → 每键都给 notPublished（诚实断供，与"从未热"可区分）', () => {
    const dead = NOW - 25 * HOUR;
    const map = buildGroupPerfSnapshotMap({
      groups: ['组甲'],
      detail24: detail({ groups: [{ group: '组甲', success_rate: 99 }] }, dead),
      detail1: detail({ groups: [{ group: '组甲', success_rate: 99 }] }, dead),
      nowMs: NOW,
    });
    expect(map['组甲']).not.toBeNull();
    expect(map['组甲']!.state).toBe('notPublished');
  });

  it('空白组名丢弃、大小写不敏感命中公示条目但键保持原样（与计价分组逐字符一致）', () => {
    const map = buildGroupPerfSnapshotMap({
      groups: ['', '  ', 'GRP-CODEX'],
      detail24: twoGroups,
      detail1: null,
      nowMs: NOW,
    });
    expect(Object.keys(map)).toEqual(['GRP-CODEX']);
    expect(map['GRP-CODEX']!.success24!.value).toBe(88);
  });
});
