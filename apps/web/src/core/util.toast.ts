/* 轻提示状态机：toast / 行内撤销动作。从 util.ts 抽出（深度重组），
 * util.ts 通过 export * 保持外部链不变。 */

import type { ToastState } from './types.ts';
import { emitOverlays } from './util.events.ts';

/** 轻提示。v2.1.0 起不再直接改 DOM，改为写状态 + 通知 src/ui/Overlays.tsx 重绘。
 *  第三参可选 `{ action, actionText, ms }`：带一个行内动作按钮（批量已读的「撤销」）。
 *  有动作时默认停留 6 秒，给用户留出反应时间；没有动作仍是最短的 1.9 秒。 */
export let toastTimer: ReturnType<typeof setTimeout> | null = null;
export let toastState: ToastState = {
  msg: '',
  ok: true,
  show: false,
  action: null,
  actionText: '',
};
/* 带「撤销」的提示还在倒计时时，后来的普通提示先排队：
 * 否则一次成功的复制 / 自动刷新一来，撤销按钮就在用户眼皮底下被换掉了。 */
interface PendingToast {
  msg: string;
  ok: boolean;
  ms: number;
}
let pendingToast: PendingToast | null = null;

interface ToastOpts {
  action?: (() => void) | null;
  actionText?: string;
  ms?: number;
}

function showToastNow(
  msg: string,
  ok: boolean,
  action: (() => void) | null,
  actionText: string,
  ms: number,
) {
  toastState = { msg, ok, show: true, action, actionText };
  emitOverlays();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastState = { msg, ok, show: false, action: null, actionText: '' };
    emitOverlays();
    if (pendingToast) {
      const p = pendingToast;
      pendingToast = null;
      showToastNow(p.msg, p.ok, null, '', p.ms);
    }
  }, ms);
}

export function toast(msg: string, ok = true, opts: ToastOpts = {}) {
  const action = opts && typeof opts.action === 'function' ? opts.action : null;
  const actionText = (opts && opts.actionText) || '撤销';
  const ms = (opts && opts.ms) || (action ? 6000 : 1900);
  // 失败提示照旧立刻出现（比撤销更急）；普通成功提示排队，别把撤销按钮挤掉
  if (!action && ok && toastState.show && typeof toastState.action === 'function') {
    pendingToast = { msg, ok, ms }; // 排队，等撤销窗口结束后再露出来
    return;
  }
  pendingToast = null;
  showToastNow(msg, ok, action, actionText, ms);
}

/** 点 toast 里的动作按钮：先收起提示（避免重复点），再执行动作 */
export function runToastAction() {
  const action = toastState.action;
  if (typeof action !== 'function') return;
  if (toastTimer) clearTimeout(toastTimer);
  toastState = {
    msg: toastState.msg,
    ok: toastState.ok,
    show: false,
    action: null,
    actionText: '',
  };
  emitOverlays();
  const queued = pendingToast;
  pendingToast = null;
  action();
  // 动作自己弹了新提示就让新提示留下，排队那条放弃
  if (queued && !toastState.show) showToastNow(queued.msg, queued.ok, null, '', queued.ms);
}
