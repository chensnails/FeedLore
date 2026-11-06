/* 笺川核心逻辑 · 卡片列表数据源（视图模式 / 当前页面 / 加载 / 筛选排序 / 渲染通知）
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { apiFetch, httpError, toast, emitShell, NET_TIMEOUT_MS } from './util.js';
import { state, layoutPref, setLayout, lockPageScroll, unlockPageScroll } from './state.js';
import { emit, EVENT } from '../kernel/events.js';

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

/** 卡片页分组筛选对应的频道 id：只算「卡片开关」打开的频道。
 *  组内一个能展示的频道都没有时返回空数组 —— 调用方传 `feeds=` 空值，
 *  服务端会返回空列表（别退化成「不过滤」，那会看到别的分组的内容）。 */
export function cardGroupFeedIds() {
  return (state.feedList || [])
    .filter((f) => f.cardEnabled && String(f.groupName || '').trim() === state.cardGroup)
    .map((f) => f.id);
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
  if (!res.ok) throw await httpError(res);
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
  // 分组本身没了（改名 / 删频道 / 卡片开关全关）→ 回落到全部，别把一个空分组锁在标题上
  if (state.cardGroup != null
    && !(state.feedList || []).some((f) => f.cardEnabled && String(f.groupName || '').trim() === state.cardGroup)) {
    state.cardGroup = null;
  }
  render();
  return data;
}

/**
 * 「再来一次」的排队位：加载途中用户又点了同一频道（或换了筛选），
 * 请求不能直接丢掉 —— 丢掉的话用户看到的是旧列表，完全不知道点了生效。
 * 这里记一个 pendingReset，等当前这次结束后补一次重置重载。
 * 与 reader.js 的同名机制对称（文章页 / 卡片页两套列表各有一份）。
 */
let pagePendingReset = false;
/* 同一时刻只认最后一次列表请求：切换筛选、搜索连打、点「重试」都会发起新请求，
 * 旧的慢响应不能回来覆盖当前列表（弱网下旧响应常常比新响应晚到）。
 * controller 让「重试」能真正打断仍挂在半路的请求，而不是被 loading 闸门吞掉。 */
let pageController = null;
let pageGeneration = 0;

export function cancelPageLoad() {
  pageGeneration += 1;
  if (pageController) { pageController.abort(); pageController = null; }
}

