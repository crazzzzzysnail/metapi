import { tr } from '../../i18n.js';

/**
 * 余额可得性的前端判据（F8）。
 *
 * 从 Accounts 页抽出来的原因：搜索弹窗也要显示同一批连接的余额，
 * 两处各写一份"读到过没有"的推断迟早会分叉 —— 一处出 `—`、一处出 `$0.00`。
 * 这里只做判定，不做格式化：最终是否画成占位符还由 formatBalanceOrDash 把关
 * （它还要求金额为 0，非零值一律照常显示）。
 */

/** 服务端下发的余额证据；字段与 accountExtraConfig 里的 BalanceEvidence 对齐。 */
export interface AccountBalanceEvidence {
  status?: string | null;
  reason?: string | null;
  source?: string | null;
  capturedAt?: number | null;
}

/** 判定函数只关心这两个字段，页面传入的整行对象天然满足。 */
export interface BalanceAvailabilityAccount {
  lastBalanceRefresh?: string | null;
  balanceEvidence?: AccountBalanceEvidence | null;
}

/**
 * 「这个余额数字是不是从没读到过」。
 *
 * 优先级：成功时间戳 > 服务端下发的 balanceEvidence > runtimeHealth 推断 > 兜底"没读到"。
 * 成功时间戳排最前有实测依据：库里有些连接（如订阅式站点的副号）余额是真的，
 * 但从不走余额刷新、`last_balance_refresh` 为空 —— 若用证据优先，它们会被判成"没读到"。
 *
 * 推断口径两条硬规矩：
 * 1) runtimeHealth 只用来**印证失败**，且只认 source === 'balance'。它是泛用状态槽，
 *    凭证过期（source:'auth'）、站点禁用（source:'system'）也会改它，拿它当"读到过"的
 *    正面证据会把正常余额涂成 —。
 * 2) 本函数只回答"读到过没有"，最终是否出 `—` 由 formatBalanceOrDash 决定
 *    （它还要求金额为 0，非零值一律照常显示）。
 */
export function isBalanceNeverRead(account: BalanceAvailabilityAccount | null | undefined): boolean {
  const lastRead = account?.lastBalanceRefresh;
  if (!(lastRead === null || lastRead === undefined || lastRead === '')) return false;
  const evidence = account?.balanceEvidence;
  const status = typeof evidence?.status === 'string' ? evidence.status : '';
  if (status === 'known') return false;
  if (status === 'unavailable' || status === 'not-applicable') return true;
  // 既无时间戳也无证据：按"没读到"处理。runtimeHealth 的 source/state 在这里
  // 不改变结论（降级与缺失同样按没读到），保留读取只为让意图可读，不参与分支。
  return true;
}

/**
 * 余额格的悬停说明：只在真的画成 `—` 时挂到 title 上，解释"为什么没有数字"。
 * 团队约定（F6）：原因不进正文，只进 tooltip —— 逐格重复的后缀已被明确否掉。
 * 证据缺失时回落一句通用文案，绝不猜具体故障。
 */
export function balanceUnavailableHint(account: BalanceAvailabilityAccount | null | undefined): string {
  const evidence = account?.balanceEvidence;
  const status = typeof evidence?.status === 'string' ? evidence.status : '';
  const reason = typeof evidence?.reason === 'string' ? evidence.reason : '';
  if (status === 'not-applicable') {
    return reason === 'unlimited-quota' ? tr('无限配额，不受额度约束') : tr('该站点不提供余额接口');
  }
  if (status === 'unavailable') {
    if (reason === 'endpoint-unauthorized') return tr('鉴权失败，未能读取余额');
    if (reason === 'endpoint-unreachable') return tr('上游不可达，未能读取余额');
    if (reason === 'malformed-payload') return tr('上游返回的数据无法解析');
  }
  return tr('尚未读取到余额');
}

/**
 * 无限配额不是"没读到"，画成 `∞` 而不是 `—`。
 * 只认证据里的 not-applicable/unlimited-quota，不靠余额数字猜。
 */
export function isUnlimitedQuota(account: BalanceAvailabilityAccount | null | undefined): boolean {
  const evidence = account?.balanceEvidence;
  return evidence?.status === 'not-applicable' && evidence?.reason === 'unlimited-quota';
}
