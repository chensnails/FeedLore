/* 笺川核心逻辑 · 文章页：置顶目标 / 手风琴 / 篇内阅读位置 / 深链恢复 / 展开收起 / 条目状态。
 * 从 reader.ts 抽出：这些都是「围绕某一篇文章」的状态与交互，共用同一份置顶目标，
 * 与加载 / 滚动定位（reader.flow.ts）通过少量 import 组合。
 * ============================================================ */

import { EVENT, emit } from '../kernel/events.ts';
import {
  findArtItemEl,
  loadReader,
  PIN_SCROLL_KEYS,
  readerPendingReset,
  readerScroller,
  renderReader,
  scrollReaderToArt,
} from './reader.flow.ts';
import { layoutPref, setLayout, state } from './state.ts';
import type { Card, EntityId, EntryFlagPatch } from './types.ts';
import { apiFetch, httpError, toast, writeHash } from './util.ts';

/* 当前「置顶目标」：由展开 / 收起 / 深链恢复写入；加载与滚动定位（reader.flow.ts）
 * 只在时间窗内读它做重校，用户一动手就由 clearReaderPin 作废。 */
export let readerPinnedId: EntityId | null = null;
export let readerPinnedAt = 0;

export function clearReaderPin() {
  readerPinnedId = null;
  readerPinnedAt = 0;
}

/* ---------- 手风琴模式 ---------- */
export let accordionOn = layoutPref.accordion;
export function readerAccordionOn() {
  return accordionOn;
}
export function readerToggleAccordion() {
  accordionOn = !accordionOn;
  setLayout('accordion', accordionOn); // 按账号持久化
  renderReader();
  toast(accordionOn ? '已开启单篇展开' : '已改为可同时展开多篇');
}

/* ---------- 篇内阅读位置（刷新 / 深链回到同一篇时恢复） ----------
 * 地址栏 hash 只记到文章 id，刷新后 restoreReaderArt 一律从标题开始 ——
 * 长文读一半刷新（手机上更常见：PWA 被系统回收后重开）就得重新找。
 * 这里按文章记「标题行已滚出视口多少」，放 sessionStorage：
 *   · 只在同一标签页生命周期内有效，换标签 / 新会话不假装记得；
 *   · 只给 hash 恢复用；从列表点一篇仍然置顶，不改变既有入口策略；
 *   · 偏移按文章高度 clamp，正文和图片异步撑开也不会滚到文章外。 */
const READ_POS_KEY = 'feedlore.readPos.v1';
const READ_POS_MAX = 60; // 最多记 60 篇，够覆盖一次连续阅读，又不让本地存储无限长
const READ_POS_MIN = 24; // 还在标题附近不值得恢复（否则等于把「置顶」又挪了一下）
let readPosCache: Record<string, unknown> | null = null;

