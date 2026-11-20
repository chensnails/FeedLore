/* 笺川核心逻辑 · 文章页：分组折叠 / 频道·范围·关注切换 / 移动端抽屉 / 批量已读 / 搜索。
 * 从 reader.ts 抽出：这些是「视图筛选与外壳交互」，不碰条目状态与滚动置顶，
 * 只通过 reader.flow.ts 的 loadReader / renderReader / readerFilterParams 驱动列表。
 * ============================================================ */

import { EVENT, emit } from '../kernel/events.ts';
import { groupFeeds, loadFeeds, loadPage } from './feeds.ts';
import { loadReader, readerFilterParams, renderReader } from './reader.flow.ts';
import {
  layoutPref,
  lockPageScroll,
  openSettings,
  setLayout,
  state,
  unlockPageScroll,
} from './state.ts';
import type { EntityId, ReaderScope, WatchFilter } from './types.ts';
import { apiFetch, confirm, emitShell, httpError, toast, writeHash } from './util.ts';

/* ---------- 频道栏分组折叠 ----------
 * 与设置面板的 collapsedGroups 各存一份（layout.rdCollapsedGroups）：数据源面板收起的是
 * 管理清单，频道栏收起的是阅读时的干扰项，两件事不该互相牵连。 */
export function rdCollapsedGroups(): Set<string> {
  const arr: unknown = Array.isArray(layoutPref.rdCollapsedGroups)
    ? layoutPref.rdCollapsedGroups
    : [];
  return new Set((arr as unknown[]).filter((g): g is string => typeof g === 'string'));
}

/* 收起的是同一份偏好，看它的却有两处 UI（文章页侧栏 + 卡片页频道筛选下拉），
   而两边的重绘信号各自独立 —— 改一次要两边都派发，否则另一边拿着旧集合渲染。 */
function renderGroupFold() {
  renderReader();
  emit(EVENT.CARDS);
}

