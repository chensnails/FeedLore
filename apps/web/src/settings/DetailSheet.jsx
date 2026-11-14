/* 设置面板的「详情层」（v2.5.0，设置 A 方案）。
 *
 * 列表 + 详情两层：列表只留紧凑行（头像 / 标题 / 状态 / 快捷开关），点行打开这一层，
 * 全部编辑控件收在里面。两种形态共用同一份 DOM：
 *  - 桌面（>720px）：设置弹层内容区右侧抽屉，左边的列表仍可见、可对照；
 *  - 移动（≤720px）：贴底整宽弹层，下滑手势关闭（useSwipeDismiss，与卡片详情同一套）。
 *
 * 层内的修改都是「即改即生效」，没有未保存草稿，所以关闭不需要脏态确认；
 * Esc 级联：先关详情层，再轮到设置外壳（外壳的 escape 宿主处理返回 / 关闭）。
 * 确认框 / 灯箱 / 范围选择浮层叠在上面时，Esc 让位给它们（捕获阶段先检查）。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useSwipeDismiss } from '../views/useSwipeDismiss.js';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function DetailSheet({ title, subtitle, onClose, foot, children }) {
  const [isMobile, setIsMobile] = useState(() =>
    !!(window.matchMedia && window.matchMedia('(max-width: 720px)').matches));
  const openerRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const mq = window.matchMedia ? window.matchMedia('(max-width: 720px)') : null;
    if (!mq) return undefined;
    const on = () => setIsMobile(!!mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', on);
    else if (mq.addListener) mq.addListener(on);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', on);
      else if (mq.removeListener) mq.removeListener(on);
    };
  }, []);

  const { panelRef, setPanelRef, handlers, reset } = useSwipeDismiss(() => closeRef.current(), { enabled: isMobile });

  // 打开记住焦点来源，关闭归还（列表行被重渲染也先确认还在文档里）
  useEffect(() => {
    openerRef.current = document.activeElement;
    const t = setTimeout(() => {
      const el = panelRef.current;
      if (!el) return;
      const first = el.querySelector('.ds-body ' + FOCUSABLE) || el.querySelector('.ds-back') || el;
      if (first && first.focus) first.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      reset();
      const back = openerRef.current;
      openerRef.current = null;
      if (back && back !== document.body && document.contains(back) && back.focus) back.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc / Tab 收在详情层内。捕获阶段注册：先于设置外壳的冒泡监听，
  // 但确认框 / 灯箱 / 范围浮层叠在上面时让位（它们自己消化这一击）。
  useEffect(() => {
    const onKey = (ev) => {
      const root = panelRef.current;
      if (!root) return;
      if (document.querySelector('.confirm-mask') || document.querySelector('.lightbox')) return;
      const t = ev.target;
      if (t && t.closest && t.closest('.rule-scope-pop')) return;
      if (ev.key === 'Escape') {
        // 输入控件里的 Esc 先让字段自己消化（取消草稿并失焦），再按一次才关层
        if (t && t.closest && root.contains(t) && t.closest('input, textarea, select')) return;
        ev.preventDefault();
        ev.stopPropagation();
        closeRef.current();
        return;
      }
      if (ev.key !== 'Tab') return;
      const items = Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE),
        (el) => !el.disabled && el.offsetParent !== null);
      if (!items.length) { ev.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (!root.contains(at)) { ev.preventDefault(); first.focus(); return; }
      if (ev.shiftKey && at === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && at === last) { ev.preventDefault(); first.focus(); }
      ev.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="ds-mask" onClick={(ev) => { if (ev.target === ev.currentTarget) closeRef.current(); }}>
      <div
        className="ds-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : '详情'}
        ref={setPanelRef}
        tabIndex={-1}
        {...handlers}
      >
        <div className="ds-head" data-sheet-grip>
          <button className="ds-back" type="button" aria-label="返回列表" onClick={() => closeRef.current()}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
          </button>
          <div className="ds-head-txt">
            <h3 className="ds-title">{title}</h3>
            {subtitle ? <p className="ds-sub">{subtitle}</p> : null}
          </div>
          <button className="ds-close" type="button" aria-label="关闭详情" onClick={() => closeRef.current()}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
          </button>
        </div>
        <div className="ds-body">{children}</div>
        {foot ? <div className="ds-foot">{foot}</div> : null}
      </div>
    </div>
  );
}