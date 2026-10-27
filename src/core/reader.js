/* 笺川核心逻辑 · 文章（阅读页）数据源与交互：加载 / 展开正文 / 已读收藏 / 抽屉 / 无限滚动 / 搜索
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { $, apiFetch, toast, emitShell, confirm } from './util.js';
import { state, layoutPref, setLayout, openSettings, lockPageScroll, unlockPageScroll } from './state.js';
import { loadFeeds, groupFeeds } from './feeds.js';

/* ============================================================
 * 阅读页（文章）：左频道 / 右文章，点标题展开全文
 * ============================================================ */

/* ============================================================
 * 阅读页（文章）：逻辑归 app.js，渲染归 React（src/views/ReaderView.jsx）
 * v1.9.0 起阅读页 React 化：频道侧栏 / 头部工具 / 搜索 / 条目与正文渲染全部移除，
 * 这里只保留数据 / 加载 / 交互逻辑，需要刷新 UI 时派发 __readerTick（组件监听后读实时 state 重绘）。
 * ============================================================ */

/** 通知 ReaderView 重绘 */
export function renderReader() { window.dispatchEvent(new Event('__readerTick')); }
/** 兼容旧调用名：频道侧栏同样由 ReaderView 渲染，故与 renderReader 同为一次重绘 */
export function renderReaderChannels() { renderReader(); }

/**
 * 阅读页当前的筛选条件 → URLSearchParams。
 * 列表查询、自动刷新、批量标为已读三处共用，保证「屏幕上看到的」和「被操作的」是同一批。
 * 分组里一个频道都没有时传 `feeds=`（空），服务端会返回空列表 —— 别退化成「不过滤」。
 */
export function readerFilterParams() {
  const params = new URLSearchParams();
  const feeds = state.feedList || [];
  let ids = null;
  if (state.rdFeedId != null) {
    ids = [Number(state.rdFeedId)];
  } else if (state.rdGroup != null) {
    // 分组筛选：把该分组的频道 id 摊平了传给 feeds=（未分组用 '' 表示）
    ids = feeds.filter((f) => (f.groupName || '').trim() === state.rdGroup).map((f) => f.id);
  }
  if (ids) params.set('feeds', ids.join(','));
  // 阅读页的「全部」看的是全部内容，不受「卡片」开关影响
  else params.set('scope', 'all');
  if (state.rdScope === 'unread') params.set('unread', '1');
  if (state.rdScope === 'favorite') params.set('fav', '1');
  if (state.rdQ) params.set('q', state.rdQ);
  return params;
}

