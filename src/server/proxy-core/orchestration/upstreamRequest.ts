export type UpstreamEndpoint = 'chat' | 'messages' | 'responses';
export type UpstreamUrlMode = 'default' | 'suffix' | 'fixed';

export type ParsedUpstreamUrlMode = {
  mode: UpstreamUrlMode;
  baseUrl: string;
  normalizedPath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractJsonErrorMessage(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    const root = isRecord(parsed) ? parsed : null;
    const error = (root && isRecord(root.error)) ? root.error : root;
    if (!error) return '';

    const message = typeof error.message === 'string' ? collapseWhitespace(error.message) : '';
    if (message) return message;

    const code = typeof error.code === 'string' ? collapseWhitespace(error.code) : '';
    const type = typeof error.type === 'string' ? collapseWhitespace(error.type) : '';
    return [type, code].filter((part) => part.length > 0).join('/');
  } catch {
    return '';
  }
}

function extractHtmlTitle(rawText: string): string {
  const match = rawText.match(/<title[^>]*>([^<>]*)<\/title>/i);
  if (!match?.[1]) return '';
  return collapseWhitespace(match[1]);
}

function extractCloudflareHtmlSummary(rawText: string, status: number): string {
  if (!/cloudflare/i.test(rawText)) return '';
  const title = extractHtmlTitle(rawText);
  const codeMatch = (
    title.match(/\b(\d{3,4})\s*:\s*([^\|<]+)/i)
    || rawText.match(/Error code\s*(\d{3,4})/i)
  );
  const code = codeMatch?.[1] || (status > 0 ? String(status) : '');
  const reason = collapseWhitespace(
    (typeof codeMatch?.[2] === 'string' ? codeMatch[2] : '')
    || (status >= 500 ? 'origin host error' : 'request blocked')
  );
  if (code) return `Cloudflare ${code}: ${reason}`;
  return `Cloudflare: ${reason}`;
}

function extractHtmlSummary(rawText: string, status: number): string {
  if (!/(<!doctype|<html)/i.test(rawText)) return '';

  const cloudflareSummary = extractCloudflareHtmlSummary(rawText, status);
  if (cloudflareSummary) return cloudflareSummary;

  const title = extractHtmlTitle(rawText);
  if (title) return title;

  const heading = rawText.match(/<h1[^>]*>([^<>]*)<\/h1>/i)?.[1] || '';
  return collapseWhitespace(heading);
}

function formatUrlOrigin(url: URL): string {
  const username = url.username ? encodeURIComponent(url.username) : '';
  const password = url.password ? encodeURIComponent(url.password) : '';
  const auth = username
    ? `${username}${password ? `:${password}` : ''}@`
    : '';

  return `${url.protocol}//${auth}${url.host}`;
}

function joinPath(basePath: string, requestPath: string): string {
  const base = basePath.replace(/\/+$/, '');
  const path = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;

  if (!base || base === '/') return path || '/';
  if (!path || path === '/') return base;
  return `${base}${path}`;
}

function splitRequestPath(requestPath: string): { pathname: string; suffix: string } {
  const normalized = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  const markerIndex = normalized.search(/[?#]/);
  if (markerIndex < 0) {
    return { pathname: normalized || '/', suffix: '' };
  }
  return {
    pathname: normalized.slice(0, markerIndex) || '/',
    suffix: normalized.slice(markerIndex),
  };
}

function normalizeUrlPathname(pathname: string): string {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return normalized.replace(/\/+$/, '') || '/';
}

function stripVersionPrefix(path: string): string {
  const { pathname, suffix } = splitRequestPath(path);
  const replacements: Array<[RegExp, string]> = [
    [/^\/v1beta\/openai(?=\/|$)/i, ''],
    [/^\/v\d+(?:\.\d+)?(?:beta)?(?=\/|$)/i, ''],
    [/^\/api\/v\d+(?:\.\d+)?(?:beta)?(?=\/|$)/i, ''],
  ];

  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(pathname)) continue;
    const stripped = pathname.replace(pattern, replacement) || '/';
    return `${stripped.startsWith('/') ? stripped : `/${stripped}`}${suffix}`;
  }

  return `${pathname}${suffix}`;
}

