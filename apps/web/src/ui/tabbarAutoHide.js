/* 底部「文章 / 卡片」导航栏随滚动方向收展（方案 A：滚动方向驱动）。
 *
 * 为什么是它、而不是「按住栏拖」：这条栏是悬浮胶囊，`position: fixed` 挂在
 * `#mobileTabbarRoot`（三个视图之外），收展只动 transform / opacity，不碰任何
 * 内容容器的高度 —— 所以滚动中不会触发重排。手势就是「翻页」本身，用户不需要
 * 学一个新动作；这和系统地址栏 / 浏览器工具栏的心智模型完全一致。
 *
 * 判据（四条，缺一条都会变成「导航找不回来」）：
 *  1. 向下累计 24px 才收 —— 一有滚动就收会让列表抖起来；
 *  2. 向上只要 6px 就展开 —— 「往回看一眼」时导航必须立刻在手边；
 *  3. 贴顶 32px / 贴底 32px 强制展开 —— 列表末尾想切视图时必须看得见；
 *  4. 一帧位移超过一屏（拖滚动条、深链跳转）只更新基准，不判方向。
 *
 * 展开永远立即执行，冷却 120ms 只压收起 —— 安全网不能被阻尼拖住，
 * 需要阻尼的是「来回小幅抖动」那一侧。
 *
 * 断点不在这里判断：`body.tabbar-tucked` 的视觉规则只写在 style.css 的
 * 移动主断点里，桌面宽度下这个类存在也改变不了任何像素。多一处 JS 断点
 * 就是多一处会跟 CSS 走散的真源 —— 这个项目以前吃过亏（断点合并 / 令牌失配）。
 */

import { on, EVENT } from '../kernel/events.js';

const HIDE_AFTER = 24;   // 向下累计到这个位移才收起
const SHOW_AFTER = 6;    // 向上只要这么多就回来
const EDGE = 32;         // 贴顶 / 贴底这么大范围内强制展开
const COOLDOWN = 120;    // 两次收起之间的最小间隔
const CLASS = 'tabbar-tucked';
// 只认这三个滚动容器：抽屉 / 弹层 / 卡片详情里的滚动不该让底栏"消失"
const SCROLLERS = '.reader-main, #cardsRoot > main.wrap, #aiView';

export function installTabbarAutoHide(doc = document, options = {}) {
  const win = doc.defaultView || window;
  const cooldown = typeof options.cooldown === 'number' ? options.cooldown : COOLDOWN;

  let nav = null;        // 当前跟踪的滚动容器
  let lastTop = 0;
  let acc = 0;           // 带符号累计位移：正 = 向下，负 = 向上
  let tucked = false;
  let lastFlip = 0;

  function apply(next) {
    if (next === tucked) return;
    tucked = next;
    // 冷却只由「收起」计时：展开是安全网，不该推迟下一次收起，
    // 也不该在展开后把收起再压 120ms（那样快速回翻会像失灵）。
    if (next) lastFlip = Date.now();
    if (doc.body) doc.body.classList.toggle(CLASS, next);
  }

  function reveal() {
    nav = null;
    lastTop = 0;
    acc = 0;
    apply(false);
  }

  function onScroll(ev) {
    const target = ev.target;
    const el = target && target.nodeType === 9 ? doc.scrollingElement : target;
    if (!el || el.nodeType !== 1 || typeof el.matches !== 'function') return;
    if (!el.matches(SCROLLERS)) return;
    if (el.scrollHeight <= el.clientHeight) return;   // 不可滚动的容器不管

    const top = el.scrollTop;
    const max = el.scrollHeight - el.clientHeight;

    // 换容器（切视图）：基准归零，并保证导航是展开的
    if (el !== nav) { nav = el; lastTop = top; acc = 0; apply(false); return; }

    const dy = top - lastTop;
    lastTop = top;

    // 贴顶 / 贴底：无视方向，强制展开（滚到底想切视图时这一步是刚需）
    if (top <= EDGE || top >= max - EDGE) { acc = 0; apply(false); return; }

    // 拖滚动条 / 深链跳转：一帧跨过整屏，方向不可信，只更新基准
    if (Math.abs(dy) > el.clientHeight) { acc = 0; return; }

    // 只累计「有意义」的那一侧：收起后只认上翻，展开后只认下翻。
    // 反方向的位移直接把累积清零 —— 否则收起后继续下滚会把 acc 顶在正数，
    // 随后 20px 的上翻会被吞掉，用户会遇到「往上翻没反应」。
    if (tucked) {
      acc = dy < 0 ? acc + dy : 0;
      if (-acc >= SHOW_AFTER) { acc = 0; apply(false); }
    } else {
      acc = dy > 0 ? acc + dy : 0;
      if (acc >= HIDE_AFTER && Date.now() - lastFlip >= cooldown) { acc = 0; apply(true); }
    }
  }

  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  // 切视图 / 改尺寸：直接展开，别让用户在一个收起状态下找入口
  const offView = on(EVENT.VIEW, reveal);
  win.addEventListener('resize', reveal, { passive: true });

  return function dispose() {
    doc.removeEventListener('scroll', onScroll, { capture: true });
    offView();
    win.removeEventListener('resize', reveal);
    apply(false);
  };
}