export async function loadReader({ reset = false } = {}) {
  if (state.rdLoading) return;
  if (!reset && !state.rdHasMore) return;

  state.rdLoading = true;
  if (reset) {
    state.rdOffset = 0;
    state.rdHasMore = true;
    state.rdEntries = [];
    state.rdExpanded.clear();
    state.rdBody.clear();
    state.rdBodyErr.clear();
  }
  renderReader();

  try {
    const params = readerFilterParams();
    params.set('limit', String(state.readerPageSize));
    params.set('offset', String(state.rdOffset));

    const res = await apiFetch('/api/entries?' + params.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    const list = data.entries || [];
    state.rdEntries = reset ? list : state.rdEntries.concat(list);
    state.rdOffset = state.rdEntries.length;
    state.rdHasMore = !!data.hasMore;
    state.rdReadError = false;
  } catch (err) {
    if (!state.rdEntries.length) {
      state.rdReadError = true;
      state.rdReadErrorMsg = '加载失败：' + String((err && err.message) || err);
    } else {
      toast('加载失败：' + (err.message || err), false);
    }
  } finally {
    state.rdLoading = false;
    renderReader();
  }
}

/* ---------- 手风琴模式 ---------- */
export let accordionOn = layoutPref.accordion;
export function readerAccordionOn() { return accordionOn; }
export function readerToggleAccordion() {
  accordionOn = !accordionOn;
  setLayout('accordion', accordionOn);   // 按账号持久化
  renderReader();
  toast(accordionOn ? '已开启单篇展开' : '已改为可同时展开多篇');
}

/** 找列表里某篇的 DOM：按 data-id 比对，避开 id 里特殊字符对 CSS 选择器的影响 */
function findArtItemEl(id) {
  const want = String(id);
  const items = document.querySelectorAll('#readerList .art-item');
  for (const el of items) if (el.dataset.id === want) return el;
  return null;
}

export async function expandReaderArt(id) {
  /* 手风琴（默认开启）：展开这一条之前会先把其它展开的收掉。
   * 若被收起的那篇在目标文章「上方」，它一收起，列表在目标文章上方就矮了一大截，
   * 而窗口 scrollTop 保持不变 —— 于是目标文章整体上移、跳离用户点击的位置，甚至滚出屏幕。
   * 这就是「上一篇没收起时，点下面的会跳到错误位置」的根因。
   * 对策：展开前记下目标文章的视口位置，DOM 更新后把差值补滚回去，保证「点哪篇、它停在哪」。
   * 若被收起的那篇在目标文章下方，差值为 0，不会有多余滚动。 */
  let anchorTop = null;
  if (accordionOn) {
    const others = Array.from(state.rdExpanded).filter((openId) => String(openId) !== String(id));
    if (others.length) {
      const el = findArtItemEl(id);
      if (el) anchorTop = el.getBoundingClientRect().top;
      for (const openId of others) state.rdExpanded.delete(openId);
    }
  }

  state.rdExpanded.add(id);
  renderReader();
  markEntryRead(id);   // 展开了就算读过了

  if (anchorTop != null) {
    // renderReader() 只是派发 __readerTick，React 的 setState 在微任务里提交 DOM（早于 rAF），
    // 所以这里量到的是更新后的位置，补偿也在同一帧完成 —— 用户几乎看不到跳动。
    // 用瞬时滚动而非 smooth：位移在一帧内被抵消最连贯，平滑动画反而会把这次修正放大成一次可见的滚动。
    requestAnimationFrame(() => {
      const el = findArtItemEl(id);
      if (!el) return;
      const delta = el.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > 1) window.scrollBy(0, delta);
    });
  }

  if (state.rdBody.has(id) || state.rdBodyErr.has(id)) return;
  try {
    const res = await apiFetch('/api/entries/' + encodeURIComponent(id));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.rdBody.set(id, await res.json());
  } catch (_) {
    state.rdBodyErr.add(id);
  }
  renderReader();
}

export function collapseReaderArt(id) { state.rdExpanded.delete(id); renderReader(); }

export function readerToggleArt(id) {
  if (state.rdExpanded.has(id)) collapseReaderArt(id);
  else expandReaderArt(id);
}

export function readerCollapseAll() {
  state.rdExpanded.clear();
  renderReader();
  toast('已全部收起');
}

const FLASH_MS = 1500;      // 高亮停留时长（与 style.css 的 artFlash 对齐）
const FOCUS_MAX_PAGES = 8;  // 为目标文章最多往后翻几页：再远就不该假装找得到

/** 把某篇文章「指给用户看」：滚到它并让文章框闪一下（卡片页 → 文章页的落点指示）。
 *  列表是分页的，目标可能不在首屏 —— 往后翻若干页找，翻不到就明说，不静默。
 *  高亮走 state.rdFlashId 而不是直接给 DOM 加类：阅读页整棵列表由 React 渲染，
 *  任何一次重绘都会按自己算出的 className 覆盖掉手写上去的类。 */
export async function focusReaderArt(id) {
  const want = String(id);
  let el = findArtItemEl(want);
  for (let i = 0; !el && i < FOCUS_MAX_PAGES && state.rdHasMore; i++) {
    await loadReader();
    el = findArtItemEl(want);
  }
  if (!el) {
    toast('这条不在该频道最近的内容里，已跳到频道列表');
    return false;
  }
  state.rdFlashId = want;
  renderReader();
  // renderReader() 只派发一次 tick，React 在微任务里提交 DOM，所以滚动放到下一帧
  requestAnimationFrame(() => {
    const target = findArtItemEl(want);
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
  });
  setTimeout(() => {
    if (state.rdFlashId !== want) return;   // 期间又跳了别处，交给那一次去收
    state.rdFlashId = null;
    renderReader();
  }, FLASH_MS);
  return true;
}

