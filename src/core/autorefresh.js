/* 笺川核心逻辑 · 页面自动刷新：定时探测新内容、「N 条新内容」浮标的显隐与套用
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { apiFetch, httpError, toast, emitShell, emitOverlays } from './util.js';
import { state } from './state.js';
import { render } from './feeds.js';
import { renderReader, readerFilterParams } from './reader.js';

/* ============================================================
 * 网页自动刷新
 * 间隔存在服务端（settings.source.autoRefreshMinutes），各设备一致。
 * 只重新读一次列表，不触发服务端抓取。发现新内容时：
 *   - 用户停在顶部、也没有展开中的文章 → 直接套用
 *   - 已经滚下去了 → 挂个浮标，点了才套用，避免列表在眼皮底下跳
 * ============================================================ */
export let autoRefreshTimer = null;
export let autoRefreshLastAt = 0;    // 上一次检查的时刻（回到前台时判断要不要补一次）
export let pendingFresh = null;      // { view, data, n } 已拉到但还没套用的新内容

/** 「N 条新内容」浮标的可视图状态，由 src/ui/Overlays.jsx 渲染（v2.1.0 起不再直接改 DOM） */
export let newPillState = { show: false, text: '' };

function setNewPill(show, text) {
  newPillState = { show, text: text || '' };
  emitOverlays();
}

export function autoRefreshMinutes() {
  const n = Number(state.feedMeta && state.feedMeta.autoRefreshMinutes);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function scheduleAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  const mins = autoRefreshMinutes();
  if (!mins) return;
  autoRefreshLastAt = Date.now();
  autoRefreshTimer = setInterval(() => {
    if (document.hidden) return;                        // 后台不跑，回到前台再补
    if (window.__settingsOpen) return;   // 正在改设置就别动列表
    autoRefreshLastAt = Date.now();
    checkForNew().catch(() => { /* 自动刷新失败就静默跳过，不打扰用户 */ });
  }, mins * 60000);
}

/** 按当前页面的筛选条件拉一页首屏（卡片页的标签是前端过滤的，不用带 tag） */
export async function fetchHead(view) {
  const params = new URLSearchParams();
  const loaded = view === 'reader' ? state.rdEntries.length : state.entries.length;
  const base = view === 'reader' ? state.readerPageSize : state.pageSize;
  params.set('limit', String(Math.min(Math.max(loaded, base), 200)));
  params.set('offset', '0');

  if (view === 'reader') {
    // 和 loadReader 用同一套条件，否则「新内容」会按错误的范围去数
    for (const [k, v] of readerFilterParams()) params.set(k, v);
  } else {
    if (state.feedFilter) params.set('feeds', String(state.feedFilter));
    else params.set('scope', 'cards');
    if (state.q) params.set('q', state.q);
  }

  const res = await apiFetch('/api/entries?' + params.toString());
  if (!res.ok) throw await httpError(res);
  return res.json();
}

/** 只数「排在当前最头条目之前」的那些，避免把翻页拿到的旧条目也算成新的 */
export function countNewHead(fresh, current) {
  const known = new Set(current.map((e) => String(e.id)));
  let n = 0;
  for (const e of fresh) {
    if (known.has(String(e.id))) break;
    n += 1;
  }
  return n;
}

export function hideNewPill() {
  pendingFresh = null;
  setNewPill(false);
}

/** 把拉到的新首屏套进当前列表 */
export function applyFresh({ view, data }) {
  const list = data.entries || [];
  if (view === 'reader') {
    state.rdEntries = list;
    state.rdOffset = list.length;
    state.rdHasMore = !!data.hasMore;
    // 展开态与正文缓存留着：条目 id 没变，重绘后会自己恢复展开
    renderReader();
  } else {
    state.entries = list;
    state.offset = list.length;
    state.hasMore = !!data.hasMore && list.length > 0;
    state.tags = data.tags || state.tags;
    render();
  }
  emitShell();
  hideNewPill();
}

export async function checkForNew() {
  if (state.tab === 'ai') return 0;                     // AI 页（日报按日期取、设置是表单）不参与自动刷新
  // 收藏列表里不可能冒出新内容（新条目默认都不是收藏），别白拉一次
  if (state.tab === 'reader' && state.rdScope === 'favorite') return 0;
  if (state.loading || state.rdLoading) return 0;
  const view = state.tab === 'cards' ? 'cards' : 'reader';
  const current = view === 'reader' ? state.rdEntries : state.entries;

  const data = await fetchHead(view);
  const n = countNewHead(data.entries || [], current);
  if (!n) return 0;

  // 停在顶部、也没有展开中的文章时才敢直接换列表；否则挂浮标等用户点
  const atTop = window.scrollY < 300;
  const busy = view === 'reader' && state.rdExpanded.size > 0;
  if (atTop && !busy) {
    applyFresh({ view, data });
    toast(`已更新 ${n} 条新内容`);
    return n;
  }
  pendingFresh = { view, data, n };
  setNewPill(true, `${n} 条新内容`);
  return n;
}

/** 浮标被点击（src/ui/Overlays.jsx 渲染的按钮调它）：套用新内容并回到顶部 */
export function applyPendingFresh() {
  const p = pendingFresh;
  hideNewPill();
  if (!p) return;
  applyFresh(p);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 回到前台时如果已经过了间隔就补一次（后台期间定时器被跳过了）
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const mins = autoRefreshMinutes();
  if (!mins) return;
  if (Date.now() - autoRefreshLastAt < mins * 60000) return;
  if (window.__settingsOpen) return;
  autoRefreshLastAt = Date.now();
  checkForNew().catch(() => {});
});
