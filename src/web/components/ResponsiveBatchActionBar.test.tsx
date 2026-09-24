import React from 'react';
import { describe, expect, it } from 'vitest';
import { create } from 'react-test-renderer';
import ResponsiveBatchActionBar from './ResponsiveBatchActionBar.js';

describe('ResponsiveBatchActionBar', () => {
  it('renders the shared mobile batch bar on mobile', () => {
    const root = create(
      <ResponsiveBatchActionBar isMobile info="已选 2 项">
        <button type="button">批量启用</button>
      </ResponsiveBatchActionBar>,
    );

    const bar = root.root.find((node) => node.props.className === 'mobile-actions-bar mobile-batch-bar');
    expect(bar).toBeTruthy();
    expect(root.root.findByType('button').children).toContain('批量启用');
  });

  it('renders the desktop card wrapper on desktop', () => {
    const root = create(
      <ResponsiveBatchActionBar isMobile={false} info="已选 3 项">
        <button type="button">批量删除</button>
      </ResponsiveBatchActionBar>,
    );

    const card = root.root.find((node) => node.props.className === 'card');
    expect(card).toBeTruthy();
    expect(root.root.findAllByType('span').some((node) => node.children.includes('已选 3 项'))).toBe(true);
  });

  it('adds the sticky class to the desktop wrapper only when sticky is set', () => {
    const stickyRoot = create(
      <ResponsiveBatchActionBar isMobile={false} info="已选 1 项" sticky>
        <button type="button">批量启用</button>
      </ResponsiveBatchActionBar>,
    );
    expect(stickyRoot.root.find((node) => node.props.className === 'card batch-bar-sticky')).toBeTruthy();

    // 移动端忽略 sticky：吸顶由 MobileBatchBar 自身 CSS 承担
    const mobileRoot = create(
      <ResponsiveBatchActionBar isMobile info="已选 1 项" sticky>
        <button type="button">批量启用</button>
      </ResponsiveBatchActionBar>,
    );
    expect(mobileRoot.root.find((node) => node.props.className === 'mobile-actions-bar mobile-batch-bar')).toBeTruthy();
    expect(mobileRoot.root.findAll((node) => String(node.props.className || '').includes('batch-bar-sticky'))).toHaveLength(0);
  });
});
