/* 设置面板的「详情层」（v2.5.0，设置 A 方案）。
 *
 * 列表 + 详情两层：列表只留紧凑行（头像 / 标题 / 状态 / 快捷开关），点行打开这一层，
 * 全部编辑控件收在里面。两种形态共用同一份 DOM：
 *  - 桌面（>720px）：设置弹层内容区右侧抽屉，左边的列表仍可见、可对照；
 *  - 移动（≤720px）：贴底整宽弹层；出口是 × / Esc，下滑关闭已下线（真机收起会闪屏）。
 *
 * 层内多数修改「即改即生效」；规则/过滤这类带草稿的编辑在关闭时保存，
 * 用 saveHint 明说，免得用户把 Esc 当成取消。
 * Esc 级联：输入框里第一击只失焦（字段可自行还原草稿），第二击才关层；
 * 关层先于设置外壳（外壳已对 .ds-sheet 让位）。
 * 确认框 / 灯箱 / 范围选择浮层叠在上面时，Esc 让位给它们（捕获阶段先检查）。
 */

import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** 详情层 props。除 onClose 外全部可选，避免给调用方制造必填级联。 */
export interface DetailSheetProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose?: () => void;
  foot?: ReactNode;
  children?: ReactNode;
  saveHint?: ReactNode;
}

export function DetailSheet({
  title,
  subtitle,
  onClose,
  foot,
  children,
  saveHint,
}: DetailSheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<(() => void) | undefined>(onClose);
  closeRef.current = onClose;

  // 系统返回键栈已随 V5 移除；本层关闭走 × / Esc / 遮罩点击。

  // 打开记住焦点来源，关闭归还（列表行被重渲染也先确认还在文档里）
  useEffect(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const t = setTimeout(() => {
      const el = panelRef.current;
      if (!el) return;
      // .ds-back 在桌面与移动端都不显示，focus() 是空操作；正文没有可聚焦元素时
      // 焦点必须落在恒可见的 .ds-close 上，而不是 tabIndex=-1 的容器（读屏只念「详情」）。
      const first =
        el.querySelector<HTMLElement>('.ds-body ' + FOCUSABLE) ||
        el.querySelector<HTMLElement>('.ds-close') ||
        el;
      if (first && 'focus' in first) first.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      const back = openerRef.current;
      openerRef.current = null;
      if (back && back !== document.body && document.contains(back) && 'focus' in back)
        back.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc / Tab 收在详情层内。捕获阶段注册：先于设置外壳的冒泡监听，
  // 但确认框 / 灯箱 / 范围浮层叠在上面时让位（它们自己消化这一击）。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const root = panelRef.current;
      if (!root) return;
      if (document.querySelector('.confirm-mask') || document.querySelector('.lightbox')) return;
      const t = ev.target instanceof Element ? ev.target : null;
      if (t && t.closest('.rule-scope-pop')) return;
      if (ev.key === 'Escape') {
        // 输入控件里的 Esc：第一击只失焦，第二击才关层。不能在这里 stopPropagation ——
        // 有的字段自己监听 Esc 还原草稿（数据源的名称 / 地址）；也不能当场 blur ——
        // 那会抢在字段的 onKeyDown 之前触发 onBlur，把草稿当成提交发出 PATCH。
        // 等同一击的冒泡处理跑完，焦点仍在输入框里才说明没人接管，我们再补一次失焦。
        // 设置外壳已对 .ds-sheet 让位，首击不会误关整个设置弹层。
        if (t && root.contains(t) && t.closest('input, textarea, select')) {
          const field = t;
          setTimeout(() => {
            if (field instanceof HTMLElement && document.activeElement === field) field.blur();
          }, 0);
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (ev.key !== 'Tab') return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !('disabled' in el && el.disabled) && el.offsetParent !== null,
      );
      if (!items.length) {
        ev.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        ev.preventDefault();
        return;
      }
      const at = document.activeElement;
      if (!root.contains(at)) {
        ev.preventDefault();
        first.focus();
        return;
      }
      if (ev.shiftKey && at === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && at === last) {
        ev.preventDefault();
        first.focus();
      }
      ev.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const label = typeof title === 'string' ? title : '详情';
  const sub = typeof subtitle === 'string' ? subtitle : '';

  return (
    <div
      className="ds-mask"
      onClick={(ev: ReactMouseEvent<HTMLDivElement>) => {
        if (ev.target === ev.currentTarget) closeRef.current?.();
      }}
    >
      <div
        className="ds-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={sub ? label + ' · ' + sub : label}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="ds-head">
          <button
            className="ds-back"
            type="button"
            aria-label="返回列表"
            onClick={() => closeRef.current?.()}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-chevron-right" />
            </svg>
          </button>
          <div className="ds-head-txt">
            <h3 className="ds-title">{title}</h3>
            {subtitle ? <p className="ds-sub">{subtitle}</p> : null}
          </div>
          <button
            className="ds-close"
            type="button"
            aria-label="关闭详情，返回列表"
            onClick={() => closeRef.current?.()}
          >
            <svg className="ico" aria-hidden="true" focusable="false">
              <use href="#i-x" />
            </svg>
          </button>
        </div>
        <div className="ds-body">
          {children}
          {saveHint ? <small className="form-tip ds-save-hint">{saveHint}</small> : null}
        </div>
        {foot ? <div className="ds-foot">{foot}</div> : null}
      </div>
    </div>
  );
}