function stripDuplicateDefaultVersionPrefix(basePath: string, requestPath: string): string {
  const baseHasVersionSuffix = /\/(?:api\/)?v1$/i.test(basePath);
  if (!baseHasVersionSuffix) return requestPath;

  const { pathname, suffix } = splitRequestPath(requestPath);
  if (pathname === '/v1') return `/${suffix}`;
  if (pathname.startsWith('/v1/')) return `${pathname.slice('/v1'.length) || '/'}${suffix}`;
  return requestPath;
}

function buildUrlFromParts(siteUrl: string, requestPath: string, stripRequestPath: (basePath: string, path: string) => string): string {
  const baseRaw = typeof siteUrl === 'string' ? siteUrl.trim() : '';
  const pathRaw = typeof requestPath === 'string' ? requestPath.trim() : '';
  const fallbackBase = baseRaw.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const initialPath = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;

  if (!fallbackBase) return initialPath || '/';
  if (!initialPath || initialPath === '/') return fallbackBase;

  try {
    const parsed = new URL(baseRaw);
    const basePath = normalizeUrlPathname(parsed.pathname);
    const path = stripRequestPath(basePath, initialPath);
    const joinedPath = joinPath(basePath, path);
    return `${formatUrlOrigin(parsed)}${joinedPath}${parsed.search}${parsed.hash}`;
  } catch {
    const path = stripRequestPath(fallbackBase, initialPath);
    return `${fallbackBase}${path}`;
  }
}

function classifyEndpointPath(path: string): string | null {
  const { pathname } = splitRequestPath(path);
  const normalized = pathname.replace(/\/+$/, '').toLowerCase();
  if (normalized.endsWith('/chat/completions')) return 'chat';
  if (normalized.endsWith('/messages/count_tokens')) return 'messages.count_tokens';
  if (normalized.endsWith('/messages')) return 'messages';
  if (normalized.endsWith('/responses/compact')) return 'responses';
  if (normalized.endsWith('/responses')) return 'responses';
  if (normalized.endsWith('/embeddings')) return 'embeddings';
  if (normalized.endsWith('/images/generations')) return 'images.generations';
  if (normalized.endsWith('/images/edits')) return 'images.edits';
  if (normalized.endsWith('/videos')) return 'videos';
  if (/\/videos\/[^/]+$/i.test(normalized)) return 'videos.item';
  if (normalized.endsWith('/search')) return 'search';
  if (normalized.endsWith('/models')) return 'models';
  if (normalized.endsWith('/completions') && !normalized.endsWith('/chat/completions')) return 'completions';
  return null;
}

function isCompatibleEndpointType(fixedType: string | null, requestType: string | null): boolean {
  if (!fixedType || !requestType) return false;
  if (fixedType === requestType) return true;
  if (fixedType === 'responses' && requestType === 'responses') return true;
  return false;
}

function deriveFixedModelDiscoveryPath(pathname: string): string | null {
  const normalized = normalizeUrlPathname(pathname);
  const suffixes = [
    '/chat/completions',
    '/messages/count_tokens',
    '/messages',
    '/responses/compact',
    '/responses',
    '/embeddings',
    '/images/generations',
    '/images/edits',
    '/videos',
    '/search',
    '/completions',
  ];
  const lowered = normalized.toLowerCase();
  for (const suffix of suffixes) {
    if (!lowered.endsWith(suffix)) continue;
    const basePath = normalized.slice(0, normalized.length - suffix.length) || '/';
    return joinPath(basePath, '/models');
  }
  if (lowered.endsWith('/models')) return normalized;
  return null;
}

