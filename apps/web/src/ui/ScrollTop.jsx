/* 回到顶部（v2.5.0）
 * ------------------------------------------------------------
 * 列表一屏只放得下 3–4 条，翻到几十条之后回顶要么一路滑、要么切一次视图。
 * 这里给一个右下角的圆形浮钮，滚过一屏（600px）才出现 —— 顶部不占任何常驻空间。
 *
 * 三个视图各自有滚动容器（见 core/state.js#activeScrollEl），滚动事件不冒泡，
 * 统一在 document 上捕获监听；按帧节流，一次滚动只读一次 scrollTop。
 * 位置在「N 条新内容」浮标（底部居中）与悬浮标签栏之间，互不遮挡。
 */
import React, { useEffect, useRef, useState } from 'react';
import { core } from '@core';
import { on, EVENT } from '../kernel/events.js';

const SHOW_AFTER = 600;

export function ScrollTop() {
  const [show, setShow] = useState(false);
  const rafRef = useRef(0);

  useEffect(() => {
    const read = () => {
      rafRef.current = 0;
      const top = core.activeScrollTop ? core.activeScrollTop() : 0;
      setShow(Number(top) > SHOW_AFTER);
    };
    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(read);
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    // 切视图后容器换了：重新判一次，别把上一页的滚动位置带过来
    const stopViewEvents = on(EVENT.VIEW, read);
    read();
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      stopViewEvents();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  if (!show) return null;
  return (
    <button type="button" className="scroll-top" aria-label="回到顶部" title="回到顶部"
      onClick={() => { if (core.scrollTop) core.scrollTop(); }}>
      <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-chevrons-up" /></svg>
    </button>
  );
}
