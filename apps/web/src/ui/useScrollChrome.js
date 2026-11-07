/* `scrollChrome.js` 的 React 侧包装：卡片详情（`.cd-scroll` / `.dd-sheet-body`）
 * 由组件自己渲染，直接接滚动容器就行，不必再走 document 级捕获监听。
 *
 * 传元素而不是 ref：弹层的滚动容器是按 `mobile` 分支条件渲染的，ref 在首帧可能是
 * 空的；用 callback ref（`ref={setScrollEl}`）把节点提升成 state，effect 自然会
 * 在节点真正挂上后重跑一次，不用「等一帧再试」那种补丁。
 */
import { useEffect, useState } from 'react';
import { createChromeTracker } from './scrollChrome.js';

export function useScrollChrome(el, enabled = true) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!el || !enabled) {
      setHidden(false);
      return undefined;
    }
    const step = createChromeTracker();
    /* 先记一次基准。弹层刚打开时 scrollTop 必为 0，记下它，用户第一次往下滑
       （首个 scroll 事件的 delta 就从 0 算起）就能判出方向；否则第一次滚动会被
       「第一帧只记基准」吃掉，表现成「往上推一大段才生效」。 */
    step(el);
    let raf = 0;
    const onScroll = () => {
      if (raf) return;   // 一帧只判一次：滚动事件比帧密，逐条判会白跑
      raf = requestAnimationFrame(() => {
        raf = 0;
        const next = step(el);
        setHidden((prev) => (prev === next ? prev : next));
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [el, enabled]);

  // 换了滚动容器（桌面↔移动分支）或关掉了，就不该沿用上一次的收起态
  useEffect(() => { setHidden(false); }, [el, enabled]);

  return hidden;
}