/* ---------- 已读 / 未读 / 收藏 ---------- */

/** 就地换掉一条条目（不改原对象）：列表项是 React.memo 的，
 *  引用不变就不会重绘，所以状态变化必须产出新对象。返回替换后的那条。 */
function replaceEntry(list, idx, patch) {
  const next = Object.assign({}, list[idx], patch);
  const arr = list.slice();
  arr[idx] = next;
  return arr;
}

/** 改某条目已读态后，同步所属频道在 feedList 里的未读计数（侧栏频道 / 分组据此渲染）。
 *  不在此处 reloadFeeds（避免一次标已读就打一次 /api/feeds），而是就地算准；
 *  下次切换频道 / 拉取订阅源 / 自动刷新时再从服务端校正。 */
function bumpFeedUnread(feedId, delta) {
  if (feedId == null) return;
  const list = state.feedList;
  if (!Array.isArray(list)) return;
  const id = String(feedId);
  const idx = list.findIndex((f) => String(f.id) === id);
  if (idx < 0) return;
  const f = list[idx];
  const next = Math.max(0, (Number(f.unreadCount) || 0) + delta);
  if (next === Number(f.unreadCount)) return;
  // 换新对象：与 replaceEntry 同口径，保证引用变化、侧栏重算时拿到的就是最新值
  const arr = list.slice();
  arr[idx] = Object.assign({}, f, { unreadCount: next });
  state.feedList = arr;
}

/** 就地改一条的状态：内存 + 侧栏计数 + 重绘（原 paintEntryFlag 的就地 DOM 改类名移除） */
export function applyEntryFlag(id, patch) {
  const idx = state.rdEntries.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) return;
  const e = state.rdEntries[idx];
  const wasRead = !!e.isRead;
  const wasFav = !!e.isFavorite;
  const next = {};
  if (patch.isRead !== undefined) next.isRead = !!patch.isRead;
  if (patch.isFavorite !== undefined) next.isFavorite = !!patch.isFavorite;
  state.rdEntries = replaceEntry(state.rdEntries, idx, next);
  const now = state.rdEntries[idx];

  if (wasRead !== now.isRead) {
    state.rdFlags.unread = Math.max(0, (state.rdFlags.unread || 0) + (now.isRead ? -1 : 1));
    // 同步所属频道的未读计数：侧栏频道徽标与分组计数都从 feedList 实时重算，否则
    // 把一组文章全点完已读，分组 / 频道栏的未读数还停在旧值（本页不重新拉订阅源）。
    bumpFeedUnread(now.feedId, now.isRead ? -1 : 1);
  }
  if (wasFav !== now.isFavorite) {
    state.rdFlags.favorite = Math.max(0, (state.rdFlags.favorite || 0) + (now.isFavorite ? 1 : -1));
  }
  renderReader();

  // 在「收藏」范围里取消收藏 = 明确的「移出这里」，立刻从列表拿掉。
  if (state.rdScope === 'favorite' && !now.isFavorite) {
    state.rdEntries = state.rdEntries.filter((x) => String(x.id) !== String(id));
    state.rdOffset = Math.max(0, state.rdOffset - 1);
    renderReader();
  }
}

