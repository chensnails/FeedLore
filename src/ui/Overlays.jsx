/* 覆盖层：轻提示 toast + 「N 条新内容」浮标 + 图片灯箱。
 *
 * v2.1.0 起这三个原本直接改 DOM 的指令式外挂改由 React 渲染，挂载到 #overlaysRoot。
 * 核心只维护状态（util.toastState / autorefresh.newPillState / ui.lightboxState）并派发
 * `__overlaysTick`，本组件监听后重读快照重绘 —— 与顶栏 `__shellTick` 同一套范式。
 *
 * DOM 结构与类名逐行沿用旧实现（.toast / .new-pill / .lightbox），CSS 零改动。 */
import React, { useEffect, useState } from 'react';
import { core } from '@core';

const S = () => core;

export function Overlays() {
  const [, bump] = useState(0);
  useEffect(() => {
    const onTick = () => bump((n) => n + 1);
    window.addEventListener('__overlaysTick', onTick);
    return () => window.removeEventListener('__overlaysTick', onTick);
  }, []);

  const s = S();
  if (!s) return null;

  const toast = s.getToastState ? s.getToastState() : { msg: '', ok: true, show: false };
  const pill = s.getNewPillState ? s.getNewPillState() : { show: false, text: '' };
  const box = s.getLightboxState ? s.getLightboxState() : { src: '', show: false };

  return (
    <>
      {/* 轻提示 */}
      <div className={'toast' + (toast.show ? ' show' + (toast.ok ? ' ok' : '') : '')}>{toast.msg}</div>

      {/* 自动刷新发现了新内容、但用户已经滚下去了：点它才套用，避免列表在眼皮底下跳 */}
      <button
        className="new-pill"
        type="button"
        hidden={!pill.show}
        onClick={() => s.applyPendingFresh()}
      >
        <svg className="new-pill-ico" aria-hidden="true" focusable="false"><use href="#i-arrow-up" /></svg>
        <span>{pill.text}</span>
      </button>

      {/* 图片灯箱：点文章里的图片看大图，自适应屏幕，再点一下关闭 */}
      {box.show && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          onClick={() => s.closeLightbox()}
        >
          <img className="lightbox-img" src={box.src} alt="" />
          <p className="lightbox-hint">点击任意处关闭 · Esc 退出</p>
        </div>
      )}
    </>
  );
}
