/* 卡片工具栏自定义下拉（v1.1.9，v1.1.10 移动端改为底部弹窗）。
 * 原生 <select> 的展开弹窗由操作系统渲染，与应用风格不统一 —— 以自绘浮层替代：
 * - 桌面（>720px）：锚定玻璃面板（分组标题、选中勾、键盘 ↑↓/Enter/Esc、外点关闭）；
 * - 移动（≤720px）：底部弹窗（bottom sheet）—— 遮罩模糊 + 圆角面板 + 标题栏/关闭 + 大触控选项，
 *   打开期间锁页面滚动，支持底部安全区（env(safe-area-inset-bottom)）。
 * 触发按钮沿用 .select 外观；弹层均为静态覆盖层（absolute/fixed），符合「弹层才用模糊」铁律。 */

import { core } from '@core';
import React, { useEffect, useRef, useState } from 'react';

/* 与 style.css 的 720px 断点一致；jsdom 无 matchMedia 或无布局时按桌面处理 */
function isMobileMq() {
  try { return !!(window.matchMedia && window.matchMedia('(max-width: 720px)').matches); }
  catch (_) { return false; }
}

export function Dropdown({ id, wrapId, title, ariaLabel, value, options, onChange }) {
  // options: [{ value, label, group }]；group 为分组名（'' / undefined 表示无分组）
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);   // 打开瞬间定格，本次开合内不切换形态
  const [hi, setHi] = useState(-1);              // 键盘 ↑↓ / 悬停高亮的下标
  const rootRef = useRef(null);
  const panelRef = useRef(null);                 // 可滚动列表容器（桌面面板 / 移动弹窗体共用）
  const triggerRef = useRef(null);

  const cur = options.find((o) => String(o.value) === String(value));

  const close = () => {
    setOpen(false);
    setHi(-1);
    if (triggerRef.current) triggerRef.current.focus();
  };

  // 打开期间：点外面 / Esc 关闭（移动端另有遮罩点击 + 关闭按钮）
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev) => { if (rootRef.current && !rootRef.current.contains(ev.target)) setOpen(false); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 移动端弹窗开着时锁页面滚动
  useEffect(() => {
    if (!open || !mobile) return;
    const s = core;
    if (s && s.lockPageScroll) s.lockPageScroll();
    return () => { if (s && s.unlockPageScroll) s.unlockPageScroll(); };
  }, [open, mobile]);

  // 打开时把选中项滚进视野（容器渲染完成后）
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const el = panelRef.current.querySelector('.dd-item.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [open]);

  const openPanel = () => { setMobile(isMobileMq()); setOpen(true); setHi(-1); };

  const pick = (v) => {
    setOpen(false);
    setHi(-1);
    if (onChange) onChange(v);
  };

  const onKeyDown = (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!open) { openPanel(); setHi(options.findIndex((o) => o === cur)); return; }
      setHi((h) => {
        const base = h < 0 ? options.findIndex((o) => o === cur) : h;
        return ev.key === 'ArrowDown' ? Math.min(options.length - 1, base + 1) : Math.max(0, base - 1);
      });
    } else if (ev.key === 'Enter' && open && hi >= 0) {
      ev.preventDefault();
      pick(options[hi].value);
    }
  };

  // 按分组插入标题行（「全部频道」无分组，排最前）
  const rows = [];
  let lastGroup;
  options.forEach((o, i) => {
    const g = o.group || '';
    if (g && g !== lastGroup) rows.push(<div className="dd-group" key={'g:' + g}>{g}</div>);
    lastGroup = g;
    const active = !!cur && String(o.value) === String(cur.value);
    rows.push(
      <button type="button" role="option" key={String(o.value)}
        className={'dd-item' + (active ? ' active' : '') + (hi === i ? ' hi' : '')}
        aria-selected={active}
        onMouseEnter={() => setHi(i)}
        onClick={() => pick(o.value)}>
        <span className="dd-item-label">{o.label}</span>
        {active ? <svg className="ico dd-check" aria-hidden="true" focusable="false"><use href="#i-check" /></svg> : null}
      </button>
    );
  });

  return (
    <div className={'dd' + (open ? ' open' : '')} id={wrapId} ref={rootRef} onKeyDown={onKeyDown}>
      <button type="button" id={id} ref={triggerRef} className="select dd-trigger"
        title={title} aria-label={ariaLabel || title} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => { if (open) close(); else openPanel(); }}>
        <span className="dd-label">{cur ? cur.label : ''}</span>
        <svg className="ico dd-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-down" /></svg>
      </button>

      {open && !mobile && (
        <div className="dd-panel" role="listbox" aria-label={ariaLabel || title} ref={panelRef}>
          {rows}
        </div>
      )}

      {open && mobile && (
        <div className="dd-mask" onClick={close}>
          <div className="dd-sheet" role="dialog" aria-modal="true" aria-label={ariaLabel || title}
            onClick={(ev) => ev.stopPropagation()}>
            <div className="dd-sheet-grip" aria-hidden="true" />
            <div className="dd-sheet-head">
              <span className="dd-sheet-title">{title}</span>
              <button type="button" className="dd-sheet-close" aria-label="关闭" onClick={close}>
                <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
              </button>
            </div>
            <div className="dd-sheet-body" role="listbox" ref={panelRef}>{rows}</div>
          </div>
        </div>
      )}
    </div>
  );
}
