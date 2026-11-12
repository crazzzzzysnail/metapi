import { describe, expect, it } from 'vitest';
import {
  formatAmountInCurrency,
  formatBalance,
  formatBalanceInline,
  formatCompactTokenMetric,
  formatCostFixed,
  formatMoney,
  formatRateNumber,
  stripSymbol,
  trimMoneyZeros,
} from './numberFormat.js';

describe('formatCompactTokenMetric', () => {
  it('keeps small values uncompressed', () => {
    expect(formatCompactTokenMetric(950)).toBe('950');
  });

  it('formats thousands with K suffix', () => {
    expect(formatCompactTokenMetric(7_974)).toBe('8K');
  });

  it('formats millions with M suffix', () => {
    expect(formatCompactTokenMetric(1_800_000)).toBe('1.8M');
    expect(formatCompactTokenMetric(611_540_335)).toBe('611.5M');
  });
});


/**
 * 统一金额格式化（T8.1 / N3）。
 *
 * 收敛前三个页面各有一套精度规则，切到 CNY 后同屏会出现三种精度的换算值，
 * 无法分辨差异来自汇率还是舍入。这里锁定唯一出口的取值边界。
 */

describe('formatMoney 精度分档', () => {
  it('≥1 用 2 位小数', () => {
    expect(formatMoney(1234.5678)).toBe('$1234.57');
    expect(formatMoney(1000)).toBe('$1000');
    expect(formatMoney(75.5)).toBe('$75.5');
  });

  it('<1 用有效位数，且不保留补零占位（二-2）', () => {
    expect(formatMoney(0.8)).toBe('$0.8');
    // 这正是收敛前 Sites.tsx 的失效场景：恒定 2 位会把非零单价显示成 $0.00
    expect(formatMoney(0.00001)).toBe('$0.00001');
    expect(formatMoney(0.00001)).not.toBe('$0.00');
  });

  it('0 与负数、非法值都有确定输出', () => {
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(-0.5)).toBe('$-0.5');
    expect(formatMoney(Number.NaN)).toBe('$0');
    expect(formatMoney(null)).toBe('$0');
    expect(formatMoney(undefined)).toBe('$0');
  });

  it('trim=false 可保留固定小数位（报表/对齐场景）', () => {
    expect(formatMoney(1, 'USD', null, { trim: false })).toBe('$1.00');
  });
});

describe('formatBalance 余额口径（一-1 / 二-1）', () => {
  it('≥1 固定 2 位，保留补零（余额列需要对齐）', () => {
    expect(formatBalance(75)).toBe('$75.00');
    expect(formatBalance(1234.5678)).toBe('$1234.57');
  });

  it('<1 显示实际小数位数', () => {
    expect(formatBalance(0.8)).toBe('$0.8');
    expect(formatBalance(0.00001)).toBe('$0.00001');
  });

  it('0 按 2 位显示，不写成裸 $0', () => {
    expect(formatBalance(0)).toBe('$0.00');
    expect(formatBalance(null)).toBe('$0.00');
  });
});

describe('formatRateNumber / trimMoneyZeros', () => {
  it('去掉尾零但保留有效小数', () => {
    expect(trimMoneyZeros('0.80000')).toBe('0.8');
    expect(trimMoneyZeros('75.00')).toBe('75');
    expect(formatRateNumber(0.8)).toBe('0.8');
    expect(formatRateNumber(3.2)).toBe('3.2');
  });
});

describe('formatMoney 币种与汇率', () => {
  it('默认 USD', () => {
    expect(formatMoney(2)).toBe('$2');
  });

  it('CNY 按汇率换算并加符号', () => {
    expect(formatMoney(2, 'CNY', 7.2)).toBe('¥14.4');
  });

  it('CNY 但汇率缺失时明确标注，不静默按 USD 数字加 ¥', () => {
    const text = formatMoney(2, 'CNY', null);
    expect(text).toContain('汇率未知');
    // 关键：不得伪装成一个可信的人民币价
    expect(text).not.toBe('¥14.4');
    expect(formatMoney(2, 'CNY', 0)).toContain('汇率未知');
    expect(formatMoney(2, 'CNY', Number.NaN)).toContain('汇率未知');
  });

  it('负汇率同样视为不可用', () => {
    expect(formatMoney(2, 'CNY', -7)).toContain('汇率未知');
  });
});

/**
 * 2026-11-12：站点管理与连接管理接币种时暴露的口径漏洞。
 *
 * 原先「汇率未知」分支用的是当前币种符号，于是 `¥75.00（汇率未知）`
 * ——数字根本没换算，却顶着一个 ¥。用户看到的第一反应是"人民币才 75 元"。
 * 判据：汇率未知 = 保留美元符号 + 标注，和 SearchModal / 图表同一口径。
 */