export function readerToggleGroupCollapse(name: string) {
  const g = String(name || '');
  const set = rdCollapsedGroups();
  if (set.has(g)) set.delete(g);
  else set.add(g);
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

/** 展开某个分组（选中组内频道 / 组名时调用，避免「点了却看不见」）。
 *  卡片页的分组筛选也复用这一份，保证两页的折叠偏好不会一边展开一边收着。
 */
export function rdExpandGroup(name: string) {
  const g = String(name || '');
  const set = rdCollapsedGroups();
  if (!set.has(g)) return;
  set.delete(g);
  setLayout('rdCollapsedGroups', Array.from(set));
  // 调用方随后自己 renderReader()，这里只补卡片页那半边
  emit(EVENT.CARDS);
}

/* ---------- 频道 / 范围 / 分组切换（ReaderView 经桥调用） ---------- */
let watchPrevScope: ReaderScope | null = null; // 进入关注/屏蔽视图前的范围，退出时还原

export function readerSetScope(scope: ReaderScope) {
  // rdWatch 也算「已经偏离了默认范围」：在关注/屏蔽视图里整篇文章仍属于 rdScope='all'，
  // 少这一项会让点「全部文章」直接短路，看起来像按钮坏了。
  if (
    scope === state.rdScope &&
    state.rdFeedId == null &&
    state.rdGroup == null &&
    state.rdWatch == null &&
    state.rdTag == null &&
    state.rdAiTag == null
  )
    return;
  state.rdScope = scope;
  setLayout('rdScope', scope); // 默认范围按账号持久化
  state.rdFeedId = null;
  state.rdGroup = null;
  state.rdWatch = null;
  state.rdTag = null; // 换范围 = 换列表，不沿用标签筛选
  state.rdAiTag = null;
  watchPrevScope = null;
  renderReader();
  loadReader({ reset: true });
  emitShell();
  if (window.innerWidth <= 720) setReaderDrawer(false);
  scrollReaderTop();
}
export function readerSetGroup(g: string) {
  state.rdScope = 'all'; // 看某个分组 = 回到「全部」范围
  state.rdWatch = null;
  state.rdTag = null; // 换分组 = 换列表，不沿用标签筛选
  state.rdAiTag = null;
  watchPrevScope = null;
  if (g === state.rdGroup) state.rdGroup = null;
  else {
    state.rdGroup = g;
    state.rdFeedId = null;
    rdExpandGroup(g);
  }
  renderReader();
  loadReader({ reset: true });
  emitShell();
  if (window.innerWidth <= 720) setReaderDrawer(false);
  scrollReaderTop();
}
export function readerSetFeed(id: EntityId | null) {
  const next = id != null ? Number(id) : null;
  // 再次点击同一个频道 = 回到该频道最新信息（与卡片页一致）。
  // 此前这里对同频道直接 return，点第二下毫无反应 —— 与卡片页「再点一次回到最新」的行为不一致。
  // 现在改为：同频道再点 → 重新拉取该频道的最新列表 + 滚回顶部（重新加载 = 拿到最新信息）。
  const sameFeed = next === state.rdFeedId && state.rdGroup == null;
  state.rdScope = 'all';
  state.rdWatch = null;
  watchPrevScope = null;
  if (sameFeed) {
    reloadReaderFeed();
    return;
  }
  const f = next == null ? null : (state.feedList || []).find((x) => String(x.id) === String(next));
  state.rdFeedId = next;
  state.rdGroup = null;
  state.rdTag = null; // 换频道 = 换列表，不沿用标签筛选
  state.rdAiTag = null;
  if (f) rdExpandGroup(String(f.groupName || '').trim()); // 折叠着就选不到它，选了必须看得见
  renderReader();
  loadReader({ reset: true });
  emitShell();
  if (window.innerWidth <= 720) setReaderDrawer(false);
  scrollReaderTop();
}
/**
 * 关注 / 屏蔽虚拟视图（v21）：「再次点击同一行 = 退出该视图」，
 * 与分组漏斗的手感一致。视图是全局聚合，进入时清掉频道与分组选中。
 *
 * 进入时强制忽略未读 / 收藏范围：这两个范围是持久化的，用户上次停在「收藏」
 * 再点关注就会看到空列表（关注里的文章未必已收藏），像是功能坏了。
 * 原范围记在 watchPrevScope，退出时还原；不写回 layout，刷新仍按用户原选择。
 */
export function readerSetWatch(w: WatchFilter | string | null) {
  let v: WatchFilter | null = w === 'watch' || w === 'block' ? (w as WatchFilter) : null;
  if (v && v === state.rdWatch) v = null; // 再点一次退出
  if (!v && !state.rdWatch) return;
  if (v) {
    // 只在从常规视图首次进入时记录，watch ↔ block 互切不覆盖
    if (!state.rdWatch) watchPrevScope = state.rdScope !== 'all' ? state.rdScope : null;
    state.rdScope = 'all';
  } else {
    state.rdScope = watchPrevScope || 'all';
    watchPrevScope = null;
  }
  state.rdWatch = v;
  state.rdFeedId = null;
  state.rdGroup = null;
  state.rdTag = null; // 换关注/屏蔽视图 = 换列表，不沿用标签筛选
  state.rdAiTag = null;
  renderReader();
  loadReader({ reset: true });
  emitShell();
  if (window.innerWidth <= 720) setReaderDrawer(false);
  scrollReaderTop();
}

/**
 * 「再次点击同一频道」：重新拉取该频道的最新条目并把视线带回顶部。
 *
 * 为什么不直接复用上面的切换分支：切换分支会把分组筛选清掉（state.rdGroup = null），
 * 而「再点一次」应该是「原地刷新当前视图」—— 用户想看的是这个频道最新的内容，
 * 不是换筛选条件。所以这里保持 rdFeedId / rdGroup 不变，只做「重置 + 重拉 + 回顶」。
 *
 * 边界：
 *  - 正在加载时再点：loadReader 内部有 state.rdLoading 闸门，重复请求会被挡掉，
 *    但我们仍要把列表重置到「加载中」态 —— 否则用户点完看到的是旧列表，毫无反馈。
 *  - 搜索词 / 收藏 / 未读范围：都在 readerFilterParams 里，刷新时原样带上，不清空。
 */
function reloadReaderFeed() {
  renderReader();
  loadReader({ reset: true });
  emitShell();
  if (window.innerWidth <= 720) setReaderDrawer(false);
  scrollReaderTop();
}

export function readerOpenSource() {
  openSettings('source');
  setReaderDrawer(false);
}

/* ---------- 移动端：左侧频道抽屉 ---------- */
export let readerDrawerLocked = false; // 抽屉当前是否拿着页面滚动锁

/** 打开/收起左侧频道抽屉。宽屏上没有视觉效果，切走阅读页或窗口变宽时自动收起 */
export function setReaderDrawer(open: boolean) {
  const on = !!open;
  if (on === document.body.classList.contains('reader-drawer-open')) return;
  document.body.classList.toggle('reader-drawer-open', on);
  // 抽屉铺满整屏，背景也得真的钉住：iOS 上只写 overflow:hidden 挡不住惯性滚动
  if (on) {
    lockPageScroll();
    readerDrawerLocked = true;
    // 焦点跟着抽屉走：键盘用户打开后仍停在背景按钮上，Tab 会先走完屏外内容
    const close = document.getElementById('readerSideClose');
    if (close && close.focus) close.focus();
  } else {
    if (readerDrawerLocked) {
      readerDrawerLocked = false;
      unlockPageScroll();
    }
    // 焦点还在抽屉里（点关闭 / Esc）时还给开关；已经点去别处就不抢
    const side = document.getElementById('readerSide');
    if (side && side.contains(document.activeElement)) {
      const opener = document.getElementById('readerMenuBtn');
      if (opener && opener.focus) opener.focus();
    }
  }
}

/** 换了频道 / 范围 / 分组 = 换了一整个列表，把视线带回顶部，别停在新列表中间。
 *  App Shell 后阅读列表的滚动容器是 .reader-main，window 根本不动 ——
 *  所以先滚真正的容器，窗口本身（窄屏抽屉态等没有独立容器的场合）兜底。 */
export function scrollReaderTop() {
  const main = document.querySelector('#readerView .reader-main');
  if (main) main.scrollTo({ top: 0, behavior: 'auto' });
  window.scrollTo({ top: 0, behavior: 'auto' });
  // 换了列表 = 原来那篇已不在列表里，地址栏不该还指着一篇
  writeHash('#reader');
}

// 抽屉开合按钮（菜单 / 关闭 / 遮罩）已随阅读页 React 化，改由 ReaderView 经桥触发
export function readerToggleDrawer() {
  setReaderDrawer(!document.body.classList.contains('reader-drawer-open'));
}
export function readerCloseDrawer() {
  setReaderDrawer(false);
}
let resizeDrawerTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener('resize', () => {
  if (resizeDrawerTimer) clearTimeout(resizeDrawerTimer);
  // 防抖：连续 resize 事件只落地一次，避免每次都触发收抽屉的 class 切换与重排
  resizeDrawerTimer = setTimeout(() => {
    if (window.innerWidth > 720) setReaderDrawer(false);
  }, 150);
});

/* 侧滑出手势已抽到 src/core/drawer.js（文章页与卡片页共用同一套）。 */

/* 「全部标为已读」的筛选条件 → 请求体。
 * 列表条件与 read-all / 撤销三处必须完全一致，否则「屏幕上看到的」和「被操作 / 被回滚的」不是同一批。
 * v2.5.0：补上 fav —— 收藏视图里点全部已读，以前会把范围内所有未读都标掉。 */
function readAllScopeBody() {
  const p = readerFilterParams();
  const feedsRaw = p.get('feeds');
  const watch = state.rdWatch === 'watch' || state.rdWatch === 'block' ? state.rdWatch : null;
  return {
    ...(p.has('feeds') ? { feeds: feedsRaw ? feedsRaw.split(',').map(Number) : [] } : {}),
    ...(p.get('q') ? { q: p.get('q') } : {}),
    ...(watch ? { watch } : {}),
    ...(p.get('fav') ? { fav: '1' } : {}),
  };
}

/** 撤销一次批量已读：服务端按批次时间戳回滚，前端把列表重新取一遍对齐。 */
async function undoReadAll(scope: Record<string, unknown>, at: unknown) {
  try {
    const res = await apiFetch('/api/entries/read-all/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...scope, at }),
    });
    if (!res.ok) throw await httpError(res);
    const d = await res.json();
    toast(d.reverted ? `已恢复 ${d.reverted} 篇未读` : '没有可撤销的标记');
    await loadFeeds();
    renderReader();
    loadReader({ reset: true });
    if ((state.entries || []).length) loadPage(true);
  } catch (err) {
    toast('撤销失败：' + (err.message || err), false);
  }
}

