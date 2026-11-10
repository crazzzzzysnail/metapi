/**
 * 动态计费表达式的**受限**解析（S5b 的第一片）。
 *
 * ## 为什么不是完整解析器
 *
 * 主方案 T5.1 设想了约 1300 行、覆盖多档 / token 区间 / 日历条件 / 服务层级 /
 * 图片与音频因子的解析器，语义对齐 all-api-hub。但实测取证（A1/A5）显示：
 * 真实上游 `/api/pricing` 里出现过的表达式只有一种最简形态 ——
 *
 *     tier("base", p * 1 + c * 1)
 *
 * 没有 `len` 区间、没有多档、没有日历项。为没见过的语法先写 1300 行，
 * 等于用未验证的代码去决定用户看到的钱数，风险高于收益。
 *
 * 因此本文件采取**白名单 + 明确拒绝**策略：
 *   - 只接受能完整推导单价的形态；
 *   - 任何超出白名单的语法返回 `unsupported` 并给出原因码；
 *   - **永不执行表达式**（不 eval、不 new Function），只做结构解析。
 *
 * 后续若真拿到多档载荷，再按同一出口形状扩展即可，调用方无需改动。
 */

/** 表达式里出现的用量计量项。 */
export type BillingMeter = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h';

/** 变量名 → 计量项。与 New API 的 expr-lang 约定一致。 */
const METER_VARIABLES: Record<string, BillingMeter> = {
  p: 'input',
  c: 'output',
  cr: 'cacheRead',
  cc: 'cacheWrite',
  cc1h: 'cacheWrite1h',
};

export type ParsedBillingPlan =
  | {
      kind: 'flat';
      /** 每百万 token 的美元单价；无法确定的计量项缺省表示"上游未给"。 */
      rates: Partial<Record<BillingMeter, number>>;
      /** 档位名（tier 的第一个参数），扁平单档时为 'base' 一类。 */
      tierName: string;
    }
  | {
      kind: 'unsupported';
      reason: BillingUnsupportedReason;
      /** 原始表达式，便于排查与后续人工补录。 */
      expr: string;
    };

export type BillingUnsupportedReason =
  | 'empty-expr'
  | 'not-a-tier-call'
  | 'multiple-tiers'
  | 'has-conditional'
  | 'unknown-variable'
  | 'malformed-term';

/**
 * 解析 `tier("<name>", <线性组合>)` 形态。
 *
 * 支持：`p * 3 + c * 15 + cr * 0.3`，即「计量项 × 系数」的和，顺序任意。
 * 不支持：三元/布尔运算、函数嵌套、`len`、多档、日历项 —— 一律 unsupported。
 */
export function parseBillingExpr(raw: unknown): ParsedBillingPlan {
  const expr = typeof raw === 'string' ? raw.trim() : '';
  if (!expr) return { kind: 'unsupported', reason: 'empty-expr', expr };

  // 条件与多档必须先拒：它们意味着"价格取决于请求内容"，
  // 用一个静态单价去显示本身就是错的。
  if (/[?&|]/.test(expr) || /<=|>=|<|>/.test(expr)) {
    return { kind: 'unsupported', reason: 'has-conditional', expr };
  }

  const tierCalls = expr.match(/\btier\s*\(/g) || [];
  if (tierCalls.length !== 1) {
    return { kind: 'unsupported', reason: tierCalls.length > 1 ? 'multiple-tiers' : 'not-a-tier-call', expr };
  }

  // 允许 `tier("base", p * 1 + c * 1)`；引号内是档位名
  const outer = /^tier\s*\(\s*"([^"]*)"\s*,\s*(.+?)\s*\)$/s.exec(expr);
  if (!outer) return { kind: 'unsupported', reason: 'not-a-tier-call', expr };

  const tierName = outer[1] || 'base';
  const body = outer[2];

  // 按 + 拆分项；减号不支持（负单价没有业务含义，出现即说明语法超出预期）
  if (body.includes('-')) return { kind: 'unsupported', reason: 'malformed-term', expr };

  const rates: Partial<Record<BillingMeter, number>> = {};
  for (const chunk of body.split('+')) {
    const term = chunk.trim();
    if (!term) continue;

    // 三种合法项形态：`var * num`、`num * var`、裸 `var`（系数视为 1）。
    // 逐式匹配而不是用一条大正则的分支捕获，避免"哪一侧是变量"判错。
    let variable: string | null = null;
    let coefficient = 1;

    const varFirst = /^([A-Za-z][A-Za-z0-9_]*)\s*\*\s*([\d.]+)$/.exec(term);
    const numFirst = /^([\d.]+)\s*\*\s*([A-Za-z][A-Za-z0-9_]*)$/.exec(term);
    const bareVar = /^([A-Za-z][A-Za-z0-9_]*)$/.exec(term);

    if (varFirst) {
      variable = varFirst[1];
      coefficient = Number(varFirst[2]);
    } else if (numFirst) {
      variable = numFirst[2];
      coefficient = Number(numFirst[1]);
    } else if (bareVar) {
      variable = bareVar[1];
      coefficient = 1;
    } else {
      return { kind: 'unsupported', reason: 'malformed-term', expr };
    }

    const meter = METER_VARIABLES[variable];
    if (!meter) return { kind: 'unsupported', reason: 'unknown-variable', expr };
    if (!Number.isFinite(coefficient) || coefficient < 0) {
      return { kind: 'unsupported', reason: 'malformed-term', expr };
    }
    rates[meter] = coefficient;
  }

  if (Object.keys(rates).length === 0) {
    return { kind: 'unsupported', reason: 'malformed-term', expr };
  }

  return { kind: 'flat', rates, tierName };
}

/**
 * 把解析结果换算成目录用的每百万单价。
 * 只有 `flat` 计划才有结果；unsupported 一律 null，由调用方标未知。
 */
export function billingPlanToPerMillion(
  plan: ParsedBillingPlan,
): Partial<Record<BillingMeter, number>> | null {
  return plan.kind === 'flat' ? plan.rates : null;
}
