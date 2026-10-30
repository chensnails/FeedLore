import { useEffect, useRef, useState } from 'react';

/**
 * 频道栏宽度拖拽手柄（对齐 v1 的 `reader-resize`）。
 *
 * 为什么值得做：桌面宽度从 1280 到 2560 都有，固定 268px 在宽屏上会让长频道名
 * 被截成「少数派报…」，而那几个字恰好是区分频道的唯一信息。
 *
 * 两个实现要点：
 * - **拖拽中只改 CSS 变量，不进 React state**。每帧 setState 会让整个壳（含列表）
 *   重渲染，60fps 下拖起来是滞的。松手才提交一次（写服务端）。
 * - **手柄是 grid 的独立一列**，不是 `.sidebar` 的绝对定位子元素：`.sidebar` 是
 *   `overflow:auto`，贴边定位的手柄会被裁掉一半，拖起来只剩 3px 热区。
 */

const DEFAULT_W = 268;
const MIN_W = 180;
const MAX_W = 400;
const KEY_STEP = 16;

/** 上限同时受「屏幕 40%」约束：宽屏也不该让频道栏吃掉正文。 */
function clamp(w: number): number {
  const cap = Math.min(MAX_W, Math.max(MIN_W, Math.floor(window.innerWidth * 0.4)));
  return Math.max(MIN_W, Math.min(cap, Math.round(w)));
}

export function applySideWidth(w: number): void {
  document.documentElement.style.setProperty('--side-w', `${clamp(w)}px`);
}

export function SideResize({ width, onCommit }: { width: number; onCommit: (w: number) => void }) {
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  /** 拖拽中的实时值。不能只放 state：pointerup 里读到的是闭包旧值，会提交错误宽度。 */
  const liveRef = useRef<number | null>(null);
  const [live, setLive] = useState<number | null>(null);

  // 组件卸载时若还在拖拽（比如窄屏切宽），把全局态清干净，否则页面一直不能选中文字
  useEffect(() => {
    return () => {
      document.body.classList.remove('side-resizing');
    };
  }, []);

  function settle(w: number): void {
    const v = clamp(w);
    applySideWidth(v);
    onCommit(v);
  }

  return (
    <div
      className="side-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整频道栏宽度"
      aria-valuenow={live ?? width}
      aria-valuemin={MIN_W}
      aria-valuemax={MAX_W}
      tabIndex={0}
      title="拖动调整频道栏宽度，双击恢复默认"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startW: width };
        document.body.classList.add('side-resizing');
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const v = clamp(drag.current.startW + (e.clientX - drag.current.startX));
        liveRef.current = v;
        setLive(v);
        applySideWidth(v);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = null;
        document.body.classList.remove('side-resizing');
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        const v = liveRef.current;
        liveRef.current = null;
        setLive(null);
        if (v !== null) onCommit(v);
      }}
      /* 指针被系统抢走（来电、切窗口）时也要收尾，否则 body 上会永久留着
       * `side-resizing`（文字不能选、光标一直是 col-resize）。 */
      onPointerCancel={() => {
        if (!drag.current) return;
        drag.current = null;
        document.body.classList.remove('side-resizing');
        const v = liveRef.current ?? width;
        liveRef.current = null;
        setLive(null);
        applySideWidth(v);
      }}
      onDoubleClick={() => settle(DEFAULT_W)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          settle(width + (e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP));
        } else if (e.key === 'Home') {
          e.preventDefault();
          settle(DEFAULT_W);
        }
      }}
    />
  );
}

export { DEFAULT_W as SIDE_W_DEFAULT };
