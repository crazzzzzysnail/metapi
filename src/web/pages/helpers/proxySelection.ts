/**
 * 代理选择的前端共享逻辑：
 *  - resolveEffectiveProxy：按 6 级序只读推导“当前生效项”，供列表徽标与编辑页提示复用；绝不参与写入。
 *  - buildBatchProxyFields：仅批量弹窗用，把互斥单选映射为三元组下发值（与现网批量语义一致）。
 */

export type ProxyEffectiveSource = 'custom' | 'pool' | 'system' | 'direct';

export type ProxySelectionInput = {
  proxyUrl?: string | null;
  proxyId?: number | null;
  useSystemProxy?: boolean;
};

export type ProxyPoolSummary = {
  id: number;
  name: string;
  url?: string;
  isDefault?: boolean;
};

/** 地址轴（自定义 > 池 > 勾选系统），账号/站点两处同规则。池内查不到视为该格空。 */
export function resolveEffectiveProxy(
  input: ProxySelectionInput,
  pool: ProxyPoolSummary[],
): ProxyEffectiveSource {
  if (typeof input.proxyUrl === 'string' && input.proxyUrl.trim()) return 'custom';
  if (input.proxyId && pool.some((entry) => entry.id === input.proxyId)) return 'pool';
  if (input.useSystemProxy === true) return 'system';
  return 'direct';
}

/** 池条目 id → 展示名；找不到回落 id 文本 */
export function proxyPoolLabel(pool: ProxyPoolSummary[], proxyId: number | null | undefined): string {
  if (!proxyId) return '';
  const hit = pool.find((entry) => entry.id === proxyId);
  return hit ? hit.name : `#${proxyId}`;
}

/**
 * 池下拉选项文案：只给「名称 · 默认」，不放地址。
 * 地址可带凭据且极长，塞进选择框会把整行撑破（站点/连接/OAuth 三处共用此口径）。
 */
export function proxyPoolOptionLabel(entry: ProxyPoolSummary): string {
  return entry.isDefault ? `${entry.name} · 默认` : entry.name;
}

export type BatchProxyMode = 'system' | 'pool' | 'custom' | 'clear';

/** 批量互斥单选 → 下发三元组（清除=三格全空） */
export function buildBatchProxyFields(
  mode: BatchProxyMode,
  input: { proxyUrl: string; proxyId: number | null },
): { proxyUrl: string; proxyId: number | null; useSystemProxy: boolean } {
  if (mode === 'custom') {
    return { proxyUrl: input.proxyUrl.trim(), proxyId: null, useSystemProxy: false };
  }
  if (mode === 'pool') {
    return { proxyUrl: '', proxyId: input.proxyId, useSystemProxy: false };
  }
  if (mode === 'system') {
    return { proxyUrl: '', proxyId: null, useSystemProxy: true };
  }
  return { proxyUrl: '', proxyId: null, useSystemProxy: false };
}

/** 校验自定义代理地址协议（与服务端 SUPPORTED_PROXY_PROTOCOLS 对齐） */
export function isValidProxyUrlValue(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']
      .includes(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}
