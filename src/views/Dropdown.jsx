/* 卡片工具栏自定义下拉（v1.1.9，v1.1.10 移动端改为底部弹窗，v1.3.4 长列表改整屏，
 * v1.3.6 移动端一律整屏 —— 排序那种三四项的也不再留半屏，用户要的是「弹层都长一个样」）。
 * 原生 <select> 的展开弹窗由操作系统渲染，与应用风格不统一 —— 以自绘浮层替代：
 * - 桌面（>720px）：锚定玻璃面板（分组标题、选中勾、键盘 ↑↓/Enter/Esc、外点关闭）；
 * - 移动（≤720px）：遮罩 + 整屏面板 + 标题栏 + 大触控选项，打开期间锁页面滚动，支持底部安全区。
 *   往下拖就能收起（useSwipeDismiss），手势条是这枚提示。
 * - 传 collapsible 时分组标题变成整行折叠开关（卡片页频道筛选，与文章页侧栏共用同一份偏好）；
 *   不传就还是纯文本分组标题，排序那种下拉不受影响。
 * 触发按钮沿用 .select 外观；弹层均为静态覆盖层（absolute/fixed），符合「弹层才用模糊」铁律。 */

import { core } from '@core';
import React, { useEffect, useRef, useState } from 'react';
import { useSwipeDismiss } from './useSwipeDismiss.js';

/* 与 style.css 的 720px 断点一致；jsdom 无 matchMedia 或无布局时按桌面处理。
   卡片详情弹窗（CardDetail）也用这条判据选弹层形态，故导出。 */
export function isMobileMq() {
  try { return !!(window.matchMedia && window.matchMedia('(max-width: 720px)').matches); }
  catch (_) { return false; }
}

export function Dropdown({ id, wrapId, title, ariaLabel, value, options, onChange, collapsible, collapsedGroups, onToggleGroup }) {
  // options: [{ value, label, group }]；group 为分组名（'' / undefined 表示无分组）
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);   // 打开瞬间定格，本次开合内不切换形态
  const [hi, setHi] = useState(-1);              // 键盘 ↑↓ / 悬停高亮的下标（在「可见选项」里数）
  const rootRef = useRef(null);
  const panelRef = useRef(null);                 // 可滚动列表容器（桌面面板 / 移动弹窗体共用）
  const triggerRef = useRef(null);

  const cur = options.find((o) => String(o.value) === String(value));
  const isActive = (o) => !!cur && String(o.value) === String(cur.value);

  /* 折叠集合：只有 collapsible 才生效。收起的组里若藏着当前选中项，那一条要留下 ——
     否则「筛选中」的频道会从列表里凭空消失，触发按钮还写着它的名字。 */
  const foldSet = collapsible
    ? (collapsedGroups instanceof Set ? collapsedGroups : new Set(Array.isArray(collapsedGroups) ? collapsedGroups : []))
    : null;
  const isVisible = (o) => !foldSet || !o.group || !foldSet.has(o.group) || isActive(o);
  const visible = foldSet ? options.filter(isVisible) : options;
  const groupTotal = {};
  for (const o of options) { const g = o.group || ''; groupTotal[g] = (groupTotal[g] || 0) + 1; }

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

  // 键盘 ↑↓ 高亮时把那一项滚进视野（长频道列表里否则看不到当前高亮在哪）
  useEffect(() => {
    if (!open || hi < 0 || !panelRef.current) return;
    const items = panelRef.current.querySelectorAll('.dd-item');
    const el = items[hi];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const openPanel = () => { setMobile(isMobileMq()); setOpen(true); setHi(-1); };

  // 移动端：往下拖就能收起（见 useSwipeDismiss.js）
  const { panelRef: sheetRef, handlers: sheetHandlers } = useSwipeDismiss(close);

  const pick = (v) => {
    setOpen(false);
    setHi(-1);
    // 点选后焦点回到触发键：否则焦点随面板卸载而丢到 body，键盘用户要从头 Tab
    if (triggerRef.current) triggerRef.current.focus();
    if (onChange) onChange(v);
  };

  const onKeyDown = (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const at = visible.findIndex((o) => o === cur);
      if (!open) { openPanel(); setHi(at); return; }
      setHi((h) => {
        const base = h < 0 ? at : h;
        return ev.key === 'ArrowDown' ? Math.min(visible.length - 1, base + 1) : Math.max(0, base - 1);
      });
    } else if (ev.key === 'Enter' && open && hi >= 0) {
      ev.preventDefault();
      pick(visible[hi].value);
    }
  };

  // 按分组插入标题行（「全部频道」无分组，排最前）；折叠态下整组频道不再入列，标题行仍在，
  // 否则收起后那组连「点开它」的入口都没有了。
  const rows = [];
  let lastGroup;
  let vi = -1;
  options.forEach((o) => {
    const g = o.group || '';
    if (g && g !== lastGroup) {
      if (foldSet) {
        const folded = foldSet.has(g);
        rows.push(
          <button type="button" key={'g:' + g} data-group-fold={g}
            className={'dd-group dd-group-fold' + (folded ? ' is-collapsed' : '')}
            aria-expanded={folded ? 'false' : 'true'}
            title={(folded ? '展开' : '收起') + `分组「${g}」`}
            onClick={() => { setHi(-1); if (onToggleGroup) onToggleGroup(g); }}>
            <svg className="ico dd-group-caret" aria-hidden="true" focusable="false">
              <use href={folded ? '#i-chevron-right' : '#i-chevron-down'} />
            </svg>
            <span className="dd-group-name">{g}</span>
            {folded ? <span className="dd-group-n" title={`该分组 ${groupTotal[g] || 0} 个频道`}>{groupTotal[g] || 0}</span> : null}
          </button>
        );
      } else {
        rows.push(<div className="dd-group" key={'g:' + g}>{g}</div>);
      }
    }
    lastGroup = g;
    if (!isVisible(o)) return;
    vi++;
    const i = vi;
    const active = isActive(o);
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
          <div ref={sheetRef} className="dd-sheet" role="dialog" aria-modal="true"
            aria-label={ariaLabel || title} onClick={(ev) => ev.stopPropagation()} {...sheetHandlers}>
            {/* 手势条 = 「往下拖就能收起」的提示 */}
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
