/**
 * 动态计费表达式的受限解析。只认四种形态，永不执行表达式：
 *
 *   ① 单档   `tier("base", p * 1 + c * 1)`
 *   ② 按次   `tier("base", fixed(0.01))` —— 每请求固定美元价
 *   ③ 长度档 `len <= 272000 ? tier("0_272k", ...) : tier("272k_plus", ...)`
 *   ④ 时间档 `weekday("TZ") >= a && weekday("TZ") <= b && (hour("TZ")...) ? tier(...) : tier(...)`
 *
 * 判不出的形态一律 `unsupported` + 原因码，由调用方标未知；解析器本身不回退倍率、不给近似数。
 * 计量项只认表达式里显式出现的系数 —— 缺省 ≠ 1。
 */

/** 用量计量项。 */
export type BillingMeter = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h' | 'cacheWrite12h';

const METER_VARIABLES: Record<string, BillingMeter> = {
  p: 'input',
  c: 'output',
  cr: 'cacheRead',
  cc: 'cacheWrite',
  cc1h: 'cacheWrite1h',
  cc12h: 'cacheWrite12h',
  ai: 'audioInput',
  ao: 'audioOutput',
} as unknown as Record<string, BillingMeter>;

/**
 * 音频模态：照常解析但不换算成每百万单价，实扣与展示都按 0。
 * 与 `unknown-variable`（整式不认识）不同 —— 这里认识，只是不进价。
 * 某档若只有音频项、无文本项，仍按 unsupported 拒绝。
 */
const UNPRICED_METERS = new Set(['audioInput', 'audioOutput']);

export type BillingUnsupportedReason =
  | 'empty-expr'
  | 'not-a-tier-expression'
  | 'malformed-term'
  | 'unknown-variable'
  | 'unsupported-meter'
  | 'nested-condition'
  | 'invalid-threshold'
  /** fixed 与 token 系数混用：两种计费单位无法统一。 */
  | 'mixed-billing';

/** 单个档位的单价表（美元 / 每百万 token），未出现的计量项为 undefined。 */
export type TierRates = Partial<Record<BillingMeter, number>> & {
  audioInput?: number;
  audioOutput?: number;
};

/** 分档选择所需的输入条件。 */
export type TierCondition =
  | { kind: 'always' }
  /** len <= threshold 或 len > threshold（token 量分档） */
  | { kind: 'token-length'; operator: '<=' | '>'; thresholdTokens: number }
  /**
   * 时间分档。星期与小时都按 `timezone` 指定的 IANA 时区解释（取自表达式，不是 UTC），
   * 判档与展示必须用同一时区。`weekdays` 已归一：1=周一..7=周日，上游写 0 也按周日处理。
   */
  | { kind: 'calendar'; timezone: string; weekdays: number[]; hourRanges: Array<{ from: number; to: number }> };

export interface BillingTier {
  name: string;
  rates: TierRates;
  condition: TierCondition;
  /**
   * `fixed(N)` 的每请求固定美元价。存在时 `rates` 为空 —— 该档按次收费，与按 token 互斥。
   */
  fixedPerRequest?: number;
}

export type ParsedBillingPlanV2 =
  | { kind: 'single'; tier: BillingTier }
  | { kind: 'conditional'; tiers: BillingTier[]; selector: 'token-length' | 'calendar' }
  | { kind: 'unsupported'; reason: BillingUnsupportedReason; detail?: string; expr: string };

/** 兼容旧调用点的导出名。 */
export type BillingMeterKey = BillingMeter;

/**
 * 档位体解析结果：token 系数表 / fixed 每请求价 / 拒绝原因，三者互斥。
 */
type TierBodyParseResult =
  | { rates: TierRates }
  | { fixedPerRequest: number }
  | { error: BillingUnsupportedReason; detail: string };

/**
 * 解析档位体：`p * 4 + cr * 0.4 + cc * 5 + c * 20`，或 `fixed(0.01)`。
 * 支持 `var * num`、`num * var`、裸 `var`（视为 1）。减法与未知语法直接拒绝。
 */
