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
import { on, EVENT } from '../kernel/events.js';
import { provide, revoke, isOn } from '../kernel/bridge.js';

const S = () => core;

/* 覆盖层渲染 toast / 新内容浮标 / 图片灯箱 / 确认框。
 * 快捷键说明自 v1.1.7 起迁至 设置 → 帮助 面板，不再在此渲染浮层。 */

function ConfirmDialog({ c }) {
  const valueRef = useRef(null);
  const okRef = useRef(null);
  const formRef = useRef(null);
  const [value, setValue] = useState('');
  // 必填校验的内联错误：常驻 role=alert 容器，空态只收掉视觉占位
  const [err, setErr] = useState('');
  // 打开它的那个元素：关闭后把焦点还回去（否则掉到 body，键盘用户要从头 Tab）
  const openerRef = useRef(null);

  // 每次打开重置输入值，并把焦点放到该去的地方（有输入框 → 输入框，否则 → 主按钮）
  useEffect(() => {
    if (!c.open) return;
    openerRef.current = document.activeElement;
    setValue('');
    setErr('');
    const t = setTimeout(() => {
      if (c.input && valueRef.current) valueRef.current.focus();
      else if (okRef.current) okRef.current.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [c.open, c.input]);

  // 关闭后归还焦点。触发按钮可能已随弹层卸载（例如从命令面板发起后菜单已关），
  // 所以先确认它还在文档里。
  useEffect(() => {
    if (c.open) return;
    const op = openerRef.current;
    openerRef.current = null;
    if (op && op !== document.body && document.contains(op) && typeof op.focus === 'function') op.focus();
  }, [c.open]);

  // Esc = 取消。用捕获阶段并阻断冒泡，避免同一击把设置弹层 / 命令面板也关掉。
  // Tab 也一并收在这个对话框里：它是叠在设置弹层之上的独立模态，焦点不能漏到背景。
  useEffect(() => {
    if (!c.open) return undefined;
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        S().cancelConfirm();
        return;
      }
      if (ev.key !== 'Tab') return;
      const root = formRef.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])'))
        .filter((el) => !el.disabled);
      if (!items.length) { ev.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (!root.contains(at)) { ev.preventDefault(); first.focus(); return; }
      if (ev.shiftKey && at === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && at === last) { ev.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [c.open]);

  if (!c.open) return null;

  const submit = (ev) => {
    ev.preventDefault();
    const raw = c.input ? (c.input.type === 'password' ? value : value.trim()) : true;
    if (c.input && c.input.required && !raw) {
      // 空值以前只是把焦点塞回输入框，没有任何可见原因；改成与登录页同一套内联错误
      setErr(c.input.label ? '请填写' + c.input.label : '此项不能为空');
      if (valueRef.current) valueRef.current.focus();
      return;
    }
    setErr('');
    S().settleConfirm(true, raw);
  };

  return (
    <div
      className="modal-mask confirm-mask"
      role="presentation"
      onMouseDown={(ev) => { if (ev.target === ev.currentTarget) S().cancelConfirm(); }}
    >
      <form
        ref={formRef}
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
              aria-invalid={err ? 'true' : undefined}
              aria-describedby={err ? 'confirmErr' : undefined}
              onChange={(ev) => { setValue(ev.target.value); if (err) setErr(''); }}
            />
            {/* 常驻 DOM：从 display:none 切出来时部分读屏不播报，空态只收高度 */}
            <p className="confirm-err" id="confirmErr" role="alert">{err}</p>
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
        if (isOn('confirmOpen')) return;
        ev.preventDefault();
        ev.stopPropagation();
        close();
      } else if (ev.key === 'Tab') {
        if (isOn('confirmOpen')) return;   // 确认框叠在上面时，Tab 归它管
        // 灯箱里所有按钮（上一张 / 下一张 / 关闭）一起循环，键盘也能切图
        const f = rootRef.current ? Array.from(rootRef.current.querySelectorAll('button')) : [];
        if (!f.length) { ev.preventDefault(); if (rootRef.current) rootRef.current.focus(); return; }
        ev.preventDefault();
        const idx = f.indexOf(document.activeElement);
        f[(idx + (ev.shiftKey ? -1 : 1) + f.length) % f.length].focus();
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
      {/* 根节点的 onClick 也是 close：关闭按钮必须拦住冒泡，否则一次点击调两次
          （幂等，但会多走一遍状态与焦点归还） */}
      <button
        ref={closeRef}
        className="lightbox-close"
        type="button"
        aria-label="关闭预览"
        onClick={(ev) => { ev.stopPropagation(); close(); }}
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
    return on(EVENT.OVERLAYS, onTick);
  }, []);

  const s = S();
  const toast = (s && s.getToastState) ? s.getToastState() : { msg: '', ok: true, show: false, action: null, actionText: '' };
  const pill = (s && s.getNewPillState) ? s.getNewPillState() : { show: false, text: '' };
  const box = (s && s.getLightboxState) ? s.getLightboxState() : { src: '', show: false };
  const cfm = (s && s.getConfirmState) ? s.getConfirmState() : { open: false };

  // 确认框打开期间锁住背景滚动（与设置弹层用同一个计数器，关掉时只解自己那一层），
  // 同时把「确认框在最上层」告诉其他 Esc 处理器（见 core/ui.js）。
  useEffect(() => {
    provide('confirmOpen', !!cfm.open);
    if (!cfm.open || !s) return undefined;
    s.lockPageScroll();
    return () => { revoke('confirmOpen'); s.unlockPageScroll(); };
  }, [cfm.open]);

  if (!s) return null;

  return (
    <>
      {/* 轻提示：成功走 polite 的 status，失败走 assertive 的 alert ——
          错误不该排在其它状态消息之后才播报。 */}
      <div
        className={'toast' + (toast.show ? ' show' + (toast.ok ? ' ok' : ' err') : '')}
        role={toast.ok ? 'status' : 'alert'}
        aria-live={toast.ok ? 'polite' : 'assertive'}
        aria-atomic="true"
      >
        {toast.ok
          ? <svg className="ico toast-ico" aria-hidden="true" focusable="false"><use href="#i-check" /></svg>
          : <svg className="ico toast-ico err" aria-hidden="true" focusable="false"><use href="#i-alert" /></svg>}
        {toast.msg}
        {/* 行内动作（批量已读的「撤销」）：toast 本身 pointer-events:none，
            有按钮时样式才放开命中。按钮不主动抢焦点（不打断阅读），但保留 Tab 可达，
            键盘用户不必只能用鼠标撤销；触屏命中区由 CSS 补到 44px。 */}
        {toast.action
          ? <button type="button" className="toast-act" onClick={() => s.runToastAction && s.runToastAction()}>{toast.actionText || '撤销'}</button>
          : null}
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
