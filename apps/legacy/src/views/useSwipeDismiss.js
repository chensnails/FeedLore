/* 移动端弹层（.dd-sheet）的下拉关闭手势（v1.3.5）。
 *
 * 为什么是一个 hook 而不是两套实现：卡片详情（CardDetail）与自定义下拉（Dropdown）
 * 共用 .dd-mask / .dd-sheet 这一族弹层，手势必须表现一致，否则同一个抽屉在两个地方
 * 一个能拖一个不能拖。
 *
 * 四条口径：
 * 1. 只在「列表已经滚到顶」之后继续往下拖才接管 —— 否则会把正常的滚动抢走；
 * 2. 位移跟手用内联 transform 直接写 DOM，不经过 state（一次拖拽几十帧，
 *    每帧 setState 会让整棵弹层树重渲染）；
 * 3. 判据只看距离，不看速度：位移本来就跟手，能拖出来的快慢已经反映在距离里，
 *    多一条速度判据只会让「短促上滑 vs 短促下滑」这种手抖误触也能关掉弹窗。
 * 4. 拖完补一次点击吞掉：手指抬起时浏览器还会在落点元素上派发一次 click，
 *    不拦的话「下拉关闭」会顺手点开底下那张卡片 / 那个选项。
 */

import { useCallback, useRef } from 'react';

const SLOP = 6;        // 小于这个位移当作手抖 / 点击，不进入拖拽
const DISTANCE = 80;   // 下拉超过这么多像素就关闭
const FLING_MS = 180;  // 飞出动画时长，跑完再真正卸载

export function useSwipeDismiss(onDismiss) {
  const panelRef = useRef(null);
  const drag = useRef({ y0: 0, dy: 0, on: false });
  const swallowUntil = useRef(0);

  const scroller = () => {
    const el = panelRef.current;
    return el ? el.querySelector('.dd-sheet-body') : null;
  };

  const onStart = useCallback((ev) => {
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    drag.current = { y0: t.clientY, dy: 0, on: false };
  }, []);

  const onMove = useCallback((ev) => {
    const el = panelRef.current;
    const t = ev.touches && ev.touches[0];
    if (!el || !t) return;
    const s = drag.current;
    const dy = t.clientY - s.y0;
    if (dy < SLOP) return;
    const sc = scroller();
    if (!s.on && sc && sc.scrollTop > 0) return;   // 列表还没滚到顶，位移归它
    s.on = true;
    s.dy = dy;
    el.style.transition = 'none';
    el.style.willChange = 'transform';
    el.style.transform = 'translateY(' + dy + 'px)';
  }, []);

  const onEnd = useCallback(() => {
    const el = panelRef.current;
    const s = drag.current;
    if (!el || !s.on) { s.on = false; s.dy = 0; return; }
    s.on = false;
    const dy = s.dy;
    s.dy = 0;
    swallowUntil.current = Date.now() + 300;
    if (dy > DISTANCE) {
      el.style.transition = 'transform ' + FLING_MS + 'ms ease';
      el.style.transform = 'translateY(100%)';
      setTimeout(onDismiss, FLING_MS);
    } else {
      el.style.transition = 'transform 160ms ease';
      el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; el.style.willChange = ''; }, 170);
    }
  }, [onDismiss]);

  // 拖拽抬手后浏览器补发的那一次 click 落在面板内，吞掉它（只吞 click，不影响键盘操作）
  const onClickCapture = useCallback((ev) => {
    if (Date.now() < swallowUntil.current) {
      ev.stopPropagation();
      ev.preventDefault();
    }
  }, []);

  const handlers = {
    onTouchStart: onStart,
    onTouchMove: onMove,
    onTouchEnd: onEnd,
    onTouchCancel: onEnd,
    onClickCapture: onClickCapture,
  };

  return { panelRef, handlers };
}