function extractRequestPathSuffix(requestPath: string): string {
  const raw = typeof requestPath === 'string' ? requestPath.trim() : '';
  try {
    const parsed = new URL(raw, 'http://metapi.local');
    return `${parsed.search}${parsed.hash}`;
  } catch {
    const matched = raw.match(/[?#].*$/);
    return matched?.[0] || '';
  }
}

export function parseUpstreamUrlMode(rawUrl: string): ParsedUpstreamUrlMode {
  const raw = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  const mode: UpstreamUrlMode = raw.endsWith('#')
    ? 'suffix'
    : raw.endsWith('$')
      ? 'fixed'
      : 'default';
  const withoutMarker = mode === 'default' ? raw : raw.slice(0, -1).trim();

  try {
    const parsed = new URL(withoutMarker);
    parsed.search = '';
    parsed.hash = '';
    const normalizedPath = normalizeUrlPathname(parsed.pathname);
    const baseUrl = `${formatUrlOrigin(parsed)}${normalizedPath === '/' ? '' : normalizedPath}`;
    return { mode, baseUrl, normalizedPath };
  } catch {
    const baseUrl = withoutMarker.replace(/[?#].*$/, '').replace(/\/+$/, '');
    return { mode, baseUrl, normalizedPath: '/' };
  }
}

export function summarizeUpstreamError(status: number, rawErrorText: string): string {
  const statusPrefix = status > 0
    ? `Upstream returned HTTP ${status}`
    : 'Upstream request failed';

  const raw = typeof rawErrorText === 'string' ? rawErrorText.trim() : '';
  if (!raw) return statusPrefix;

  const jsonMessage = extractJsonErrorMessage(raw);
  if (jsonMessage) return `${statusPrefix}: ${jsonMessage}`;

  const htmlMessage = extractHtmlSummary(raw, status);
  if (htmlMessage) return `${statusPrefix}: ${htmlMessage}`;

  const compact = collapseWhitespace(raw);
  if (!compact) return statusPrefix;
  if (compact.length <= 400) return `${statusPrefix}: ${compact}`;
  return `${statusPrefix}: ${compact.slice(0, 400)}...(truncated)`;
}

export function buildUpstreamUrl(siteUrl: string, requestPath: string): string {
  const parsedMode = parseUpstreamUrlMode(siteUrl);
  if (parsedMode.mode === 'fixed') return parsedMode.baseUrl;
  if (parsedMode.mode === 'suffix') {
    return buildUrlFromParts(parsedMode.baseUrl, requestPath, (_basePath, path) => stripVersionPrefix(path));
  }
  return buildUrlFromParts(siteUrl, requestPath, stripDuplicateDefaultVersionPrefix);
}

export function isFixedUpstreamUrlCompatible(siteUrl: string, requestPath: string): boolean {
  const parsedMode = parseUpstreamUrlMode(siteUrl);
  if (parsedMode.mode !== 'fixed') return true;
  return isCompatibleEndpointType(
    classifyEndpointPath(parsedMode.normalizedPath),
    classifyEndpointPath(requestPath),
  );
}

export function resolveModelDiscoveryUrl(siteUrl: string, modelPath: string): string | null {
  const parsedMode = parseUpstreamUrlMode(siteUrl);
  if (parsedMode.mode === 'fixed') {
    const modelDiscoveryPath = deriveFixedModelDiscoveryPath(parsedMode.normalizedPath);
    if (!modelDiscoveryPath) return null;
    const requestSuffix = extractRequestPathSuffix(modelPath);
    try {
      const parsed = new URL(parsedMode.baseUrl);
      return `${formatUrlOrigin(parsed)}${modelDiscoveryPath}${requestSuffix}`;
    } catch {
      const origin = parsedMode.baseUrl.slice(0, Math.max(0, parsedMode.baseUrl.length - parsedMode.normalizedPath.length));
      return `${origin}${modelDiscoveryPath}${requestSuffix}`;
    }
  }
  return buildUpstreamUrl(siteUrl, modelPath);
}
