/* 滚动进行时给 body 挂一个状态类（`is-scrolling`），滚动停下 160ms 后摘掉。
 *
 * 为什么需要它：鼠标滚轮滚动时指针**一直停在列表上**，内容从指针下方穿过，
 * :hover 就在行与行 / 卡片与卡片之间高频切换。每条悬停过渡都要逐帧重绘
 * box-shadow（带模糊半径，重绘里最贵的一项）和图片缩放，于是看起来就是
 * 「滚起来发涩」。键盘和触屏没有这个问题 —— 所以它是纯指针场景的补偿。
 *
 * 类名只在滚动起止各切一次，不参与 React 渲染，也不改任何几何：
 * 样式规则里只把 `transition` 关掉，属性的终值不变 —— 滚完松手再移鼠标，
 * 过渡照旧，视觉与设计稿完全一致。
 *
 * 只认真正在滚的容器：内容区（.reader-main / 卡片 main / 日报）与窗口本身。
 * 弹层 / 抽屉 / 卡片详情里的滚动不挂这个类 —— 那里没有长列表要滚。
 *
 * 实测（.workbuddy/ui-lab/perf.mjs，真滚轮事件、指针停在列表中段）：
 *   卡片页 80 项：掉帧 12.6% → 0.8%，p95 48.6ms → 13.8ms。
 */

const CLASS = 'is-scrolling';
const IDLE = 160; // 最后一次滚动后多久算「停下」
const SCROLLERS = '.reader-main, #cardsRoot > main.wrap, #aiView, .pane-scroll, .feed-list';

export interface ScrollBusyOptions {
  idle?: number;
}

export function installScrollBusy(doc: Document = document, options: ScrollBusyOptions = {}) {
  const idle = typeof options.idle === 'number' ? options.idle : IDLE;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let on = false;

  function set(next: boolean) {
    if (next === on) return;
    on = next;
    if (doc.body) doc.body.classList.toggle(CLASS, next);
  }

  function onScroll(ev: Event) {
    const t = ev.target as
      | (EventTarget & { nodeType?: number; matches?: (s: string) => boolean })
      | null;
    // 鸭子类型判断：测试桩用普通对象伪造 DOM，不能用 instanceof Node/HTMLElement
    const el = t && t.nodeType === 9 ? (doc.scrollingElement as typeof t) : t;
    if (!el || el.nodeType !== 1) return;
    if (el !== doc.scrollingElement && typeof el.matches === 'function' && !el.matches(SCROLLERS))
      return;
    set(true);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      set(false);
    }, idle);
  }

  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });

  return function dispose() {
    doc.removeEventListener('scroll', onScroll, { capture: true });
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    set(false);
  };
}
