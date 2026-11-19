import { Icon } from './Icon.jsx';

/**
 * @param {object}  p
 * @param {string} [p.className] 旧状态类名，保留样式与选择器契约
 * @param {string} [p.icon]      sprite 图标名；传 spinner=true 时忽略
 * @param {boolean} [p.spinner]  渲染转圈而不是图标
 * @param {boolean} [p.alert]    失败态：补 role=alert 让读屏立刻播报
 * @param {any} [p.children]     块内内容
 */
export function StateBlock({ className = '', icon, spinner = false, alert = false, children }) {
  return (
    <div
      className={['state-block', className].filter(Boolean).join(' ')}
      role={alert ? 'alert' : undefined}
    >
      {spinner ? (
        <div className="dg-spinner" />
      ) : icon ? (
        <div className="dg-empty-ico">
          <Icon n={icon} />
        </div>
      ) : null}
      {children}
    </div>
  );
}
