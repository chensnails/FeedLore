/* 覆盖层：轻提示 toast + 「N 条新内容」浮标 + 图片灯箱 + 统一确认框。
 *
 * v2.1.0 起这些原本直接改 DOM 的指令式外挂改由 React 渲染，挂载到 #overlaysRoot。
 * 核心只维护状态（util.toastState / util.confirmState / autorefresh.newPillState /
 * ui.lightboxState）并派发 `__overlaysTick`，本组件监听后重读快照重绘 —— 与顶栏
 * `__shellTick` 同一套范式。
 *
 * V5：确认框与灯箱由 Radix AlertDialog / Dialog 接管浮层语义（模态、FocusScope、
 * DismissableLayer、滚动锁、Esc）。自研的焦点陷阱 / 返回键栈 / 计数滚动锁已移除，
 * 采用标准库默认行为。Radix Portal 用 container 指向 #overlaysRoot，保留 DOM 层级
 * 与 z-index 层叠上下文（不是自研补丁，是 Radix Portal 的标准 container API）。
 * DOM 契约（class / role / id / aria）逐字保留。
 */

import { core } from '@core';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import React, { type FormEvent, useEffect, useRef, useState } from 'react';
import type { LightboxState, ToastState } from '../core/types.ts';
import { provide, revoke } from '../kernel/bridge.ts';
import { EVENT, on } from '../kernel/events.ts';

const S = () => core;

/** 确认框快照（core.confirmState）：input 还带 label / required / autoComplete。 */
interface OverlayConfirmState {
  open: boolean;
  title?: string;
  desc?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  input?: {
    placeholder?: string;
    type?: string;
    label?: string;
    required?: boolean;
    autoComplete?: string;
  } | null;
}

/** Radix Portal 统一挂到 #overlaysRoot：保住层叠上下文与查询作用域。 */
function overlayContainer() {
  return document.getElementById('overlaysRoot') || document.body;
}

