/* 弹层层栈与浏览器返回键的唯一出口（v2.5.2）。
 *
 * 背景：应用只用 replaceState 维护 hash，弹层从不进历史 —— 系统返回键 / 手势返回
 * 落在页面上，弹层纹丝不动，和「下滑关闭 / ×」各自为政，用户感觉几套交互在打架。
 *
 * 做法：第一个弹层打开时压一条历史哨兵（pushState），返回键先吃掉哨兵；由本模块
 * 决定这一击归谁：
 *  - 期望中的 pop（我们为关闭弹层自己调 history.back() 引起的）→ 吞掉，不交给视图；
 *  - 用户按的返回 → 关掉栈顶（支持 Promise<boolean>，false = 用户选择保留该层），
 *    下面还有层时立刻补一条新哨兵，避免连按两下把页面也退走；
 *  - 关闭动画 / 脏态确认期间再按返回：只补哨兵，不重复 dismiss（processing）。
 *
 * 关闭时如果应用已用 replaceState 改过 hash（卡片详情「在文章页查看」），
 * back() 回到的是更早的快照 —— 在期望 pop 里把地址栏纠正回关闭前那一刻，
 * 视图不会被旧 hash 带跑。
 *
 * 注意：哨兵只加一条（整个栈共用），组件关闭一律走自己的正常路径，卸载时
 * 由 registerLayer 返回的清理函数销账。
 */

const EXPECTED_TIMEOUT_MS = 400; // back() 被浏览器取消 / 被别的 pushState 吞掉时的兜底
const layers: any = [];
let barrier = false; // 历史里有一条属于弹层栈的哨兵
let expected = false; // 下一次 popstate 是栈自己 history.back() 引起的
let savedHash = ''; // 发起关闭那一刻的地址，用于纠正 back() 回到的旧快照
let expectedTimer: any = 0;
let closeTimer: any = 0; // 最后一层关闭时延一拍退哨兵：同一帧内又开一层就复用
let processing = false; // 栈顶 dismiss 还没返回，期间的返回键只补哨兵
let seq = 0;

function pushBarrier() {
  if (typeof history === 'undefined' || typeof history.pushState !== 'function') return;
  try {
    history.pushState({ __feedloreOverlay: true }, '', location.href);
    barrier = true;
  } catch (_) {
    /* 沙箱 / 不允许改历史：退化成没有返回键支持，弹层本身照常工作 */
  }
}

function ensureBarrier() {
  if (layers.length && !barrier && !expected) pushBarrier();
}

function consumeBarrier() {
  if (!barrier || closeTimer) return;
  // 延一拍再退：StrictMode 的开发期重复挂载、以及「关一个立刻开另一个」都会在
  // 同一帧里走 卸载 → 挂载，直接 back() 会白退一趟历史。
  closeTimer = setTimeout(() => {
    closeTimer = 0;
    if (layers.length || !barrier) return;
    barrier = false;
    savedHash = typeof location !== 'undefined' ? location.hash : '';
    expected = true;
    clearTimeout(expectedTimer);
    expectedTimer = setTimeout(() => {
      expected = false;
      savedHash = '';
      ensureBarrier();
    }, EXPECTED_TIMEOUT_MS);
    if (expectedTimer && typeof expectedTimer.unref === 'function') expectedTimer.unref();
    try {
      history.back();
    } catch (_) {
      expected = false;
      savedHash = '';
    }
  }, 0);
  if (closeTimer && typeof closeTimer.unref === 'function') closeTimer.unref();
}

/** 注册一层弹层。dismiss 是这一层的关闭动作（可返回 Promise<boolean>）。
 *  返回清理函数：组件卸载 / 正常关闭时调用，由它负责把哨兵一起销掉。
 *@param {*} [dismiss]
 */

export function registerLayer(dismiss: any) {
  const token = ++seq;
  layers.push({ token, dismiss });
  ensureBarrier();
  return () => {
    const i: any = layers.findIndex(/** @param {*} [l] */ (l: any) => l.token === token);
    if (i < 0) return;
    layers.splice(i, 1);
    // 下面还有层：哨兵继续留着，交给下一击返回键
    if (layers.length) {
      ensureBarrier();
      return;
    }
    // 最后一层关掉了：把哨兵退回去，历史里不留下多余的条目
    consumeBarrier();
  };
}

/** core/ui.ts 的 popstate 第一站。返回 true 表示这一击已被弹层消化，
 *  视图侧（hash 恢复 / 切视图）不要再处理。 */
export function handleOverlayPop() {
  if (expected) {
    expected = false;
    clearTimeout(expectedTimer);
    const want = savedHash;
    savedHash = '';
    if (want && typeof location !== 'undefined' && location.hash !== want) {
      try {
        history.replaceState(history.state, '', want);
      } catch (_) {
        /* 地址栏不允许就放弃纠正 */
      }
    }
    ensureBarrier();
    return true;
  }
  if (!layers.length) return false;

  barrier = false; // 用户这一击已经用掉了哨兵
  if (processing) {
    ensureBarrier();
    return true;
  }
  const top: any = layers[layers.length - 1];
  // 下面还有层时立刻补哨兵：连按返回不能一路退到视图之外
  if (layers.length > 1) pushBarrier();

  processing = true;
  Promise.resolve()
    .then(() => top.dismiss())
    .then(
      /** @param {*} [ok] */ (ok: any) => {
        processing = false;
        // false = 用户选择保留这一层（设置脏态确认 / 详情层退回列表），哨兵必须补回。
        // 真正关掉的层会随即卸载，由 registerLayer 的清理函数销账（关到最后一层时退掉哨兵）；
        // 这里不主动补，否则每次返回键关闭都会多压再退一次，历史里白白走两趟。
        if (ok === false) ensureBarrier();
      },
    )
    .catch(() => {
      processing = false;
      ensureBarrier();
    });
  return true;
}