/* 「全部标为已读」：条件与当前列表完全一致，标完刷新徽标（ReaderView 经桥 readerReadAll 调用） */
export async function readerReadAll() {
  // 破坏性操作（可能一口气把几百篇标成已读），先确认一次，与「删除订阅/用户」保持一致
  const watch = state.rdWatch === 'watch' || state.rdWatch === 'block' ? state.rdWatch : null;
  const label =
    state.rdScope === 'unread'
      ? '全部未读'
      : state.rdScope === 'favorite'
        ? '全部收藏'
        : watch === 'watch'
          ? '关注列表'
          : watch === 'block'
            ? '屏蔽列表'
            : '当前列表';

  // 受影响篇数：按当前筛选的频道聚合未读数（favorite 范围无法精确估算，退化为不显示数字）
  let affected = 0;
  let unknown = false;
  if (state.rdScope === 'favorite') {
    unknown = true;
  } else if (watch) {
    // 关注 / 屏蔽视图的命中集只有服务端知道，篇数在确认框里给不出准数 —— 走通用文案
    unknown = true;
  } else {
    const fp = readerFilterParams().get('feeds');
    const ids = fp ? fp.split(',').map(Number) : null;
    affected = (state.feedList || []).reduce(
      /** @param {*} [s] @param {*} [f] */ (s, f) => {
        const id = Number(f.id);
        if (ids && ids.length && ids.indexOf(id) < 0) return s;
        return s + (Number(f.unreadCount) || 0);
      },
      0,
    );
  }
  // 可撤销：服务端按批次时间戳回滚，标完的提示条里给一个「撤销」入口
  const desc =
    affected > 0
      ? `将标记 ${affected} 篇未读文章为已读，标完可在提示条里撤销。`
      : unknown
        ? '将把当前列表中的未读文章标为已读，标完可在提示条里撤销。'
        : '当前范围内没有未读文章。';

  const ok = await confirm({
    title: `把「${label}」全部标为已读？`,
    desc,
    confirmText: '全部标为已读',
  });
  if (!ok) return;
  try {
    /* v2 契约按「字段缺省 = 不限」解析（zod 的 optional 不接受 null / ''）：
       没传 feeds = 不限频道；传空数组 = 分组里没有频道，那就什么都不标。
       watch / fav 同理，只有生效时才带。 */
    const scope = readAllScopeBody();
    const res = await apiFetch('/api/entries/read-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scope),
    });
    if (!res.ok) throw await httpError(res);
    const d = await res.json();
    const undoAt = d && d.undo && d.undo.at;
    toast(
      d.updated ? `已标为已读 ${d.updated} 篇` : '这里没有未读文章',
      true,
      undoAt && d.updated
        ? { action: () => undoReadAll(scope, undoAt), actionText: '撤销', ms: 6000 }
        : undefined,
    );
    await loadFeeds();
    renderReader();
    loadReader({ reset: true });
    // 批量操作无法逐条同步到卡片列表：已拉过的卡片重新取一遍，圆点与计数才对得上
    if ((state.entries || []).length) loadPage(true);
  } catch (err) {
    toast('操作失败：' + (err.message || err), false);
  }
}

