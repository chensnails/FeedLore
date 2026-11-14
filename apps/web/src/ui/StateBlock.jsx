/* 加载 / 空态 / 失败态的共用外壳。
 *
 * 各视图原本各抄一份「图标 + 文案 + 可选动作」的容器，间距、图标尺寸与 role 语义
 * 各走一套，切页面时信息层级会跳。这里只收敛外壳：旧类名（.dg-empty / .dg-loading /
 * .dg-error 等）由调用方通过 className 保留，样式与回归断言完全不受影响；主体内容与
 * 各状态的出口文案仍由 children 决定，不做语义化简（失败要重试、空态要给下一步）。
 */
import React from 'react';
import { Icon } from './Icon.jsx';

/**
 * @param {object}  p
 * @param {string} [p.className] 旧状态类名，保留样式与选择器契约
 * @param {string} [p.icon]      sprite 图标名；传 spinner=true 时忽略
 * @param {boolean} [p.spinner]  渲染转圈而不是图标
 * @param {boolean} [p.alert]    失败态：补 role=alert 让读屏立刻播报
 */
export function StateBlock({ className = '', icon, spinner = false, alert = false, children }) {
  return (
    <div className={['state-block', className].filter(Boolean).join(' ')} role={alert ? 'alert' : undefined}>
      {spinner
        ? <div className="dg-spinner" />
        : icon ? <div className="dg-empty-ico"><Icon n={icon} /></div> : null}
      {children}
    </div>
  );
}
