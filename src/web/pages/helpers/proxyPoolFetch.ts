import { api, type ProxyPoolEntry } from '../../api.js';

/**
 * 静默拉取代理池：失败时返回空数组。
 * 池只影响下拉候选与徽标名称，读取失败不能让站点/连接列表整页陪葬，
 * 也不该在列表页弹错误条（设置页编辑池时才需要显式报错）。
 */
export async function fetchProxyPoolQuietly(): Promise<ProxyPoolEntry[]> {
  try {
    const res = await api.getProxyPool();
    return Array.isArray(res?.items) ? res.items : [];
  } catch {
    return [];
  }
}
