import { AsyncLocalStorage } from 'node:async_hooks';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { lookup as dnsLookup } from 'node:dns';
import { isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { SocksClient } from 'socks';
import type { Dispatcher, RequestInit as UndiciRequestInit } from 'undici';
import { Agent as UndiciAgent, ProxyAgent } from 'undici';
import { mergeHeadersWithSiteCustomHeaders } from './siteCustomHeaders.js';
import { resolveProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import { stripTrailingSlashes } from './urlNormalization.js';
import { resolveHolderProxyUrl } from './proxyResolution.js';
import { SUPPORTED_PROXY_PROTOCOLS, normalizeSiteProxyUrl, parseSiteProxyUrlInput } from './proxyUrlNormalize.js';

// 归一化与入参解析的真源在 proxyUrlNormalize；此处复导出保持既有 import 面不破。
export { SUPPORTED_PROXY_PROTOCOLS, normalizeSiteProxyUrl, parseSiteProxyUrlInput };

const SITE_PROXY_CACHE_TTL_MS = 3_000;
const SOCKS_PROXY_PROTOCOLS = new Set([
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
]);
const DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PROXY_KEEPALIVE_INITIAL_DELAY_MS = 60_000;

type SiteProxyRow = {
  siteUrl: string;
  proxyUrl: string | null;
  proxyId: number | null;
  useSystemProxy: boolean;
  customHeaders: unknown;
};

export type SiteProxyConfigLike = {
  proxyUrl?: string | null;
  proxyId?: number | null;
  useSystemProxy?: boolean | null;
  customHeaders?: unknown;
};

let siteProxyCache: {
  loadedAt: number;
  rows: SiteProxyRow[];
  systemProxyUrl: string | null;
} = {
  loadedAt: 0,
  rows: [],
  systemProxyUrl: null,
};

const dispatcherCache = new Map<string, Dispatcher>();

const accountProxyOverride = new AsyncLocalStorage<string | null>();

export function withAccountProxyOverride<T>(
  proxyUrl: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const normalized = normalizeSiteProxyUrl(proxyUrl);
  if (!normalized) return fn();
  return accountProxyOverride.run(normalized, fn);
}

type ParsedSocksProxyConfig = {
  shouldLookup: boolean;
  proxy: {
    host: string;
    port: number;
    type: 4 | 5;
    userId?: string;
    password?: string;
  };
};

type UndiciConnectOptions = {
  hostname: string;
  host?: string;
  protocol: string;
  port: string;
  servername?: string;
  localAddress?: string | null;
  httpSocket?: Socket;
};

export function normalizeSiteUrl(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    const normalizedPath = stripTrailingSlashes(parsed.pathname);
    return `${parsed.origin}${normalizedPath}`;
  } catch {
    return stripTrailingSlashes(trimmed);
  }
}

async function getCachedSiteProxyRows(nowMs = Date.now()): Promise<SiteProxyRow[]> {
  if ((nowMs - siteProxyCache.loadedAt) < SITE_PROXY_CACHE_TTL_MS) {
    return siteProxyCache.rows;
  }

  try {
    const [rows, systemProxySetting] = await Promise.all([
      db
        .select({
          siteUrl: schema.sites.url,
          proxyUrl: schema.sites.proxyUrl,
          proxyId: schema.sites.proxyId,
          useSystemProxy: schema.sites.useSystemProxy,
          customHeaders: schema.sites.customHeaders,
        })
        .from(schema.sites)
        .all(),
      db.select({ value: schema.settings.value })
        .from(schema.settings)
        .where(eq(schema.settings.key, 'system_proxy_url'))
        .get(),
    ]);
    const parsedSystemProxyUrl = normalizeSiteProxyUrl(
      typeof systemProxySetting?.value === 'string'
        ? (() => {
          try {
            return JSON.parse(systemProxySetting.value);
          } catch {
            return systemProxySetting.value;
          }
        })()
        : systemProxySetting?.value,
    );

    siteProxyCache = {
      loadedAt: nowMs,
      rows: rows.map((row) => ({
        siteUrl: normalizeSiteUrl(row.siteUrl),
        proxyUrl: normalizeSiteProxyUrl(row.proxyUrl),
        proxyId: Number.isInteger(row.proxyId) && (row.proxyId as number) > 0 ? row.proxyId as number : null,
        useSystemProxy: !!row.useSystemProxy,
        customHeaders: row.customHeaders ?? null,
      })),
      systemProxyUrl: parsedSystemProxyUrl,
    };
  } catch {
    siteProxyCache = { loadedAt: nowMs, rows: [], systemProxyUrl: null };
  }

  return siteProxyCache.rows;
}

function getDispatcherByProxyUrl(proxyUrl: string, skipCache = false): Dispatcher | undefined {
  const normalized = normalizeSiteProxyUrl(proxyUrl);
  if (!normalized) return undefined;

  if (!skipCache) {
    const cached = dispatcherCache.get(normalized);
    if (cached) return cached;
  }

  try {
    const parsedProxyUrl = new URL(normalized);
    const dispatcher = SOCKS_PROXY_PROTOCOLS.has(parsedProxyUrl.protocol.toLowerCase())
      ? createSocksDispatcher(parsedProxyUrl)
      : new ProxyAgent(normalized);
    if (!skipCache) {
      dispatcherCache.set(normalized, dispatcher);
    }
    return dispatcher;
  } catch {
    return undefined;
  }
}

function parseSocksProxyUrl(proxyUrl: URL): ParsedSocksProxyConfig {
  let shouldLookup = false;
  let type: 4 | 5 = 5;

  switch (proxyUrl.protocol.toLowerCase()) {
    case 'socks4:':
      shouldLookup = true;
      type = 4;
      break;
    case 'socks4a:':
      type = 4;
      break;
    case 'socks5:':
      shouldLookup = true;
      type = 5;
      break;
    case 'socks:':
    case 'socks5h:':
      type = 5;
      break;
    default:
      throw new TypeError(`Unsupported SOCKS proxy protocol: ${proxyUrl.protocol}`);
  }

  const proxy: ParsedSocksProxyConfig['proxy'] = {
    host: proxyUrl.hostname,
    port: Number.parseInt(proxyUrl.port, 10) || 1080,
    type,
  };

  if (proxyUrl.username) {
    proxy.userId = decodeURIComponent(proxyUrl.username);
  }
  if (proxyUrl.password) {
    proxy.password = decodeURIComponent(proxyUrl.password);
  }

  return { shouldLookup, proxy };
}

function applySocketDefaults(socket: Socket | TLSSocket) {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, DEFAULT_PROXY_KEEPALIVE_INITIAL_DELAY_MS);
}

