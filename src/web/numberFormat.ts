function toSafeNumber(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return value;
}

function trimTrailingZero(value: string): string {
  return value.replace(/\.0$/, '');
}

export function formatCompactTokenMetric(value: number): string {
  const normalized = Math.round(toSafeNumber(value));
  const absoluteValue = Math.abs(normalized);

  if (absoluteValue >= 1_000_000_000) {
    return `${trimTrailingZero((normalized / 1_000_000_000).toFixed(1))}B`;
  }

  if (absoluteValue >= 1_000_000) {
    return `${trimTrailingZero((normalized / 1_000_000).toFixed(1))}M`;
  }

  if (absoluteValue >= 1_000) {
    return `${trimTrailingZero((normalized / 1_000).toFixed(1))}K`;
  }

  return normalized.toLocaleString();
}


/**
 * 金额币种与格式化（T8.1 / N3）。
 *
 * 收敛前的状况：同一屏上并存三套互不相同的金额精度 ——
 *   - `Sites.tsx`        → 恒定 2 位小数
 *   - `downstream-keys`  → ≥1 用 3 位、否则 6 位
 *   - `ModelAnalysisPanel` → ≥1000 用 2 位、≥1 用 3 位、否则 6 位
 * 一旦切到 CNY（S6），三种精度会同时出现在换算后的数字上，肉眼无法判断差异来自汇率还是舍入。
 * 因此先统一成一个出口，S6 只需在这里加币种与汇率参数。
 */

export type DisplayCurrency = 'USD' | 'CNY';

const CURRENCY_SYMBOLS: Record<DisplayCurrency, string> = {
  USD: '$',
  CNY: '¥',
};

/**
 * 小数位数分档。
 *
 * ⚠️ 2026-11-09 改判据（VPS 实测反馈）：原实现是「≥1000 用 2 位、≥1 用 3 位、否则 6 位」，
 * 于是余额显示成 `$75.500`、分组价显示成 `0.80000` —— 用户明确不接受补零占位。
 * 现规则：**默认保留 2 位，只有绝对值 <1 才按有效位数展开**（4 位足够覆盖 $0.00001/M，
 * 再小给 6 位兜底，至少保证非零金额不塌成 `$0.00` 被读成"免费"）。
 */
function decimalsFor(absoluteValue: number): number {
  if (absoluteValue >= 1) return 2;
  // 极小值：给足位数，避免非零金额显示成 $0.0000（那会被读成免费）。
  if (absoluteValue === 0) return 2;
  if (absoluteValue >= 0.0001) return 4;
  return 6;
}

/**
 * 去掉小数尾部的 0：`$75.50` → `$75.5`、`$75.00` → `$75`、`0.80000` → `0.8`。
 * 只处理带小数点的串，整数与 `汇率未知` 等后缀不受影响。
 */
export function trimMoneyZeros(text: string): string {
  return text.replace(/(\.\d*?)0+$/g, '$1').replace(/\.$/g, '');
}

/**
 * 余额类金额格式化（一-1 / 二-1）。
 *
 * 与 formatMoney 的唯一区别：**≥1 时固定保留 2 位小数且不裁剪尾零**。
 * 用户判据是"总余额应保留 2 位小数，仅在余额小于 1 时才显示实际小数位数" ——
 * `$75.00` 在这里是正确形态（余额列需要可对比的对齐感），而单价才需要裁掉补零。
 * 两者分开，避免为了裁尾零把余额列改成 `$75`。
 */
export function formatBalance(
  value: unknown,
  currency: DisplayCurrency = 'USD',
  cnyPerUsd?: number | null,
): string {
  const safe = toSafeNumber(value);
  const symbol = CURRENCY_SYMBOLS[currency] ?? CURRENCY_SYMBOLS.USD;
  // <1 走 formatMoney 的有效位数分支；≥1 恒 2 位。
  if (Math.abs(safe) >= 1) {
    const amount = currency === 'CNY'
      ? (() => {
        const rate = Number(cnyPerUsd);
        return Number.isFinite(rate) && rate > 0 ? safe * rate : null;
      })()
      : safe;
    if (amount === null) {
      return `${symbol}${safe.toFixed(2)}（汇率未知）`;
    }
    return `${symbol}${amount.toFixed(2)}`;
  }
  // <1 走 formatMoney 的有效位数分支，并裁掉补零 —— 用户判据是"显示实际小数位数"。
  // 例外：0 按 2 位显示（`$0.00`），"0/无余额"写成 `$0` 反而像缺单位。
  if (safe === 0) {
    const rate = Number(cnyPerUsd);
    if (currency === 'CNY' && (!Number.isFinite(rate) || rate <= 0)) return `${symbol}0.00（汇率未知）`;
    return `${symbol}0.00`;
  }
  return formatMoney(safe, currency, cnyPerUsd, { trim: true });
}

