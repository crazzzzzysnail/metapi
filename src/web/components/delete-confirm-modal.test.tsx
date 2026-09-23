import { describe, expect, it, vi } from 'vitest';
import { create } from 'react-test-renderer';
import DeleteConfirmModal from './DeleteConfirmModal.js';

function collectText(node: any): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  const children = node.children || node.props?.children || [];
  return (Array.isArray(children) ? children : [children]).map(collectText).join('');
}

describe('DeleteConfirmModal', () => {
  it('default props preserve the original alert copy', () => {
    const root = create(
      <DeleteConfirmModal open description="确定删除？" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const text = collectText(root.root);
    expect(text).toContain('此操作不可撤销');
    expect(text).toContain('确认删除');
    root.unmount();
  });

  it('alertTitle / loadingText overrides take effect (B4.2)', () => {
    const root = create(
      <DeleteConfirmModal
        open
        loading
        alertTitle="此操作会触发路由重建"
        loadingText="移除中..."
        description="确定移除？"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const text = collectText(root.root);
    expect(text).toContain('此操作会触发路由重建');
    expect(text).toContain('移除中...');
    expect(text).not.toContain('删除中...');
    root.unmount();
  });

  it('四个既有调用点不传新 props 时行为不变（标题/按钮沿用默认）', () => {
    const root = create(
      <DeleteConfirmModal open title="确认删除站点" confirmText="确认删除" description="x" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const dangerButton = root.root.find((node) => (
      node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('btn-danger')
    ));
    expect(collectText(dangerButton)).toContain('确认删除');
    root.unmount();
  });
});
