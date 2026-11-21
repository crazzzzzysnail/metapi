/**
 * perf-metrics 公示指标能力分类（S2-2 权威纯函数）。
 *
 * 逐站能力，绝不按 platform 猜（AGENTS.md「平台行为须显式」+ README 2.4）。
 * 实测 10 站里 new-api 家族 4 站有、sub2api/厂商直连 404；鉴权分匿名200/需session401/仅session不认sk-三种，
 * 且**必须逐端点实测、不可跨端点外推**（数据篇 L4：跨端点外推 401 曾写错过结论）。
 *
 * 本模块只做"状态码 → 四态"的纯分类，不发 HTTP、不写库。
 * 实际探测（匿名 + 凭据链各打一次 `GET /api/perf-metrics/summary?hours=24`）由 S2.5 预热服务发起并调本函数分类，
 * 再经共用写点落 `sites.perf_metrics_capability`。这样"探测口径"只有一份实现。
 */

export type PerfMetricsCapability = 'public' | 'auth' | 'cred_invalid' | 'none';

/** 值域全集（含 null=未探测），供 PUT 守卫与备份校验共用。 */
export const PERF_METRICS_CAPABILITY_VALUES: readonly (PerfMetricsCapability | null)[] = [
  'public', 'auth', 'cred_invalid', 'none', null,
];

/**
 * 探测两跳的 HTTP 状态。
 * - anon：不带凭据的匿名请求结果。
 * - authed：仅当 anon 是 401/403 时才发（带 session→apikey 候选链）；anon 已 200 或未触网时省略。
 * 非 HTTP 响应（连不上、超时、5xx 上游故障）传 `transportError: true`，分类返回 null（保持原值，绝不因抖动洗列）。
 */
export interface PerfProbeResult {
  anonStatus?: number;
  authedStatus?: number;
  /** true = 压根没拿到 HTTP 响应（网络/超时/上游 5xx），区别于"拿到了但 401/404"。 */
  transportError?: boolean;
}

function isUnauthorized(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/**
 * 分类四态（判据钉死，按数据篇第三节 + grilling Q9）：
 * - 200(匿名)                        → public       （siteA/B/F：匿名即得，且登录与否内容逐字节同）
 * - 401/403(匿名) + 200(带凭据)       → auth         （siteC：只认 session）
 * - 401/403(匿名) + 401/403(带凭据)   → cred_invalid （需登录站的会话挂了——独立信号，不是"站没功能"）
 * - 404                              → none         （sub2api/厂商直连：无该端点）
 * - 传输错误 / 其它(5xx)              → null         （不确定，保持原列，不洗）
 *
 * ⚠️ cred_invalid 与 none 必须分开：前者说"你的登录失效了"（autoRelogin 负责修），
 * 后者说"这站就没这功能"。混成"不可得"会把运维排查引向反方向（Q9 裁定新增第四态的理由）。
 */
export function classifyPerfMetricsProbe(result: PerfProbeResult): PerfMetricsCapability | null {
  if (result.transportError) return null;

  const anon = result.anonStatus;
  if (anon === 404) return 'none';
  if (anon === 200) return 'public';

  if (isUnauthorized(anon)) {
    const authed = result.authedStatus;
    if (authed === 200) return 'auth';
    if (isUnauthorized(authed)) return 'cred_invalid';
    // 匿名要登录、带凭据却没拿到明确结果（404/超时/5xx/未发）：不确定，不洗列。
    return null;
  }

  // 匿名给了非 200/401/403/404（如 5xx）：不确定。
  return null;
}

/**
 * PUT 入参归一（仿 balanceCapability 守卫：null/'' → 清空=未探测）。
 * 返回 { ok:true, value } 或 { ok:false }（非法值，调用方回 400）。
 * 注意：perf 四态是 public/auth/cred_invalid/none，**没有** balance 那套 auto/none 别名——
 * 手动清空用 null（=未探测，等下次预热重写），不允许手动钉成模糊的 'auto'。
 */
export function normalizePerfMetricsCapabilityInput(raw: unknown): { ok: true; value: PerfMetricsCapability | null } | { ok: false } {
  if (raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'public' || normalized === 'auth' || normalized === 'cred_invalid' || normalized === 'none') {
    return { ok: true, value: normalized };
  }
  return { ok: false };
}