function parseTierBody(body: string): TierBodyParseResult {
  // fixed(N) 必须在逐项解析之前识别：它不含 `*`，落到逐项里会被判 malformed-term。
  const fixedMatch = /^fixed\s*\(\s*(\d+(?:\.\d+)?)\s*\)$/.exec(body.trim());
  if (fixedMatch) {
    const amount = Number(fixedMatch[1]);
    if (!Number.isFinite(amount) || amount < 0) {
      return { error: 'malformed-term', detail: `fixed 金额非法: ${fixedMatch[1]}` };
    }
    return { fixedPerRequest: amount };
  }

  const rates: TierRates = {};

  if (body.includes('-')) {
    return { error: 'malformed-term', detail: '含减法（负单价无业务含义）' };
  }

  for (const chunk of body.split('+')) {
    const term = chunk.trim();
    if (!term) continue;

    const varFirst = /^([A-Za-z][A-Za-z0-9_]*)\s*\*\s*(\d+(?:\.\d+)?)$/.exec(term);
    const numFirst = /^(\d+(?:\.\d+)?)\s*\*\s*([A-Za-z][A-Za-z0-9_]*)$/.exec(term);
    const bareVar = /^([A-Za-z][A-Za-z0-9_]*)$/.exec(term);

    let variable = '';
    let coefficient = 1;

    if (varFirst) {
      variable = varFirst[1];
      coefficient = Number(varFirst[2]);
    } else if (numFirst) {
      variable = numFirst[2];
      coefficient = Number(numFirst[1]);
    } else if (bareVar) {
      variable = bareVar[1];
    } else {
      return { error: 'malformed-term', detail: term };
    }

    const mapped = METER_VARIABLES[variable];
    if (!mapped) return { error: 'unknown-variable', detail: variable };
    if (!Number.isFinite(coefficient) || coefficient < 0) {
      return { error: 'malformed-term', detail: `系数非法: ${coefficient}` };
    }
    // 音频项照常解析进 rates，由换算层决定是否进价（见 UNPRICED_METERS）。
    rates[mapped as BillingMeterKey] = coefficient;
  }

  // 至少要有一个可计价（非纯音频）计量项，否则这一档没有可显示/可扣的价。
  const pricedCount = Object.keys(rates).filter((k) => !UNPRICED_METERS.has(k)).length;
  if (pricedCount === 0) {
    return Object.keys(rates).length === 0
      ? { error: 'malformed-term', detail: '空档位体' }
      : { error: 'unsupported-meter', detail: '档位仅含音频等不可计价项' };
  }
  return { rates };
}

/** 提取 `tier("name", body)` —— body 内可能含括号，故用非贪婪配对到最后一个 `)`。 */
function extractTier(callText: string): { name: string; body: string } | null {
  const matched = /^\s*tier\s*\(\s*"([^"]*)"\s*,\s*([\s\S]+)\s*\)\s*$/.exec(callText.trim());
  if (!matched) return null;
  return { name: matched[1] || 'base', body: matched[2] };
}

/**
 * 把档位体解析结果落成 BillingTier。
 * `rates` 与 `fixedPerRequest` 互斥：fixed 档不带任何 token 系数。
 */
function buildTier(
  name: string,
  parsed: Exclude<TierBodyParseResult, { error: BillingUnsupportedReason; detail: string }>,
  condition: TierCondition,
): BillingTier {
  if ('fixedPerRequest' in parsed) {
    return { name, rates: {}, condition, fixedPerRequest: parsed.fixedPerRequest };
  }
  return { name, rates: parsed.rates, condition };
}

/**
 * 解析时间条件：`weekday("TZ") >= a && weekday("TZ") <= b && ((hour("TZ") >= c && hour("TZ") < d) || ...)`。
 * 时区取自 weekday/hour 的字符串参数。
 */
