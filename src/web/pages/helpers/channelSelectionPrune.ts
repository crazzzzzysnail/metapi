/**
 * 通道选择与现存通道求交集（B3.5，方案 A 契约的例外通道）。
 * - 未加载通道的路由：选择集原样保留（不能断定通道已不存在）。
 * - 已加载的路由：剔除不在现存集合中的 id；id 永不复用（AUTOINCREMENT），
 *   交集缩小即"所选通道已不存在"，changed=true 由调用方提示一次。
 * 被筛选隐藏的勾选不在剔除范围（筛选永不收缩选择集）。
 */
export function pruneStaleChannelSelections(
  selections: Record<number, number[]>,
  channelsByRouteId: Record<number, Array<{ id: number }>>,
): { next: Record<number, number[]>; changed: boolean } {
  let changed = false;
  const next: Record<number, number[]> = {};
  for (const [key, ids] of Object.entries(selections)) {
    const routeId = Number(key);
    const channels = channelsByRouteId[routeId];
    if (!channels) { next[routeId] = ids; continue; }
    const alive = new Set(channels.map((channel) => channel.id));
    const kept = ids.filter((id) => alive.has(id));
    if (kept.length !== ids.length) changed = true;
    next[routeId] = kept;
  }
  return { next, changed };
}
