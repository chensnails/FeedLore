/* 图片灯箱状态与键盘/点击监听。从 ui.ts 抽出（深度重组），ui.ts 通过 export * 保持外部链不变。 */

import { lightboxDisplaySrc } from './lightboxSrc.ts';
import { lockPageScroll, unlockPageScroll } from './state.ts';
import type { LightboxState } from './types.ts';
import { emitOverlays } from './util.ts';

export { lightboxDisplaySrc } from './lightboxSrc.ts';

/* ---------- 图片灯箱 ----------
 * index.html 与 style.css 里一直有 .lightbox，但之前没有任何 JS 接上它，
 * 于是图片上写着「点击查看大图」却点不动。这里补齐：点图看大图，点任意处或 Esc 关闭。
 * v2.1.0 起灯箱 DOM 改由 src/ui/Overlays.tsx 渲染，核心只维护状态并派发 __overlaysTick。
 * 同一篇正文里的图组成一组，支持 ← → 翻看；关闭时把焦点还给触发图。
 */
export let lightboxState: LightboxState = { src: '', show: false, list: [], index: 0 };
/** 触发灯箱的元素（不放进 state：它是 DOM 引用，进 state 会跟着快照到处传） */
let lightboxOpener: HTMLElement | null = null;

interface LightboxOpts {
  list?: string[];
  opener?: HTMLElement | null;
}

export function openLightbox(src: string, opts: LightboxOpts = {}) {
  if (!src) return;
  const o = opts || {};
  const list = Array.isArray(o.list) && o.list.length ? o.list : [src];
  const i = list.indexOf(src);
  lightboxOpener = o.opener || null;
  lightboxState = { src, show: true, list, index: Math.max(i, 0) };
  emitOverlays();
  lockPageScroll();
}

export function closeLightbox() {
  if (!lightboxState.show) return;
  lightboxState = { src: '', show: false, list: [], index: 0 };
  emitOverlays();
  unlockPageScroll();
  // 焦点归还触发图：不还的话关掉后焦点掉到 body，键盘用户得从头 Tab。
  // 正文图是 <img>、默认不可聚焦，临时补 tabindex="-1"（不进 Tab 序列，但可程序聚焦）。
  const op = lightboxOpener;
  lightboxOpener = null;
  if (op && document.contains(op) && typeof op.focus === 'function') {
    if (!op.hasAttribute('tabindex') && !op.matches('a[href],button,input,select,textarea')) {
      op.setAttribute('tabindex', '-1');
    }
    op.focus();
  }
}

/** 组内翻页（±1）。只有一张图时是空操作。 */
export function stepLightbox(d: number) {
  const st = lightboxState;
  if (!st.show || !st.list || st.list.length < 2) return;
  const n = st.list.length;
  const i = (((st.index + d) % n) + n) % n;
  lightboxState = { ...st, src: st.list[i] || '', index: i };
  emitOverlays();
}

document.addEventListener(
  'click',
  /** @param {*} [ev] */ (ev) => {
    if (lightboxState.show) {
      closeLightbox();
      return;
    } // 开着的时候点哪儿都关
    if (!(ev.target instanceof Element)) return;
    const img = ev.target.closest('.art-img');
    if (!img) return;
    // 同一篇正文内的图算一组：卡片详情 / 文章页正文 / 列表展开体。
    // currentSrc 用来认「点的是哪张」，展示地址归一到大图档（见 lightboxDisplaySrc）。
    const pickSrc = (el: Element): string => {
      const node = el as HTMLImageElement;
      return lightboxDisplaySrc(node.currentSrc || node.getAttribute('src') || '');
    };
    const scope = img.closest('.art-body, .cd-body, .cd-modal, .art-item') || document;
    const list = Array.from(scope.querySelectorAll('.art-img'))
      .map(pickSrc)
      .filter((s): s is string => !!s);
    const src = pickSrc(img);
    if (!src) return;
    openLightbox(src, { list, opener: img as HTMLElement });
  },
);

document.addEventListener(
  'keydown',
  /** @param {*} [ev] */ (ev) => {
    if (!lightboxState.show) return;
    if (ev.key === 'Escape') closeLightbox();
    else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      stepLightbox(1);
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      stepLightbox(-1);
    }
  },
);