async function resolveSocksDestinationHost(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, {}, (error, address) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(address);
    });
  });
}

async function createSocksSocket(
  connectOptions: UndiciConnectOptions,
  socksProxy: ParsedSocksProxyConfig,
): Promise<Socket | TLSSocket> {
  if (!connectOptions.hostname) {
    throw new Error('Missing hostname for SOCKS proxy request');
  }

  const destinationHost = socksProxy.shouldLookup
    ? await resolveSocksDestinationHost(connectOptions.hostname)
    : connectOptions.hostname;
  const destinationPort = Number.parseInt(connectOptions.port, 10)
    || (connectOptions.protocol === 'https:' ? 443 : 80);

  const { socket } = await SocksClient.createConnection({
    proxy: socksProxy.proxy,
    destination: {
      host: destinationHost,
      port: destinationPort,
    },
    command: 'connect',
    timeout: DEFAULT_PROXY_CONNECT_TIMEOUT_MS,
    socket_options: connectOptions.localAddress
      ? { localAddress: connectOptions.localAddress } as any
      : undefined,
  });
  applySocketDefaults(socket);

  if (connectOptions.protocol !== 'https:') {
    return socket;
  }

  return await new Promise<TLSSocket>((resolve, reject) => {
    const tlsSocket = tlsConnect({
      socket,
      host: connectOptions.hostname,
      servername: connectOptions.servername || (!isIP(connectOptions.hostname) ? connectOptions.hostname : undefined),
      ALPNProtocols: ['http/1.1'],
    });

    const cleanup = (error: Error) => {
      socket.destroy();
      tlsSocket.destroy();
      reject(error);
    };

    tlsSocket.once('secureConnect', () => {
      tlsSocket.off('error', cleanup);
      applySocketDefaults(tlsSocket);
      resolve(tlsSocket);
    });
    tlsSocket.once('error', cleanup);
  });
}

function createSocksDispatcher(proxyUrl: URL): Dispatcher {
  const socksProxy = parseSocksProxyUrl(proxyUrl);
  return new UndiciAgent({
    connect: (connectOptions, callback) => {
      void createSocksSocket(connectOptions, socksProxy)
        .then((socket) => callback(null, socket))
        .catch((error) => {
          callback(error instanceof Error ? error : new Error(String(error)), null as any);
        });
    },
  });
}

export function invalidateSiteProxyCache(): void {
  siteProxyCache = { loadedAt: 0, rows: [], systemProxyUrl: null };
}

function findBestMatchingSiteRow(rows: SiteProxyRow[], normalizedRequestUrl: string): SiteProxyRow | null {
  let bestMatch: SiteProxyRow | null = null;
  let bestMatchLength = -1;

  for (const row of rows) {
    if (!row.siteUrl) continue;

    const isPrefixMatch = (
      normalizedRequestUrl === row.siteUrl
      || normalizedRequestUrl.startsWith(`${row.siteUrl}/`)
      || normalizedRequestUrl.startsWith(`${row.siteUrl}?`)
    );
    if (!isPrefixMatch) continue;

    if (row.siteUrl.length > bestMatchLength) {
      bestMatch = row;
      bestMatchLength = row.siteUrl.length;
    }
  }

  return bestMatch;
}

