/* 笺川核心逻辑 · 全局状态真源 + 当前视图滚动容器桥
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来；深度重组后：
 *   主题 / 外观 → state.appearance.ts
 *   布局偏好 / 镜像 / 旧版迁移 → state.layout.ts
 *   设置弹层委托 / 滚动锁 → state.settings.ts
 * 本文件保留滚动容器工具与 re-export 枢纽，外部引用链（core/index.ts 与各 core 模块）
 * 完全不变。依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { state } from '../store/app.ts';

/* 被抽走的模块统一 re-export：外部链不变，读状态的一方拿到同一份 live binding。
 * state 真源在 store/app.ts（Zustand），此处 re-export 同一个 Proxy：
 * 字段名、读写语义、原地修改（push/add/set）全部逐字不变。 */
export * from './state.appearance.ts';
export * from './state.layout.ts';
export * from './state.settings.ts';
export { state };

/* ---------------- 常量 ----------------
 * 分页长度固定：卡片页 50 条，文章页 40 篇。
 */
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_READER_PAGE = 40;

/* ---------------- 当前视图的滚动容器 ----------------
 * App Shell 把 body 锁在视口内，三个视图各自是独立滚动容器，window.scrollY 永远是 0。
 * 自动刷新判「是否停在顶部」、浮标回顶、切页回顶、滚动到顶命令都必须落到容器上，
 * 否则要么误判（列表在眼皮底下被换掉），要么点了没反应。
 * 放在 state 是因为 autorefresh 与 ui 都要用，而两边不能互相依赖。 */
export function activeScrollEl() {
  if (state.tab === 'cards') return document.querySelector('#cardsRoot > main.wrap');
  if (state.tab === 'ai') return document.getElementById('aiView');
  return document.querySelector('#readerView .reader-main');
}

export function activeScrollTop() {
  const el = activeScrollEl();
  return el ? el.scrollTop : window.scrollY || 0;
}

/**
 * @param {*} [behavior]
 */

export function scrollActiveTop(behavior: ScrollBehavior = 'auto') {
  const el = activeScrollEl();
  if (!el) {
    window.scrollTo({ top: 0, behavior });
    return;
  }
  // jsdom / 老浏览器没有 Element.scrollTo，退回直接写 scrollTop
  if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior });
  else el.scrollTop = 0;
}

/* ---------------- 视图滚动位置记忆（移动端底部标签栏） ----------------
 * 三个视图是三个独立滚动容器，「切走再切回」时如果一律回顶，用户得重新翻回
 * 刚才看到的位置。这里按视图 id 记一份 scrollTop：切页前存当前页、切回时恢复。
 * 只活在内存里（刷新后回到顶部是合理的），也不参与账号偏好持久化。
 *
 * 注意：selectScope / jumpToFeed 这类「换了筛选条件」的入口仍应显式回顶 ——
 * 旧位置属于旧列表，恢复它反而会停在半截。所以默认 switchView 仍回顶，
 * 只有视图导航（ViewNav）明确传 restoreScroll 时才走这里。 */
const viewScroll = new Map();

/**
 * @param {*} [tab]
 */

export function rememberViewScroll(tab = state.tab) {
  const el = activeScrollEl();
  if (!el) return;
  const top = Math.max(0, Number(el.scrollTop) || 0);
  if (top > 0) viewScroll.set(tab, top);
  else viewScroll.delete(tab);
}

/* 列表被重置（换筛选 / 搜索 / 后台重拉）时调用：旧位置属于旧列表，
   再恢复只会把新列表夹到底部，甚至触发触底自动翻页的连环。 */
/**
 * @param {*} [tab]
 */
export function forgetViewScroll(tab = state.tab) {
  viewScroll.delete(tab);
}

/**
 * @param {*} [tab]
 */

export function restoreViewScroll(tab = state.tab) {
  if (tab !== state.tab) return;
  const want = viewScroll.get(tab) || 0;
  if (!want) return;
  let frames = 0;
  /**
   * @param {*} [el]
   * @param {*} [top]
   */
  const write = (el: Element, top: number) => {
    // 与 scrollActiveTop 同一套兜底：jsdom / 老浏览器没有 Element.scrollTo
    if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'auto' });
    else el.scrollTop = top;
  };
  const apply = () => {
    // 途中又切走了：这次恢复作废，别把新页的容器滚走
    if (tab !== state.tab) return;
    const el = activeScrollEl();
    if (!el) {
      window.scrollTo({ top: want, behavior: 'auto' });
      return;
    }
    const sh = el.scrollHeight || 0;
    const ch = el.clientHeight || 0;
    // 读不到布局（jsdom / 隐藏视图）：照旧写原值，由浏览器自己的夹取规则兜底
    if (!sh && !ch) {
      write(el, want);
      return;
    }
    /* 列表还没铺开（首屏在途 / 图片尚未占位）：此刻写进去会被夹到当前最大高度，
       等布局随后撑开，停下的位置就不是离开时那一处 —— 用户看到「自己滚到了底部」。
       等容器可滚动再落地，最多等约 0.5s；超时就按当前可达位置恢复。 */
    const max = Math.max(0, sh - ch);
    if (max <= 0 && frames < 30 && typeof requestAnimationFrame === 'function') {
      frames += 1;
      requestAnimationFrame(apply);
      return;
    }
    // 恢复值夹在当前可达范围里：旧位置属于更长的列表时，硬写只会停在底部
    write(el, Math.min(want, max));
  };
  apply();
}
