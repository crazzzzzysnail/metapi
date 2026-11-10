/**
 * 动态计费表达式的完整受限解析（S5b）。
 *
 * ## 与 billingExpr.ts 的关系
 * `billingExpr.ts` 是第一版白名单，只认单层 `tier(name, ...)`。
 * 本文件在其基础上扩展到**三种真实形态**（均取自 2026-11-09 的真实上游载荷）：
 *
 *   ① 单档        `tier("base", p * 1 + c * 1)`
 *   ② 按输入长度分档 `len <= 272000 ? tier("0_272k", ...) : tier("272k_plus", ...)`
 *   ③ 按时间分档    `weekday("UTC") >= 1 && weekday("UTC") <= 5
 *                    && ((hour("UTC") >= 9 && hour("UTC") < 12) || (hour("UTC") >= 14 && hour("UTC") < 18))
 *                    ? tier("peak", p * 2 + cr * 0.04 + c * 8) : tier("off_peak", p * 1 + cr * 0.02 + c * 4)`
 *
 * ## 铁律
 *   - **永不执行表达式**（不 eval、不 new Function），只做结构解析；
 *   - 解析不出来一律 `unsupported` + 原因码，**不回退倍率**、不给"看起来合理"的错数；
 *   - 计量项只认表达式里显式出现的系数，缺省 ≠ 1（上一版就栽在把缺省的 cache 当 1 倍，
 *     配合失效的 model_ratio 得出 $75/M 的假缓存价）。
 */

/** 表达式里的用量计量项。变量名与 New API 的 expr-lang 约定一致。 */
export type BillingMeter = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h';

const METER_VARIABLES: Record<string, BillingMeter> = {
  p: 'input',
  c: 'output',
  cr: 'cacheRead',
  cc: 'cacheWrite',
  cc1h: 'cacheWrite1h',
  ai: 'audioInput',
  ao: 'audioOutput',
} as unknown as Record<string, BillingMeter>;

/** 已知但本轮不支持定价的计量项（音频等模态），单独归因便于排查。 */
const KNOWN_UNSUPPORTED_METERS = new Set(['audioInput', 'audioOutput']);

export type BillingUnsupportedReason =
  | 'empty-expr'
  | 'not-a-tier-expression'
  | 'malformed-term'
  | 'unknown-variable'
  | 'unsupported-meter'
  | 'nested-condition'
  | 'invalid-threshold';

/** 单个档位的单价表（美元 / 每百万 token），未出现的计量项为 undefined。 */
export type TierRates = Partial<Record<BillingMeter, number>>;

/** 分档选择所需的输入条件。 */
export type TierCondition =
  | { kind: 'always' }
  /** len <= threshold 或 len > threshold（token 量分档） */
  | { kind: 'token-length'; operator: '<=' | '>'; thresholdTokens: number }
  /** 星期 + 小时区间（时间分档），小时均为 UTC */
  | { kind: 'calendar'; weekdays: number[]; hourRanges: Array<{ from: number; to: number }> };

export interface BillingTier {
  name: string;
  rates: TierRates;
  condition: TierCondition;
}

export type ParsedBillingPlanV2 =
  | { kind: 'single'; tier: BillingTier }
  | { kind: 'conditional'; tiers: BillingTier[]; selector: 'token-length' | 'calendar' }
  | { kind: 'unsupported'; reason: BillingUnsupportedReason; detail?: string; expr: string };

/** 兼容旧调用点的导出名。 */
export type BillingMeterKey = BillingMeter;

/**
 * 解析档位体：`p * 4 + cr * 0.4 + cc * 5 + c * 20`。
 * 支持 `var * num`、`num * var`、裸 `var`（视为 1）。减法与未知语法直接拒绝。
 */
function parseTierBody(body: string): { rates: TierRates } | { error: BillingUnsupportedReason; detail: string } {
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
    if (KNOWN_UNSUPPORTED_METERS.has(mapped)) {
      return { error: 'unsupported-meter', detail: `${variable}（音频模态本轮不支持）` };
    }
    if (!Number.isFinite(coefficient) || coefficient < 0) {
      return { error: 'malformed-term', detail: `系数非法: ${coefficient}` };
    }
    // 断言安全：mapped 已排除音频项，剩下的都在 BillingMeter 键集内
    rates[mapped as BillingMeter] = coefficient;
  }

  if (Object.keys(rates).length === 0) {
    return { error: 'malformed-term', detail: '空档位体' };
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
 * 解析时间条件：`weekday("UTC") >= 1 && weekday("UTC") <= 5 && ((hour...) || (hour...))`
 * 真实形态固定为「weekday 下界 && weekday 上界 && (小时区间的 OR 组合)」。
 */
function parseCalendarCondition(text: string): TierCondition | null {
  const wdLower = /weekday\(\s*"UTC"\s*\)\s*>=\s*(\d+)/.exec(text);
  const wdUpper = /weekday\(\s*"UTC"\s*\)\s*<=\s*(\d+)/.exec(text);
  if (!wdLower || !wdUpper) return null;

  const from = Number(wdLower[1]);
  const to = Number(wdUpper[1]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to > 7) return null;

  const weekdays: number[] = [];
  for(let day = from; day <= to; day += 1) weekdays.push(day);

  // 小时区间形如 (hour("UTC") >= 9 && hour("UTC") < 12)
  const hourRanges: Array<{ from: number; to: number }> = [];
  const rangePattern = /\(\s*hour\(\s*"UTC"\s*\)\s*>=\s*(\d+)\s*&&\s*hour\(\s*"UTC"\s*\)\s*<\s*(\d+)\s*\)/g;
  let matchedRange: RegExpExecArray | null;
  while ((matchedRange = rangePattern.exec(text)) !== null) {
    const hFrom = Number(matchedRange[1]);
    const hTo = Number(matchedRange[2]);
    if (!Number.isFinite(hFrom) || !Number.isFinite(hTo) || hFrom >= hTo || hTo > 24) return null;
    hourRanges.push({ from: hFrom, to: hTo });
  }
  if (hourRanges.length === 0) return null;

  return { kind: 'calendar', weekdays, hourRanges };
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
      tier: { name: tier.name, rates: parsed.rates, condition: { kind: 'always' } },
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
        { name: trueTier.name, rates: trueParsed.rates, condition: calendarCondition },
        { name: falseTier.name, rates: falseParsed.rates, condition: { kind: 'always' } },
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
      { name: trueTier.name, rates: trueParsed.rates, condition: lengthCondition },
      { name: falseTier.name, rates: falseParsed.rates, condition: opposite },
    ],
  };
}

/**
 * 判断给定输入是否在某个档位生效。
 * 时间档按 UTC 计算，与上游 `weekday("UTC")/hour("UTC")` 保持一致。
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

  const date = new Date(context.nowMs ?? Date.now());
  // JS getUTCDay(): 周日=0..周六=6；上游 weekday 采用 1..7（周一为首），需换算
  const jsDay = date.getUTCDay();
  const upstreamWeekday = jsDay === 0 ? 7 : jsDay;
  const hour = date.getUTCHours();

  if (!condition.weekdays.includes(upstreamWeekday)) return false;
  return condition.hourRanges.some((range) => hour >= range.from && hour < range.to);
}
