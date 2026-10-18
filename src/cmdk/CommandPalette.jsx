/* 命令面板 React 组件（⌘K / Ctrl+K 开关）。
 * 从旧 public/app.js 的原生 DOM 实现逐行为等价移植：
 * 键位（↑↓/↵/Esc）、拼音过滤、分组渲染、类名全部保持一致，
 * 视觉与交互零变化；动作经 `@core` 单例调用核心逻辑。 */

import { core } from '@core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { buildCommands, cmdkFilter } from './commands.js';

const BRIDGE = () => core;   // 核心逻辑单例（@core）

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // ⌘K (mac) / Ctrl+K (win) 开关面板（与原实现一致）
  useEffect(() => {
    const onKey = (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) {
        ev.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // 开合状态同步给旧 app（阅读页 j/k 键盘导航在面板开着时不应响应）
  useEffect(() => {
    window.__cmdkOpen = open;
    return () => { window.__cmdkOpen = false; };
  }, [open]);

  // 打开时清空输入并聚焦；关闭时还给焦点
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      const raf = requestAnimationFrame(() => {
        if (inputRef.current) inputRef.current.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [open]);

  // 高亮项滚入可视区（与原 cmdkSetActive 的 scrollIntoView 一致）
  useEffect(() => {
    const el = listRef.current && listRef.current.querySelector('.cmdk-item.active');
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const close = useCallback(() => setOpen(false), []);
  const items = open ? cmdkFilter(buildCommands(BRIDGE()), q) : [];

  const runCmdk = useCallback((idx) => {
    const c = items[idx];
    if (!c) return;
    close();
    try { c.run(); } catch (err) { console.error(err); }
  }, [items, close]);

  const onInputKeyDown = (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive((i) => (items.length ? (i + 1) % items.length : 0)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive((i) => (items.length ? (i - 1 + items.length) % items.length : 0)); }
    else if (ev.key === 'Enter') { ev.preventDefault(); runCmdk(active); }
    else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  };

  const onMaskClick = (ev) => { if (ev.target === ev.currentTarget) close(); };

  const isMac = /mac|iphone|ipad|ipod/i.test(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '');

  if (!open) return null;

  let rows = null;
  let lastGroup = null;
  if (!items.length) {
    rows = <div className="cmdk-empty">没有匹配的命令</div>;
  } else {
    rows = items.map((c, idx) => {
      const head = c.group !== lastGroup ? (
        <div className="cmdk-group-label" key={'g-' + idx}>{c.group}</div>
      ) : null;
      lastGroup = c.group;
      return (
        <React.Fragment key={idx}>
          {head}
          <button
            className={'cmdk-item' + (idx === active ? ' active' : '')}
            type="button"
            role="option"
            aria-selected={idx === active ? 'true' : 'false'}
            onMouseMove={() => setActive(idx)}
            onClick={() => runCmdk(idx)}
          >
            <svg className="cmdk-ico" aria-hidden="true" focusable="false"><use href={'#i-' + c.icon} /></svg>
            <span className="cmdk-label">{c.label}</span>
            {c.hint ? <span className="cmdk-tag">{c.hint}</span> : null}
          </button>
        </React.Fragment>
      );
    });
  }

  return (
    <div className="cmdk-mask" onClick={onMaskClick}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="cmdk-input-wrap">
          <svg className="search-ico" aria-hidden="true" focusable="false"><use href="#i-search" /></svg>
          <input
            ref={inputRef}
            className="cmdk-input"
            type="text"
            placeholder="输入命令或搜索…（⌘K / Ctrl+K 开关，↑↓ 选择，↵ 执行，Esc 关闭）"
            autoComplete="off"
            spellCheck="false"
            value={q}
            onChange={(ev) => { setQ(ev.target.value); setActive(0); }}
            onKeyDown={onInputKeyDown}
          />
          <kbd className="cmdk-kbd">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </div>
        <div className="cmdk-list" ref={listRef} role="listbox">{rows}</div>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 执行</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  );
}