function readPosMap(): Record<string, unknown> {
  if (readPosCache) return readPosCache;
  try {
    const raw = sessionStorage.getItem(READ_POS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    readPosCache = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (_) {
    readPosCache = {};
  }
  return readPosCache ?? {};
}

function persistReadPos() {
  try {
    sessionStorage.setItem(READ_POS_KEY, JSON.stringify(readPosMap()));
  } catch (_) {
    /* 隐私模式 / 配额满：忽略 */
  }
}

function readSavedOffset(id: EntityId) {
  const v = readPosMap()[String(id)];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function saveReadPos(id: EntityId, offset: number) {
  const map = readPosMap();
  map[String(id)] = Math.round(offset);
  const keys = Object.keys(map);
  if (keys.length > READ_POS_MAX) {
    for (const k of keys.slice(0, keys.length - READ_POS_MAX)) delete map[k];
  }
  persistReadPos();
}

function dropReadPos(id: EntityId) {
  const map = readPosMap();
  if (!(String(id) in map)) return;
  delete map[String(id)];
  persistReadPos();
}

/** 滚动时记下「当前顶到视口上沿的那一篇」读到了哪里。
 *  取顶边已越过容器上沿的最后一篇：手风琴下就是正在读的那篇；多篇展开时
 *  也仍然对应用户视线所在的位置。只记真正读到正文里的偏移（≥ READ_POS_MIN）。 */
function rememberReadingPos() {
  if (state.tab !== 'reader' || readerPinnedId != null) return; // 置顶/恢复自己写的 scrollTop 不算阅读位置
  const main = readerScroller();
  if (!main) return;
  const mainTop = main.getBoundingClientRect().top;
  const items = document.querySelectorAll<HTMLElement>('#readerList .art-item');
  let pick: HTMLElement | null = null;
  for (const el of items) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= mainTop) continue;
    if (r.top > mainTop + 2) break; // 第一篇标题还在下方：视口里还没有任何一篇的正文
    pick = el;
  }
  if (!pick) return;
  const id = pick.dataset.id;
  if (!id) return;
  const offset = Math.round(mainTop - pick.getBoundingClientRect().top);
  if (offset >= READ_POS_MIN) saveReadPos(id, offset);
  else dropReadPos(id); // 回到标题附近 = 从头读，别在下次刷新时把人拽回中间
}
let readPosTimer: ReturnType<typeof setTimeout> | null = null;
document.addEventListener(
  'scroll',
  /** @param {*} [ev] */ (ev) => {
    const main = readerScroller();
    if (!main || ev.target !== main || readPosTimer) return;
    readPosTimer = setTimeout(() => {
      readPosTimer = null;
      rememberReadingPos();
    }, 250);
  },
  { capture: true, passive: true },
);

/** 恢复篇内位置：只动 .reader-main，按实际布局逐次逼近。
 *  正文/图片是异步到达的，单次测量可能偏 —— 初始两帧对齐，之后每次图片
 *  加载完再对齐一次（3 秒内）；用户一动手就彻底停手。
 */
function restoreReaderOffset(id: EntityId, offset: number) {
  const main = readerScroller();
  if (!main) return;
  const want = String(id);
  let cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const cleanup = () => {
    cancelled = true;
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
    document.removeEventListener('wheel', onUser, true);
    document.removeEventListener('touchmove', onUser, true);
    document.removeEventListener('keydown', onUser, true);
    document.removeEventListener('pointerdown', onUser, true);
  };
  const onUser = (ev: Event) => {
    if (ev.type === 'keydown') {
      if (!(ev instanceof KeyboardEvent) || !PIN_SCROLL_KEYS.has(ev.key)) return;
    }
    cleanup();
  };

  const place = () => {
    if (cancelled || state.tab !== 'reader') return;
    const el = findArtItemEl(want);
    if (!el) return;
    const mr = main.getBoundingClientRect();
    const itemTop = main.scrollTop + (el.getBoundingClientRect().top - mr.top);
    // 最多滚到「文章底部还留六成屏」的位置，短文不会被顶出视口
    const limit = Math.max(0, itemTop + el.offsetHeight - Math.round(main.clientHeight * 0.6));
    const max = Math.max(0, main.scrollHeight - main.clientHeight);
    const target = Math.max(0, Math.min(itemTop + offset, limit, max));
    if (Math.abs(main.scrollTop - target) > 1) main.scrollTop = target;
  };

  document.addEventListener('wheel', onUser, { capture: true, passive: true });
  document.addEventListener('touchmove', onUser, { capture: true, passive: true });
  document.addEventListener('keydown', onUser, true);
  document.addEventListener('pointerdown', onUser, true);

  place();
  requestAnimationFrame(() => {
    if (!cancelled) place();
  });
  /* 展开是 React 异步提交：首帧量到的可能还是收起行（行高小 → clamp 把人停在
   * 文章上方）。后台标签页 / PWA 被系统恢复时 rAF 根本不跑，只靠上面那一帧会
   * 一直停在错误位置 —— 再用定时器逼近几次，3 秒内收敛，期间用户一动手即停。 */
  for (const delay of [60, 200, 600, 1200, 2400]) {
    timers.push(
      setTimeout(() => {
        if (!cancelled) place();
      }, delay),
    );
  }
  const el = findArtItemEl(want);
  if (el)
    for (const img of el.querySelectorAll('img'))
      img.addEventListener('load', () => {
        if (!cancelled) place();
      });
  timers.push(setTimeout(cleanup, 3000));
}

/* ---------- 窄屏阅读头部收展（实现在 reader.flow.ts） ---------- */

export async function expandReaderArt(id: EntityId) {
  /* 手风琴（默认开启）：展开这一条之前会把其它展开的收掉。
   * 滚动策略（修正「切换文章后新文章不从顶部开始」的老问题）：
   * 进入一篇文章 = 它的标题行对齐滚动容器顶部（sticky 工具条下方）——
   * 读完当前篇、切到另一篇，就从新文章的开头接着读。
   * 旧实现是「点哪停哪」的锚点补偿：展开后把目标补滚回点击时的位置。
   * 那条策略与「进入即置顶」互斥 —— 点了列表中段的一篇，视口停在那儿，
   * 新文章的开头反而落在视口下半屏，读起来像「跳进文章中间」。
   * 现在统一为：进入即置顶（收起其它篇造成的位移由这次主动滚动一并抵消），
   * 点上方一篇与点下方一篇走同一条路径，行为一致。 */
  if (accordionOn) {
    for (const openId of Array.from(state.rdExpanded)) {
      if (String(openId) !== String(id)) state.rdExpanded.delete(openId);
    }
  }

  state.rdExpanded.add(id);
  renderReader();
  markEntryRead(id); // 展开了就算读过了
  writeHash('#reader/art/' + id); // 地址栏留当前篇（刷新/回来据此恢复）

  // 置顶：等 DOM 提交后按实际布局把这一篇顶到内容区顶部（详见 scrollReaderToArt）
  readerPinnedId = id;
  readerPinnedAt = Date.now();
  scrollReaderToArt(id);

  if (state.rdBody.has(id) || state.rdBodyErr.has(id)) return;
  await fetchReaderBody(id);
  renderReader();
  // 正文是异步到达的，插入后列表布局会变 —— 再对准一次，避免停在偏移处。
  // 只在真正改变布局的这里做（而不是挂进 renderReader 全局）。
  scrollReaderToArt(id);
}

async function fetchReaderBody(id: EntityId) {
  try {
    const res = await apiFetch('/api/entries/' + encodeURIComponent(id));
    if (!res.ok) throw await httpError(res);
    state.rdBody.set(id, await res.json());
    state.rdBodyErr.delete(id);
  } catch (_) {
    state.rdBodyErr.add(id);
  }
}

/** 正文加载失败的「重试」：清掉错误标记再拉一次；成功后会解除展开体里的错误提示 */
export async function readerRetryBody(id: EntityId) {
  if (!state.rdBodyErr.has(id)) return;
  state.rdBodyErr.delete(id);
  renderReader();
  await fetchReaderBody(id);
  renderReader();
  scrollReaderToArt(id);
}

/** 翻页失败后的「重试」：错误标记就是自动加载的刹车，重试前先松开 */
export function readerRetryMore() {
  state.rdLoadMoreErr = false;
  return loadReader();
}

/** 空态 / 错误态上的「再试一次」：整个列表重置重拉 */
export function readerReload() {
  return loadReader({ reset: true });
}

export function collapseReaderArt(id: EntityId) {
  state.rdExpanded.delete(id);
  // 收起后不再有「置顶目标」：否则列表变动时的重校会一直把这一条往回顶
  if (String(readerPinnedId) === String(id)) clearReaderPin();
  renderReader();
  writeHash('#reader'); // 收起后地址栏回到「文章」页，不再指着一篇
  dropReadPos(id); // 收起了就是没在读，别在下次刷新时恢复这一篇的中间位置
  /* 正文一塌陷视口常停在空白处：把标题行钉回吸顶条下方。
   * 走和展开同一条收敛路径（只动 .reader-main），不用原生 scrollIntoView
   * （那会连带滚所有祖先容器，且在旧布局里测量）。
   * 顺手立一个置顶标记：不是为了让翻页重校，而是让用户一动手就打断这 12 帧修正。 */
  readerPinnedId = id;
  readerPinnedAt = Date.now();
  scrollReaderToArt(id);
}

export function readerToggleArt(id: EntityId) {
  if (state.rdExpanded.has(id)) collapseReaderArt(id);
  else expandReaderArt(id);
}

export function readerCollapseAll() {
  for (const id of state.rdExpanded) dropReadPos(id);
  state.rdExpanded.clear();
  clearReaderPin(); // 全部收起 → 没有置顶目标
  renderReader();
  toast('已全部收起');
}

const FLASH_MS = 1500; // 高亮停留时长（与 style.css 的 artFlash 对齐）
const FOCUS_MAX_PAGES = 8; // 为目标文章最多往后翻几页：再远就不该假装找得到

/** 把某篇文章「指给用户看」：滚到它并让文章框闪一下（卡片页 → 文章页的落点指示）。
 *  列表是分页的，目标可能不在首屏 —— 往后翻若干页找，翻不到就明说，不静默。
 *  高亮走 state.rdFlashId 而不是直接给 DOM 加类：阅读页整棵列表由 React 渲染，
 *  任何一次重绘都会按自己算出的 className 覆盖掉手写上去的类。
 */
export async function focusReaderArt(id: EntityId) {
  const want = String(id);
  // 目标文章可能正赶上一次在途加载（switchView 的自动加载 / jumpToFeed 排队的重置）。
  // 此刻列表还是旧的甚至空的，直接找会误判「找不到」。加载是串行的（rdLoading 一次性封锁），
  // 轮询到它落地再找即可；最多等约 5s，避免极端情况下死等。
  for (let guard = 0; state.rdLoading && guard < 200; guard++) {
    await new Promise(/** @param {*} [r] */ (r) => setTimeout(r, 25));
  }
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
  /* 卡片页「在文章页查看」= 一次到位：直接展开并置顶。
   * expandReaderArt 负责收起其它篇、标已读、写 hash、置顶（直写 scrollTop）；
   * 旧实现只把一条**收起**的行滚到视口中间，用户还得再点一次才看到文章，
   * 而且用的是原生 scrollIntoView —— 会连带滚所有祖先容器。 */
  await expandReaderArt(want);
  /* 展开可能被随后落地的重置重载清掉（列表整体换一遍，rdExpanded 一起清空）。
     用户点「在文章页查看」要的结果是「看到这篇的正文」，所以等加载彻底安静后确认一次：
     目标还在列表里就补展开；换成别的频道（目标已不在）则说明是用户的新意图，不抢。
     这道确认是给入口竞态兜底，不替代 jumpToFeed 里「只发一次首屏请求」的修正。 */
  for (let guard = 0; guard < 200 && (state.rdLoading || readerPendingReset); guard++) {
    await new Promise(/** @param {*} [r] */ (r) => setTimeout(r, 25));
  }
  if (
    !state.rdExpanded.has(want) &&
    state.rdEntries.some(/** @param {*} [e] */ (e) => String(e.id) === want)
  ) {
    await expandReaderArt(want);
  }
  setTimeout(() => {
    if (state.rdFlashId !== want) return; // 期间又跳了别处，交给那一次去收
    state.rdFlashId = null;
    renderReader();
  }, FLASH_MS);
  return true;
}

/** 已读 / 未读 / 收藏 */

/** 从地址栏 hash 恢复某一篇（刷新 / 从别处回来的深链）：
 *  等列表落地、必要时往后翻页找到它，然后展开并**置顶**——
 *  与「点下一篇进入一篇文章」的滚动策略一致：谁进来都从文章开头看起。
 */
export async function restoreReaderArt(id: EntityId) {
  const want = String(id);
  for (let guard = 0; state.rdLoading && guard < 200; guard++) {
    await new Promise(/** @param {*} [r] */ (r) => setTimeout(r, 25));
  }
  let el = findArtItemEl(want);
  for (let i = 0; !el && i < FOCUS_MAX_PAGES && state.rdHasMore; i++) {
    await loadReader();
    el = findArtItemEl(want);
  }
  if (!el) return false;
  const saved = readSavedOffset(want);
  await expandReaderArt(want);
  /* 同一篇刷新/重开：回到上次读到的位置（正文已落地、布局稳定后再对）。
   * 换了一篇时 saveReadPos 里根本没有它的记录，仍然走「进入即置顶」。 */
  if (saved != null && saved >= READ_POS_MIN) {
    // 先放开置顶：否则展开时那条收敛循环还在往回写 scrollTop，恢复会被拖回标题
    clearReaderPin();
    restoreReaderOffset(want, saved);
  }
  return true;
}
/** 就地换掉一条条目（不改原对象）：列表项是 React.memo 的，
 *  引用不变就不会重绘，所以状态变化必须产出新对象。返回替换后的那条。 */
function replaceEntry(list: Card[], idx: number, patch: EntryFlagPatch): Card[] {
  const next: Card = { ...list[idx]!, ...patch };
  const arr = list.slice();
  arr[idx] = next;
  return arr;
}

/** 改某条目已读态后，同步所属频道在 feedList 里的未读计数（侧栏频道 / 分组据此渲染）。
 *  不在此处 reloadFeeds（避免一次标已读就打一次 /api/feeds），而是就地算准；
 *  下次切换频道 / 拉取订阅源 / 自动刷新时再从服务端校正。
 */
function bumpFeedUnread(feedId: EntityId, delta: number) {
  if (feedId == null) return;
  const list = state.feedList;
  if (!Array.isArray(list)) return;
  const id = String(feedId);
  const idx = list.findIndex((f) => String(f.id) === id);
  if (idx < 0) return;
  const f = list[idx]!;
  const next = Math.max(0, (Number(f.unreadCount) || 0) + delta);
  if (next === Number(f.unreadCount)) return;
  // 换新对象：与 replaceEntry 同口径，保证引用变化、侧栏重算时拿到的就是最新值
  const arr = list.slice();
  arr[idx] = Object.assign({}, f, { unreadCount: next });
  state.feedList = arr;
}

/** 文章页与卡片页各持一份条目列表（state.rdEntries / state.entries），同一行在两边
 *  是两个不同对象。状态变化要两边一起换新对象，任一视图切回来时读到的才是同一状态。 */
function findEntry(id: EntityId): Card | null {
  const key = String(id);
  return (
    state.rdEntries.find((x) => String(x.id) === key) ||
    state.entries.find((x) => String(x.id) === key) ||
    null
  );
}

/** 就地改一条的状态：内存（两页列表）+ 侧栏计数 + 重绘（原 paintEntryFlag 的就地 DOM 改类名移除） */
export function applyEntryFlag(id: EntityId, patch: EntryFlagPatch) {
  const key = String(id);
  const rdIdx = state.rdEntries.findIndex((x) => String(x.id) === key);
  const cardIdx = state.entries.findIndex((x) => String(x.id) === key);
  if (rdIdx < 0 && cardIdx < 0) return;
  const e = (rdIdx >= 0 ? state.rdEntries[rdIdx] : state.entries[cardIdx])!;
  const wasRead = !!e.isRead;
  const wasFav = !!e.isFavorite;
  const next: EntryFlagPatch = {};
  if (patch.isRead !== undefined) next.isRead = !!patch.isRead;
  if (patch.isFavorite !== undefined) next.isFavorite = !!patch.isFavorite;
  if (rdIdx >= 0) state.rdEntries = replaceEntry(state.rdEntries, rdIdx, next);
  if (cardIdx >= 0) state.entries = replaceEntry(state.entries, cardIdx, next);
  const now = Object.assign({}, e, next);
  const inReader = rdIdx >= 0;
  const inCards = cardIdx >= 0;

  if (wasRead !== now.isRead) {
    state.rdFlags.unread = Math.max(0, (state.rdFlags.unread || 0) + (now.isRead ? -1 : 1));
    // 同步所属频道的未读计数：两页侧栏的频道徽标与分组计数都从 feedList 实时重算，
    // 否则把一组文章全点完已读，分组 / 频道栏的未读数还停在旧值（本页不重新拉订阅源）。
    bumpFeedUnread(now.feedId, now.isRead ? -1 : 1);
  }
  if (wasFav !== now.isFavorite) {
    state.rdFlags.favorite = Math.max(0, (state.rdFlags.favorite || 0) + (now.isFavorite ? 1 : -1));
  }

  if (inReader) renderReader();
  // 卡片列表只在可见时重绘：隐藏时重排整墙卡片没有意义，切回卡片页时 switchView 会再刷一次
  if (inCards && state.tab === 'cards') emit(EVENT.CARDS);

  // 在「收藏」范围里取消收藏 = 明确的「移出这里」，立刻从列表拿掉。
  if (inReader && state.rdScope === 'favorite' && !now.isFavorite) {
    state.rdEntries = state.rdEntries.filter((x) => String(x.id) !== String(id));
    state.rdOffset = Math.max(0, state.rdOffset - 1);
    renderReader();
  }
}

/** 打标记：先乐观更新界面，再发请求；失败回滚并提示 */
export async function setEntryFlag(id: EntityId, patch: EntryFlagPatch) {
  const e = findEntry(id);
  const before = e ? { isRead: !!e.isRead, isFavorite: !!e.isFavorite } : null;
  if (e) applyEntryFlag(id, patch);
  try {
    const res = await apiFetch('/api/entries/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw await httpError(res);
    const d = await res.json();
    if (e) applyEntryFlag(id, { isRead: d.isRead, isFavorite: d.isFavorite });
    return true;
  } catch (err) {
    if (e && before) applyEntryFlag(id, before);
    toast('标记失败：' + (err.message || err), false);
    return false;
  }
}

/** 点开正文 / 打开卡片详情即视为已读（只在还没读过时发请求）。
 *  两页共用：不论条目此刻在哪个列表里，状态都同步到两边。 */
export function markEntryRead(id: EntityId) {
  const e = findEntry(id);
  if (!e || e.isRead) return;
  setEntryFlag(id, { isRead: true });
}

/** 收藏 / 取消收藏（原 toggleFavorite(el) → 改按 id） */
export function readerToggleFav(id: EntityId) {
  const e = state.rdEntries.find((x) => String(x.id) === String(id));
  const next = !(e && e.isFavorite);
  setEntryFlag(id, { isFavorite: next }).then(
    /** @param {*} [ok] */ (ok) => {
      if (ok) toast(next ? '已收藏' : '已取消收藏');
    },
  );
}

/** 已读回退成未读：展开即已读之后，误点 / 想稍后再读的常见补救 */
export function readerMarkUnread(id: EntityId) {
  const e = state.rdEntries.find((x) => String(x.id) === String(id));
  if (!e || !e.isRead) return;
  setEntryFlag(id, { isRead: false }).then(
    /** @param {*} [ok] */ (ok) => {
      if (ok) toast('已标为未读');
    },
  );
}