function ConfirmDialog({ c }: { c: OverlayConfirmState }) {
  const valueRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState('');
  // 必填校验的内联错误：常驻 role=alert 容器，空态只收掉视觉占位
  const [err, setErr] = useState('');

  // 每次打开重置输入值（Radix FocusScope 负责把焦点放进对话框）
  useEffect(() => {
    if (!c.open) return;
    setValue('');
    setErr('');
  }, [c.open, c.input]);

  const submit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const raw = c.input ? (c.input.type === 'password' ? value : value.trim()) : true;
    if (c.input && c.input.required && !raw) {
      setErr(c.input.label ? '请填写' + c.input.label : '此项不能为空');
      if (valueRef.current) valueRef.current.focus();
      return;
    }
    setErr('');
    S().settleConfirm(true, raw);
  };

  /* Radix AlertDialog 接管浮层语义。onOpenChange 把 Radix 的 Esc / 遮罩点击关闭
   * 映射回 core 的取消结算（Promise 状态机仍由 core 掌管，标准库只管浮层行为）。
   *
   * 不用 Portal：与 CardDetail 同构——原先用 AlertDialog.Portal 把 Overlay 和 Content
   * 都甩到 #overlaysRoot，两者成了兄弟，.modal（position:static）不再被 .modal-mask
   * 的 flex 居中；窄屏页面一长，#overlaysRoot 被推到视口外（y=视口高），弹窗掉出屏幕，
   * 只剩 fixed 遮罩 → 用户看到「黑屏 / 确认框没显示」。改为就地渲染：.modal-mask 是
   * 普通 div（保留 DOM 契约与 flex 居中），AlertDialog.Content 作为它的子元素。
   * Overlay 的遮罩点击语义由 Root 的 onOpenChange + mask 上的点击兜底提供。 */
  return (
    <AlertDialog.Root
      open={!!c.open}
      onOpenChange={
        /** @param {*} [open] */ (open) => {
          if (!open) S().cancelConfirm();
        }
      }
    >
      <div
        className="modal-mask confirm-mask"
        role="presentation"
        hidden={!c.open}
        onClick={(ev) => {
          if (ev.target === ev.currentTarget) S().cancelConfirm();
        }}
      >
        <AlertDialog.Content asChild>
          <form
            id="confirmBox"
            className={'modal confirm' + (c.danger ? ' is-danger' : '')}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirmTitle"
            aria-describedby={c.desc ? 'confirmDesc' : undefined}
            onSubmit={submit}
          >
            <div className="modal-head">
              <div className="confirm-head-txt">
                <AlertDialog.Title asChild>
                  <h2 id="confirmTitle">{c.title}</h2>
                </AlertDialog.Title>
                {c.desc ? (
                  <AlertDialog.Description asChild>
                    <p className="modal-sub" id="confirmDesc">
                      {c.desc}
                    </p>
                  </AlertDialog.Description>
                ) : null}
              </div>
              <AlertDialog.Cancel asChild>
                <button className="modal-close" type="button" aria-label="取消">
                  <svg className="ico" aria-hidden="true" focusable="false">
                    <use href="#i-x" />
                  </svg>
                </button>
              </AlertDialog.Cancel>
            </div>

            {c.input ? (
              <div className="confirm-body">
                {c.input.label ? (
                  <label className="confirm-label" htmlFor="confirmInput">
                    {c.input.label}
                  </label>
                ) : null}
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
                  onChange={
                    /** @param {*} [ev] */ (ev) => {
                      setValue(ev.target.value);
                      if (err) setErr('');
                    }
                  }
                />
                {/* 常驻 DOM：从 display:none 切出来时部分读屏不播报，空态只收高度 */}
                <p className="confirm-err" id="confirmErr" role="alert">
                  {err}
                </p>
              </div>
            ) : null}

            <div className="confirm-foot">
              <AlertDialog.Cancel asChild>
                <button className="btn btn-ghost" type="button">
                  {c.cancelText}
                </button>
              </AlertDialog.Cancel>
              {/* 确认按钮不能用 AlertDialog.Action：Radix 把它实现成 DialogPrimitive.Close，
               * 点击时 composeEventHandlers 先跑 onOpenChange(false)（→ cancelConfirm 结算成取消），
               * 等 form 的 onSubmit 再 settleConfirm(true) 时 Promise 已被结算，确认被吞成取消。
               * 真机「点全部已读」请求根本不发出即是此因。这里只保留原生 submit 按钮，
               * 关闭权完全交给 core 状态机（submit → settleConfirm(true) → emitOverlays → open=false）。
               * 取消按钮仍用 AlertDialog.Cancel（取消本就该关框）。DOM 契约 class/role/id 不变。 */}
              <button
                className={'btn ' + (c.danger ? 'btn-danger-solid' : 'btn-primary')}
                type="submit"
              >
                {c.confirmText}
              </button>
            </div>
          </form>
        </AlertDialog.Content>
      </div>
    </AlertDialog.Root>
  );
}

/* 图片灯箱：点文章里的图片看大图。Radix Dialog 接管模态语义 —— FocusScope 管焦点、
 * DismissableLayer 管 Esc / 遮罩关闭、自带滚动锁。DOM 契约逐字保留。 */
