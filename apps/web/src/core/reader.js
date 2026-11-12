/* 笺川核心逻辑 · 文章（阅读页）数据源与交互：加载 / 展开正文 / 已读收藏 / 抽屉 / 无限滚动 / 搜索
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { apiFetch, httpError, toast, emitShell, confirm, writeHash, NET_TIMEOUT_MS } from './util.js';
import { state, layoutPref, setLayout, openSettings, lockPageScroll, unlockPageScroll } from './state.js';
import { loadFeeds, groupFeeds, loadPage } from './feeds.js';
import { emit, EVENT, on } from '../kernel/events.js';

/* ============================================================
 * 阅读页（文章）：左频道 / 右文章，点标题展开全文
 * ============================================================ */

/* ============================================================
 * 阅读页（文章）：逻辑归 app.js，渲染归 React（src/views/ReaderView.jsx）
 * v1.9.0 起阅读页 React 化：频道侧栏 / 头部工具 / 搜索 / 条目与正文渲染全部移除，
 * 这里只保留数据 / 加载 / 交互逻辑，需要刷新 UI 时派发 __readerTick（组件监听后读实时 state 重绘）。
 * ============================================================ */

/** 当前「置顶目标」：文章列表内容变化后（翻页追加、正文异步到达）要重新对准它。
 *  列表一变动，之前算好的位置就失效了——翻页时列表总高会剧烈变化
 *  （实测 scrollHeight 21411 → 14797），不重校就会停在偏移处。
 *
 *  ⚠️ 只覆盖「我们自己的布局动作」那几百毫秒，不是长期状态。
 *  早先它一直生效到收起为止：用户展开一篇、往下滚到列表深处，一次自动翻页
 *  （loadReader 后按它重校）就把视口拽回那篇的标题，看起来是页面自己在快速滚动。
 *  现在：时间窗（PIN_WINDOW_MS）+ 用户滚动意图立即作废 + 切走视图清空。 */
let readerPinnedId = null;
let readerPinnedAt = 0;

const PIN_WINDOW_MS = 800;

/* 窄屏吸顶头部收展（实现见 installReaderHeadTuck）。
 * 类名与复位钩子放在置顶逻辑旁边：scrollReaderToArt 量落点之前必须先展开头部，
 * 否则 head-tucked 的 translateY(-100%) 会让吸顶条底边量成 0，文章标题埋进头部。 */
const HEAD_TUCK_CLASS = 'head-tucked';
let readerHeadReveal = () => {};

export function clearReaderPin() {
  readerPinnedId = null;
  readerPinnedAt = 0;
}

/** 只有刚发生的布局动作才值得重校；过期后列表再变一律不动滚动。 */
function pinAlive() {
  return readerPinnedId != null && Date.now() - readerPinnedAt < PIN_WINDOW_MS;
}

/* 用户接管滚动：置顶立刻作废。
 * wheel / touchmove 覆盖滚轮与手指，键盘只认真正会滚动的键，pointerdown 兜住
 * 拖滚动条（它既不发 wheel 也不发 touchmove）。这些事件只由用户输入产生，
 * 置顶循环自己写 scrollTop 不会触发，所以不会误伤正在进行的对齐。 */
const PIN_SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar']);
function onPinUserIntent(ev) {
  if (readerPinnedId == null || state.tab !== 'reader') return;
  if (ev.type === 'keydown' && !PIN_SCROLL_KEYS.has(ev.key)) return;
  clearReaderPin();
}
document.addEventListener('wheel', onPinUserIntent, { capture: true, passive: true });
document.addEventListener('touchmove', onPinUserIntent, { capture: true, passive: true });
document.addEventListener('keydown', onPinUserIntent, true);
document.addEventListener('pointerdown', (ev) => {
  if (readerPinnedId == null) return;
  const main = readerScroller();
  if (main && (ev.target === main || main.contains(ev.target))) clearReaderPin();
}, true);

/** 通知 ReaderView 重绘。
 *  ⚠️ 这里不要挂任何滚动副作用：renderReader() 在近 20 处被调用（含与置顶无关的
 *  重绘），往里塞 rAF 会在每次重绘都排一次滚动修正，既拖慢又容易踩到时序。
 *  置顶的重新对准只在真正改变布局的两处做：正文异步到达、翻页追加（见下）。 */
