import { z } from 'zod';

/** 池条目名称长度上限（备注名，去空白后非空） */
export const PROXY_POOL_NAME_MAX_LENGTH = 64;

/**
 * 代理池写接口共用契约：
 *   create: { name, url }
 *   update: { name }                         // 只改备注名，地址走单独端点
 *   url:    { url }                           // 改地址（会改变所有引用者出口）
 * url 的协议合法性由服务层用 normalizeSiteProxyUrl 判定（与站点/账户同一口径），
 * 掩码值（含 ***）由服务层拒绝，故这里只约束类型。
 */
const nameSchema = z.string().trim().min(1).max(PROXY_POOL_NAME_MAX_LENGTH);
const urlSchema = z.string().trim().min(1);

const proxyPoolCreatePayloadSchema = z.object({
  name: nameSchema,
  url: urlSchema,
}).passthrough();

const proxyPoolUpdatePayloadSchema = z.object({
  name: nameSchema,
}).passthrough();

const proxyPoolUrlPayloadSchema = z.object({
  url: urlSchema,
}).passthrough();

export type ProxyPoolCreatePayload = z.output<typeof proxyPoolCreatePayloadSchema>;
export type ProxyPoolUpdatePayload = z.output<typeof proxyPoolUpdatePayloadSchema>;
export type ProxyPoolUrlPayload = z.output<typeof proxyPoolUrlPayloadSchema>;

function normalizeProxyPoolPayloadInput(input: unknown): unknown {
  if (input === undefined) return {};
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  return null;
}

function describeProxyPoolError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  const firstPath = firstIssue?.path?.[0];
  if (firstPath === 'name') {
    return 'Invalid name. Expected a non-empty proxy name (max 64 chars).';
  }
  if (firstPath === 'url') {
    return 'Invalid url. Expected a non-empty proxy URL.';
  }
  return 'Invalid proxy pool payload.';
}

function parseProxyPoolPayload<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
): { success: true; data: z.output<T> } | { success: false; error: string } {
  const normalized = normalizeProxyPoolPayloadInput(input);
  if (normalized === null) {
    return { success: false, error: 'Payload must be an object.' };
  }
  const result = schema.safeParse(normalized);
  if (!result.success) {
    return { success: false, error: describeProxyPoolError(result.error) };
  }
  return { success: true, data: result.data as z.output<T> };
}

export function parseProxyPoolCreatePayload(input: unknown) {
  return parseProxyPoolPayload(proxyPoolCreatePayloadSchema, input);
}

export function parseProxyPoolUpdatePayload(input: unknown) {
  return parseProxyPoolPayload(proxyPoolUpdatePayloadSchema, input);
}

export function parseProxyPoolUrlPayload(input: unknown) {
  return parseProxyPoolPayload(proxyPoolUrlPayloadSchema, input);
}
