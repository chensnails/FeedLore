import { useEffect, useRef } from 'react';
import { useUi } from '../store/ui';
import { Icon } from './Icon';

/**
 * 统一确认框（替代 `window.confirm`）。
 *
 * 为什么不用原生：原生对话框在移动端由浏览器接管，样式不可控、无法显示「删除后
 * 不可恢复」这类重点信息，而且它**同步阻塞主线程** —— 确认期间 React 完全停摆，
 * 恰好在删除这种最需要「按钮进入 pending」的场景里什么也做不了。
 *
 * 三个刻意的取舍：
 * 1. **默认聚焦「取消」**：删频道/删用户都是不可恢复操作，连按两下 Enter 不该删东西。
 * 2. **只循环两个按钮的焦点**：对话框背后是整页内容，Tab 漏出去以后用户会在
 *    看不见焦点的情况下操作页面。
 * 3. **遮罩可点取消**：这是唯一一个「点外面 = 拒绝」比「点外面 = 忽略」更安全的场景。
 */
export function ConfirmDialog() {
  const c = useUi((s) => s.confirmState);
  const resolve = useUi((s) => s.resolveConfirm);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!c) return undefined;

    // 等一帧再聚焦：节点刚挂上时直接 focus 在部分浏览器里会被后续渲染覆盖掉
    const t = setTimeout(() => cancelRef.current?.focus(), 0);

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        resolve(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const atCancel = document.activeElement === cancelRef.current;
      const next = atCancel ? okRef.current : cancelRef.current;
      if (!next) return;
      e.preventDefault();
      next.focus();
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [c, resolve]);

  if (!c) return null;

  return (
    <div className="confirm-backdrop" onClick={() => resolve(false)} role="presentation">
      <div
        className="confirm-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-head">
          <span className={`confirm-ico${c.danger ? ' danger' : ''}`} aria-hidden>
            <Icon name={c.danger ? 'alert' : 'check'} size={16} />
          </span>
          <h3 className="confirm-title" id="confirm-title">{c.title}</h3>
        </div>
        {c.body && <p className="confirm-body">{c.body}</p>}
        <div className="confirm-actions">
          <button ref={cancelRef} className="btn ghost" onClick={() => resolve(false)}>
            取消
          </button>
          <button
            ref={okRef}
            className={`btn${c.danger ? ' danger' : ''}`}
            onClick={() => resolve(true)}
          >
            {c.okText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
