/* 移动端底部弹层的手势关闭（v2.3.x 重做，2026-11-07；v2.5.2 收口）。
 *
 * 为什么是一个 hook：卡片详情（CardDetail）、自定义下拉（Dropdown）、设置弹层
 * （SettingsModal）共用同一套「贴底抽屉」语言，手势必须表现一致，不能一个能拖一个不能拖。
 *
 * 旧实现为什么在真机上经常没反应：它把 touchmove 交给 React 的 onTouchMove，而 React
 * 在根节点上把 touchstart/touchmove 注册成 **passive**，里面调 preventDefault 是无效的；
 * Android Chrome 会把「从顶部继续下拉」当成整页下拉刷新，直接派发 touchcancel，手势被吞。
 * 现在改成在面板元素上原生注册 { passive: false }，接管后真正阻止默认行为。
 *
 * 八条口径：
 * 1. 抓手 / 头部起手可直接拖；正文区起手要先让列表滚到顶，之后继续下拉才接管
 *    （可滚动祖先由 getComputedStyle 实测，不写死某个 class）；
 * 2. 跟手位移直接写内联 transform，不经过 state —— 一次拖拽几十帧，每帧 setState
 *    会让整棵弹层树重渲染；遮罩同步渐隐，形成「整张卡片被拉走」的连续反馈；
 * 3. 关闭判据 = 距离 OR 短距离快甩（iOS 的 flick）。纯距离判据会让快甩失效，
 *    纯速度判据又会被手抖误触，两条一起才稳；上滑 / 回弹不关闭；
 * 4. onDismiss 允许返回 Promise<boolean>：设置弹层有「放弃未保存更改」确认，用户点
 *    「继续编辑」时返回 false，面板必须弹回原位而不是停在半空；
 * 5. 拖完吞一次 click：抬手时浏览器还会在落点补发 click，不拦会顺手点开底下的卡片；
 * 6. touchcancel 一律回弹：Android 下拉刷新 / 来电 / 系统手势会派发 touchcancel，
 *    那不是「松手关闭」，当成松手会让弹层凭空消失；
 * 7. 飞出只做位移、不做整屏淡出：整屏面板降到半透明会让背后的页面透出来，看着像闪屏；
 * 8. prefers-reduced-motion 下跳过飞出动画，直接走关闭 / 回弹。
 *
 * 只做竖向：左右边缘横滑交给系统的返回手势，应用不再争抢（v2.5.2 去掉水平关闭）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const SLOP = 6;              // 小于这个位移当作手抖 / 点击
const DISTANCE = 80;         // 下拉超过这么多像素就关闭
const FLICK_DISTANCE = 48;   // 快甩至少要走这么远，避免单击被当成甩
const FLICK_MIN_MS = 60;     // 速度采样至少这么长：0ms 完成的位移多半是合成事件 / 手抖误触
const FLICK_VELOCITY = 0.5;  // px/ms
const FLING_MS = 180;
const SPRING_MS = 200;
const CLICK_GUARD_MS = 300;
const GRIP_SELECTOR = '.dd-sheet-grip, .modal-head, [data-sheet-grip]';
const GRIP_BAND = 72;        // 面板顶部这一条都算抓手（.modal::before 是伪元素，事件落在面板上）

function scrollableAncestor(node, panel) {
  let el = node && node.nodeType === 1 ? node : (node && node.parentElement);
  while (el && el !== panel) {
    const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (st && /(auto|scroll|overlay)/.test(st.overflowY)) {
      if (el.scrollHeight > el.clientHeight + 1) return el;
    }
    el = el.parentElement;
  }
  return null;
}

const emptyDrag = () => ({
  y0: 0, t0: 0, dy: 0,
  on: false, fromGrip: false, block: false, sc: null,
});

export function useSwipeDismiss(onDismiss, options = {}) {
  const { enabled = true } = options;
  const panelRef = useRef(null);
  // 弹层常常是「打开时才挂载」的；effect 早于 ref 赋值执行，普通对象 ref 会让原生
  // 监听绑了个空。用 callback ref + node state，元素一落地就重跑 effect 重新绑定。
  const [node, setNode] = useState(null);
  const setPanelRef = useCallback((el) => {
    panelRef.current = el;
    setNode(el);
  }, []);
  const drag = useRef(emptyDrag());
  const swallowUntil = useRef(0);
  const dismissRef = useRef(onDismiss);
  const enabledRef = useRef(enabled);
  dismissRef.current = onDismiss;
  enabledRef.current = enabled;

  const maskOf = useCallback((el) => {
    const m = el && el.parentElement;
    return m && /(^|\s)(dd-mask|modal-mask|ds-mask)(\s|$)/.test(m.className || '') ? m : null;
  }, []);

  const springBack = useCallback((el) => {
    const mask = maskOf(el);
    el.style.transition = 'transform ' + SPRING_MS + 'ms cubic-bezier(.32,.72,0,1)';
    el.style.transform = '';
    if (mask) {
      mask.style.transition = 'opacity ' + SPRING_MS + 'ms ease';
      mask.style.opacity = '1';
    }
    setTimeout(() => {
      el.style.transition = '';
      el.style.willChange = '';
      if (mask) { mask.style.transition = ''; mask.style.opacity = ''; }
    }, SPRING_MS + 20);
  }, [maskOf]);

  /** 清掉拖拽留下的内联样式；弹层关闭 / 视口形态切换时调用。 */
  const reset = useCallback(() => {
    const el = panelRef.current;
    drag.current = emptyDrag();
    if (!el) return;
    el.style.transition = '';
    el.style.transform = '';
    el.style.willChange = '';
    const mask = maskOf(el);
    if (mask) { mask.style.transition = ''; mask.style.opacity = ''; }
  }, [maskOf]);

  useEffect(() => {
    const el = node;
    if (!el) return undefined;

    const onStart = (ev) => {
      if (!enabledRef.current) return;
      // 详情层 / 下拉层嵌在设置外壳里：手势归最内层，别让外层（同样挂了
      // useSwipeDismiss）跟着拖一份，否则滑一次关两层。
      ev.stopPropagation();
      const t = ev.touches && ev.touches[0];
      if (!t) return;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { top: 0 };
      const target = ev.target;
      const gripHit = !!(target && target.closest && target.closest(GRIP_SELECTOR));
      const nearTop = t.clientY - rect.top < GRIP_BAND;
      // 起手点往上的可滚动祖先优先；找不到时（例如事件直接派发在面板上）退回面板内
      // 既定的滚动容器，检查它是否还没滚到顶 —— 否则正常的列表滚动会被手势抢走。
      const sc = scrollableAncestor(target, el)
        || el.querySelector('.dd-sheet-body, .cd-scroll, .modal-body, .tabs');
      drag.current = {
        ...emptyDrag(),
        y0: t.clientY, t0: Date.now(),
        fromGrip: gripHit || nearTop,
        sc,
        block: !!(sc && sc.scrollTop > 0),
      };
    };

    const onMove = (ev) => {
      const s = drag.current;
      const t = ev.touches && ev.touches[0];
      if (!t || s.block || !enabledRef.current) return;
      ev.stopPropagation();
      const dy = t.clientY - s.y0;
      if (s.on) {
        s.dy = dy;
        // 关键：接管后阻止默认，否则 Android Chrome 的下拉刷新 / overscroll 会抢走手势。
        if (ev.cancelable && ev.preventDefault) ev.preventDefault();
        el.style.transition = 'none';
        el.style.willChange = 'transform';
        el.style.transform = 'translateY(' + dy + 'px)';
        const mask0 = maskOf(el);
        if (mask0) {
          const height0 = el.offsetHeight || 600;
          mask0.style.opacity = String(Math.max(0.25, 1 - Math.abs(dy) / height0 * 0.8));
        }
        return;
      }
      if (dy < SLOP) return;   // 上滑 / 手抖：把位移还给列表滚动
      if (!s.fromGrip && s.sc && s.sc.scrollTop > 0) return;

      s.on = true;
      s.dy = dy;
      if (ev.cancelable && ev.preventDefault) ev.preventDefault();
      el.style.transition = 'none';
      el.style.willChange = 'transform';
      el.style.transform = 'translateY(' + dy + 'px)';
      const mask = maskOf(el);
      if (mask) {
        const height = el.offsetHeight || 600;
        mask.style.opacity = String(Math.max(0.25, 1 - Math.abs(dy) / height * 0.8));
      }
    };

    const onEnd = () => {
      const s = drag.current;
      if (!s.on) { s.on = false; return; }
      s.on = false;
      const shift = s.dy;
      const elapsed = Date.now() - s.t0;
      const velocity = elapsed >= FLICK_MIN_MS ? shift / elapsed : 0;
      const flick = shift > FLICK_DISTANCE && velocity > FLICK_VELOCITY;
      const shouldClose = shift > DISTANCE || flick;
      swallowUntil.current = Date.now() + CLICK_GUARD_MS;
      if (!shouldClose) { springBack(el); return; }

      const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const settle = () => {
        Promise.resolve()
          .then(() => dismissRef.current())
          .then((ok) => {
            // 设置弹层有脏态确认：用户选「继续编辑」时 dismiss 返回 false，弹回原位。
            if (ok === false) springBack(el);
            else reset();
          })
          .catch(() => springBack(el));
      };

      if (reduced) { settle(); return; }
      el.style.transition = 'transform ' + FLING_MS + 'ms cubic-bezier(.32,.72,0,1)';
      el.style.transform = 'translateY(100%)';
      setTimeout(settle, FLING_MS);
    };

    // 系统抢走手势（下拉刷新 / 来电 / 手势导航）不是「松手关闭」：回弹，不 dismiss。
    const onCancel = () => {
      const s = drag.current;
      const wasDragging = s.on;
      s.on = false;
      s.dy = 0;
      if (wasDragging) springBack(el);
    };

    // 原生注册：React 的 onTouchMove 是 passive，拦不住浏览器下拉刷新。
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [node, maskOf, springBack, reset]);

  // 拖拽抬手后浏览器补发的那一次 click 落在面板内，吞掉它（只吞 click，不影响键盘操作）
  const onClickCapture = useCallback((ev) => {
    if (Date.now() < swallowUntil.current) {
      ev.stopPropagation();
      ev.preventDefault();
    }
  }, []);

  return { panelRef, setPanelRef, handlers: { onClickCapture }, reset };
}