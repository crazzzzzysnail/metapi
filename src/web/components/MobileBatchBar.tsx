import React from 'react';
import { createPortal } from 'react-dom';

type MobileBatchBarProps = {
  info: React.ReactNode;
  children: React.ReactNode;
};

export default function MobileBatchBar({ info, children }: MobileBatchBarProps) {
  const bar = (
    <div className="mobile-actions-bar mobile-batch-bar">
      <span className="mobile-actions-info">{info}</span>
      <div className="mobile-actions-row">{children}</div>
    </div>
  );

  // 与 MobileDrawer / CenteredModal 等 fixed 覆盖层同构：portal 到 body，
  // 绕开页面根节点残留 transform 造成的 fixed 包含块错位；无 document 时（SSR / node 测试环境）原地渲染。
  const portalTarget = typeof document !== 'undefined' ? document.body : null;
  return portalTarget ? createPortal(bar, portalTarget) : bar;
}