export function readerSearch(q: string) {
  q = String(q || '').trim();
  if (q === state.rdQ && state.rdTag == null && state.rdAiTag == null) return;
  state.rdQ = q;
  state.rdTag = null; // 搜索与标签互斥（与卡片页 cardsSearch 一致）
  state.rdAiTag = null;
  renderReader();
  loadReader({ reset: true });
}

/**
 * 阅读页就地按标签筛选（手动 tag / AI 标签 aiTag 互斥）。
 *
 * 与卡片页的关键差异：文章页看的是「全部内容」，点标签就留在本页重拉，
 * 不再跳到卡片页 —— 卡片页受 cardEnabled 开关限制，会漏掉未开卡片频道的文章。
 * 因此点标签（两类都一样）等于「在全库找这个标签」：频道 / 分组 / 关注视图 /
 * 未读·收藏范围全部让位，列表标题也回到「#标签」本身。再点同一个标签 = 取消筛选，
 * 与频道/分组「再点回顶」同一手感；取消时不再动范围，用户接着看原来的视图。
 */
export function readerSetTag(tag: string, ai = false) {
  const t = tag || null;
  const field = ai ? 'rdAiTag' : 'rdTag';
  const other = ai ? 'rdTag' : 'rdAiTag';
  const same = state[field] === t && state[other] == null;
  const next = same ? null : t;
  state.rdTag = ai ? null : next;
  state.rdAiTag = ai ? next : null;
  if (next) {
    state.rdScope = 'all';
    state.rdFeedId = null;
    state.rdGroup = null;
    state.rdWatch = null;
    watchPrevScope = null;
  }
  renderReader();
  loadReader({ reset: true });
  emitShell();
  scrollReaderTop();
  toast(next ? `已按${ai ? 'AI ' : ''}标签筛选：#${next}` : '已清除标签筛选');
}
