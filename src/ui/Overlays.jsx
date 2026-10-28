/* 覆盖层：轻提示 toast + 「N 条新内容」浮标 + 图片灯箱 + 统一确认框。
 *
 * v2.1.0 起这些原本直接改 DOM 的指令式外挂改由 React 渲染，挂载到 #overlaysRoot。
 * 核心只维护状态（util.toastState / util.confirmState / autorefresh.newPillState /
 * ui.lightboxState）并派发 `__overlaysTick`，本组件监听后重读快照重绘 —— 与顶栏
 * `__shellTick` 同一套范式。
 *
 * v1.3.8-test2 起：确认框也住在这里（替代原生 confirm / prompt），toast 补了
 * role="status" / aria-live，不再有「屏幕阅读器听不到保存成功」的问题。
 */
import React, { useEffect, useRef, useState } from 'react';
import { core } from '@core';

const S = () => core;

/* 覆盖层渲染 toast / 新内容浮标 / 图片灯箱 / 确认框。
 * 快捷键说明自 v1.1.7 起迁至 设置 → 帮助 面板，不再在此渲染浮层。 */

function ConfirmDialog({ c }) {
  const valueRef = useRef(null);
  const okRef = useRef(null);
  const [value, setValue] = useState('');

  // 每次打开重置输入值，并把焦点放到该去的地方（有输入框 → 输入框，否则 → 主按钮）
  useEffect(() => {
    if (!c.open) return;
    setValue('');
    const t = setTimeout(() => {
      if (c.input && valueRef.current) valueRef.current.focus();
      else if (okRef.current) okRef.current.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [c.open, c.input]);

  // Esc = 取消。用捕获阶段并阻断冒泡，避免同一击把设置弹层 / 命令面板也关掉。
  useEffect(() => {
    if (!c.open) return undefined;
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      S().cancelConfirm();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [c.open]);

  if (!c.open) return null;

  const submit = (ev) => {
    ev.preventDefault();
    const raw = c.input ? (c.input.type === 'password' ? value : value.trim()) : true;
    if (c.input && c.input.required && !raw) {
      if (valueRef.current) valueRef.current.focus();
      return;
    }
    S().settleConfirm(true, raw);
  };

  return (
    <div
      className="modal-mask confirm-mask"
      role="presentation"
      onMouseDown={(ev) => { if (ev.target === ev.currentTarget) S().cancelConfirm(); }}
    >
      <form
        className={'modal confirm' + (c.danger ? ' is-danger' : '')}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmTitle"
        aria-describedby={c.desc ? 'confirmDesc' : undefined}
        onSubmit={submit}
      >
        <div className="modal-head">
          <div className="confirm-head-txt">
            <h2 id="confirmTitle">{c.title}</h2>
            {c.desc ? <p className="modal-sub" id="confirmDesc">{c.desc}</p> : null}
          </div>
          <button className="modal-close" type="button" aria-label="取消" onClick={() => S().cancelConfirm()}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
          </button>
        </div>

        {c.input ? (
          <div className="confirm-body">
            {c.input.label ? <label className="confirm-label" htmlFor="confirmInput">{c.input.label}</label> : null}
            <input
              id="confirmInput"
              ref={valueRef}
              className="confirm-input"
              type={c.input.type || 'text'}
              placeholder={c.input.placeholder || ''}
              autoComplete={c.input.autoComplete || 'off'}
              value={value}
              onChange={(ev) => setValue(ev.target.value)}
            />
          </div>
        ) : null}

        <div className="confirm-foot">
          <button className="btn btn-ghost" type="button" onClick={() => S().cancelConfirm()}>
            {c.cancelText}
          </button>
          <button className={'btn ' + (c.danger ? 'btn-danger-solid' : 'btn-primary')} type="submit" ref={okRef}>
            {c.confirmText}
          </button>
        </div>
      </form>
    </div>
  );
}

/* 图片灯箱：点文章里的图片看大图。作为模态对话框（aria-modal）须满足键盘可达：
 * 打开即把焦点放进对话框、Esc 关闭、Tab 循环不跑出对话框、打开期间锁背景滚动。 */
function Lightbox({ box, close }) {
  const rootRef = useRef(null);
  const closeRef = useRef(null);

  // 打开时把焦点放进对话框（优先关闭按钮，回退到容器）
  useEffect(() => {
    const t = setTimeout(() => {
      if (closeRef.current) closeRef.current.focus();
      else if (rootRef.current) rootRef.current.focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // 打开期间锁背景滚动（与确认框共用同一计数器）；关闭时解自己那一层
  useEffect(() => {
    const s = S();
    if (!s) return undefined;
    s.lockPageScroll();
    return () => s.unlockPageScroll();
  }, []);

  // Esc 关闭 + Tab 焦点陷阱（确认框打开时让位于确认框的 Esc 处理）
  useEffect(() => {
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        if (window.__confirmOpen) return;
        ev.preventDefault();
        ev.stopPropagation();
        close();
      } else if (ev.key === 'Tab') {
        ev.preventDefault();
        if (closeRef.current) closeRef.current.focus();
        else if (rootRef.current) rootRef.current.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [close]);

  const list = Array.isArray(box.list) ? box.list : [];
  const multi = list.length > 1;
  const step = (d) => { const s = S(); if (s && s.stepLightbox) s.stepLightbox(d); };

  return (
    <div
      ref={rootRef}
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={multi ? `图片预览，第 ${box.index + 1} 张，共 ${list.length} 张` : '图片预览'}
      tabIndex={-1}
      onClick={() => close()}
    >
      <img className="lightbox-img" src={box.src} alt="" />
      {multi ? (
        <React.Fragment>
          <button
            className="lightbox-nav is-prev"
            type="button"
            aria-label="上一张"
            onClick={(ev) => { ev.stopPropagation(); step(-1); }}
          >
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
          </button>
          <button
            className="lightbox-nav is-next"
            type="button"
            aria-label="下一张"
            onClick={(ev) => { ev.stopPropagation(); step(1); }}
          >
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
          </button>
          <p className="lightbox-count" aria-live="polite">{box.index + 1} / {list.length}</p>
        </React.Fragment>
      ) : null}
      <button
        ref={closeRef}
        className="lightbox-close"
        type="button"
        aria-label="关闭预览"
        onClick={close}
      >
        <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
      </button>
      <p className="lightbox-hint">{multi ? '← → 切换 · 点击任意处或按 Esc 关闭' : '点击任意处或按 Esc 关闭'}</p>
    </div>
  );
}

export function Overlays() {
  const [, bump] = useState(0);
  useEffect(() => {
    const onTick = () => bump((n) => n + 1);
    window.addEventListener('__overlaysTick', onTick);
    return () => window.removeEventListener('__overlaysTick', onTick);
  }, []);

  const s = S();
  const toast = (s && s.getToastState) ? s.getToastState() : { msg: '', ok: true, show: false };
  const pill = (s && s.getNewPillState) ? s.getNewPillState() : { show: false, text: '' };
  const box = (s && s.getLightboxState) ? s.getLightboxState() : { src: '', show: false };
  const cfm = (s && s.getConfirmState) ? s.getConfirmState() : { open: false };

  // 确认框打开期间锁住背景滚动（与设置弹层用同一个计数器，关掉时只解自己那一层），
  // 同时把「确认框在最上层」告诉其他 Esc 处理器（见 core/ui.js）。
  useEffect(() => {
    window.__confirmOpen = !!cfm.open;
    if (!cfm.open || !s) return undefined;
    s.lockPageScroll();
    return () => { window.__confirmOpen = false; s.unlockPageScroll(); };
  }, [cfm.open]);

  if (!s) return null;

  return (
    <>
      {/* 轻提示：role=status + aria-live 让屏幕阅读器也能播报保存结果 */}
      <div
        className={'toast' + (toast.show ? ' show' + (toast.ok ? ' ok' : ' err') : '')}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {toast.ok
          ? <svg className="ico toast-ico" aria-hidden="true" focusable="false"><use href="#i-check" /></svg>
          : <svg className="ico toast-ico err" aria-hidden="true" focusable="false"><use href="#i-alert" /></svg>}
        {toast.msg}
      </div>

      {/* 自动刷新发现了新内容、但用户已经滚下去了：点它才套用，避免列表在眼皮底下跳 */}
      <button
        className="new-pill"
        type="button"
        hidden={!pill.show}
        onClick={() => s.applyPendingFresh()}
      >
        <svg className="new-pill-ico" aria-hidden="true" focusable="false"><use href="#i-arrow-up" /></svg>
        <span>{pill.text}</span>
      </button>

      {/* 图片灯箱：点文章里的图片看大图，自适应屏幕，再点一下 / Esc 关闭 */}
      {box.show && <Lightbox box={box} close={() => s.closeLightbox()} />}

      {/* 统一确认框（替代原生 confirm / prompt） */}
      <ConfirmDialog c={cfm} />
    </>
  );
}
