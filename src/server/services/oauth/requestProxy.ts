import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { getOAuthProviderDefinition } from './providers.js';
import { resolveProxyUrlFromExtraConfig } from '../accountExtraConfig.js';
import { resolveProxyUrlForSite, resolveSiteProxyUrlByRequestUrl } from '../siteProxy.js';

/** 无账号上下文（provider 级流）：退化为站点层解析，含池与勾选系统代理 */
export async function resolveOauthProviderProxyUrl(provider: string): Promise<string | null> {
  const definition = getOAuthProviderDefinition(provider);
  if (!definition) return null;
  return resolveSiteProxyUrlByRequestUrl(definition.site.url);
}

/**
 * OAuth 连接与普通账号同一条链：账号整层（自定义>池>勾选系统）优先，
 * 空则站点整层（自定义>池>勾选系统）。站点按 siteId 取记录解析，
 * 不用 URL 前缀匹配——避免命中同前缀的其它站点行导致口径漂移。
 */
export async function resolveOauthAccountProxyUrl(input: {
  siteId?: number | null;
  extraConfig?: string | null;
}): Promise<string | null> {
  const accountProxyUrl = resolveProxyUrlFromExtraConfig(input.extraConfig);
  if (accountProxyUrl) return accountProxyUrl;
  if (!input.siteId || input.siteId <= 0) return null;
  const site = await db.select({
    proxyUrl: schema.sites.proxyUrl,
    proxyId: schema.sites.proxyId,
    useSystemProxy: schema.sites.useSystemProxy,
  }).from(schema.sites).where(eq(schema.sites.id, input.siteId)).get();
  if (!site) return null;
  return resolveProxyUrlForSite({
    proxyUrl: site.proxyUrl,
    proxyId: site.proxyId,
    useSystemProxy: !!site.useSystemProxy,
  });
}
