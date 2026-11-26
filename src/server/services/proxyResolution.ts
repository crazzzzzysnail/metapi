import { config } from '../config.js';
import { proxyPoolDefaultUrl, proxyPoolUrlOf } from './proxyPoolStore.js';
import { normalizeSiteProxyUrl } from './proxyUrlNormalize.js';

/** 单个持有者（账号或站点）的三格代理配置 */
export type ProxyHolderConfig = {
  proxyUrl?: string | null;
  proxyId?: number | null;
  useSystemProxy?: boolean | null;
  /** 系统格回落地址（调用方显式给定，如 settings 行镜像）；缺省回落 config.systemProxyUrl */
  systemProxyUrl?: string | null;
};

/**
 * 地址轴解析：自定义地址 > 代理池地址 > 系统代理地址（勾选才用，取池默认条目）。
 * 账号层与站点层共用同一实现，差异只在传入哪三格。
 * 系统代理严格「显式勾选」：未勾选则绝不被动套用池默认条目（对应方案的直连兜底）。
 * 池缓存未加载时（启动播种前/脱机测试），系统格回落到调用方指定地址或 config 镜像。
 */
export function resolveHolderProxyUrl(holder: ProxyHolderConfig | null | undefined): string | null {
  if (!holder) return null;

  const custom = normalizeSiteProxyUrl(holder.proxyUrl);
  if (custom) return custom;

  const pooled = proxyPoolUrlOf(holder.proxyId);
  if (pooled) return pooled;

  if (holder.useSystemProxy === true) {
    return proxyPoolDefaultUrl()
      || normalizeSiteProxyUrl(holder.systemProxyUrl ?? config.systemProxyUrl);
  }

  return null;
}
