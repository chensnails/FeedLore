/* 统一确认框状态机（替代原生 confirm / prompt）。从 util.ts 抽出（深度重组），
 * util.ts 通过 export * 保持外部链不变。 */

import type { ConfirmOptions, ConfirmState } from './types.ts';
import { emitOverlays } from './util.events.ts';

/* ---------------- 统一确认框（替代原生 confirm / prompt） ----------------
 * 全站弹层都是自绘玻璃语言，唯独破坏性操作交给浏览器原生框会割裂（移动端还显示
 * 「localhost 显示…」）。这里只维护状态，视图由 src/ui/Overlays.tsx 渲染；
 * 调用方 `await confirm(...)` 即可，确认返回 true / 输入值，取消返回 false / null。
 *
 * 用法：
 *   if (!(await confirm({ title: '删除订阅', desc: '…', danger: true, confirmText: '删除' }))) return;
 *   const pwd = await confirm({ title: '设置新密码', input: { placeholder: '至少 4 位', type: 'password' } });
 */
export let confirmState: ConfirmState = {
  open: false,
  title: '',
  desc: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
  input: null,
};

/** confirm 结算回调：取消回 false/null，确认回 true 或输入框的值。 */
type ConfirmResolver = (value: boolean | string | null) => void;
let confirmResolve: ConfirmResolver | null = null;

/** 打开确认框；返回 Promise<boolean|string|null> */
export function confirm(opts: ConfirmOptions | string = {}): Promise<boolean | string | null> {
  // 上一个还没结束就先按「取消」结算，避免 Promise 永久挂起
  if (confirmResolve) {
    const prev = confirmResolve;
    confirmResolve = null;
    prev(confirmState.input ? null : false);
  }
  const o: ConfirmOptions = typeof opts === 'string' ? { title: opts } : opts || {};
  confirmState = {
    open: true,
    title: o.title || '确认操作',
    desc: o.desc || '',
    confirmText: o.confirmText || '确定',
    cancelText: o.cancelText || '取消',
    danger: !!o.danger,
    input: o.input || null,
  };
  emitOverlays();
  return new Promise<boolean | string | null>((resolve) => {
    confirmResolve = resolve;
  });
}

/** 结算确认框：ok=true 时返回 true（或有输入框时返回输入值） */
export function settleConfirm(ok?: boolean, value?: unknown) {
  const r = confirmResolve;
  confirmResolve = null;
  const withInput = !!confirmState.input;
  confirmState = { ...confirmState, open: false };
  emitOverlays();
  if (!r) return;
  if (!ok) {
    r(withInput ? null : false);
    return;
  }
  r(withInput ? String(value == null ? '' : value) : true);
}

/** 点遮罩 / 右键 / Esc 都走「取消」 */
export function cancelConfirm() {
  settleConfirm(false);
}
