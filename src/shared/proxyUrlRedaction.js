/**
 * 代理 URL 凭据处理的单一真源：脱敏展示、凭据探测、掩码回写拒绝。
 * 服务端与前端共用，避免两处口径漂移。
 */

/** 脱敏后用户名字段的固定占位 */
export const PROXY_MASK_MARKER = '***';

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 脱敏代理地址：有凭据时用户名替换为 ***、密码删除，其余结构保留；
 * 根路径且无查询/片段时去掉序列化补出的尾部斜杠。解析失败走正则兜底。
 */
export function redactProxyUrl(value) {
  const text = asTrimmedString(value);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (parsed.username || parsed.password) {
      parsed.username = PROXY_MASK_MARKER;
      parsed.password = '';
    }
    const serialized = parsed.toString();
    return parsed.pathname === '/' && !parsed.search && !parsed.hash
      ? serialized.replace(/\/$/, '')
      : serialized;
  } catch {
    return text.replace(/\/\/[^/@:\s]+(?::[^/@\s]*)?@/, `//${PROXY_MASK_MARKER}@`);
  }
}

/** 是否含用户名或密码凭据；用于控制是否展示 reveal 按钮。 */
export function hasProxyCredentials(value) {
  const text = asTrimmedString(value);
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return !!(parsed.username || parsed.password);
  } catch {
    return /\/\/[^/@:\s]+(?::[^/@\s]*)?@/.test(text);
  }
}

/**
 * 是否为（或疑似）脱敏产物。写入侧据此拒绝掩码值入库：
 * 脱敏值一旦被当作新地址保存，会让该代理立刻变成无效出口。
 */
export function containsMaskMarker(value) {
  const text = asTrimmedString(value);
  if (!text) return false;
  if (text.includes(PROXY_MASK_MARKER)) return true;
  try {
    const parsed = new URL(text);
    return parsed.username.includes('*') || parsed.password.includes('*');
  } catch {
    return false;
  }
}
