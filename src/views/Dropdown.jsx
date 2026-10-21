/* 卡片工具栏自定义下拉（v1.1.9）。
 * 原生 <select> 的展开弹窗由操作系统渲染（桌面是半透明系统面板、移动端是原生底部列表），
 * 与应用的拟态玻璃风格不统一 —— 这里以自绘浮层替代，视觉与交互完全受控：
 * 分组标题、选中勾、键盘 ↑↓ / Enter / Esc、外点关闭、打开时选中项滚入视野。
 * 触发按钮沿用 .select 外观（与工具栏一致），弹层为玻璃面板
 * （position:absolute 静态覆盖层，非 sticky，符合「弹层才用模糊」的性能铁律）。 */

import React, { useEffect, useRef, useState } from 'react';

export function Dropdown({ id, wrapId, title, ariaLabel, value, options, onChange }) {
  // options: [{ value, label, group }]；group 为分组名（'' / undefined 表示无分组）
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);   // 键盘 ↑↓ / 悬停高亮的下标
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const triggerRef = useRef(null);

  const cur = options.find((o) => String(o.value) === String(value));

  // 打开期间：点外面 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev) => { if (rootRef.current && !rootRef.current.contains(ev.target)) setOpen(false); };
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      setOpen(false);
      if (triggerRef.current) triggerRef.current.focus();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 打开时把选中项滚进视野（面板渲染完成后）
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const el = panelRef.current.querySelector('.dd-item.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [open]);

  const pick = (v) => {
    setOpen(false);
    setHi(-1);
    if (onChange) onChange(v);
  };

  const onKeyDown = (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!open) { setOpen(true); setHi(options.findIndex((o) => o === cur)); return; }
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
        onClick={() => { setOpen(!open); setHi(-1); }}>
        <span className="dd-label">{cur ? cur.label : ''}</span>
        <svg className="ico dd-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-down" /></svg>
      </button>
      {open && (
        <div className="dd-panel" role="listbox" aria-label={ariaLabel || title} ref={panelRef}>
          {rows}
        </div>
      )}
    </div>
  );
}
