/** 探测可用的 confirm 及其调用接收者（native confirm 必须以 window/globalThis 为接收者调用，否则浏览器抛 Illegal invocation） */
function resolveConfirmTarget(): { receiver: { confirm: (m: string) => boolean } } | null {
  if (typeof globalThis === 'undefined') return null;
  if (typeof (globalThis as { confirm?: unknown }).confirm === 'function') {
    return { receiver: globalThis as unknown as { confirm: (m: string) => boolean } };
  }
  const win = (globalThis as { window?: { confirm?: unknown } }).window;
  if (win && typeof win.confirm === 'function') {
    return { receiver: win as { confirm: (m: string) => boolean } };
  }
  return null;
}

/** 当前环境是否能弹出确认框（调用方据此区分"用户取消"与"环境不支持"） */
export function isConfirmAvailable(): boolean {
  return resolveConfirmTarget() !== null;
}

/**
 * 统一确认兜底语义（fail-closed）：环境无 confirm 时视为"用户未完成确认"→ 返回 false 拒绝执行。
 * 调用方模式：if (!confirmOrThrow('…')) return;
 * 原全站三种兜底（放行 / 抛异常 / 跳过）全部归一到这里。
 *
 * 依次探测 globalThis.confirm 与 globalThis.window?.confirm：真实浏览器中 window === globalThis，
 * 两者为同一函数；只有二者都不存在（SSR / 精简测试环境）时才判定"环境不支持"。
 */
export function confirmOrThrow(message: string): boolean {
  const target = resolveConfirmTarget();
  if (!target) return false;
  // 以 receiver.confirm(...) 形式调用，保留 native 方法的 this 绑定
  return target.receiver.confirm(message);
}
