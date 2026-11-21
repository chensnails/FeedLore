/* 轻提示状态机：toast / 行内撤销动作。从 util.ts 抽出（深度重组），
 * util.ts 通过 export * 保持外部链不变。
 *
 * v3.0.0 起改为有界队列（最多 3 条叠放）：并发操作不该互相覆盖。
 * 兼容约束：toastState 仍是「当前最该看到的一条」，getToastState() 的调用方
 * 与旧守卫零改动；新渲染走 getToastQueue()。 */
import type { ToastState } from './types.ts';
import { emitOverlays } from './util.events.ts';

/** 中文文案 + 稳定 id + 独立计时的一条提示。 */
export interface ToastItem extends ToastState {
  id: number;
  ms: number;
}

/** 队列上限：叠放三条，再多就不是「轻」提示而是遮罩了。 */
export const TOAST_QUEUE_MAX = 3;
/** 带动作的提示默认停留 6 秒，给用户留出反应时间；没有动作仍是最短的 1.9 秒。 */
export const TOAST_ACTION_MS = 6000;
export const TOAST_PLAIN_MS = 1900;

/* 保留旧的导出名：诊断脚本与既有断言用 toastTimer / toastState 观察主提示。 */
export let toastTimer: ReturnType<typeof setTimeout> | null = null;
export let toastState: ToastState = {
  msg: '',
  ok: true,
  show: false,
  action: null,
  actionText: '',
};

let nextToastId = 0;
let queue: ToastItem[] = [];
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** 当前队列快照（只读约定：不要改数组，改状态一律走 toast/runToastAction）。 */
export function getToastQueue(): readonly ToastItem[] {
  return queue;
}

/** 把主提示同步为队首：未过期的第一条。空队列时收起。 */
function syncState() {
  const head = queue[0];
  toastState = head
    ? { msg: head.msg, ok: head.ok, show: true, action: head.action, actionText: head.actionText }
    : { msg: '', ok: true, show: false, action: null, actionText: '' };
  emitOverlays();
}

function clearTimer(item: ToastItem) {
  const t = timers.get(item.id);
  if (t) clearTimeout(t);
  timers.delete(item.id);
  if (toastTimer === t) toastTimer = null;
}

function removeItem(id: number) {
  const item = queue.find((x) => x.id === id);
  if (!item) return;
  clearTimer(item);
  queue = queue.filter((x) => x.id !== id);
  syncState();
}

function armTimer(item: ToastItem) {
  const t = setTimeout(() => removeItem(item.id), item.ms);
  timers.set(item.id, t);
  toastTimer = t;
}

function enqueue(
  msg: string,
  ok: boolean,
  action: (() => void) | null,
  actionText: string,
  ms: number,
) {
  const item: ToastItem = { id: ++nextToastId, msg, ok, show: true, action, actionText, ms };
  queue = [...queue, item];
  armTimer(item);
  // 超限时先淘汰最早的一条（有撤销动作的优先保留，见 toast() 的插队规则）。
  while (queue.length > TOAST_QUEUE_MAX) {
    const item = queue.find((x) => typeof x.action !== 'function') || queue[0];
    if (!item) break;
    clearTimer(item);
    queue = queue.filter((x) => x.id !== item.id);
  }
  syncState();
}

interface ToastOpts {
  action?: (() => void) | null;
  actionText?: string;
  ms?: number;
}

export function toast(msg: string, ok = true, opts: ToastOpts = {}) {
  const action = opts && typeof opts.action === 'function' ? opts.action : null;
  const actionText = (opts && opts.actionText) || '撤销';
  const ms = (opts && opts.ms) || (action ? TOAST_ACTION_MS : TOAST_PLAIN_MS);
  /* 插队规则（与旧单槽语义一致）：
   * - 失败提示最急，直接进队首，读屏 assertive 优先播报；
   * - 带动作（撤销）的提示也是首位语义 —— 新来的普通成功不能把它从「主提示」上挤掉；
   * - 普通成功按到达顺序叠放，旧的先过期，撤销按钮始终可见可点。 */
  if (!ok || action) {
    for (const item of queue) clearTimer(item);
    queue = [];
  }
  enqueue(msg, ok, action, actionText, ms);
}

/** 点 toast 里的动作按钮：先收起这一条（避免重复点），再执行动作。
 *  传入 id 时只结算那一条；不传则结算队首带动作的提示（兼容旧调用点）。 */
export function runToastAction(id?: number) {
  let item: ToastItem | undefined;
  if (typeof id === 'number') item = queue.find((x) => x.id === id);
  else item = queue.find((x) => typeof x.action === 'function') || queue[0];
  if (!item || typeof item.action !== 'function') return;
  const before = queue.map((x) => x.id);
  const action = item.action;
  removeItem(item.id);
  action();
  /* 动作自己弹了新提示（如「已恢复订阅」）就让新提示留下：
   * 只放弃此前排队的项，避免旧提示在新提示之上闪一下。 */
  if (queue.some((x) => !before.includes(x.id))) {
    for (const item of queue) if (before.includes(item.id)) clearTimer(item);
    queue = queue.filter((x) => !before.includes(x.id));
  }
  syncState();
}
