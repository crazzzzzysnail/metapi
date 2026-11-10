import { describe, expect, it } from 'vitest';
import { formatMoney } from '../../../web/numberFormat.js';
import { convertSiteUsdToCny, summarizeByCurrency } from './currencySplit.js';

/**
 * S6 / T8.12 · 双币切换的行为矩阵。
 *
 * 要守住的不是"能换算"，而是四件事：
 *   ① 精度按量级分档，极小单价不被舍成 $0.00；
 *   ② 汇率缺失必须显式标注，绝不套默认汇率；
 *   ③ 逐站换算、缺汇率站点排除并计数（R7）；
 *   ④ 两个开关彼此正交 —— 切货币不改倍率，切口径不改币种。
 */

describe('① 精度分档', () => {
  it.each([
    [1234.5678, '$1234.57'],
    [1, '$1'],
    [0.5, '$0.5'],
    [0.00001, '$0.00001'],
    [0, '$0'],
  ])('%s → %s', (value, expected) => {
    expect(formatMoney(value)).toBe(expected);
  });

  it('极小值保留可见位数（不补零，也不塌成 $0.00）', () => {
    // 契约：<0.0001 用 6 位小数展示，并裁掉补零。
    expect(formatMoney(1e-6)).toBe('$0.000001');
    expect(formatMoney(0.00001)).toBe('$0.00001');
    expect(formatMoney(0.00001)).not.toBe('$0.00');
    // 低于 6 位精度是已知限制：此处如实锁定当前行为，而不是假装它能显示。
    // 注意仍输出 $0.000000 而非 $0 —— 非零值不许被裁成"免费"。
    expect(formatMoney(1e-7)).toBe('$0.000000');
  });

  it('非法输入一律归零而不是 NaN 文本', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, 'abc']) {
      const text = formatMoney(bad as never);
      expect(text).not.toContain('NaN');
      expect(text.startsWith('$')).toBe(true);
    }
  });
});

describe('② 汇率缺失的诚实表达', () => {
  it('null / 0 / 负数 / NaN 四种无效汇率都标注，不伪装成可信数字', () => {
    for (const rate of [null, undefined, 0, -7.3, Number.NaN]) {
      const text = formatMoney(2, 'CNY', rate as number | null | undefined);
      expect(text).toContain('汇率未知');
      expect(text).not.toBe('¥14.600');
    }
  });

  it('有效汇率正常换算', () => {
    expect(formatMoney(2, 'CNY', 7.3)).toBe('¥14.6');
    expect(convertSiteUsdToCny(1, 7.3)).toBe(7.3);
    expect(convertSiteUsdToCny(1, null)).toBeNull();
  });

  it('换算结果同样受精度分档约束', () => {
    // 0.00001 × 7.3 = 0.000073 → 应保留可见位数，不为 ¥0.00
    const text = formatMoney(0.00001, 'CNY', 7.3);
    expect(text).not.toBe('¥0.00');
    expect(text.startsWith('¥')).toBe(true);
  });
});

describe('③ 逐站换算与排除', () => {
  it('混合场景：已知站点入合计，未知站点进 excluded 计数', () => {
    const result = summarizeByCurrency([
      { siteId: 1, usd: 100, cnyPerUsd: 7.3 },
      { siteId: 2, usd: 50, cnyPerUsd: null },
      { siteId: 3, usd: 20, cnyPerUsd: 7 },
    ]);
    expect(result.usdTotal).toBe(170);
    expect(result.cnyTotal).toBeCloseTo(100 * 7.3 + 20 * 7, 6);
    expect(result.includedSiteCount).toBe(2);
    expect(result.excludedSiteCount).toBe(1);
    expect(result.excludedSites).toEqual([{ siteId: 2, reason: 'rate-unknown' }]);
  });

  it('USD 合计永不受汇率影响（这是双轨口径的前提）', () => {
    const allUnknown = summarizeByCurrency([
      { siteId: 1, usd: 10, cnyPerUsd: null },
      { siteId: 2, usd: 20, cnyPerUsd: null },
    ]);
    expect(allUnknown.usdTotal).toBe(30);
    expect(allUnknown.cnyTotal).toBe(0);
    expect(allUnknown.excludedSiteCount).toBe(2);
  });

  it('每站用自己的汇率，不共用一个汇率（R7 逐站语义）', () => {
    const result = summarizeByCurrency([
      { siteId: 1, usd: 10, cnyPerUsd: 7.3 },
      { siteId: 2, usd: 10, cnyPerUsd: 6.5 },
    ]);
    expect(result.cnyTotal).toBeCloseTo(73 + 65, 6);
    // 若误用统一汇率会得到 146 或 130，而非 138
    expect(result.cnyTotal).not.toBeCloseTo(146, 6);
  });
});

describe('④ 两个开关的正交性', () => {
  it('只切货币：金额数值随汇率变，倍率不参与', () => {
    const officialUsd = formatMoney(1);
    const officialCny = formatMoney(1, 'CNY', 7.3);
    expect(officialUsd).toBe('$1');
    expect(officialCny).toBe('¥7.3');
  });

  it('只切口径：美元内部乘倍率，不涉及汇率', () => {
    // effective = official × group_ratio，两者都在 USD 域内完成
    const ratio = 0.15;
    const official = 2;
    const effective = official * ratio;
    expect(formatMoney(official)).toBe('$2');
    expect(formatMoney(effective)).toBe('$0.3');
  });

  it('同时切两个开关：先乘倍率再换算，顺序不影响结果', () => {
    const official = 2;
    const ratio = 0.15;
    const rate = 7.3;
    const viaEffectiveThenConvert = formatMoney(official * ratio, 'CNY', rate);
    const expected = formatMoney(0.3, 'CNY', rate);
    expect(viaEffectiveThenConvert).toBe(expected);
    expect(viaEffectiveThenConvert).toBe('¥2.19');
  });

  it('CNY + 汇率未知时，即使口径已切换也不能给出伪造成果', () => {
    const text = formatMoney(2 * 0.15, 'CNY', null);
    expect(text).toContain('汇率未知');
  });
});
