import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readCss(): string {
  return readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8').replace(/\r\n/g, '\n');
}

// 抓某个选择器第一条规则的花括号体（源码级契约，非渲染级）
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : '';
}

describe('批量栏统一吸顶 CSS 地基', () => {
  const css = readCss();

  it('定义吸顶锚点与层级 token', () => {
    expect(css).toContain('--batch-bar-sticky-top: calc(var(--topbar-height) + 8px);');
    expect(css).toContain('--z-batch-bar: 50;');
  });

  it('路由栏锚定 token，并定义 is-inflow 槽位移交（退回文档流）', () => {
    const routeBar = ruleBody(css, '.route-batch-bar');
    expect(routeBar).toContain('position: sticky;');
    expect(routeBar).toContain('top: var(--batch-bar-sticky-top);');
    const inflow = ruleBody(css, '.route-batch-bar\\.is-inflow');
    expect(inflow).toContain('position: static;');
    expect(inflow).toContain('z-index: auto;');
  });

  it('通道栏默认流式、is-floating 原地吸顶到同一槽位', () => {
    const floating = ruleBody(css, '.channel-batch-bar\\.is-floating');
    expect(floating).toContain('position: sticky;');
    expect(floating).toContain('top: var(--batch-bar-sticky-top);');
    expect(floating).toContain('z-index: var(--z-batch-bar);');
  });

  it('通用桌面批量栏吸顶类存在', () => {
    const sticky = ruleBody(css, '.batch-bar-sticky');
    expect(sticky).toContain('position: sticky;');
    expect(sticky).toContain('top: var(--batch-bar-sticky-top);');
  });

  it('移动端批量栏由底部悬浮改为顶部吸顶（不再含 bottom 锚）', () => {
    const mobileBar = ruleBody(css, '.mobile-actions-bar');
    expect(mobileBar).toContain('top: var(--batch-bar-sticky-top);');
    expect(mobileBar).not.toContain('bottom:');
    // 移动端 z 仍需盖过吸顶顶栏，维持原 token
    expect(mobileBar).toContain('z-index: var(--z-mobile-batch-bar);');
  });

  it('移动端 main-content 底部避让已回退（140px 不复存在）', () => {
    expect(css).not.toContain('padding-bottom: 140px;');
  });
});