export async function loadPage(reset = false) {
  // 错误空态里的「重试」：上一次可能还挂在半路，先让它失效、释放闸门再发新的。
  // 旧实现只往 pagePendingReset 排队，请求永不返回时就永远不会补跑 —— 按钮点了没反应。
  const force = reset && state.loadError;
  if (force) {
    cancelPageLoad();
    state.loading = false;
    pagePendingReset = false;
  }
  // 首屏失败、列表还是空的时候，滚动哨兵会不断触发「翻页」请求 ——
  // 失败 → 自动重拉 → 再失败，骨架永远不消失，错误空态里的「重试」也没机会出现。
  // 只有用户主动「重试」(reset) 才继续，自动加载一律停下。
  if (!reset && state.loadError && !state.entries.length) return;
  if (state.loading) {
    if (reset) pagePendingReset = true;
    return;
  }
  state.loading = true;

  if (reset) { state.offset = 0; state.hasMore = true; state.entries = []; state.loadMoreErr = false; state.loadError = false; }
  if (!reset) state.loadMoreErr = false;

  const first = state.entries.length === 0;
  render();   // 立刻反映骨架 / 加载态（渲染归 React 卡片视图）

  const gen = ++pageGeneration;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  pageController = ctrl;
  const stale = () => gen !== pageGeneration || !!(ctrl && ctrl.signal.aborted);

  try {
    // 移动端首屏只取一小批（v1.5.0）：窄屏一屏只显示得下 6~8 张卡，
    // 一次拉 50 条会白渲染 40+ 张卡片（DOM 节点翻倍）并多发 40 个图片请求。
    // 滚动到底部会自动续拉（CardsView 的 scroll 监听），用户感知不到差别。
    const narrow = typeof window !== 'undefined' && window.innerWidth <= 720;
    const want = narrow ? Math.min(state.pageSize, 20) : state.pageSize;
    const qs = new URLSearchParams({
      limit: String(want),
      offset: String(state.offset),
    });
    if (state.q) qs.set('q', state.q);
    // 分组筛选优先于频道：与文章页同一口径（传该组频道的 id 清单）
    if (state.cardGroup != null) qs.set('feeds', cardGroupFeedIds().join(','));
    // 没指定具体频道时，卡片页只取「卡片开关」打开的频道
    else if (state.feedFilter) qs.set('feeds', String(state.feedFilter));
    else qs.set('scope', 'cards');

    const res = await apiFetch('/api/entries?' + qs.toString(),
      ctrl ? { signal: ctrl.signal, timeoutMs: NET_TIMEOUT_MS } : { timeoutMs: NET_TIMEOUT_MS });
    if (stale()) return;   // 已被更新的请求取代 / 用户点了重试
    if (!res.ok) throw await httpError(res);
    const data = await res.json();
    if (stale()) return;

    if (reset) state.tags = data.tags || [];

    const list = data.entries || [];
    const seen = new Set(state.entries.map((e) => e.id));
    for (const e of list) if (!seen.has(e.id)) state.entries.push(e);

    state.offset += list.length;
    state.hasMore = !!data.hasMore && list.length > 0;
    state.total = Number(data.total) || 0;
    state.loadError = false;
    state.loadMoreErr = false;
  } catch (err) {
    if (stale()) return;                 // 主动取消 / 已被取代，不算失败
    if (first) state.loadError = true;   // 首屏失败 → React 显示错误空态
    else state.loadMoreErr = true;       // 翻页失败 → 列表底部给「重试」，不再只弹一下 toast
  } finally {
    if (pageController === ctrl) pageController = null;
    if (gen !== pageGeneration) return;  // 新请求已接管，别把它的 loading 状态清掉
    state.loading = false;
    render();
    // 加载途中排队的「重置重载」：补跑一次，让用户的第二次点击真正生效
    if (pagePendingReset) {
      pagePendingReset = false;
      loadPage(true);
    }
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
/** 顶栏副标题文本（纯计算；React 组件经桥 getShell 读取） */
export function subtitleText() {
  const meta = state.feedMeta;
  if (!meta) return '正在加载频道…';
  if (!meta.total) return '还没有订阅源 · 点右上角「设置 → 数据源」添加 RSS';
  return `${state.tagline} · 采集 ${meta.enabled}/${meta.total} 个频道`
    + (Number(meta.cardEnabled) !== Number(meta.enabled) ? ` · 卡片展示 ${meta.cardEnabled} 个` : '');
}

export function render() {
  // 顶栏（副标题 / 视图高亮）由 React 渲染
  emitShell();
  // 卡片列表渲染交给 React 卡片视图（src/views/CardsView.jsx）：通知它读实时 state 重绘
  emit(EVENT.CARDS);
}

/* 卡片页的「滚动到底自动加载」在 src/views/CardsView.jsx 的 effect 里实现（v1.6.0-test6）：
 * App Shell 之后滚动容器是 main.wrap 而不是 window，这里的 window 滚动监听永远收不到
 * 事件（实测自动加载失灵的根因之一），已随「加载更多」按钮一起移除 —— 触发统一走
 * CardsView 的 document 捕获监听 + #cardsSentinel 哨兵几何判定。 */

/* ---------------- 移动端：卡片页的频道抽屉 ----------------
 * 与文章页同一套交互（v1.3.10）：标题栏左侧「频道」按钮开合，右滑从左边推出，
 * 点遮罩 / 关闭按钮 / 左滑收起。状态照旧落在 <body> 的类上 —— 类名由 CSS 接管动画，
 * 手势（src/core/drawer.js）读同一个类判断开合，不需要再传一份状态。
 * 宽屏没有抽屉（频道筛选走工具栏下拉），窗口变宽时自动收起。
 */
export let cardsDrawerLocked = false;   // 抽屉当前是否拿着页面滚动锁

export function setCardsDrawer(open) {
  const on = !!open;
  if (on === document.body.classList.contains('cards-drawer-open')) return;
  document.body.classList.toggle('cards-drawer-open', on);
  // 与文章页抽屉一致：铺满整屏的浮层得把背景真的钉住，iOS 上只写 overflow:hidden 挡不住惯性滚动
  if (on) { lockPageScroll(); cardsDrawerLocked = true; }
  else if (cardsDrawerLocked) { cardsDrawerLocked = false; unlockPageScroll(); }
}

export function cardsToggleDrawer() { setCardsDrawer(!document.body.classList.contains('cards-drawer-open')); }
export function cardsCloseDrawer() { setCardsDrawer(false); }
window.addEventListener('resize', () => { if (window.innerWidth > 720) setCardsDrawer(false); });