describe('CNY 汇率未知时保留美元符号', () => {
  it('formatBalance 不得给未换算的美元数字贴 ¥', () => {
    expect(formatBalance(75, 'CNY', null)).toBe('$75.00（汇率未知）');
    expect(formatBalance(75, 'CNY', 0)).toBe('$75.00（汇率未知）');
    expect(formatBalance(0, 'CNY', null)).toBe('$0.00（汇率未知）');
    expect(formatBalance(0.8, 'CNY', null)).toBe('$0.8（汇率未知）');
  });

  it('formatMoney / formatCostFixed 同一判据', () => {
    expect(formatMoney(2, 'CNY', null)).toBe('$2（汇率未知）');
    expect(formatCostFixed(0.5, 6, 'CNY', null)).toBe('$0.500000（汇率未知）');
  });

  it('汇率有效时仍按汇率换算', () => {
    expect(formatBalance(100, 'CNY', 7.2)).toBe('¥720.00');
    expect(formatCostFixed(0.5, 6, 'CNY', 7.2)).toBe('¥3.600000');
  });

  /**
   * F6 修订（2026-11-12）：站点管理有独立汇率列、连接管理每条记录带站点徽标，
   * 汇率未知在别处已可见；金额后面再缀「（汇率未知）」会让整列被重复文字淹没。
   * 内联出口在同样场景下只退回 `$` 数字，不加后缀。
   */
  it('formatBalanceInline 汇率未知时不追加后缀', () => {
    expect(formatBalanceInline(75, 'CNY', null)).toBe('$75.00');
    expect(formatBalanceInline(75, 'CNY', 0)).toBe('$75.00');
    expect(formatBalanceInline(0.8, 'CNY', null)).toBe('$0.8');
    // 与带标注版本形成对照：同一个入参，只有后缀差异
    expect(formatBalance(75, 'CNY', null)).toBe('$75.00（汇率未知）');
  });

  it('formatBalanceInline 汇率有效时与 formatBalance 完全一致', () => {
    expect(formatBalanceInline(100, 'CNY', 7.2)).toBe('¥720.00');
    expect(formatBalanceInline(100, 'CNY', 7.2)).toBe(formatBalance(100, 'CNY', 7.2));
    expect(formatBalanceInline(100, 'USD')).toBe('$100.00');
  });
});

/**
 * F3：给"后端已逐站换算好的金额"加符号的专用出口。
 *
 * 立这个文件的直接原因是我差点写出二次换算的 bug：仪表盘的 totalBalanceCny
 * 已经是人民币值（B2 里按各站汇率算过），若复用 formatBalance(x,'CNY',rate)
 * 会再乘一次汇率，¥736 直接变成 ¥5374 这种量级。
 * 所以这里最要紧的一条断言是：**传多大的汇率都不会改变数值**。
 */
describe('formatAmountInCurrency（不做换算）', () => {
  it('CNY 只加符号，绝不乘任何系数', () => {
    expect(formatAmountInCurrency(736.34, 'CNY')).toBe('¥736.34');
    // 与 formatBalance 的关键差异：后者带 rate 会换算，这里没有 rate 参数可用
    expect(Number(formatAmountInCurrency(736.34, 'CNY').replace('¥', ''))).toBe(736.34);
  });

  it('USD 与不带币种调用结果一致', () => {
    expect(formatAmountInCurrency(100)).toBe('$100.00');
    expect(formatAmountInCurrency(100, 'USD')).toBe('$100.00');
  });

  it('精度沿用余额口径：≥1 两位、<1 展开有效位', () => {
    expect(formatAmountInCurrency(0.8, 'CNY')).toBe('¥0.8');
    expect(formatAmountInCurrency(0.00001, 'CNY')).toBe('¥0.00001');
    expect(formatAmountInCurrency(0, 'CNY')).toBe('¥0.00');
  });

  it('非零极小值不被裁成 0（$0 的语义是免费）', () => {
    expect(formatAmountInCurrency(1e-7, 'CNY')).toBe('¥0.000000');
    expect(formatAmountInCurrency(1e-7, 'CNY')).not.toBe('¥0');
  });

  it('非法输入回落到 0 表示而非 NaN', () => {
    expect(formatAmountInCurrency(Number.NaN, 'CNY')).toBe('¥0.00');
    expect(formatAmountInCurrency(null, 'USD')).toBe('$0.00');
    expect(formatAmountInCurrency(undefined, 'USD')).toBe('$0.00');
  });
});

describe('stripSymbol', () => {
  it('只剥开头符号，保留正负号与数字', () => {
    expect(stripSymbol('$1.50')).toBe('1.50');
    expect(stripSymbol('¥0.8')).toBe('0.8');
    expect(stripSymbol('$0.00')).toBe('0.00');
    // 「今日 +¥X」这类要先去符号再拼 +/-，否则会出现 +$ 双符号
    expect(`+${stripSymbol(formatAmountInCurrency(2.5, 'CNY'))}`).toBe('+2.50');
  });

  it('无符号串原样返回，空值不抛', () => {
    expect(stripSymbol('abc')).toBe('abc');
    expect(stripSymbol('')).toBe('');
    expect(stripSymbol(undefined as unknown as string)).toBe('');
  });
});