async function resolveSiteRequestConfigByRequestUrl(requestUrl: string): Promise<{
  proxyUrl: string | null;
  customHeaders: unknown;
}> {
  const normalizedRequestUrl = normalizeSiteUrl(requestUrl);
  if (!normalizedRequestUrl) {
    return { proxyUrl: null, customHeaders: null };
  }

  const rows = await getCachedSiteProxyRows();
  const matchedRow = findBestMatchingSiteRow(rows, normalizedRequestUrl);
  // 站点层地址轴：自定义 > 池 > 勾选系统代理（镜像回落 settings 行值，与按记录解析同口径）
  const proxyUrl = matchedRow
    ? resolveHolderProxyUrl({
      proxyUrl: matchedRow.proxyUrl,
      proxyId: matchedRow.proxyId,
      useSystemProxy: matchedRow.useSystemProxy,
      systemProxyUrl: siteProxyCache.systemProxyUrl,
    })
    : null;
  return {
    proxyUrl: proxyUrl || null,
    customHeaders: matchedRow?.customHeaders ?? null,
  };
}

export async function resolveSiteProxyUrlByRequestUrl(requestUrl: string): Promise<string | null> {
  const resolved = await resolveSiteRequestConfigByRequestUrl(requestUrl);
  return resolved.proxyUrl;
}

export async function withSiteProxyRequestInit(
  requestUrl: string,
  options?: UndiciRequestInit,
): Promise<UndiciRequestInit> {
  const resolved = await resolveSiteRequestConfigByRequestUrl(requestUrl);
  const nextOptions: UndiciRequestInit = {
    ...(options || {}),
  };
  const mergedHeaders = mergeHeadersWithSiteCustomHeaders(resolved.customHeaders, options?.headers);
  if (mergedHeaders) {
    nextOptions.headers = mergedHeaders;
  }

  const alsOverride = accountProxyOverride.getStore();
  const proxyUrl = alsOverride ?? resolved.proxyUrl;

  if (!proxyUrl) {
    return nextOptions;
  }

  const dispatcher = getDispatcherByProxyUrl(proxyUrl, alsOverride != null);
  if (!dispatcher) {
    return nextOptions;
  }

  return {
    ...nextOptions,
    dispatcher,
  };
}

export function withExplicitProxyRequestInit(
  proxyUrl: string | null | undefined,
  options?: UndiciRequestInit,
  skipCache = false,
): UndiciRequestInit {
  const normalized = normalizeSiteProxyUrl(proxyUrl);
  if (!normalized) return options ?? {};

  const dispatcher = getDispatcherByProxyUrl(normalized, skipCache);
  if (!dispatcher) return options ?? {};

  return {
    ...(options || {}),
    dispatcher,
  };
}

export function resolveProxyUrlForSite(site: SiteProxyConfigLike | null | undefined): string | null {
  // 站点层地址轴：自定义 > 池 > 勾选系统代理（取池默认条目）
  return resolveHolderProxyUrl({
    proxyUrl: site?.proxyUrl,
    proxyId: site?.proxyId,
    useSystemProxy: site?.useSystemProxy,
  });
}

export function withSiteRecordProxyRequestInit(
  site: SiteProxyConfigLike | null | undefined,
  options?: UndiciRequestInit,
  accountProxyUrl?: string | null,
): UndiciRequestInit {
  const nextOptions: UndiciRequestInit = {
    ...(options || {}),
  };
  const mergedHeaders = mergeHeadersWithSiteCustomHeaders(site?.customHeaders, options?.headers);
  if (mergedHeaders) {
    nextOptions.headers = mergedHeaders;
  }
  const accountNormalized = normalizeSiteProxyUrl(accountProxyUrl) ?? accountProxyOverride.getStore();
  const siteProxyUrl = resolveProxyUrlForSite(site);
  const proxyUrl = accountNormalized || siteProxyUrl;
  const isAccountOverride = !!accountNormalized && accountNormalized !== siteProxyUrl;
  return withExplicitProxyRequestInit(proxyUrl, nextOptions, isAccountOverride);
}

export function resolveChannelProxyUrl(
  site: SiteProxyConfigLike | null | undefined,
  accountExtraConfig?: string | null,
): string | null {
  if (accountExtraConfig) {
    const normalized = normalizeSiteProxyUrl(resolveProxyUrlFromExtraConfig(accountExtraConfig));
    if (normalized) return normalized;
  }
  return resolveProxyUrlForSite(site);
}
