/* 滚动方向感知的按钮自动收起（2026-11-07，用户要求「下翻隐藏、上翻显示」）。
 *
 * 对象只有按钮，不是整条吸顶条：
 *  - 文章页：吸顶工具条里的工具按钮（`#readerCollapseAll` 等）+ 展开态标题行右侧的
 *    「收起这篇 / 收藏」（`.art-item.open .art-acts`）；
 *  - 卡片详情：右上角常驻的 ×（`.cd-close`）。
 * 标题文字、频道条、正文一律不动 —— 标题是「我在读哪一篇」的定位信息，收掉会让人
 * 失去方位；按钮是动作，读的时候本来用不上。吸顶条本身也不动，否则 `--reader-head-h`
 * 的实测高度会跟着变，`scroll-margin-top` 与 sticky 顶边全要重算。
 *
 * 三条判据决定它好不好用：
 *  1. **累积位移，不看单次事件**：一次滚轮 tick 就是 40–120px，按单次判定会在手指
 *     轻抖时闪一下。向下攒够 24px 才收，向上攒够 6px 就回来（「想退出」比「想读下去」
 *     意图更明确，所以回来的门槛低得多）。
 *  2. **贴顶 / 到底强制显示**：距顶 32px 内是「刚打开这一篇」，距底 32px 内是「读完了」，
 *     这两个时刻用户最想找出口，不能让他先上翻一下才看见按钮。
 *  3. **内容不足一屏不参与**：`scrollHeight <= clientHeight` 时根本没有「往下翻」这回事，
 *     此时把按钮藏起来就是纯粹的功能丢失。
 *
 * 判定是纯函数（`createChromeTracker`），jsdom 里塞 `scrollHeight` / `scrollTop`
 * 就能测，不必等浏览器；样式侧只认 `.is-chrome-down` / `.is-chrome-hidden` 两个类。
 */

/** 向下累计多少像素才收起。太小学生手指一点就闪，太大又像没反应。 */
export const HIDE_AFTER = 24;
/** 向上累计多少像素就回来。必须远小于 HIDE_AFTER：想退出的人不应该先滑一大段。 */
export const SHOW_AFTER = 6;
/** 距顶 / 距底多少像素内强制显示。 */
export const EDGE = 32;

/**
 * 造一个方向判定器。每次滚动把容器传进来，返回「现在该不该收起」。
 * 同一个容器要用同一个实例（内部记着上次的 scrollTop 与累计位移）。
 */
export function createChromeTracker() {
  /* 基准从 0 起算：容器刚出现（弹层打开 / 列表首屏）时位置必在顶端，
     这样**第一次**滚动就能判出方向。曾经写成 -1（第一帧只记基准），
     结果用户第一次往下滑被吃掉，表现成「要滑两次才收」。 */
  let lastTop = 0;
  let down = 0;
  let up = 0;
  let hidden = false;

  const reset = () => {
    lastTop = 0;
    down = 0;
    up = 0;
    hidden = false;
  };

  const step = (el) => {
    if (!el) return false;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) {
      // 内容撑不满：没有「往下翻」，按钮永远显示
      down = 0;
      up = 0;
      hidden = false;
      return false;
    }
    // 越界钳一下：SSR / 惰性布局的瞬间 scrollTop 可能比 max 还大
    const top = Math.max(0, Math.min(el.scrollTop, max));
    const delta = top - lastTop;
    lastTop = top;

    // 贴顶（刚打开）与到底（读完了）：出口必须立刻可见
    if (top <= EDGE || top >= max - EDGE) {
      down = 0;
      up = 0;
      hidden = false;
      return false;
    }

    /* 一帧跨过整屏，不是人在滚：拖滚动条、深链定位、内容变短都会这样。
       这时方向无从谈起（也可能是布局自己挪的），只跟基准，别凭空收按钮。 */
    if (Math.abs(delta) > el.clientHeight) {
      down = 0;
      up = 0;
      return hidden;
    }

    if (delta > 0) {
      down += delta;
      up = 0;
    } else if (delta < 0) {
      up -= delta;
      down = 0;
    }

    if (down >= HIDE_AFTER) {
      hidden = true;
      down = 0;
    } else if (up >= SHOW_AFTER) {
      hidden = false;
      up = 0;
    }
    return hidden;
  };

  step.reset = reset;
  /** 只读当前状态，不推进判定（给需要同步读一次的场景用）。 */
  step.isHidden = () => hidden;
  return step;
}

/** 文章页用：`.reader-main` 是 index.html 里的宿主 DOM，不在 React 树里，
 *  所以走一个 document 级捕获监听（scroll 不冒泡但能被捕获，与 reader.js 里
 *  自动翻页的监听同一手法），命中的容器上打 `.is-chrome-down`。
 *  返回卸载函数，测试与热重载可以收干净。 */
export function mountScrollChrome() {
  if (typeof document === 'undefined') return () => {};
  const step = createChromeTracker();
  let raf = 0;
  let pending = null;

  const apply = () => {
    raf = 0;
    const el = pending;
    pending = null;
    if (!el || !el.isConnected) return;
    const next = step(el);
    // 类名没变就别碰 DOM：滚动里每帧写 className 会打断合成层的稳定性
    if (el.classList.contains('is-chrome-down') !== next) {
      el.classList.toggle('is-chrome-down', next);
    }
  };

  const onScroll = (ev) => {
    const el = ev.target;
    // 只认文章页的滚动容器：频道栏、弹窗、文档级的滚动不参与
    if (!el || el.nodeType !== 1 || !el.classList || !el.classList.contains('reader-main')) return;
    pending = el;
    if (!raf) raf = requestAnimationFrame(apply);
  };

  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => {
    document.removeEventListener('scroll', onScroll, { capture: true });
    if (raf) cancelAnimationFrame(raf);
  };
}