function parseCalendarCondition(text: string): TierCondition | null {
  const tzMatch = /(?:weekday|hour)\(\s*"([A-Za-z0-9_+\-/]+)"\s*\)/.exec(text);
  if (!tzMatch) return null;
  const timezone = tzMatch[1];

  // weekday 与 hour 必须同时区，混用即非本解析器认识的形态。
  const tzPattern = new RegExp(`(?:weekday|hour)\\(\\s*"([^"]+)"\\s*\\)`, 'g');
  let tzSeen: RegExpExecArray | null;
  while ((tzSeen = tzPattern.exec(text)) !== null) {
    if (tzSeen[1] !== timezone) return null;
  }

  const wdLower = new RegExp(`weekday\\(\\s*"${escapeRe(timezone)}"\\s*\\)\\s*>=\\s*(\\d+)`).exec(text);
  const wdUpper = new RegExp(`weekday\\(\\s*"${escapeRe(timezone)}"\\s*\\)\\s*<=\\s*(\\d+)`).exec(text);
  if (!wdLower || !wdUpper) return null;

  const from = Number(wdLower[1]);
  const to = Number(wdUpper[1]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to > 7) return null;

  // 星期归一：内部用 1=周一..7=周日，上游写 0 也视为周日（兼容 Go 周日=0 与 ISO 周日=7 两套约定）。
  const weekdays: number[] = [];
  for (let day = from; day <= to; day += 1) weekdays.push(day === 0 ? 7 : day);
  const normalizedWeekdays = Array.from(new Set(weekdays)).sort((a, b) => a - b);

  // 小时区间形如 (hour("UTC") >= 9 && hour("UTC") < 12)
  const hourRanges: Array<{ from: number; to: number }> = [];
  const tzEsc = escapeRe(timezone);
  const rangePattern = new RegExp(
    `\\(\\s*hour\\(\\s*"${tzEsc}"\\s*\\)\\s*>=\\s*(\\d+)\\s*&&\\s*hour\\(\\s*"${tzEsc}"\\s*\\)\\s*<\\s*(\\d+)\\s*\\)`,
    'g',
  );
  let matchedRange: RegExpExecArray | null;
  while ((matchedRange = rangePattern.exec(text)) !== null) {
    const hFrom = Number(matchedRange[1]);
    const hTo = Number(matchedRange[2]);
    if (!Number.isFinite(hFrom) || !Number.isFinite(hTo) || hFrom >= hTo || hTo > 24) return null;
    hourRanges.push({ from: hFrom, to: hTo });
  }
  if (hourRanges.length === 0) return null;

  return { kind: 'calendar', timezone, weekdays: normalizedWeekdays, hourRanges };
}

/** 把时区名转义成正则可用形态（斜杠、加号等）。 */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 指定 IANA 时区在某时刻的本地分量：星期（1=周一..7=周日）与小时（0-23）。
 * 判档与展示共用此口径；用 Intl 以正确处理 DST。时区名非法时退回 UTC 分量。
 */
export function zonedParts(dateMs: number, timezone: string): { weekday: number; hour: number } {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    });
  } catch {
    // 时区名非法：退回 UTC 分量，不抛错。判档结果可能偏差，但优于整档解析失败退失效倍率。
    const d = new Date(dateMs);
    const jsDay = d.getUTCDay();
    return { weekday: jsDay === 0 ? 7 : jsDay, hour: d.getUTCHours() };
  }

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(dateMs))) parts[part.type] = part.value;

  const weekdayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  const weekday = weekdayMap[(parts.weekday || '').slice(0, 3)] ?? (new Date(dateMs).getUTCDay() === 0 ? 7 : new Date(dateMs).getUTCDay());
  const hour = Number.parseInt(parts.hour || '0', 10);
  return { weekday, hour: Number.isFinite(hour) ? hour : 0 };
}

/** 解析 `len <= 272000` / `len > 272000` 形式的阈值条件。 */
function parseLengthCondition(text: string): TierCondition | null {
  const matched = /^\s*len\s*(<=|>)\s*(\d+)\s*$/.exec(text.trim());
  if (!matched) return null;
  const threshold = Number(matched[2]);
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  return { kind: 'token-length', operator: matched[1] as '<=' | '>', thresholdTokens: threshold };
}

/**
 * 主入口。
 *
 * 判定顺序经过设计：先分离三元结构，再解析各档位；
 * 任何一步失败都返回带原因的 unsupported，绝不部分成功。
 */