function Lightbox({ box, close }: { box: LightboxState; close: () => void }) {
  const list = Array.isArray(box.list) ? box.list : [];
  const multi = list.length > 1;
  const step = (d: number) => {
    const s = S();
    if (s && s.stepLightbox) s.stepLightbox(d);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <Dialog.Portal container={overlayContainer()}>
        <Dialog.Content asChild aria-describedby={undefined}>
          <div
            className="lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={
              multi ? `图片预览，第 ${box.index + 1} 张，共 ${list.length} 张` : '图片预览'
            }
            tabIndex={-1}
            onClick={() => close()}
          >
            <Dialog.Title className="sr-only">
              {multi ? `图片预览，第 ${box.index + 1} 张，共 ${list.length} 张` : '图片预览'}
            </Dialog.Title>
            <img className="lightbox-img" src={box.src} alt="" />
            {multi ? (
              <React.Fragment>
                <button
                  className="lightbox-nav is-prev"
                  type="button"
                  aria-label="上一张"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    step(-1);
                  }}
                >
                  <svg className="ico" aria-hidden="true" focusable="false">
                    <use href="#i-chevron-right" />
                  </svg>
                </button>
                <button
                  className="lightbox-nav is-next"
                  type="button"
                  aria-label="下一张"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    step(1);
                  }}
                >
                  <svg className="ico" aria-hidden="true" focusable="false">
                    <use href="#i-chevron-right" />
                  </svg>
                </button>
                <p className="lightbox-count" aria-live="polite">
                  {box.index + 1} / {list.length}
                </p>
              </React.Fragment>
            ) : null}
            <Dialog.Close asChild>
              <button className="lightbox-close" type="button" aria-label="关闭预览">
                <svg className="ico" aria-hidden="true" focusable="false">
                  <use href="#i-x" />
                </svg>
              </button>
            </Dialog.Close>
            <p className="lightbox-hint">
              {multi ? '← → 切换 · 点击任意处或按 Esc 关闭' : '点击任意处或按 Esc 关闭'}
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Overlays() {
  const [, bump] = useState(0);
  useEffect(() => {
    const onTick = () => bump((n) => n + 1);
    return on(EVENT.OVERLAYS, onTick);
  }, []);

  const s = S();
  const toast: ToastState =
    s && s.getToastState
      ? s.getToastState()
      : { msg: '', ok: true, show: false, action: null, actionText: '' };
  /* 多槽队列：并发提示不再互相覆盖；旧桥（测试桩）没有队列时退回单条。 */
  const queue = s && s.getToastQueue ? s.getToastQueue() : null;
  const toasts: ToastState[] = queue && queue.length ? [...queue] : [toast];
  const pill = s && s.getNewPillState ? s.getNewPillState() : { show: false, text: '' };
  const box: LightboxState =
    s && s.getLightboxState ? s.getLightboxState() : { src: '', show: false, list: [], index: 0 };
  const cfm = s && s.getConfirmState ? s.getConfirmState() : { open: false };

  // 确认框开着时告诉其它（自研）Esc 处理器让位：core/ui.ts 的层级仲裁读这个桥。
  useEffect(() => {
    provide('confirmOpen', !!cfm.open);
    return () => {
      revoke('confirmOpen');
    };
  }, [cfm.open]);

  if (!s) return null;

  return (
    <>
      {/* 轻提示：成功走 polite 的 status，失败走 assertive 的 alert ——
          错误不该排在其它状态消息之后才播报。多条并发时按到达顺序叠放，
          带撤销动作的那条不会被普通成功提示挤掉。 */}
      <div className="toast-stack">
        {toasts.map((toast, i) => (
          <div
            key={(toast as { id?: number }).id || 'legacy-' + i}
            className={'toast' + (toast.show ? ' show' + (toast.ok ? ' ok' : ' err') : '')}
            role={toast.ok ? 'status' : 'alert'}
            aria-live={toast.ok ? 'polite' : 'assertive'}
            aria-atomic="true"
          >
            {toast.ok ? (
              <svg className="ico toast-ico" aria-hidden="true" focusable="false">
                <use href="#i-check" />
              </svg>
            ) : (
              <svg className="ico toast-ico err" aria-hidden="true" focusable="false">
                <use href="#i-alert" />
              </svg>
            )}
            {toast.msg}
            {toast.action ? (
              <button
                type="button"
                className="toast-act"
                onClick={() => {
                  const id = (toast as { id?: number }).id;
                  if (s.runToastAction) s.runToastAction(id);
                }}
              >
                {toast.actionText || '撤销'}
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {/* 自动刷新发现了新内容、但用户已经滚下去了：点它才套用，避免列表在眼皮底下跳 */}
      <button
        className="new-pill"
        type="button"
        hidden={!pill.show}
        onClick={() => s.applyPendingFresh()}
      >
        <svg className="new-pill-ico" aria-hidden="true" focusable="false">
          <use href="#i-arrow-up" />
        </svg>
        <span>{pill.text}</span>
      </button>

      {/* 图片灯箱：点文章里的图片看大图，自适应屏幕，再点一下 / Esc 关闭 */}
      {box.show && <Lightbox box={box} close={() => s.closeLightbox()} />}

      {/* 统一确认框（替代原生 confirm / prompt） */}
      <ConfirmDialog c={cfm} />
    </>
  );
}