/**
 * 单价类数字格式化（带币种符号，允许裁尾零）。
 * `$0.8`、`$3.2` —— 这是模型广场与路由通道里"每百万 token 多少钱"的写法。
 */
export function formatPrice(value: unknown): string {
  return formatMoney(value, 'USD', null, { trim: true });
}

/**
 * 统一的金额格式化。
 *
 * @param value     以 USD 计的金额（换算在调用前完成，本函数只管展示）
 * @param currency  目标币种，默认 USD
 * @param cnyPerUsd 汇率；currency 为 CNY 且汇率无效时退回原值并标注，绝不猜汇率
 * @param options.trim 是否去掉小数尾部补零，默认 true（用户判据：不许用 0 占位）
 */
export function formatMoney(
  value: unknown,
  currency: DisplayCurrency = 'USD',
  cnyPerUsd?: number | null,
  options?: { trim?: boolean },
): string {
  const safe = toSafeNumber(value);
  const symbol = CURRENCY_SYMBOLS[currency] ?? CURRENCY_SYMBOLS.USD;
  const trim = options?.trim !== false;
  const plain = (amount: number) => {
    const text = amount.toFixed(decimalsFor(Math.abs(amount)));
    if (!trim) return text;
    const trimmed = trimMoneyZeros(text);
    // 非零值被裁成 0 时保留原精度：那是"小于显示精度"，不是"免费"（N2 语义）。
    if (Math.abs(amount) > 0 && Number(trimmed) === 0) return text;
    return trimmed;
  };

  // CNY 但汇率不可用：明确标出来，而不是静默按 USD 数字加个 ¥ 符号。
  if (currency === 'CNY') {
    const rate = Number(cnyPerUsd);
    if (!Number.isFinite(rate) || rate <= 0) {
      return `${symbol}${plain(safe)}（汇率未知）`;
    }
    return `${symbol}${plain(safe * rate)}`;
  }

  return `${symbol}${plain(safe)}`;
}

/**
 * 单价/倍率类数字的裸数值格式（无币种符号）。
 * 用于模型广场的分组计费 —— 那里价格后面跟的是 `/ 1M` 而非币种，
 * 同样不允许 `0.80000` 这种补零写法。
 */
export function formatRateNumber(value: unknown): string {
  const safe = toSafeNumber(value);
  return trimMoneyZeros(safe.toFixed(decimalsFor(Math.abs(safe))));
}

/**
 * 输入/输出单价的成对写法（4 / 5）。
 *
 * 统一成一个出口的原因：原先模型广场拼 `0.8/3.2 USD /1M`、路由通道拼另一套、
 * 日志页又是 `$${x.toFixed(6)}`，同一个价三处不同形。
 * 规范：**每个数字都带币种符号**、分隔符是 `/`、单位前有一个空格 ——
 *   `$0.8/$3.2 / 1M`、`¥0.8/¥3.2 / 1M`、`$0.1 / call`。
 *
 * @param convert 换算回调；返回 null 表示该站点汇率未知，调用方须显示"汇率未知"而不是猜
 */
export function formatPricePair(input: number | undefined, output: number | undefined, unit: 'perMillion' | 'perCall'): string {
  const suffix = unit === 'perMillion' ? ' / 1M' : ' / call';
  if (input == null) return `—${suffix}`;
  if (output == null) return `${formatPrice(input)}${suffix}`;
  return `${formatPrice(input)}/${formatPrice(output)}${suffix}`;
}

/**
 * 按币种与站点汇率渲染一对单价（供模型广场 / 路由通道 / 日志共用）。
 * 汇率未知时返回 null —— 由调用方决定显示"汇率未知"还是回退美元，绝不静默按 ¥ 前缀贴美元数。
 */
export function formatPricePairWithCurrency(
  input: number | undefined,
  output: number | undefined,
  unit: 'perMillion' | 'perCall',
  currency: DisplayCurrency,
  cnyPerUsd?: number | null,
): string | null {
  if (currency === 'USD') {
    const suffix = unit === 'perMillion' ? ' / 1M' : ' / call';
    if (input == null) return `—${suffix}`;
    if (output == null) return `${formatMoney(input, 'USD')}${suffix}`;
    return `${formatMoney(input, 'USD')}/${formatMoney(output, 'USD')}${suffix}`;
  }
  const rate = Number(cnyPerUsd);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const suffix = unit === 'perMillion' ? ' / 1M' : ' / call';
  if (input == null) return `—${suffix}`;
  const convertedInput = formatMoney(input * rate, 'CNY', 1);
  if (output == null) return `${convertedInput}${suffix}`;
  return `${convertedInput}/${formatMoney(output * rate, 'CNY', 1)}${suffix}`;
}
