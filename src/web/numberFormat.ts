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
      // 汇率未知时保留美元符号：数值本身没有换算过，贴 ¥ 会让人把它当成人民币读数。
      return `${CURRENCY_SYMBOLS.USD}${safe.toFixed(2)}（汇率未知）`;
    }
    return `${symbol}${amount.toFixed(2)}`;
  }
  // <1 走 formatMoney 的有效位数分支，并裁掉补零 —— 用户判据是"显示实际小数位数"。
  // 例外：0 按 2 位显示（`$0.00`），"0/无余额"写成 `$0` 反而像缺单位。
  if (safe === 0) {
    const rate = Number(cnyPerUsd);
    if (currency === 'CNY' && (!Number.isFinite(rate) || rate <= 0)) return `${CURRENCY_SYMBOLS.USD}0.00（汇率未知）`;
    return `${symbol}0.00`;
  }
  return formatMoney(safe, currency, cnyPerUsd, { trim: true });
}

/**
 * 给"已经换算过"的金额加符号与精度（F3）。
 *
 * 存在理由：formatBalance / formatMoney 的 CNY 分支都会**再乘一次汇率**。
 * 而仪表盘汇总金额、以及任何由后端逐站算好的 CNY 数字，本身已经是人民币值 ——
 * 再传汇率进去就是二次换算，会把 ¥736 变成 ¥5374 这种量级的错。
 * 这个出口明确不做换算，只负责符号与小数位；需要换算的场景请继续用 formatBalance。
 */
export function formatAmountInCurrency(
  value: unknown,
  currency: DisplayCurrency = 'USD',
): string {
  const safe = toSafeNumber(value);
  const symbol = CURRENCY_SYMBOLS[currency] ?? CURRENCY_SYMBOLS.USD;
  if (Math.abs(safe) >= 1 || safe === 0) return `${symbol}${safe.toFixed(2)}`;
  const text = safe.toFixed(decimalsFor(Math.abs(safe)));
  const trimmed = trimMoneyZeros(text);
  // 非零值被裁成 0 时保留原精度（同 formatMoney 的 N2 语义）
  return `${symbol}${Math.abs(safe) > 0 && Number(trimmed) === 0 ? text : trimmed}`;
}

/**
 * 站点级余额的内联展示（F6 修订，2026-11-12）。
 *
 * 与 formatBalance 的唯一差异：**汇率未知时不追加「（汇率未知）」后缀**。
 * 依据：站点管理有独立的「汇率」列（黄色徽标），连接管理每条记录都带站点徽标，
 * 汇率是否维护过在别处已经可见；每个金额后面再缀同一句话，一屏会出现十几次，
 * 用户实测反馈"过于臃肿"。这里退回纯美元数字（`$75.00`），由 $ 符号本身说明未换算。
 *
 * 仅这两页使用；搜索结果、图表等没有旁路提示的地方仍用 formatBalance 的带标注分支。
 */
export function formatBalanceInline(
  value: unknown,
  currency: DisplayCurrency = 'USD',
  cnyPerUsd?: number | null,
): string {
  const rate = Number(cnyPerUsd);
  if (currency === 'CNY' && (!Number.isFinite(rate) || rate <= 0)) return formatBalance(value, 'USD');
  return formatBalance(value, currency, rate);
}

/**
 * 去掉币种符号。
 * 用于「今日 +¥X」这类自带正负号、不希望重复出现符号的场合。
 */
export function stripSymbol(text: string): string {
  return String(text || '').replace(/^[¥$]/, '');
}

/**
 * 固定小数位的成本格式化（F3）。
 *
 * 存在理由：聚合成本（日志页「消耗总额」、密钥成本趋势）原本用
 * `${x.toFixed(4)}` / `${x.toFixed(6)}` 散写，既要收敛掉手写的 $ 前缀，
 * 又**不能**套用 formatAmountInCurrency 的"≥1 只留 2 位"规则 ——
 * 我实测把 $1.2300 变成 $1.23 就立刻被既有测试抓到，说明这个位数是有人在依赖的。
 *
 * 所以这里只做两件事：按指定精度定长输出 + 由共享币种表给符号。
 * 刻意不裁尾零：聚合成本里 0.0000 与 0.0001 必须看得出区别。
 */
export function formatCostFixed(
  value: unknown,
  digits = 6,
  currency: DisplayCurrency = 'USD',
  cnyPerUsd?: number | null,
): string {
  const safe = toSafeNumber(value);
  const symbol = CURRENCY_SYMBOLS[currency] ?? CURRENCY_SYMBOLS.USD;
  if (currency === 'CNY') {
    const rate = Number(cnyPerUsd);
    if (!Number.isFinite(rate) || rate <= 0) return `${CURRENCY_SYMBOLS.USD}${safe.toFixed(digits)}（汇率未知）`;
    return `${symbol}${(safe * rate).toFixed(digits)}`;
  }
  return `${symbol}${safe.toFixed(digits)}`;
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
      return `${CURRENCY_SYMBOLS.USD}${plain(safe)}（汇率未知）`;
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
