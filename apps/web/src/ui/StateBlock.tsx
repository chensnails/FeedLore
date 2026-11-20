import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';

export interface StateBlockProps {
  className?: string;
  /** sprite 图标名；传 spinner=true 时忽略 */
  icon?: string;
  spinner?: boolean;
  /** 失败态：补 role=alert 让读屏立刻播报 */
  alert?: boolean;
  children?: ReactNode;
}

export function StateBlock({
  className = '',
  icon,
  spinner = false,
  alert = false,
  children,
}: StateBlockProps) {
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
