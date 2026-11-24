/**
 * 自定义货币金额渲染（S6 · 单一职责）。
 *
 * 把 USD 金额换算成"上游页面显示的数字 + 上游符号"：显示值 = usd × rate。
 * 站点页与日志页共用本出口，避免两处各写一份前缀实现而格式漂移。
 *
 * 诚实性约定：symbol 原样使用；为空时**只显示数字**，不用 `×N` 或占位符
 * 冒充一个不存在的符号。"是否自定义货币"由调用方判定（站点页看 quota_display_type，
 * 日志页档案已由 currencyContext 限定为 CUSTOM）。
 */

/** 金额文本：≥1 固定两位、<1 保留 4 位有效数字，与 metapi 其他金额出口一致。 */
export function formatCustomAmountValue(amount: number): string {
  if (!Number.isFinite(amount)) return '';
  return Math.abs(amount) >= 1 ? amount.toFixed(2) : String(Number(amount.toPrecision(4)));
}

/**
 * 渲染自定义货币读数：符号前置 `符号 数值`，与上游"符号 + 数值"的读法一致。
 * 符号缺失/为空白时只返回裸数字，绝不替站主编一个符号；
 * rate 非法或 usd 非有限值时返回 null（不画半截信息）。
 */
export function formatCustomCurrencyAmount(
  symbol: string | null | undefined,
  rate: number | null | undefined,
  usd: number | null | undefined,
): string | null {
  const multiplier = Number(rate);
  // ⚠️ 必须先判 null/undefined 再 Number()：Number(null) === 0 是有限值，
  // 缺金额会被当成"0 单位"画出来 —— 与"确实余额为 0"无法区分，正是该防的假读数。
  if (usd == null) return null;
  const value = Number(usd);
  if (!Number.isFinite(multiplier) || multiplier <= 0 || !Number.isFinite(value)) return null;
  const text = formatCustomAmountValue(value * multiplier);
  if (!text) return null;
  const trimmedSymbol = (symbol || '').trim();
  return trimmedSymbol ? `${trimmedSymbol} ${text}` : text;
}