/** 打标记：先乐观更新界面，再发请求；失败回滚并提示 */
export async function setEntryFlag(id, patch) {
  const e = state.rdEntries.find((x) => String(x.id) === String(id));
  const before = e ? { isRead: !!e.isRead, isFavorite: !!e.isFavorite } : null;
  if (e) applyEntryFlag(id, patch);
  try {
    const res = await apiFetch('/api/entries/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (e) applyEntryFlag(id, { isRead: d.isRead, isFavorite: d.isFavorite });
    return true;
  } catch (err) {
    if (e && before) applyEntryFlag(id, before);
    toast('标记失败：' + (err.message || err), false);
    return false;
  }
}

/** 展开全文即视为已读（只在还没读过时发请求） */
export function markEntryRead(id) {
  const e = state.rdEntries.find((x) => String(x.id) === String(id));
  if (!e || e.isRead) return;
  setEntryFlag(id, { isRead: true });
}

/** 收藏 / 取消收藏（原 toggleFavorite(el) → 改按 id） */
export function readerToggleFav(id) {
  const e = state.rdEntries.find((x) => String(x.id) === String(id));
  const next = !(e && e.isFavorite);
  setEntryFlag(id, { isFavorite: next }).then((ok) => {
    if (ok) toast(next ? '已收藏' : '已取消收藏');
  });
}

/* ---------- 频道栏分组折叠（v1.4.0-test） ----------
 * 与设置面板的 collapsedGroups 各存一份（layout.rdCollapsedGroups）：数据源面板收起的是
 * 管理清单，频道栏收起的是阅读时的干扰项，两件事不该互相牵连。 */
export function rdCollapsedGroups() {
  const arr = Array.isArray(layoutPref.rdCollapsedGroups) ? layoutPref.rdCollapsedGroups : [];
  return new Set(arr.filter((g) => typeof g === 'string'));
}

/* 收起的是同一份偏好，看它的却有两处 UI（文章页侧栏 + 卡片页频道筛选下拉），
   而两边的重绘信号各自独立 —— 改一次要两边都派发，否则另一边拿着旧集合渲染。 */
function renderGroupFold() {
  renderReader();
  window.dispatchEvent(new Event('__cardsTick'));
}

export function readerToggleGroupCollapse(name) {
  const g = String(name || '');
  const set = rdCollapsedGroups();
  if (set.has(g)) set.delete(g); else set.add(g);
  setLayout('rdCollapsedGroups', Array.from(set));
  renderGroupFold();
}

/** 一键收起 / 展开全部分组：全都收着就展开，否则一次收齐 */
export function readerToggleAllGroups() {
  const names = groupFeeds(state.feedList || []).map((g) => g.name || '');
  if (!names.length) return;
  const set = rdCollapsedGroups();
  const allCollapsed = names.every((n) => set.has(n));
  setLayout('rdCollapsedGroups', allCollapsed ? [] : names);
  renderGroupFold();
  toast(allCollapsed ? '已展开全部分组' : '已收起全部分组');
}

/** 展开某个分组（选中组内频道 / 组名时调用，避免「点了却看不见」） */
function expandRdGroup(name) {
  const g = String(name || '');
  const set = rdCollapsedGroups();
  if (!set.has(g)) return;
  set.delete(g);
  setLayout('rdCollapsedGroups', Array.from(set));
  // 调用方随后自己 renderReader()，这里只补卡片页那半边
  window.dispatchEvent(new Event('__cardsTick'));
}

/* ---------- 频道 / 范围 / 分组切换（ReaderView 经桥调用） ---------- */
export function readerSetScope(scope) {
  if (scope === state.rdScope && state.rdFeedId == null && state.rdGroup == null) return;
  state.rdScope = scope;
  setLayout('rdScope', scope);   // 默认范围按账号持久化
  state.rdFeedId = null;
  state.rdGroup = null;
  renderReader();
  loadReader({ reset: true });
  emitShell();
  setReaderDrawer(false);
  scrollReaderTop();
}
export function readerSetGroup(g) {
  state.rdScope = 'all';   // 看某个分组 = 回到「全部」范围
  if (g === state.rdGroup) state.rdGroup = null;
  else { state.rdGroup = g; state.rdFeedId = null; expandRdGroup(g); }
  renderReader();
  loadReader({ reset: true });
  emitShell();
  setReaderDrawer(false);
  scrollReaderTop();
}
export function readerSetFeed(id) {
  const next = id != null ? Number(id) : null;
  state.rdScope = 'all';
  if (next === state.rdFeedId && state.rdGroup == null) return;
  const f = next == null ? null : (state.feedList || []).find((x) => String(x.id) === String(next));
  state.rdFeedId = next;
  state.rdGroup = null;
  if (f) expandRdGroup(String(f.groupName || '').trim());   // 折叠着就选不到它，选了必须看得见
  renderReader();
  loadReader({ reset: true });
  emitShell();
  setReaderDrawer(false);
  scrollReaderTop();
}
export function readerOpenSource() { openSettings('source'); setReaderDrawer(false); }

/* ---------- 移动端：左侧频道抽屉 ---------- */
export let readerDrawerLocked = false;   // 抽屉当前是否拿着页面滚动锁

/** 打开/收起左侧频道抽屉。宽屏上没有视觉效果，切走阅读页或窗口变宽时自动收起 */
export function setReaderDrawer(open) {
  const on = !!open;
  if (on === document.body.classList.contains('reader-drawer-open')) return;
  document.body.classList.toggle('reader-drawer-open', on);
  // 抽屉铺满整屏，背景也得真的钉住：iOS 上只写 overflow:hidden 挡不住惯性滚动
  if (on) { lockPageScroll(); readerDrawerLocked = true; }
  else if (readerDrawerLocked) { readerDrawerLocked = false; unlockPageScroll(); }
}

/** 换了频道 / 范围 / 分组 = 换了一整个列表，把视线带回顶部，别停在新列表中间 */
export function scrollReaderTop() {
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// 抽屉开合按钮（菜单 / 关闭 / 遮罩）已随阅读页 React 化，改由 ReaderView 经桥触发
export function readerToggleDrawer() { setReaderDrawer(!document.body.classList.contains('reader-drawer-open')); }
export function readerCloseDrawer() { setReaderDrawer(false); }
window.addEventListener('resize', () => { if (window.innerWidth > 720) setReaderDrawer(false); });

/* 侧滑出手势已抽到 src/core/drawer.js（v1.3.10 起文章页与卡片页共用同一套）。 */

export let readerAutoBusy = false;

export function readerSentinelNear() {
  const el = document.getElementById('readerSentinel');
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.top < window.innerHeight + 500;
}

export async function readerAutoLoad() {
  if (readerAutoBusy) return;
  if (state.tab !== 'reader' || state.rdLoading || !state.rdHasMore || !state.rdEntries.length) return;
  readerAutoBusy = true;
  try {
    await loadReader();
  } finally {
    readerAutoBusy = false;
    if (state.rdHasMore && readerSentinelNear()) setTimeout(readerAutoLoad, 120);
  }
}

window.addEventListener('scroll', () => {
  if (state.tab !== 'reader') return;
  if (state.rdLoading || !state.rdHasMore || !state.rdEntries.length) return;
  if (readerSentinelNear()) readerAutoLoad();
});

/* 「全部标为已读」：条件与当前列表完全一致，标完刷新徽标（ReaderView 经桥 readerReadAll 调用） */
export async function readerReadAll() {
  // 破坏性操作（可能一口气把几百篇标成已读），先确认一次，与「删除订阅/用户」保持一致
  const label = state.rdScope === 'unread' ? '全部未读'
    : (state.rdScope === 'favorite' ? '全部收藏' : '当前列表');
  const ok = await confirm({
    title: `把「${label}」全部标为已读？`,
    desc: '此操作不可撤销。',
    confirmText: '全部标为已读',
  });
  if (!ok) return;
  try {
    const p = readerFilterParams();
    const feedsRaw = p.get('feeds');
    const res = await apiFetch('/api/entries/read-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // 没传 feeds = 不限频道；传空串 = 分组里没有频道，那就什么都不标
        feeds: p.has('feeds') ? (feedsRaw ? feedsRaw.split(',').map(Number) : []) : null,
        q: p.get('q') || '',
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    toast(d.updated ? `已标为已读 ${d.updated} 篇` : '这里没有未读文章');
    await loadFeeds();
    renderReader();
    loadReader({ reset: true });
  } catch (err) {
    toast('操作失败：' + (err.message || err), false);
  }
}

export function readerSearch(q) {
  q = String(q || '').trim();
  if (q === state.rdQ) return;
  state.rdQ = q;
  renderReader();
  loadReader({ reset: true });
}
