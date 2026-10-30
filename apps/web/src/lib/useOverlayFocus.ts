import { useEffect, type RefObject } from 'react';

/**
 * 覆盖层打开时把焦点移进层内、关闭时还给触发元素 —— 键盘用户不该在弹层打开后
 * 焦点还留在背后的列表/卡片上（Tab 会钻到看不见的底层去）。
 *
 * 只聚焦「关闭」按钮：对阅读层/设置/管理这类「看一眼就关」的层，关闭是最高频动作。
 * 还原时只聚焦 still-connected 的元素：阅读层内「上一篇→下一篇」会重挂载，
 * 旧的关闭按钮已脱离文档，强行 .focus() 反而把焦点弄丢。
 */
export function useOverlayFocus(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  closeSelector = '.reader-close',
): void {
  useEffect(() => {
    if (!active) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      const el = containerRef.current?.querySelector<HTMLElement>(closeSelector);
      (el ?? containerRef.current)?.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      if (prev && prev.isConnected) prev.focus();
    };
  }, [active, containerRef, closeSelector]);
}
