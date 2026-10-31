import { useEffect } from 'react';
import { useUi } from '../store/ui';

/**
 * 移动端频道抽屉的边缘手势：
 * - 抽屉关着：从屏幕**左缘**起手向右滑（起手点 ≤ 28px），横移超过 56px 打开；
 * - 抽屉开着：任意位置向左滑同距离关闭（此时遮罩盖住全屏，触摸只会落在遮罩/抽屉上）。
 *
 * 为什么挂在 window 上而不是抽屉组件：打开手势的起手点在**列表区**（左缘），
 * 抽屉还没渲染出来，手势必须先于它存在。全程 passive、不 preventDefault ——
 * 不命中手势的触摸（纵向滚动为主）完全不受影响，也不需要浏览器让出默认行为。
 *
 * 判据只看位移、不看速度，且要求横向位移占优（|dx| > |dy|）：
 * 竖向滚动占优时立即放弃跟踪，把手势还给列表滚动。
 *
 * 三条让路（touchstart 时判定）：
 * 1. 阅读层 / 设置 / 日报面板 / 确认框任一开着 —— 覆盖层在手势之上，滑动归它们；
 * 2. 多指（捏合缩放）直接放弃；
 * 3. 抽屉模式只在 ≤820px 生效 —— 这个数字与 style.css 的窄屏媒体查询**必须是同一个**，
 *    legacy 踩过「CSS 认 820、JS 认 1080 → 抽屉关不掉」的坑，改断点两处同步。
 */

const EDGE = 28; // 起手判定区：距屏幕左缘多少像素内算「从边缘滑入」
const DISTANCE = 56; // 触发开/关的最小横向位移
const SLOP = 12; // 小于这个位移当作手抖，不判定方向
const MQ = '(max-width: 820px)';

export function useEdgeSwipeNav(navOpen: boolean, open: () => void, close: () => void): void {
  useEffect(() => {
    const mq = window.matchMedia(MQ);
    let x0 = 0;
    let y0 = 0;
    let fromEdge = false; // 抽屉关着、从左缘起手 → 可能是「打开」
    let closing = false; // 抽屉开着 → 可能是「关闭」

    const onStart = (e: TouchEvent): void => {
      const t = e.touches[0];
      if (!t || e.touches.length > 1) return;
      x0 = t.clientX;
      y0 = t.clientY;
      fromEdge = false;
      closing = false;
      const st = useUi.getState();
      if (st.readingId !== null || st.panel !== null || st.confirmState) return;
      if (!mq.matches) return;
      if (navOpen) closing = true;
      else if (x0 <= EDGE) fromEdge = true;
    };

    const onMove = (e: TouchEvent): void => {
      if (!fromEdge && !closing) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      if (Math.abs(dy) >= Math.abs(dx)) {
        fromEdge = false;
        closing = false;
        return;
      }
      if (fromEdge && dx > DISTANCE) {
        fromEdge = false;
        open();
      } else if (closing && dx < -DISTANCE) {
        closing = false;
        close();
      }
    };

    const onEnd = (): void => {
      fromEdge = false;
      closing = false;
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [navOpen, open, close]);
}
