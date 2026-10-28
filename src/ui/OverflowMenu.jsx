/* 溢出菜单（合并头部右侧的 ⋮）：承载不常用功能。
 * 全局项：三视图切换 / 刷新 / 夜间模式 / 设置；
 * 卡片页专属（cardControls）：排序子菜单 + 网格/列表视图切换。
 *
 * 焦点管理：打开即入焦首个菜单项、Esc 关闭、↑↓ 漫游、→ 进子菜单、← 出子菜单、点击外部关闭。
 * 面板为实底（同 .link-menu 治理思路：未锁滚动不模糊），不触发滚动锁定。 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { core } from '@core';

const S = () => core;

const SORTS = [
  { v: 'new', label: '最新' },
  { v: 'old', label: '最早' },
  { v: 'name', label: '名称' },
];

function readShell() {
  try { return core.getShell(); } catch (_) { return {}; }
}

export function OverflowMenu({ view, cardControls = false, sortValue, viewMode }) {
  const [open, setOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snap, setSnap] = useState(readShell);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const subRef = useRef(null);

  const refreshSnap = useCallback(() => setSnap(readShell()), []);
  useEffect(() => {
    window.addEventListener('__shellTick', refreshSnap);
    return () => window.removeEventListener('__shellTick', refreshSnap);
  }, [refreshSnap]);

  const close = useCallback(() => {
    setOpen(false);
    setSubOpen(false);
    btnRef.current && btnRef.current.focus();
  }, []);

  // 打开时入焦首个菜单项；Esc / 外部点击关闭
  useEffect(() => {
    if (!open) { setSubOpen(false); return undefined; }
    const first = menuRef.current && menuRef.current.querySelector('[role="menuitem"],[role="menuitemradio"]');
    if (first) first.focus();
    const onDocDown = (ev) => {
      if (menuRef.current && !menuRef.current.contains(ev.target) && btnRef.current && !btnRef.current.contains(ev.target)) {
        setOpen(false);
      }
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // 子菜单打开时入焦首个排序项
  useEffect(() => {
    if (subOpen && subRef.current) {
      const f = subRef.current.querySelector('[role="menuitemradio"]');
      if (f) f.focus();
    }
  }, [subOpen]);

  const onRefresh = async () => {
    setBusy(true);
    try { await S().refresh(); } finally { setBusy(false); }
  };

  const focusWithin = (dir) => {
    const items = Array.from(menuRef.current.querySelectorAll('[role="menuitem"],[role="menuitemradio"]'));
    const idx = items.indexOf(document.activeElement);
    const next = items[Math.max(0, Math.min(items.length - 1, (idx < 0 ? 0 : idx) + dir))];
    if (next) next.focus();
  };

  const onMenuKey = (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); focusWithin(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); focusWithin(-1); }
    else if (ev.key === 'Home') { ev.preventDefault(); const f = menuRef.current.querySelector('[role="menuitem"],[role="menuitemradio"]'); f && f.focus(); }
    else if (ev.key === 'End') { ev.preventDefault(); const a = menuRef.current.querySelectorAll('[role="menuitem"],[role="menuitemradio"]'); a.length && a[a.length - 1].focus(); }
  };

  const onSubKey = (ev) => {
    if (ev.key === 'ArrowLeft' || ev.key === 'Escape') {
      ev.preventDefault();
      setSubOpen(false);
      const t = menuRef.current.querySelector('[data-subtrigger]');
      t && t.focus();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      const i = subRef.current.querySelectorAll('[role="menuitemradio"]');
      i.length && i[0].focus();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      const i = subRef.current.querySelectorAll('[role="menuitemradio"]');
      i.length && i[i.length - 1].focus();
    }
  };

  return (
    <div className="overflow-wrap">
      <button
        type="button"
        ref={btnRef}
        className="btn btn-ghost btn-sm overflow-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多功能"
        title="更多功能"
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-more" /></svg>
      </button>
      {open && (
        <div className="overflow-menu" role="menu" ref={menuRef} onKeyDown={onMenuKey}>
          <div className="overflow-sep" role="separator" />
          <button type="button" role="menuitem" className="overflow-item" onClick={onRefresh} disabled={busy}>
            <svg className={'ico' + (busy ? ' spin' : '')} aria-hidden="true" focusable="false"><use href="#i-refresh" /></svg>
            <span>刷新</span>
          </button>
          <button type="button" role="menuitem" className="overflow-item" onClick={() => { S().cycleTheme(); }}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + (snap.themeIco || 'theme-auto')} /></svg>
            <span>夜间模式</span>
          </button>
          <button type="button" role="menuitem" className="overflow-item" onClick={() => { S().openSettings(); close(); }}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-settings" /></svg>
            <span>设置</span>
          </button>
          {cardControls && (
            <>
              <div className="overflow-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={subOpen}
                data-subtrigger
                className="overflow-item"
                onMouseEnter={() => setSubOpen(true)}
                onClick={() => setSubOpen((v) => !v)}
                onKeyDown={(e) => { if (e.key === 'ArrowRight') { e.preventDefault(); setSubOpen(true); } }}
              >
                <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-sort" /></svg>
                <span>排序</span>
                <svg className="ico overflow-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
              </button>
              {subOpen && (
                <div className="overflow-submenu" role="menu" ref={subRef} onKeyDown={onSubKey}>
                  {SORTS.map((o) => (
                    <button
                      type="button"
                      key={o.v}
                      role="menuitemradio"
                      aria-checked={sortValue === o.v}
                      className={'overflow-item' + (sortValue === o.v ? ' is-active' : '')}
                      onClick={() => { S().cardsSort(o.v); close(); }}
                    >
                      <span>{o.label}</span>
                      {sortValue === o.v && <svg className="ico overflow-check" aria-hidden="true" focusable="false"><use href="#i-check" /></svg>}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                role="menuitem"
                className="overflow-item"
                onClick={() => { S().cardsView(viewMode === 'grid' ? 'list' : 'grid'); close(); }}
              >
                <svg className="ico" aria-hidden="true" focusable="false"><use href={viewMode === 'grid' ? '#i-list' : '#i-grid'} /></svg>
                <span>{viewMode === 'grid' ? '列表视图' : '网格视图'}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