export function renderReader() { emit(EVENT.READER); }
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
  // 关注 / 屏蔽视图（v21）：服务端按 watch_state 过滤，可与未读 / 收藏范围叠加
  if (state.rdWatch === 'watch' || state.rdWatch === 'block') params.set('watch', state.rdWatch);
  if (state.rdScope === 'unread') params.set('unread', '1');
  if (state.rdScope === 'favorite') params.set('fav', '1');
  if (state.rdQ) params.set('q', state.rdQ);
  return params;
}

/**
 * 「再来一次」的排队位：加载途中用户又点了「再次点击同一频道」，
 * 请求不能直接丢掉 —— 丢掉的话用户看到的是旧列表，完全不知道点了生效。
 * 这里记一个 pendingReset，等当前这次结束后补一次重置重载。
 */
let readerPendingReset = false;
/* 与卡片页对称：只认最后一次列表请求，且「重试」能打断仍挂在半路的请求。 */
let readerController = null;
let readerGeneration = 0;

export function cancelReaderLoad() {
  readerGeneration += 1;
  if (readerController) { readerController.abort(); readerController = null; }
}

export async function loadReader({ reset = false } = {}) {
  // 错误空态里的「重试」不能被上一次悬挂的请求挡住
  const force = reset && state.rdReadError;
  if (force) {
    cancelReaderLoad();
    state.rdLoading = false;
    readerPendingReset = false;
  }
  if (state.rdLoading) {
    // 已经在加载：把「重置重载」排队，别静默丢弃
    if (reset) readerPendingReset = true;
    return;
  }
  // 与卡片页对称：首屏失败且列表为空时，不让滚动哨兵借「翻页」无限重拉
  if (!reset && state.rdReadError && !state.rdEntries.length) return;
  if (!reset && (!state.rdHasMore || state.rdLoadMoreErr)) return;

  state.rdLoading = true;
  if (reset) {
    state.rdOffset = 0;
    state.rdHasMore = true;
    state.rdEntries = [];
    state.rdExpanded.clear();
    state.rdBody.clear();
    state.rdBodyErr.clear();
    state.rdReadError = false;
    state.rdLoadMoreErr = false;
    clearReaderPin();   // 列表重置 → 旧的置顶目标已不在列表里
  } else {
    state.rdLoadMoreErr = false;
  }
  renderReader();

  const gen = ++readerGeneration;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  readerController = ctrl;
  const stale = () => gen !== readerGeneration || !!(ctrl && ctrl.signal.aborted);

  try {
    const params = readerFilterParams();
    params.set('limit', String(state.readerPageSize));
    params.set('offset', String(state.rdOffset));

    const res = await apiFetch('/api/entries?' + params.toString(),
      ctrl ? { signal: ctrl.signal, timeoutMs: NET_TIMEOUT_MS } : { timeoutMs: NET_TIMEOUT_MS });
    if (stale()) return;
    if (!res.ok) throw await httpError(res);
    const data = await res.json();
    if (stale()) return;

    const list = data.entries || [];
    state.rdEntries = reset ? list : state.rdEntries.concat(list);
    state.rdOffset = state.rdEntries.length;
    state.rdHasMore = !!data.hasMore;
    state.rdTotal = Number(data.total) || 0;
    state.rdReadError = false;
    state.rdLoadMoreErr = false;
  } catch (err) {
    if (stale()) return;   // 主动取消 / 已被取代，不算失败
    if (!state.rdEntries.length) {
      state.rdReadError = true;
      state.rdReadErrorMsg = '加载失败：' + String((err && err.message) || err);
    } else {
      state.rdLoadMoreErr = true;
    }
  } finally {
    if (readerController === ctrl) readerController = null;
    if (gen !== readerGeneration) return;   // 新请求已接管，别动它的状态与滚动副作用
    state.rdLoading = false;
    renderReader();
    // 翻页追加会让列表总高剧变（实测 scrollHeight 21411 → 14797），此前算好的
    // 置顶位置随之失效 —— 这里是唯一需要重校的另一处（另一处是正文异步到达）。
    // 只在置顶窗口内才重校：用户已经滚走（或窗口过期）后再翻页，绝不能把视口拽回去。
    if (pinAlive()) scrollReaderToArt(readerPinnedId);
    // 一屏没装满时哨兵本就贴着视口底 —— 不靠用户滚动也要接着拉，直到装满或没有更多。
    // 上一次翻页失败时停下，等用户点「重试」，否则会贴着哨兵反复失败、反复请求。
    if (state.rdHasMore && !state.rdLoadMoreErr && readerSentinelNear()) readerAutoLoad();
    // 加载途中排队的「重置重载」：补跑一次，让用户的第二次点击真正生效
    if (readerPendingReset) {
      readerPendingReset = false;
      loadReader({ reset: true });
    }
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

/** 内容区的滚动容器（App Shell 后文章列表在它里面滚，window 不动） */
function readerScroller() {
  return document.querySelector('#readerView .reader-main');
}

/** 头部高度不是常量：搜索展开、频道条换行、转屏、窗口缩放都会变。
 *  只在置顶那一刻量一次，之后布局一变标题行就停在旧深度上，比头部低一截，
 *  正文从它上方那条空档里滚过去 —— 看起来就是「标题没钉住」。
 *  用 ResizeObserver 盯着头部：尺寸一变就重写两个变量（写的是 position:sticky 的
 *  top 与 scroll-margin，不影响头部自身尺寸，不会自激）。
 *  后台标签页不跑渲染步，回调会推迟到重新可见 —— 恢复时补量正好。 */
let headRO = null;
let headROEl = null;
function trackReaderHeadChange(main) {
  if (typeof ResizeObserver !== 'function') return;
  const head = main.querySelector('.reader-head');
  if (!head || (head === headROEl && headRO)) return;
  if (headRO) headRO.disconnect();
  headROEl = head;
  headRO = new ResizeObserver(() => {
    // 切到卡片页时头部被隐藏（尺寸 0），别把回退值写进阅读页的变量
    if (state.tab === 'reader') readerHeadOffset();
  });
  headRO.observe(head);
}

/** 吸顶头部的真实高度：置顶时要让出它，否则新文章的第一行正好被盖住。
 *
 *  不要再读静态 `--head-h`：窄屏的吸顶头部是两行（工具行 44 + 频道条 44 = 88），
 *  而令牌仍写 44。390×844 真机尺寸下浏览器实测：展开后标题被头部盖住 35px，
 *  只露出下半截，看起来就是「标题被划过头 / 划掉了」。
 *  这里直接量当前布局里 sticky 头部的底边，频道条出现、横屏压缩、搜索框换行、
 *  密度变化都自动跟随，不必再为每个断点补一个魔数。
 *  结果写回 `--reader-sticky-offset`，让 CSS 的 scroll-margin-top 与这里同源。 */
function readerHeadOffset() {
  const main = readerScroller();
  if (!main) return 56;
  trackReaderHeadChange(main);
  const mainTop = main.getBoundingClientRect().top;
  let bottom = 0;
  for (const sel of ['.reader-head', '.chan-tabs', '.view-toolbar']) {
    for (const el of main.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      /* 头部收起时 .reader-head 被 translateY(-100%)，bottom 落到滚动区上方，
         只认「自身高度 + 相对滚动区顶的偏移（不取负）」：展开、收起量到的高度
         一致，收展到一半时也不会量成 0 把标题行顶进头部。 */
      bottom = Math.max(bottom, r.height + Math.max(0, r.top - mainTop));
    }
  }
  // 头部尚未挂载 / 被隐藏（首帧、抽屉态）时回退到令牌，别把标题顶到屏幕外
  if (!bottom) bottom = parseFloat(getComputedStyle(main).getPropertyValue('--head-h')) || 52;
  // 吸顶头部的底边：展开态文章的标题行要**贴着**它吸住（见 style.css「长文折叠」段）。
  // 留 8px 缝的话，正文会从这条缝里漏出一条字，看起来像是标题行浮在正文中间。
  main.style.setProperty('--reader-head-h', Math.round(bottom) + 'px');
  const offset = Math.round(bottom) + 8;
  main.style.setProperty('--reader-sticky-offset', offset + 'px');
  return offset;
}

/** 把文章列表滚到「某篇的标题行对齐内容区顶部」，并把页面级滚动一并归零。
 *
 *  踩过的坑（v1.7.0 修复「切换文章后新文章不从顶部开始」的老问题）：
 *  单纯用 el.scrollIntoView({ block:'start' }) 不够——手风琴模式下展开新的一篇
 *  会**收起上一篇**，那一下让列表上方少了一大截高度（上一篇正文越长，差得越多）。
 *  scrollIntoView 在**收起前**的布局里算好目标位置，等 DOM 提交后列表整体上移，
 *  新的一篇就被甩到了视口上方（实测 openTop = -465，恰好是上一篇释放的高度）。
 *  禁用 scroll anchoring、直接写 scrollTop 都绕不开——因为错的是**测量时机**，
 *  不是滚动 API。
 *
 *  正确做法：不猜 React 什么时候提交 DOM，而是**每帧按当前实际布局修正一次**，
 *  直到对齐（或达到帧数上限）。这样无论 DOM 提交落在哪一帧，最终都会归位：
 *    · 提交前量 → 位置偏高，下一帧 DOM 提交后自然被修正；
 *    · 提交后量 → 一次到位。
 *  向上翻（点上方一篇）与向下翻（点下方一篇）走的是同一条路径，行为完全一致。
 *  这里不用 scrollIntoView 而是直接设 scrollTop：scrollIntoView 会连带滚动
 *  所有祖先容器（含 window），而我们只想动 .reader-main 一个。 */
function scrollReaderToArt(id) {
  const main = readerScroller();
  if (!main) return;
  const want = String(id);
  // 记下这次修正属于哪一次置顶：循环途中用户接管（置顶被清）就停手，
  // 别在用户已经开始滚动后继续每帧写 scrollTop。
  const token = readerPinnedId;
  const takenOver = () => token != null && readerPinnedId !== token;

  const place = () => {
    if (takenOver()) return true;
    // 头部处于收起态时它的 rect 是平移后的，量出的落点会少一个头部高度：
    // 先复位再量。复位时不播过渡（head-instant），否则测量落在动画中间。
    if (main.classList.contains(HEAD_TUCK_CLASS)) {
      main.classList.add('head-instant');
      main.classList.remove(HEAD_TUCK_CLASS);   // 直接摘，别依赖收展闭包跟踪的是哪个容器
      readerHeadReveal();                       // 同步闭包状态，避免下次下滚时 early-return
    }
    // 每帧重算：正文异步到达 / 频道条换行都会改吸顶头部高度，静态量一次会偏
    const headOff = readerHeadOffset();
    main.classList.remove('head-instant');
    // 页面级滚动一并归零：窄屏抽屉态等没有独立滚动容器的场合，
    // 窗口残留的偏移会让「置顶」看起来没生效。
    if (window.scrollY > 0 || document.documentElement.scrollTop > 0) window.scrollTo(0, 0);
    const el = findArtItemEl(want);
    if (!el) return true;              // 目标不在列表里（已被换页），交给别的逻辑
    // 目标条目顶边相对内容区视口顶的偏移（正数 = 在视口下方）
    const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top;
    const delta = top - headOff;       // >0 说明目标在下方，需要往下滚 delta
    if (Math.abs(delta) <= 1) return true;
    main.scrollTop += delta;
    return false;
  };

  // 收敛循环：最多 12 帧（约 200ms）。每帧都按**当时**的真实布局修正，
  // 覆盖「React 提交 DOM」「正文异步到达」两种时序抖动。
  let frames = 0;
  const step = () => {
    if (place()) return;               // 已对齐（或目标不在了）→ 收工
    if (++frames >= 12) return;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- 篇内阅读位置（刷新 / 深链回到同一篇时恢复） ----------
 * 地址栏 hash 只记到文章 id，刷新后 restoreReaderArt 一律从标题开始 ——
 * 长文读一半刷新（手机上更常见：PWA 被系统回收后重开）就得重新找。
 * 这里按文章记「标题行已滚出视口多少」，放 sessionStorage：
 *   · 只在同一标签页生命周期内有效，换标签 / 新会话不假装记得；
 *   · 只给 hash 恢复用；从列表点一篇仍然置顶，不改变既有入口策略；
 *   · 偏移按文章高度 clamp，正文和图片异步撑开也不会滚到文章外。 */
const READ_POS_KEY = 'feedlore.readPos.v1';
const READ_POS_MAX = 60;   // 最多记 60 篇，够覆盖一次连续阅读，又不让本地存储无限长
const READ_POS_MIN = 24;   // 还在标题附近不值得恢复（否则等于把「置顶」又挪了一下）
let readPosCache = null;

function readPosMap() {
  if (readPosCache) return readPosCache;
  try {
    const raw = sessionStorage.getItem(READ_POS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    readPosCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    readPosCache = {};
  }
  return readPosCache;
}

function persistReadPos() {
  try { sessionStorage.setItem(READ_POS_KEY, JSON.stringify(readPosMap())); } catch (_) { /* 隐私模式 / 配额满：忽略 */ }
}

function readSavedOffset(id) {
  const v = readPosMap()[String(id)];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function saveReadPos(id, offset) {
  const map = readPosMap();
  map[String(id)] = Math.round(offset);
  const keys = Object.keys(map);
  if (keys.length > READ_POS_MAX) {
    for (const k of keys.slice(0, keys.length - READ_POS_MAX)) delete map[k];
  }
  persistReadPos();
}

function dropReadPos(id) {
  const map = readPosMap();
  if (!(String(id) in map)) return;
  delete map[String(id)];
  persistReadPos();
}

/** 滚动时记下「当前顶到视口上沿的那一篇」读到了哪里。
 *  取顶边已越过容器上沿的最后一篇：手风琴下就是正在读的那篇；多篇展开时
 *  也仍然对应用户视线所在的位置。只记真正读到正文里的偏移（≥ READ_POS_MIN）。 */
function rememberReadingPos() {
  if (state.tab !== 'reader' || readerPinnedId != null) return;   // 置顶/恢复自己写的 scrollTop 不算阅读位置
  const main = readerScroller();
  if (!main) return;
  const mainTop = main.getBoundingClientRect().top;
  const items = document.querySelectorAll('#readerList .art-item');
  let pick = null;
  for (const el of items) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= mainTop) continue;
    if (r.top > mainTop + 2) break;   // 第一篇标题还在下方：视口里还没有任何一篇的正文
    pick = el;
  }
  if (!pick) return;
  const id = pick.dataset.id;
  if (!id) return;
  const offset = Math.round(mainTop - pick.getBoundingClientRect().top);
  if (offset >= READ_POS_MIN) saveReadPos(id, offset);
  else dropReadPos(id);   // 回到标题附近 = 从头读，别在下次刷新时把人拽回中间
}

let readPosTimer = null;
document.addEventListener('scroll', (ev) => {
  const main = readerScroller();
  if (!main || ev.target !== main || readPosTimer) return;
  readPosTimer = setTimeout(() => { readPosTimer = null; rememberReadingPos(); }, 250);
}, { capture: true, passive: true });

/** 恢复篇内位置：只动 .reader-main，按实际布局逐次逼近。
 *  正文/图片是异步到达的，单次测量可能偏 —— 初始两帧对齐，之后每次图片
 *  加载完再对齐一次（3 秒内）；用户一动手就彻底停手。 */
function restoreReaderOffset(id, offset) {
  const main = readerScroller();
  if (!main) return;
  const want = String(id);
  let cancelled = false;
  const timers = [];

  const cleanup = () => {
    cancelled = true;
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
    document.removeEventListener('wheel', onUser, true);
    document.removeEventListener('touchmove', onUser, true);
    document.removeEventListener('keydown', onUser, true);
    document.removeEventListener('pointerdown', onUser, true);
  };
  const onUser = (ev) => {
    if (ev.type === 'keydown' && !PIN_SCROLL_KEYS.has(ev.key)) return;
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
  requestAnimationFrame(() => { if (!cancelled) place(); });
  /* 展开是 React 异步提交：首帧量到的可能还是收起行（行高小 → clamp 把人停在
   * 文章上方）。后台标签页 / PWA 被系统恢复时 rAF 根本不跑，只靠上面那一帧会
   * 一直停在错误位置 —— 再用定时器逼近几次，3 秒内收敛，期间用户一动手即停。 */
  for (const delay of [60, 200, 600, 1200, 2400]) {
    timers.push(setTimeout(() => { if (!cancelled) place(); }, delay));
  }
  const el = findArtItemEl(want);
  if (el) for (const img of el.querySelectorAll('img')) img.addEventListener('load', () => { if (!cancelled) place(); });
  timers.push(setTimeout(cleanup, 3000));
}

/* ---------- 窄屏阅读头部收展（v2.5.0） ----------
 * 手机上吸顶头部是两行（工具行 + 横滑频道条），390×844 下长期占掉 88px。
 * 判据与底部标签栏同一套：向下累计 32px 才收、向上 6px 立刻回、贴顶贴底
 * 强制展开、一帧跨屏（拖滚动条 / 置顶）只更新基准不判方向。
 * 置顶/恢复期间自动展开：readerHeadOffset 量的是头部底边，藏着量会算错落点。 */
const HEAD_HIDE_AFTER = 32;
const HEAD_SHOW_AFTER = 6;
const HEAD_EDGE = 24;

function installReaderHeadTuck() {
  let main = null;
  let lastTop = 0;
  let acc = 0;
  let tucked = false;
  let lastFlip = 0;

  const reveal = () => {
    acc = 0;
    if (main && tucked) {
      tucked = false;
      main.classList.remove(HEAD_TUCK_CLASS);
    }
  };
  readerHeadReveal = reveal;
  const hide = () => {
    if (!main || tucked) return;
    tucked = true;
    lastFlip = Date.now();
    main.classList.add(HEAD_TUCK_CLASS);
  };

  document.addEventListener('scroll', (ev) => {
    if (state.tab !== 'reader') return;
    const el = ev.target;
    if (!el || el.nodeType !== 1 || typeof el.matches !== 'function' || !el.matches('.reader-main')) return;
    if (el !== main) {
      main = el;
      lastTop = el.scrollTop;
      acc = 0;
      if (tucked) { tucked = false; el.classList.remove(HEAD_TUCK_CLASS); }
      return;
    }
    const top = el.scrollTop;
    const dy = top - lastTop;
    lastTop = top;
    // 置顶 / 恢复正在写 scrollTop：这不是用户滚动，露出头部让落点测量准确
    if (readerPinnedId != null) { reveal(); return; }
    const max = el.scrollHeight - el.clientHeight;
    if (top <= HEAD_EDGE || top >= max - HEAD_EDGE) { reveal(); return; }
    if (Math.abs(dy) > el.clientHeight) { acc = 0; return; }
    // 翻转后必须清零累计：否则收起时留下的正累计要向上翻过它才回弹，
    // 「往回 6px 立刻展开」就变成「先抵消 30 多像素」。
    if (tucked) {
      acc = dy < 0 ? acc + dy : 0;
      if (-acc >= HEAD_SHOW_AFTER) { acc = 0; reveal(); }
    } else {
      acc = dy > 0 ? acc + dy : 0;
      if (acc >= HEAD_HIDE_AFTER && Date.now() - lastFlip >= 120) { acc = 0; hide(); }
    }
  }, { capture: true, passive: true });

  on(EVENT.VIEW, reveal);
  window.addEventListener('resize', reveal, { passive: true });
}
installReaderHeadTuck();

export async function expandReaderArt(id) {
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
  markEntryRead(id);   // 展开了就算读过了
  writeHash('#reader/art/' + id);   // 地址栏留当前篇（刷新/回来据此恢复）

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

async function fetchReaderBody(id) {
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
export async function readerRetryBody(id) {
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

export function collapseReaderArt(id) {
  state.rdExpanded.delete(id);
  // 收起后不再有「置顶目标」：否则列表变动时的重校会一直把这一条往回顶
  if (String(readerPinnedId) === String(id)) clearReaderPin();
  renderReader();
  writeHash('#reader');   // 收起后地址栏回到「文章」页，不再指着一篇
  dropReadPos(id);        // 收起了就是没在读，别在下次刷新时恢复这一篇的中间位置
  /* 正文一塌陷视口常停在空白处：把标题行钉回吸顶条下方。
   * 走和展开同一条收敛路径（只动 .reader-main），不用原生 scrollIntoView
   * （那会连带滚所有祖先容器，且在旧布局里测量）。
   * 顺手立一个置顶标记：不是为了让翻页重校，而是让用户一动手就打断这 12 帧修正。 */
  readerPinnedId = id;
  readerPinnedAt = Date.now();
  scrollReaderToArt(id);
}

export function readerToggleArt(id) {
  if (state.rdExpanded.has(id)) collapseReaderArt(id);
  else expandReaderArt(id);
}

export function readerCollapseAll() {
  for (const id of state.rdExpanded) dropReadPos(id);
  state.rdExpanded.clear();
  clearReaderPin();   // 全部收起 → 没有置顶目标
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
  // 目标文章可能正赶上一次在途加载（switchView 的自动加载 / jumpToFeed 排队的重置）。
  // 此刻列表还是旧的甚至空的，直接找会误判「找不到」。加载是串行的（rdLoading 一次性封锁），
  // 轮询到它落地再找即可；最多等约 5s，避免极端情况下死等。
  for (let guard = 0; state.rdLoading && guard < 200; guard++) {
    await new Promise((r) => setTimeout(r, 25));
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
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!state.rdExpanded.has(want) && state.rdEntries.some((e) => String(e.id) === want)) {
    await expandReaderArt(want);
  }
  setTimeout(() => {
    if (state.rdFlashId !== want) return;   // 期间又跳了别处，交给那一次去收
    state.rdFlashId = null;
    renderReader();
  }, FLASH_MS);
  return true;
}

/* ---------- 已读 / 未读 / 收藏 ---------- */

/** 从地址栏 hash 恢复某一篇（刷新 / 从别处回来的深链）：
 *  等列表落地、必要时往后翻页找到它，然后展开并**置顶**——
 *  与「点下一篇进入一篇文章」的滚动策略一致：谁进来都从文章开头看起。 */
export async function restoreReaderArt(id) {
  const want = String(id);
  for (let guard = 0; state.rdLoading && guard < 200; guard++) {
    await new Promise((r) => setTimeout(r, 25));
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

/** 文章页与卡片页各持一份条目列表（state.rdEntries / state.entries），同一行在两边
 *  是两个不同对象。状态变化要两边一起换新对象，任一视图切回来时读到的才是同一状态。 */
function findEntry(id) {
  const key = String(id);
  return (state.rdEntries || []).find((x) => String(x.id) === key)
    || (state.entries || []).find((x) => String(x.id) === key)
    || null;
}

/** 就地改一条的状态：内存（两页列表）+ 侧栏计数 + 重绘（原 paintEntryFlag 的就地 DOM 改类名移除） */
export function applyEntryFlag(id, patch) {
  const key = String(id);
  const rdIdx = (state.rdEntries || []).findIndex((x) => String(x.id) === key);
  const cardIdx = (state.entries || []).findIndex((x) => String(x.id) === key);
  if (rdIdx < 0 && cardIdx < 0) return;
  const e = rdIdx >= 0 ? state.rdEntries[rdIdx] : state.entries[cardIdx];
  const wasRead = !!e.isRead;
  const wasFav = !!e.isFavorite;
  const next = {};
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
export async function setEntryFlag(id, patch) {
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
export function markEntryRead(id) {
  const e = findEntry(id);
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

/** 已读回退成未读：展开即已读之后，误点 / 想稍后再读的常见补救 */
export function readerMarkUnread(id) {
  const e = state.rdEntries.find((x) => String(x.id) === String(id));
  if (!e || !e.isRead) return;
  setEntryFlag(id, { isRead: false }).then((ok) => {
    if (ok) toast('已标为未读');
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
  emit(EVENT.CARDS);
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

/** 展开某个分组（选中组内频道 / 组名时调用，避免「点了却看不见」）。
 *  卡片页的分组筛选也复用这一份，保证两页的折叠偏好不会一边展开一边收着。 */
export function rdExpandGroup(name) {
  const g = String(name || '');
  const set = rdCollapsedGroups();
  if (!set.has(g)) return;
  set.delete(g);
  setLayout('rdCollapsedGroups', Array.from(set));
  // 调用方随后自己 renderReader()，这里只补卡片页那半边
  emit(EVENT.CARDS);
}

/* ---------- 频道 / 范围 / 分组切换（ReaderView 经桥调用） ---------- */
let watchPrevScope = null;   // 进入关注/屏蔽视图前的范围，退出时还原

export function readerSetScope(scope) {
  // rdWatch 也算「已经偏离了默认范围」：在关注/屏蔽视图里整篇文章仍属于 rdScope='all'，
  // 少这一项会让点「全部文章」直接短路，看起来像按钮坏了。
  if (scope === state.rdScope && state.rdFeedId == null && state.rdGroup == null && state.rdWatch == null) return;
  state.rdScope = scope;
  setLayout('rdScope', scope);   // 默认范围按账号持久化
  state.rdFeedId = null;
  state.rdGroup = null;
  state.rdWatch = null;
  watchPrevScope = null;
  renderReader();
  loadReader({ reset: true });
  emitShell();
  if (window.innerWidth <= 720) setReaderDrawer(false);
  scrollReaderTop();
}
export function readerSetGroup(g) {
  state.rdScope = 'all';   // 看某个分组 = 回到「全部」范围
  state.rdWatch = null;
  watchPrevScope = null;
  if (g === state.rdGroup) state.rdGroup = null;
  else { state.rdGroup = g; state.rdFeedId = null; rdExpandGroup(g); }
  renderReader();
  loadReader({ reset: true });
  emitShell();
  if (window.innerWidth <= 720) setReaderDrawer(false);
  scrollReaderTop();
}
export function readerSetFeed(id) {
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
  if (f) rdExpandGroup(String(f.groupName || '').trim());   // 折叠着就选不到它，选了必须看得见
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
export function readerSetWatch(w) {
  let v = w === 'watch' || w === 'block' ? w : null;
  if (v && v === state.rdWatch) v = null;   // 再点一次退出
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

/** 换了频道 / 范围 / 分组 = 换了一整个列表，把视线带回顶部，别停在新列表中间。
 *  App Shell（v1.6.0-test2）后阅读列表的滚动容器是 .reader-main，window 根本不动 ——
 *  所以先滚真正的容器，窗口本身（窄屏抽屉态等没有独立容器的场合）兜底。 */
export function scrollReaderTop() {
  const main = document.querySelector('#readerView .reader-main');
  if (main) main.scrollTo({ top: 0, behavior: 'auto' });
  window.scrollTo({ top: 0, behavior: 'auto' });
  // 换了列表 = 原来那篇已不在列表里，地址栏不该还指着一篇
  writeHash('#reader');
}

// 抽屉开合按钮（菜单 / 关闭 / 遮罩）已随阅读页 React 化，改由 ReaderView 经桥触发
export function readerToggleDrawer() { setReaderDrawer(!document.body.classList.contains('reader-drawer-open')); }
export function readerCloseDrawer() { setReaderDrawer(false); }
let resizeDrawerTimer = null;
window.addEventListener('resize', () => {
  if (resizeDrawerTimer) clearTimeout(resizeDrawerTimer);
  // 防抖：连续 resize 事件只落地一次，避免每次都触发收抽屉的 class 切换与重排
  resizeDrawerTimer = setTimeout(() => { if (window.innerWidth > 720) setReaderDrawer(false); }, 150);
});

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
  if (state.tab !== 'reader' || state.rdLoading || !state.rdHasMore || state.rdLoadMoreErr || !state.rdEntries.length) return;
  readerAutoBusy = true;
  try {
    await loadReader();
  } finally {
    readerAutoBusy = false;
    if (state.rdHasMore && !state.rdLoadMoreErr && readerSentinelNear()) setTimeout(readerAutoLoad, 120);
  }
}

/* 滚动到底自动加载（v1.6.0-test5 修复）：
 * App Shell 之后阅读列表在 .reader-main 里滚动，window 的 scroll 事件永远不触发 ——
 * 这就是自动加载失灵的根因。scroll 事件不冒泡但**能被捕获**，document 上挂捕获监听
 * 一处收齐所有滚动容器的滚动（侧栏 / 列表 / 窗口），命中与否交给哨兵几何判定，
 * 判定本身用 getBoundingClientRect，天然与「谁在滚」无关。 */
document.addEventListener('scroll', () => {
  if (state.tab !== 'reader') return;
  if (state.rdLoading || !state.rdHasMore || state.rdLoadMoreErr || !state.rdEntries.length) return;
  if (readerSentinelNear()) readerAutoLoad();
}, { capture: true, passive: true });

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
async function undoReadAll(scope, at) {
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
  const label = state.rdScope === 'unread' ? '全部未读'
    : (state.rdScope === 'favorite' ? '全部收藏'
      : (watch === 'watch' ? '关注列表' : (watch === 'block' ? '屏蔽列表' : '当前列表')));

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
    affected = (state.feedList || []).reduce((s, f) => {
      const id = Number(f.id);
      if (ids && ids.length && ids.indexOf(id) < 0) return s;
      return s + (Number(f.unreadCount) || 0);
    }, 0);
  }
  // 可撤销：服务端按批次时间戳回滚，标完的提示条里给一个「撤销」入口
  const desc = affected > 0
    ? `将标记 ${affected} 篇未读文章为已读，标完可在提示条里撤销。`
    : (unknown ? '将把当前列表中的未读文章标为已读，标完可在提示条里撤销。' : '当前范围内没有未读文章。');

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
    toast(d.updated ? `已标为已读 ${d.updated} 篇` : '这里没有未读文章', true,
      undoAt && d.updated ? { action: () => undoReadAll(scope, undoAt), actionText: '撤销', ms: 6000 } : undefined);
    await loadFeeds();
    renderReader();
    loadReader({ reset: true });
    // 批量操作无法逐条同步到卡片列表：已拉过的卡片重新取一遍，圆点与计数才对得上
    if ((state.entries || []).length) loadPage(true);
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
