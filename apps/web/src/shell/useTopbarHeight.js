/* 把「合并后头部」的高度写进 --topbar-h。
 * 各视图的 Row1 头部（.cards-sticky / .reader-head / .ai-head）调用本钩子，
 * 内容吸顶锚点（抽屉、频道列表、浮层、两页头部）统一消费这个变量。
 * 三个视图常驻挂载、靠显隐切换；用 getClientRects 守卫：display:none 的视图测得 0 高时不写，
 * 避免把 --topbar-h 误写成 0 拖累其它可见视图。 */
import { useEffect } from 'react';

export function useTopbarHeight(ref) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = () => {
      if (el.getClientRects().length === 0) return; // 当前视图未显示（display:none）
      document.documentElement.style.setProperty(
        '--topbar-h',
        Math.ceil(el.getBoundingClientRect().height) + 'px'
      );
    };
    apply();
    const raf = requestAnimationFrame(apply);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply).catch(() => {});
    const onResize = () => apply();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(apply); ro.observe(el); }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      if (ro) ro.disconnect();
    };
  }, [ref]);
}
