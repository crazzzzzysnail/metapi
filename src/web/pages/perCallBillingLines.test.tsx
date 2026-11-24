import { describe, expect, it } from 'vitest';
import { buildGroupBillingLines } from './ProxyLogs.js';

/**
 * 按次计费在日志「分组/计费」两行里的渲染口径。
 *
 * 锁两件事：
 *   ① 按次记录显示 `X / call`，绝不显示成 `/ 1M`（单位错会差若干个数量级）；
 *   ② token 记录仍走 `/ 1M`，且当只有 perCallPrice 时不会被误画成每百万价。
 * 数据为合成的按次形态（model_price=25 × 组倍率 0.2 = 5）。
 */

const money = (usd: number | null | undefined) => (usd == null ? '--' : `$${usd}`);

describe('buildGroupBillingLines 按次/每百万口径互斥', () => {
  it('按次明细渲染 groupName 与 $X / call', () => {
    const lines = buildGroupBillingLines({
      details: {
        quotaType: 1,
        usage: {
          promptTokens: 1200, completionTokens: 300, totalTokens: 1500,
          cacheReadTokens: 0, cacheCreationTokens: 0, billablePromptTokens: 1200,
          promptTokensIncludeCache: null,
        },
        pricing: {
          modelRatio: 0, completionRatio: 0, cacheRatio: 1, cacheCreationRatio: 1,
          groupRatio: 0.2, groupName: '按次', evidenceSource: 'upstream-per-call',
        },
        breakdown: {
          perCallPrice: 5,
          inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, totalCost: 5,
        },
      },
    }, money);

    expect(lines).toEqual(['按次（×0.2）', '$5 / call']);
    // 关键：单位是 call，不是 1M
    expect(lines.join(' ')).not.toContain('/ 1M');
  });

  it('token 明细仍渲染 $in/$out / 1M，不受按次分支影响', () => {
    const lines = buildGroupBillingLines({
      details: {
        quotaType: 0,
        usage: {
          promptTokens: 100000, completionTokens: 10000, totalTokens: 110000,
          cacheReadTokens: 0, cacheCreationTokens: 0, billablePromptTokens: 100000,
          promptTokensIncludeCache: null,
        },
        pricing: {
          modelRatio: 2, completionRatio: 8, cacheRatio: 1, cacheCreationRatio: 1,
          groupRatio: 0.4, groupName: '组丁-chs', tierName: 'off_peak', evidenceSource: 'upstream-ratio',
        },
        breakdown: {
          inputPerMillion: 0.4, outputPerMillion: 1.6, cacheReadPerMillion: 0, cacheCreationPerMillion: 0,
          inputCost: 0.04, outputCost: 0.016, cacheReadCost: 0, cacheCreationCost: 0, totalCost: 0.056,
        },
      },
    }, money);

    expect(lines).toEqual(['组丁-chs（×0.4）', 'off_peak · $0.4/$1.6 / 1M']);
  });

  it('列表摘要路径：perCallPrice 也走 / call（不依赖明细接口）', () => {
    const lines = buildGroupBillingLines({
      summary: { groupName: '按次', groupRatio: 0.2, tierName: null, inputPerMillion: null, outputPerMillion: null, perCallPrice: 5 },
    }, money);
    expect(lines).toEqual(['按次（×0.2）', '$5 / call']);
  });

  it('旧记录无任何计费字段：返回空行，不画占位价', () => {
    const lines = buildGroupBillingLines({
      summary: { groupName: null, groupRatio: null, tierName: null, inputPerMillion: null, outputPerMillion: null, perCallPrice: null },
    }, money);
    expect(lines).toEqual([]);
  });
});

/**
 * fixed(X) 的实扣明细（2026-11-23 抓包实证）。
 *
 * 上游 `quota_type` 仍是 0，但 `billing_expr` 是 `fixed(...)` —— 按次收费。
 * 前端不能只看 quotaType：必须同时认 breakdown.perCallPrice，
 * 否则会落进 token 模板，把 `undefined × tokens` 渲染进日志。
 */
describe('fixed(X)：quotaType=0 但按次口径', () => {
  it('明细里出现 perCallPrice 就走 $X / call，不落进 / 1M 模板', () => {
    const lines = buildGroupBillingLines({
      details: {
        quotaType: 0,
        usage: {
          promptTokens: 34, completionTokens: 262, totalTokens: 296,
          cacheReadTokens: 0, cacheCreationTokens: 0, billablePromptTokens: 34,
          promptTokensIncludeCache: null,
        },
        pricing: {
          modelRatio: 37.5, completionRatio: 1, cacheRatio: 1, cacheCreationRatio: 1,
          groupRatio: 1, groupName: 'default', tierName: 'base', evidenceSource: 'upstream-dynamic-expr',
        },
        breakdown: {
          perCallPrice: 0.0004,
          inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0, totalCost: 0.0004,
        },
      },
    }, money);

    expect(lines).toEqual(['default（×1）', 'base · $0.0004 / call']);
    expect(lines.join(' ')).not.toContain('/ 1M');
  });

  it('列表摘要路径：quotaType=0 且 perCallPrice 有值时也走 / call', () => {
    const lines = buildGroupBillingLines({
      summary: {
        groupName: 'default', groupRatio: 1, tierName: 'base',
        inputPerMillion: null, outputPerMillion: null, perCallPrice: 0.0004,
      },
    }, money);
    expect(lines).toEqual(['default（×1）', 'base · $0.0004 / call']);
  });
});
