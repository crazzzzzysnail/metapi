import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmOrThrow, isConfirmAvailable } from './confirmDialog.js';

// 说明：工具依次探测 globalThis.confirm 与 globalThis.window?.confirm（真实浏览器中 window === globalThis）。
// 之所以做两级探测，是因为既有测试（tokenRoutes.mobile / ImportExport）只桩了 globalThis.window.confirm，
// 单级读 globalThis.confirm 会让它们走 fail-closed 分支而失败。两级探测对 SSR/node 裸环境仍为拒绝执行。
describe('confirmOrThrow / isConfirmAvailable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('globalThis.confirm 返回 true → true，并以原文案调用', () => {
    const spy = vi.fn(() => true);
    vi.stubGlobal('confirm', spy);
    expect(isConfirmAvailable()).toBe(true);
    expect(confirmOrThrow('确认删除？')).toBe(true);
    expect(spy).toHaveBeenCalledWith('确认删除？');
  });

  it('用户取消（返回 false）→ false', () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    expect(confirmOrThrow('确认删除？')).toBe(false);
  });

  it('仅有 window.confirm 时回退命中（兼容既有测试替身）', () => {
    const spy = vi.fn(() => true);
    vi.stubGlobal('window', { confirm: spy });
    expect(isConfirmAvailable()).toBe(true);
    expect(confirmOrThrow('确认导入？')).toBe(true);
    expect(spy).toHaveBeenCalledWith('确认导入？');
  });

  it('globalThis.confirm 优先于 window.confirm', () => {
    const globalSpy = vi.fn(() => true);
    const windowSpy = vi.fn(() => false);
    vi.stubGlobal('confirm', globalSpy);
    vi.stubGlobal('window', { confirm: windowSpy });
    expect(confirmOrThrow('x')).toBe(true);
    expect(globalSpy).toHaveBeenCalledTimes(1);
    expect(windowSpy).not.toHaveBeenCalled();
  });

  it('两者都缺失 → isConfirmAvailable=false 且拒绝执行（fail-closed）', () => {
    // node 裸环境：globalThis.confirm 与 globalThis.window 均不存在
    expect(isConfirmAvailable()).toBe(false);
    expect(confirmOrThrow('确认删除？')).toBe(false);
  });
});
