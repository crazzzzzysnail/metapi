import { describe, expect, it } from 'vitest';
import {
  formatBalance,
  formatCompactTokenMetric,
  formatMoney,
  formatRateNumber,
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