export function parseBillingExprV2(raw: unknown): ParsedBillingPlanV2 {
  const expr = typeof raw === 'string' ? raw.trim() : '';
  if (!expr) return { kind: 'unsupported', reason: 'empty-expr', expr };

  const ternaryIndex = expr.indexOf('?');

  // ① 单档
  if (ternaryIndex < 0) {
    const tier = extractTier(expr);
    if (!tier) return { kind: 'unsupported', reason: 'not-a-tier-expression', expr };
    const parsed = parseTierBody(tier.body);
    if ('error' in parsed) {
      return { kind: 'unsupported', reason: parsed.error, detail: parsed.detail, expr };
    }
    return {
      kind: 'single',
      tier: buildTier(tier.name, parsed, { kind: 'always' }),
    };
  }

  // ② / ③ 三元分档：condition ? tierA : tierB
  const conditionText = expr.slice(0, ternaryIndex);
  const rest = expr.slice(ternaryIndex + 1);
  const branchSplit = rest.split(':');
  if (branchSplit.length !== 2) {
    return { kind: 'unsupported', reason: 'nested-condition', detail: '三元分支数不为 2', expr };
  }

  const trueTier = extractTier(branchSplit[0]);
  const falseTier = extractTier(branchSplit[1]);
  if (!trueTier || !falseTier) {
    return { kind: 'unsupported', reason: 'not-a-tier-expression', detail: '分支不是 tier(...)', expr };
  }

  const trueParsed = parseTierBody(trueTier.body);
  const falseParsed = parseTierBody(falseTier.body);
  if ('error' in trueParsed) return { kind: 'unsupported', reason: trueParsed.error, detail: trueParsed.detail, expr };
  if ('error' in falseParsed) return { kind: 'unsupported', reason: falseParsed.error, detail: falseParsed.detail, expr };

  // fixed 与 token 系数混用：一个档按次、一个档按 token，没有统一的展示与实扣单位。
  // 与 all-api-hub 的处置一致（它也拒绝 mixed fixed/token leaves）。
  if (('fixedPerRequest' in trueParsed) !== ('fixedPerRequest' in falseParsed)) {
    return { kind: 'unsupported', reason: 'mixed-billing', detail: 'fixed 与 token 系数混用', expr };
  }

  // 时间条件优先判定（其文本含 weekday/hour，绝不会误判成 len）
  const isCalendar = /weekday\(|hour\(/.test(conditionText);

  if (isCalendar) {
    const calendarCondition = parseCalendarCondition(conditionText);
    if (!calendarCondition) {
      return { kind: 'unsupported', reason: 'invalid-threshold', detail: '时间条件无法解析', expr };
    }
    // 时间分档语义：条件成立走 peak，否则 off_peak（后者恒生效）
    return {
      kind: 'conditional',
      selector: 'calendar',
      tiers: [
        buildTier(trueTier.name, trueParsed, calendarCondition),
        buildTier(falseTier.name, falseParsed, { kind: 'always' }),
      ],
    };
  }

  const lengthCondition = parseLengthCondition(conditionText);
  if (!lengthCondition || lengthCondition.kind !== 'token-length') {
    return {
      kind: 'unsupported',
      reason: 'invalid-threshold',
      detail: `无法解析条件: ${conditionText.trim().slice(0, 60)}`,
      expr,
    };
  }

  // len <= N 的反面是 len > N
  const opposite: TierCondition = lengthCondition.operator === '<='
    ? { kind: 'token-length', operator: '>', thresholdTokens: lengthCondition.thresholdTokens }
    : { kind: 'token-length', operator: '<=', thresholdTokens: lengthCondition.thresholdTokens };

  return {
    kind: 'conditional',
    selector: 'token-length',
    tiers: [
      buildTier(trueTier.name, trueParsed, lengthCondition),
      buildTier(falseTier.name, falseParsed, opposite),
    ],
  };
}

/**
 * 判断给定输入是否在某个档位生效。
 * 时间档按**表达式声明的时区**判定（`weekday("TZ")/hour("TZ")`），与上游一致。
 */
export function tierMatchesAt(tier: BillingTier, context: {
  inputTokens: number;
  nowMs?: number;
}): boolean {
  const condition = tier.condition;
  if (condition.kind === 'always') return true;

  if (condition.kind === 'token-length') {
    return condition.operator === '<='
      ? context.inputTokens <= condition.thresholdTokens
      : context.inputTokens > condition.thresholdTokens;
  }

  const { weekday, hour } = zonedParts(context.nowMs ?? Date.now(), condition.timezone);
  if (!condition.weekdays.includes(weekday)) return false;
  return condition.hourRanges.some((range) => hour >= range.from && hour < range.to);
}

/**
 * 取指定 IANA 时区在某时刻相对 UTC 的偏移（分钟，正数=东时区）。
 * 非法时区返回 null。用 Intl 的墙钟分量反推，不依赖 Node 内部 tz 数据库细节。
 */
export function zoneOffsetMinutes(dateMs: number, timezone: string): number | null {
  const wall = (tz: string): number | null => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(dateMs));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
      // 把该时区的墙钟读数当作 UTC 时间戳；与真值之差即该时区相对 UTC 的偏移
      return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    } catch {
      return null;
    }
  };

  const zoneWall = wall(timezone);
  const utcWall = wall('UTC');
  if (zoneWall === null || utcWall === null) return null;
  const baseMs = Math.floor(dateMs / 1000) * 1000;
  return Math.round((zoneWall - baseMs) / 60000) - Math.round((utcWall - baseMs) / 60000);
}

