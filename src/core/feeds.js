/* 笺川核心逻辑 · 卡片列表数据源（视图模式 / 当前页面 / 加载 / 筛选排序 / 渲染通知）
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { $, apiFetch, toast, emitShell } from './util.js';
import { state, layoutPref, setLayout } from './state.js';

/** 按分组名把频道归类：未分组的排最前，其余按名称排序；组内保持原顺序 */
export function groupFeeds(feeds) {
  const map = new Map();
  for (const f of feeds) {
    const g = String(f.groupName || '').trim();
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(f);
  }
  // 分组顺序：优先用显式保存的 groupOrder；不在其中的命名分组按出现顺序补到后面；
  // 「未分组」（空串）永远放最后，不参与拖拽排序。
  const order = state.groupOrder || [];
  const seen = new Set();
  const names = [];
  for (const g of order) if (g && map.has(g) && !seen.has(g)) { names.push(g); seen.add(g); }
  for (const g of map.keys()) if (g && !seen.has(g)) { names.push(g); seen.add(g); }
  if (map.has('')) names.push('');
  return names.map((name) => ({ name, feeds: map.get(name) }));
}

/* ---------------- 视图模式（卡片 / 列表） ----------------
 * 按账号持久化（users.prefs.layout.view），不再落浏览器 localStorage。
 * 两种模式用同一份 state.entries 重新渲染，不做双份 DOM 隐藏切换。
 */
export const VIEW_MODES = ['grid', 'list'];

export function currentViewMode() {
  return VIEW_MODES.indexOf(layoutPref.view) >= 0 ? layoutPref.view : 'grid';
}

/* 分组折叠状态：按账号持久化（users.prefs.layout.collapsedGroups），不再落浏览器 */
export function loadCollapsedGroups() {
  const arr = Array.isArray(layoutPref.collapsedGroups) ? layoutPref.collapsedGroups : [];
  return new Set(arr.filter((g) => typeof g === 'string'));
}

/** 把模式写到 state / DOM / 按钮态；persist=true 时才写账号（手动切换才记） */
export function applyViewMode(mode, persist) {
  state.view = VIEW_MODES.indexOf(mode) >= 0 ? mode : 'grid';
  if (persist) setLayout('view', state.view);
  render();   // 通知 CardsView 重绘（含 viewMode 按钮态）
}

/** 用户点击切换：切完立刻按新模式重绘 */
export function setViewMode(mode) {
  if (mode === state.view) return;
  applyViewMode(mode, true);   // 内部已 render()
  toast(state.view === 'list' ? '已切换到列表视图' : '已切换到卡片视图');
}

/* ---------------- 当前页面（文章 / 卡片 / 日报） ----------------
 * 按账号持久化（users.prefs.layout.tab），不再落浏览器 localStorage：
 * 切到「卡片」再刷新不会又跳回「文章」。首次访问回落到「文章」（阅读为主的主页）。
 */
export const TABS = ['reader', 'cards', 'ai'];

export function currentTab() {
  const t = layoutPref.tab;
  // 老版本存的是 'digest'，那个页面已经升级成「AI」了
  if (t === 'digest') return 'ai';
  return TABS.indexOf(t) >= 0 ? t : 'reader';
}

/* ---------------- 数据加载 ---------------- */
export async function loadFeeds() {
  const res = await apiFetch('/api/feeds');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  state.feedList = data.feeds || [];
  state.feedMeta = data;
  state.groupOrder = Array.isArray(data.groupOrder) ? data.groupOrder : [];
  state.collapsedGroups = loadCollapsedGroups();
  // 侧栏「全部 / 未读 / 收藏」的计数跟频道一起回来，省一次请求
  if (data.flags) state.rdFlags = data.flags;
  // 之前筛选的频道被关掉卡片开关 / 删掉了，回落到全部（旧 renderFeedSelect 的兜底职责）
  if (state.feedFilter != null
    && !(state.feedList || []).some((f) => String(f.id) === String(state.feedFilter) && f.cardEnabled)) {
    state.feedFilter = null;
  }
  render();
  return data;
}

export async function loadPage(reset = false) {
  if (state.loading) return;
  state.loading = true;

  if (reset) { state.offset = 0; state.hasMore = true; state.entries = []; }

  const first = state.entries.length === 0;
  render();   // 立刻反映骨架 / 加载态（渲染归 React 卡片视图）

  try {
    const qs = new URLSearchParams({
      limit: String(state.pageSize),
      offset: String(state.offset),
    });
    if (state.q) qs.set('q', state.q);
    // 没指定具体频道时，卡片页只取「卡片开关」打开的频道
    if (state.feedFilter) qs.set('feeds', String(state.feedFilter));
    else qs.set('scope', 'cards');

    const res = await apiFetch('/api/entries?' + qs.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    if (reset) state.tags = data.tags || [];

    const list = data.entries || [];
    const seen = new Set(state.entries.map((e) => e.id));
    for (const e of list) if (!seen.has(e.id)) state.entries.push(e);

    state.offset += list.length;
    state.hasMore = !!data.hasMore && list.length > 0;
    state.loadError = false;
  } catch (err) {
    if (first) state.loadError = true;   // 首屏失败 → React 显示错误空态
    else toast('加载失败：' + (err.message || err), false);
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------------- 筛选与排序 ---------------- */
export function applyFilters() {
  const list = state.entries.filter((e) => {
    if (state.tag && !(e.tags || []).includes(state.tag)) return false;
    return true;
  });

  if (state.sort === 'new') list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  else if (state.sort === 'old') list.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  else if (state.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  return list;
}

/* ---------------- 渲染 ---------------- */
/** 顶栏副标题文本（纯计算；App Shell 的 TopBar 经桥 getShell 读取） */
export function subtitleText() {
  const meta = state.feedMeta;
  if (!meta) return '正在加载频道…';
  if (!meta.total) return '还没有订阅源 · 点右上角「设置 → 数据源」添加 RSS';
  return `${state.tagline} · 采集 ${meta.enabled}/${meta.total} 个频道`
    + (Number(meta.cardEnabled) !== Number(meta.enabled) ? ` · 卡片展示 ${meta.cardEnabled} 个` : '');
}

export function render() {
  // 顶栏（条资源计数 / 副标题）由 React 渲染
  emitShell();
  // 卡片列表渲染交给 React 卡片视图（src/views/CardsView.jsx）：通知它读实时 state 重绘
  window.dispatchEvent(new Event('__cardsTick'));
}

export let scrollLock = false;
window.addEventListener('scroll', () => {
  if (scrollLock || state.loading || !state.hasMore) return;
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 600) {
    scrollLock = true;
    loadPage(false).finally(() => setTimeout(() => (scrollLock = false), 400));
  }
});
