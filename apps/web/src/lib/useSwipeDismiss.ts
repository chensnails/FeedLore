import { useCallback, useRef } from 'react';

/**
 * 移动端弹层（.reader-sheet）的下拉关闭手势 —— 从 v1 的 useSwipeDismiss 原样迁移。
 *
 * 为什么是一个 hook 而不是两套实现：阅读层现在就是 v2 唯一的「弹层」，
 * 以后若有第二处（详情、抽屉），手势必须表现一致，否则同一个界面在两个地方
 * 一个能拖一个不能拖。
 *
 * 四条口径（v1 定下来的，都是踩过的坑）：
 * 1. 只在「内容已经滚到顶」之后继续往下拖才接管 —— 否则会把正常的滚动抢走；
 * 2. 位移跟手用内联 transform 直接写 DOM，不经过 state（一次拖拽几十帧，
 *    每帧 setState 会让整棵弹层树重渲染）；
 * 3. 判据只看距离，不看速度：位移本来就跟手，能拖出来的快慢已经反映在距离里，
 *    多一条速度判据只会让手抖误触也能关掉弹窗；
 * 4. 拖完补一次点击吞掉：手指抬起时浏览器还会在落点派发一次 click，
 *    不拦的话「下拉关闭」会顺手点开底下那张卡片。
 */

const SLOP = 6; // 小于这个位移当作手抖 / 点击，不进入拖拽
const DISTANCE = 80; // 下拉超过这么多像素就关闭
const FLING_MS = 180; // 飞出动画时长，跑完再真正卸载

export interface SwipeDismiss {
  panelRef: React.RefObject<HTMLElement | null>;
  handlers: {
    onTouchStart: (ev: React.TouchEvent) => void;
    onTouchMove: (ev: React.TouchEvent) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
    onClickCapture: (ev: React.MouseEvent) => void;
  };
}

export function useSwipeDismiss(onDismiss: () => void): SwipeDismiss {
  const panelRef = useRef<HTMLElement | null>(null);
  const drag = useRef({ y0: 0, dy: 0, on: false });
  const swallowUntil = useRef(0);

  const onStart = useCallback((ev: React.TouchEvent) => {
    const t = ev.touches[0];
    if (!t) return;
    drag.current = { y0: t.clientY, dy: 0, on: false };
  }, []);

  const onMove = useCallback((ev: React.TouchEvent) => {
    const el = panelRef.current;
    const t = ev.touches[0];
    if (!el || !t) return;
    const s = drag.current;
    const dy = t.clientY - s.y0;
    if (dy < SLOP) return;
    /* 真正的滚动容器可能是面板自己（.dd-sheet-body 那种），也可能是它的父级
     * （v2 的 .reader-backdrop 承担滚动，面板只是被撑满高度）。
     * 两处都看：只要还有可滚的余量，位移就归滚动，不抢手势。 */
    const scroller = el.scrollTop > 0 ? el : el.parentElement;
    if (!s.on && scroller && scroller.scrollTop > 0) return;
    s.on = true;
    s.dy = dy;
    el.style.transition = 'none';
    el.style.willChange = 'transform';
    el.style.transform = `translateY(${dy}px)`;
  }, []);

  const onEnd = useCallback(() => {
    const el = panelRef.current;
    const s = drag.current;
    if (!el || !s.on) {
      s.on = false;
      s.dy = 0;
      return;
    }
    s.on = false;
    const dy = s.dy;
    s.dy = 0;
    swallowUntil.current = Date.now() + 300;
    if (dy > DISTANCE) {
      el.style.transition = `transform ${FLING_MS}ms ease`;
      el.style.transform = 'translateY(100%)';
      setTimeout(onDismiss, FLING_MS);
    } else {
      el.style.transition = 'transform 160ms ease';
      el.style.transform = '';
      setTimeout(() => {
        el.style.transition = '';
        el.style.willChange = '';
      }, 170);
    }
  }, [onDismiss]);

  // 拖拽抬手后浏览器补发的那一次 click 落在面板内，吞掉它（只吞 click，不影响键盘操作）
  const onClickCapture = useCallback((ev: React.MouseEvent) => {
    if (Date.now() < swallowUntil.current) {
      ev.stopPropagation();
      ev.preventDefault();
    }
  }, []);

  return {
    panelRef,
    handlers: {
      onTouchStart: onStart,
      onTouchMove: onMove,
      onTouchEnd: onEnd,
      onTouchCancel: onEnd,
      onClickCapture,
    },
  };
}