/** 一组「星期(1..7) × 小时[from,to)」点集，用于时区投影后重新聚合。 */
type HourRange = { from: number; to: number };

/** 投影后的一个显示窗口：`hourTo > 24` 表示跨午夜（次日时段），起始日记在 weekdays。 */
export interface ProjectedCalendarWindow {
  /** 该窗口在展示时区下的起始星期集合（1=周一..7=周日）。 */
  weekdays: number[];
  hourFrom: number;
  /** 相对起始日的结束小时；>24 表示结束在次日。 */
  hourTo: number;
}

/**
 * 把 calendar 条件从**声明时区**投影到**展示时区**（用户要求把 UTC 分段计费换算为
 * Asia/Shanghai 展示）。只做显示换算，判档仍由 `tierMatchesAt` 按声明时区精确执行。
 *
 * 关键正确性：跨午夜窗口必须保持「起始日 + 次日结束」的耦合 ——
 * 峰段 周一至周五 14:00-18:00 UTC 投影到上海是 周一至周五 22:00-次日02:00，
 * 若按天分裂成「周五 22-24 / 周六 0-2」就丢了原意（周六 0-2 并非峰段）。
 *
 * 偏移非整小时（如 +5:30 / DST 半小时档）时对齐不了整点，返回 null，
 * 由调用方退回原样并标注声明时区，而不是显示一个对不齐的错窗。
 *
 * @param referenceMs 取偏移的参考时刻；缺省当前时间。固定时区（UTC / Asia/Shanghai）下无影响；
 *                    DST 切换正落在窗口内时可能与真实本地时间差一小时，属已知的展示近似。
 */
export function projectCalendarWindows(
  condition: Extract<TierCondition, { kind: 'calendar' }>,
  displayTimezone: string,
  referenceMs: number = Date.now(),
): ProjectedCalendarWindow[] | null {
  const srcOffset = zoneOffsetMinutes(referenceMs, condition.timezone);
  const dstOffset = zoneOffsetMinutes(referenceMs, displayTimezone);
  if (srcOffset === null || dstOffset === null) return null;

  const deltaMin = dstOffset - srcOffset;
  if (deltaMin % 60 !== 0) return null;
  const deltaHours = Math.round(deltaMin / 60);

  // 同偏移下所有 (星期,区间) 的平移量一致；用线性"周分"坐标做平移，再按
  // (起始日, 小时跨度) 聚合回星期集合。
  const byKey = new Map<string, { hourFrom: number; hourTo: number; days: Set<number> }>();
  for (const range of condition.hourRanges) {
    for (const weekday of condition.weekdays) {
      const linearStart = (weekday - 1) * 24 + range.from + deltaHours;
      const startDay = Math.floor(linearStart / 24);
      const hourFrom = linearStart - startDay * 24;
      const hourTo = hourFrom + (range.to - range.from);
      const normalizedDay = ((startDay % 7) + 7) % 7 + 1;
      const key = `${hourFrom}-${hourTo}`;
      const bucket = byKey.get(key) ?? { hourFrom, hourTo, days: new Set<number>() };
      bucket.days.add(normalizedDay);
      byKey.set(key, bucket);
    }
  }

  return Array.from(byKey.values())
    .map((bucket) => ({
      weekdays: Array.from(bucket.days).sort((a, b) => a - b),
      hourFrom: bucket.hourFrom,
      hourTo: bucket.hourTo,
    }))
    .sort((a, b) => a.hourFrom - b.hourFrom || a.hourTo - b.hourTo);
}
