/* 笺川核心逻辑 · 移动端侧滑抽屉手势（文章页 / 卡片页共用）
 *
 * v1.3.10 起从 reader.js 抽出来：卡片页也有了频道抽屉，两页的手势规则一模一样，
 * 没有理由各写一份。差异只在「用哪个抽屉」——由 state.tab 决定：
 *   reader → #readerSide / #readerMask / body.reader-drawer-open
 *   cards  → #cardsSide  / #cardsMask  / body.cards-drawer-open
 * 开合状态仍由各自的模块持有（setReaderDrawer / setCardsDrawer），这里只负责手势本身。
 *
 * 规则（与原文章页手势一致）：
 * 未打开时，手指在屏幕左 2/3 区域内向右横滑即可「拖」出抽屉；
 * 已打开时，向左横滑即可收回；竖滑交给页面自己滚动，互不干扰。识别区比旧版 60px 左边缘宽，
 * 单手更易够到；同时做了一组冲突规避：
 *   - 宽屏并排布局（>720px）/ 其它页面没有抽屉，不拦截（避免误锁页面滚动）；
 *   - 设置 / 命令面板开着时不拦截；
 *   - 触摸点在可横向滚动的容器内（如 <pre> 代码块）时，让容器自己滚，不抢抽屉手势；
 *   - 关闭态下的左滑直接放弃，避免把抽屉反向误拉出。
 * ============================================================ */

import { state } from './state.js';
import { setReaderDrawer } from './reader.js';
import { setCardsDrawer } from './feeds.js';

const THRESH = 48;                                              // 松手判定开 / 关的最小位移（px）
const OPEN_ZONE = () => Math.round(window.innerWidth * 2 / 3);  // 关闭态下可起手的左 2/3 屏幕宽
const drawerMode = () => window.innerWidth <= 720;              // 与 style.css 的 720px 抽屉断点一致

/** 当前页面用哪套抽屉；不是带抽屉的页面则返回 null */
function target() {
  if (state.tab === 'cards') {
    return { sideId: 'cardsSide', maskId: 'cardsMask', cls: 'cards-drawer-open', set: setCardsDrawer };
  }
  if (state.tab === 'reader') {
    return { sideId: 'readerSide', maskId: 'readerMask', cls: 'reader-drawer-open', set: setReaderDrawer };
  }
  return null;
}

const SIDE_W = () => Math.min(272, window.innerWidth * 0.84);
const sideOf = (t) => (t ? document.getElementById(t.sideId) : null);
const maskOf = (t) => (t ? document.getElementById(t.maskId) : null);

let x0 = 0, y0 = 0, dragging = false, decided = false, dir = 0, active = null;

/** px = 抽屉已滑出的像素（0=关，抽屉宽=开）→ 换算成 translateX 百分比 */
function place(px) {
  const w = SIDE_W();
  px = Math.max(0, Math.min(w, px));
  const pct = px / w;
  const side = sideOf(active);
  if (side) side.style.transform = `translateX(${(-104 + pct * 104).toFixed(2)}%)`;
  const mask = maskOf(active);
  if (mask) {
    mask.style.visibility = 'visible';
    mask.style.opacity = String(pct);
  }
}

/** 触摸点是否落在可横向滚动的容器内（如 <pre> 代码块）：是则把横滑让给容器，不抢抽屉手势 */
function inHorizontalScroller(el) {
  let n = el;
  while (n && n.nodeType === 1 && n !== document.body) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'overlay') return true;
    }
    n = n.parentElement;
  }
  return false;
}

document.addEventListener('touchstart', (ev) => {
  const t = ev.touches && ev.touches[0];
  if (!t) return;
  // 宽屏并排布局 / 当前页面没有抽屉，不拦截（避免误锁页面滚动）
  const cur = drawerMode() ? target() : null;
  if (!cur) { dragging = false; active = null; return; }
  if (window.__settingsOpen || window.__cmdkOpen) return;
  const open = document.body.classList.contains(cur.cls);
  // 关闭态：仅在左 2/3 区域内可起手（右滑拉出）；其余区域交给内容本身
  if (!open && t.clientX > OPEN_ZONE()) { dragging = false; return; }
  // 触摸点在可横向滚动容器里时，让容器自己滚，不抢手势
  if (!open && inHorizontalScroller(ev.target)) { dragging = false; return; }
  x0 = t.clientX; y0 = t.clientY; dragging = true; decided = false; dir = 0; active = cur;
}, { passive: true });

document.addEventListener('touchmove', (ev) => {
  if (!dragging || !active) return;
  const t = ev.touches && ev.touches[0];
  if (!t) return;
  const dx = t.clientX - x0, dy = t.clientY - y0;
  if (!decided) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;        // 等方向明确
    if (Math.abs(dy) > Math.abs(dx)) { dragging = false; return; }  // 竖滑 → 不接管
    decided = true; dir = dx >= 0 ? 1 : -1;
    const open = document.body.classList.contains(active.cls);
    // 关闭态只接受「右滑拉出」；左滑直接放弃，避免把抽屉反向误拉出
    if (!open && dir < 0) { dragging = false; return; }
    const side0 = sideOf(active); if (side0) side0.style.transition = 'none';   // 跟手期间关掉过渡
  }
  if (dir > 0) place(Math.max(0, dx));                        // 从 0 滑出
  else place(SIDE_W() + dx);                                  // 已开 → 从满位左收（dx 为负）
  if (ev.cancelable) ev.preventDefault();                     // 拦掉默认横滑 / 回弹
}, { passive: false });

document.addEventListener('touchend', (ev) => {
  if (!dragging || !active) return;
  dragging = false;
  if (!decided) return;                                       // 只是轻点，没拖动
  const t = ev.changedTouches && ev.changedTouches[0];
  if (!t) return;
  const cur = active;
  const dx = t.clientX - x0;
  const open = dir > 0 ? dx >= THRESH                        // 右滑够距 → 开
                       : (dx <= -THRESH ? false : true);     // 左滑够距 → 关，否则维持开
  const sideEl = sideOf(cur);
  if (sideEl) {
    sideEl.style.transition = '';                             // 恢复过渡，交给 CSS 吸附
    sideEl.style.transform = open ? 'translateX(0%)' : 'translateX(-104%)';
  }
  const maskEl = maskOf(cur);
  if (maskEl) maskEl.style.opacity = open ? '1' : '0';
  cur.set(open);                                              // 类切换 + 页面滚动锁
  // 吸附动画结束后把内联样式交还给 CSS，避免后续用按钮开关时内联值压住类样式
  setTimeout(() => {
    const side1 = sideOf(cur); if (side1) side1.style.transform = '';
    const mask1 = maskOf(cur); if (mask1) { mask1.style.opacity = ''; mask1.style.visibility = ''; }
    active = null;
  }, 300);
}, { passive: true });
