import { describe, expect, it } from 'vitest';
import { formatCustomAmountValue, formatCustomCurrencyAmount } from './upstreamCurrencyDisplay.js';

/**
 * 自定义货币金额渲染（S6）判据锁。数值均为合成样本。
 * 防三件事：① 用上游真实符号且前缀式 `符号 数值`；② 符号缺失时只显示数字，
 * 不拿占位符冒充不存在的符号；③ 倍率非法或金额非有限时返回 null。
 */

describe('formatCustomCurrencyAmount 自定义货币读数', () => {
  it('能量 ×10：100.25 USD → 符号前置「能量 1002.50」', () => {
    expect(formatCustomCurrencyAmount('能量', 10, 100.25)).toBe('能量 1002.50');
  });

  it('🍊 ×1：50.5 USD → 「🍊 50.50」（符号原样前置，rate=1 不改数值）', () => {
    expect(formatCustomCurrencyAmount('🍊', 1, 50.5)).toBe('🍊 50.50');
  });

  it('符号是空白/不可显示：默认裸数字，不编造符号', () => {
    // symbol 是空格/零宽 → trim 成空 → 只显示数字，绝不据空白编造符号。
    expect(formatCustomCurrencyAmount(' ', 10, 100.25)).toBe('1002.50');
    expect(formatCustomCurrencyAmount('　', 10, 100.25)).toBe('1002.50'); // 全角空格
    expect(formatCustomCurrencyAmount(null, 10, 100.25)).toBe('1002.50');
    expect(formatCustomCurrencyAmount('', 10, 100.25)).toBe('1002.50');
  });

  it('小额走有效位分支、大额走两位小数（与其它金额出口同一精度策略）', () => {
    // ×10 后仍很小的请求成本：保留有效位而不是四舍五入成 0.00。
    expect(formatCustomCurrencyAmount('能量', 10, 0.000042)).toBe('能量 0.00042');
    // 大额固定两位。
    expect(formatCustomCurrencyAmount('能量', 10, 812.345)).toBe('能量 8123.45');
  });

  it('倍率非法（0/负/NaN）或金额非有限：返回 null，不画半截读数', () => {
    expect(formatCustomCurrencyAmount('能量', 0, 100)).toBeNull();
    expect(formatCustomCurrencyAmount('能量', -5, 100)).toBeNull();
    expect(formatCustomCurrencyAmount('能量', Number.NaN, 100)).toBeNull();
    expect(formatCustomCurrencyAmount('能量', null, 100)).toBeNull();
    expect(formatCustomCurrencyAmount('能量', 10, null)).toBeNull();
    expect(formatCustomCurrencyAmount('能量', 10, Number.NaN)).toBeNull();
  });
});

describe('formatCustomAmountValue 精度', () => {
  it('非有限值返回空串（调用方据此退化为不显示）', () => {
    expect(formatCustomAmountValue(Number.NaN)).toBe('');
    expect(formatCustomAmountValue(Number.POSITIVE_INFINITY)).toBe('');
  });
});
