import { normalizeSiteProxyUrl } from './proxyUrlNormalize.js';

/**
 * 代理池的只读同步状态：解析链在 fetch 初始化时被同步调用，必须无 IO 取址。
 * 本模块刻意不 import db / siteProxy / proxyPoolService，只依赖归一化叶子，
 * 由此保证 accountExtraConfig → proxyResolution → 本模块 这条链不拉起库连接、不成环。
 * 写入方是 proxyPoolService（每次 CRUD 与启动后整体替换）。
 */

export type ProxyPoolCacheEntry = { id: number; url: string; isDefault: boolean };

let byId = new Map<number, string>();
let defaultUrlValue: string | null = null;

/** 整体替换缓存；URL 一律归一化，非法地址不入缓存 */
export function setProxyPoolCache(entries: ProxyPoolCacheEntry[]): void {
  const next = new Map<number, string>();
  let nextDefault: string | null = null;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'number') continue;
    const url = normalizeSiteProxyUrl(entry.url);
    if (!url) continue;
    next.set(entry.id, url);
    if (entry.isDefault && nextDefault === null) nextDefault = url;
  }
  byId = next;
  defaultUrlValue = nextDefault;
}

export function clearProxyPoolCache(): void {
  byId = new Map();
  defaultUrlValue = null;
}

/** 引用 id → 地址；未知 id 视为未选择（返回 null，由调用方落到下一格） */
export function proxyPoolUrlOf(id: number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  return byId.get(id) ?? null;
}

/** 池内是否存在该 id（供写入侧校验引用；与取址分离，避免把「地址非法」当「不存在」） */
export function proxyPoolHasId(id: number | null | undefined): boolean {
  if (id === null || id === undefined) return false;
  return byId.has(id);
}

/** 系统代理地址：池默认条目 URL；无默认则为 null（显式勾选但无默认条目 → 直连） */
export function proxyPoolDefaultUrl(): string | null {
  return defaultUrlValue;
}
