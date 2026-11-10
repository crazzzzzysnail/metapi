/**
 * 分组名判据（三-1）。
 *
 * 单独成模块的理由有两个：
 *   ① 路由通道展示（routes/api/tokens.ts）与实扣计价（modelPricingService）
 *      必须用**同一份**判据，否则会出现"界面按 A 档显示、实扣按 B 档记账"；
 *   ② 它是纯函数，放在这里可以让两边的测试各自 mock 掉重依赖而不影响它。
 */

/** auto 这类"没有独立倍率"的别名。上游 new-api 的 usable_group.auto 明确写着「此分组无效」。 */
const AUTO_GROUP_ALIASES = new Set(['auto', '自动']);

export function isAutoGroupName(value: string | null | undefined): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.length > 0 && AUTO_GROUP_ALIASES.has(normalized);
}
