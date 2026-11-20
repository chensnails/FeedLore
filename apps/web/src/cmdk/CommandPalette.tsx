/* 命令面板 React 组件（⌘K / Ctrl+K 开关）。
 * 从旧 public/app.js 的原生 DOM 实现逐行为等价移植：
 * 键位（↑↓/↵/Esc）、拼音过滤、分组渲染、类名全部保持一致，
 * 视觉与交互零变化；动作经 `@core` 单例调用核心逻辑。 */

import { core } from '@core';
import * as Dialog from '@radix-ui/react-dialog';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { provide, revoke } from '../kernel/bridge.ts';
import { hasLayerAbove } from '../ui/layers.ts';
import { NO_AUTOFILL_PROPS, useNoAutofillName } from '../ui/noAutofill.ts';
import { buildCommands, cmdkFilter } from './commands.ts';

const BRIDGE = () => core; // 核心逻辑单例（@core）

export function CommandPalette() {
  const [open, setOpen] = useState<any>(false);
  const [q, setQ] = useState<any>('');
  const [active, setActive] = useState<any>(0);
  const inputRef: any = useRef<any>(null);
  const listRef: any = useRef<any>(null);
  const panelRef: any = useRef<any>(null);
  // 命令面板是全局搜索框，不是登录框：名字要唯一且被密码管理器忽略（DESIGN 第 10 条）。
  // 之前漏了这层防护，Chrome/Edge Android 会把保存的用户名填进来当成搜索词。
  const noAutofillName = useNoAutofillName('cmdk');

  // ⌘K (mac) / Ctrl+K (win) 开关面板（与原实现一致）。
  // 打开前先看有没有更上层的弹层：命令面板 z-index(500) 高于设置弹层(200)，
  // 之前能在确认框 / 设置之上再叠一层模态，两层 Tab 陷阱互相抢焦点、Esc 关错层。
  // 已经开着时永远允许关（这是「我就要退出」的意图）。
  useEffect(() => {
    /**
     * @param {*} [ev]
     */
    const onKey = (ev: any) => {
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) {
        ev.preventDefault();
        setOpen(
          /** @param {*} [o] */ (o: any) => {
            if (o) return false;
            return !hasLayerAbove('cmdk');
          },
        );
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // 开合状态同步给旧 app（命令面板开着时屏蔽页面级键盘交互）
  useEffect(() => {
    provide('cmdkOpen', open);
    return () => {
      revoke('cmdkOpen');
    };
  }, [open]);

  // 打开时清空输入并聚焦；关闭时把焦点还给打开它的那个按钮（与设置弹层 / 灯箱一致）。
  // 不还的话焦点掉到 body，键盘用户得从头 Tab 回原来那块地方。
  const openerRef: any = useRef<any>(null);
  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement;
      setQ('');
      setActive(0);
      const raf = requestAnimationFrame(() => {
        if (inputRef.current) inputRef.current.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    const op = openerRef.current;
    openerRef.current = null;
    // 触发元素可能已随视图切换被卸载；只在还挂在文档里时归还
    if (op && op !== document.body && document.contains(op) && typeof op.focus === 'function')
      op.focus();
  }, [open]);

  // 高亮项滚入可视区（与原 cmdkSetActive 的 scrollIntoView 一致）
  useEffect(() => {
    const el = listRef.current && listRef.current.querySelector('.cmdk-item.active');
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const close = useCallback(() => setOpen(false), []);
  const matched = open ? cmdkFilter(buildCommands(BRIDGE()), q) : [];
  // 输入词同时当「全文搜索」用：命令都不匹配时它就是唯一一条，回车直接搜；
  // 有命令匹配时排在最后，回车仍先执行命令，想搜再按 ↓ 选它。
  const query = q.trim();
  const searchCmd =
    open && query
      ? {
          group: '搜索',
          icon: 'search',
          label: `在文章中搜索「${query}」`,
          hint: 'Enter',
          run: () => {
            const c = BRIDGE();
            if (c.state.tab !== 'reader') c.switchView('reader');
            if (c.readerSearch) c.readerSearch(query);
          },
        }
      : null;
  const items = searchCmd ? matched.concat([searchCmd]) : matched;

  const runCmdk = useCallback(
    /** @param {*} [idx] */ (idx: any) => {
      const c = items[idx];
      if (!c) return;
      close();
      try {
        c.run();
      } catch (err) {
        console.error(err);
      }
    },
    [items, close],
  );

  /**
   * @param {*} [ev]
   */
  const onInputKeyDown = (ev: any) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setActive(/** @param {*} [i] */ (i: any) => (items.length ? (i + 1) % items.length : 0));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setActive(
        /** @param {*} [i] */ (i: any) =>
          items.length ? (i - 1 + items.length) % items.length : 0,
      );
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      runCmdk(active);
    }
  };

  /**
   * @param {*} [ev]
   */
  const isMac = /mac|iphone|ipad|ipod/i.test(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '',
  );

  let rows: any = null;
  let lastGroup: any = null;
  if (!items.length) {
    rows = <div className="cmdk-empty">没有匹配的命令</div>;
  } else {
    rows = items.map(
      /** @param {*} [c] @param {*} [idx] */ (c: any, idx: any) => {
        const head: any =
          c.group !== lastGroup ? (
            <div className="cmdk-group-label" key={'g-' + idx}>
              {c.group}
            </div>
          ) : null;
        lastGroup = c.group;
        return (
          <React.Fragment key={idx}>
            {head}
            <button
              className={'cmdk-item' + (idx === active ? ' active' : '')}
              type="button"
              role="option"
              id={'cmdkOpt' + idx}
              aria-selected={idx === active ? 'true' : 'false'}
              onMouseMove={() => setActive(idx)}
              onClick={() => runCmdk(idx)}
            >
              <svg className="cmdk-ico" aria-hidden="true" focusable="false">
                <use href={'#i-' + c.icon} />
              </svg>
              <span className="cmdk-label">{c.label}</span>
              {c.hint ? <span className="cmdk-tag">{c.hint}</span> : null}
            </button>
          </React.Fragment>
        );
      },
    );
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o: any) => {
        if (!o) close();
      }}
    >
      <Dialog.Portal container={document.getElementById('cmdkRoot') || document.body}>
        <Dialog.Overlay className="cmdk-mask" role="presentation" />
        <Dialog.Content asChild aria-describedby={undefined}>
          <div
            className="cmdk"
            role="dialog"
            aria-modal="true"
            aria-label="命令面板"
            ref={panelRef}
          >
            <Dialog.Title className="sr-only">命令面板</Dialog.Title>
            <div className="cmdk-input-wrap">
              <svg className="search-ico" aria-hidden="true" focusable="false">
                <use href="#i-search" />
              </svg>
              {/* ↑↓ 只改 active 状态、焦点始终留在输入框，必须靠 aria-activedescendant
              把「当前高亮项」报给读屏，否则读屏听不出选中了哪条。 */}
              <input
                ref={inputRef}
                className="cmdk-input"
                type="text"
                name={noAutofillName}
                placeholder="输入命令或搜索…"
                {...NO_AUTOFILL_PROPS}
                role="combobox"
                aria-label="搜索命令"
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls="cmdkList"
                aria-activedescendant={items.length ? 'cmdkOpt' + active : undefined}
                value={q}
                onChange={
                  /** @param {*} [ev] */ (ev: any) => {
                    setQ(ev.target.value);
                    setActive(0);
                  }
                }
                onKeyDown={onInputKeyDown}
              />
              <kbd className="cmdk-kbd">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
            </div>
            <div
              className="cmdk-list"
              ref={listRef}
              role="listbox"
              id="cmdkList"
              aria-label="命令列表"
            >
              {rows}
            </div>
            <div className="cmdk-foot">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> 选择
              </span>
              <span>
                <kbd>↵</kbd> 执行
              </span>
              <span>
                <kbd>Esc</kbd> 关闭
              </span>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
