/* 笺川核心逻辑 · 文章页：加载 / 置顶 / 滚动定位 / 窄屏头部收展 / 自动翻页。
 * 从 reader.ts 抽出：这几件事强耦合——翻页追加与正文异步到达都会改列表高度，
 * 必须在同一次布局动作里重校置顶；置顶失效判据（时间窗 + 用户接管）共用一份状态。
 * ============================================================ */

import { EVENT, emit, on } from '../kernel/events.ts';
import { clearReaderPin, readerPinnedAt, readerPinnedId } from './reader.articles.ts';
import { state } from './state.ts';
import type { EntityId } from './types.ts';
import { apiFetch, httpError, NET_TIMEOUT_MS } from './util.ts';

/* 当前「置顶目标」：文章列表内容变化后（翻页追加、正文异步到达）要重新对准它。
 *  列表一变动，之前算好的位置就失效了——翻页时列表总高会剧烈变化
 *  （实测 scrollHeight 21411 → 14797），不重校就会停在偏移处。
 *
 *  ⚠️ 只覆盖「我们自己的布局动作」那几百毫秒，不是长期状态。
 *  早先它一直生效到收起为止：用户展开一篇、往下滚到列表深处，一次自动翻页
 *  （loadReader 后按它重校）就把视口拽回那篇的标题，看起来是页面自己在快速滚动。
 *  现在：时间窗（PIN_WINDOW_MS）+ 用户滚动意图立即作废 + 切走视图清空。
 *
 *  置顶目标本体与 clearReaderPin 在 reader.articles.ts：展开 / 收起 / 深链恢复都要写它。 */

const PIN_WINDOW_MS = 800;

/* 窄屏吸顶头部收展（实现见 installReaderHeadTuck）。
 * 类名与复位钩子放在置顶逻辑旁边：scrollReaderToArt 量落点之前必须先展开头部，
 * 否则 head-tucked 的 translateY(-100%) 会让吸顶条底边量成 0，文章标题埋进头部。 */
const HEAD_TUCK_CLASS = 'head-tucked';
let readerHeadReveal = () => {};

/** 只有刚发生的布局动作才值得重校；过期后列表再变一律不动滚动。 */
function pinAlive() {
  return readerPinnedId != null && Date.now() - readerPinnedAt < PIN_WINDOW_MS;
}

/* 用户接管滚动：置顶立刻作废。
 * wheel / touchmove 覆盖滚轮与手指，键盘只认真正会滚动的键，pointerdown 兜住
 * 拖滚动条（它既不发 wheel 也不发 touchmove）。这些事件只由用户输入产生，
 * 置顶循环自己写 scrollTop 不会触发，所以不会误伤正在进行的对齐。 */
export const PIN_SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);
function onPinUserIntent(ev: Event) {
  if (readerPinnedId == null || state.tab !== 'reader') return;
  if (ev.type === 'keydown') {
    if (!(ev instanceof KeyboardEvent) || !PIN_SCROLL_KEYS.has(ev.key)) return;
  }
  clearReaderPin();
}
document.addEventListener('wheel', onPinUserIntent, { capture: true, passive: true });
document.addEventListener('touchmove', onPinUserIntent, { capture: true, passive: true });
document.addEventListener('keydown', onPinUserIntent, true);
/* 抽成具名处理器，保证注册点是单行 addEventListener('pointerdown', ...)。
 * 逻辑与原来的行内箭头函数逐字等价：拖滚动条时作废置顶。 */
function onPinPointerDown(ev: PointerEvent) {
  if (readerPinnedId == null) return;
  const main = readerScroller();
  if (main && (ev.target === main || (ev.target instanceof Node && main.contains(ev.target))))
    clearReaderPin();
}
document.addEventListener('pointerdown', onPinPointerDown, true);

/** 通知 ReaderView 重绘。
 *  ⚠️ 这里不要挂任何滚动副作用：renderReader() 在近 20 处被调用（含与置顶无关的
 *  重绘），往里塞 rAF 会在每次重绘都排一次滚动修正，既拖慢又容易踩到时序。
 *  置顶的重新对准只在真正改变布局的两处做：正文异步到达、翻页追加（见下）。 */
export function renderReader() {
  emit(EVENT.READER);
}
/** 兼容旧调用名：频道侧栏同样由 ReaderView 渲染，故与 renderReader 同为一次重绘 */
export function renderReaderChannels() {
  renderReader();
}

/**
 * 阅读页当前的筛选条件 → URLSearchParams。
 * 列表查询、自动刷新、批量标为已读三处共用，保证「屏幕上看到的」和「被操作的」是同一批。
 * 分组里一个频道都没有时传 `feeds=`（空），服务端会返回空列表 —— 别退化成「不过滤」。
 */
export function readerFilterParams() {
  const params = new URLSearchParams();
  const feeds = state.feedList || [];
  let ids: EntityId[] | null = null;
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
  // 标签筛选：与卡片页同一套服务端参数，手动标签走 tag、AI 标签走 aiTag（两表物理隔离）。
  // 阅读页看的是「全部内容」（上面 scope=all），不会被卡片的 cardEnabled 开关漏掉条目。
  if (state.rdTag) params.set('tag', state.rdTag);
  if (state.rdAiTag) params.set('aiTag', state.rdAiTag);
  return params;
}

/**
 * 「再来一次」的排队位：加载途中用户又点了「再次点击同一频道」，
 * 请求不能直接丢掉 —— 丢掉的话用户看到的是旧列表，完全不知道点了生效。
 * 这里记一个 pendingReset，等当前这次结束后补一次重置重载。
 */
export let readerPendingReset = false;
/* 与卡片页对称：只认最后一次列表请求，且「重试」能打断仍挂在半路的请求。 */
let readerController: AbortController | null = null;
let readerGeneration = 0;

export function cancelReaderLoad() {
  readerGeneration += 1;
  if (readerController) {
    readerController.abort();
    readerController = null;
  }
}

export async function loadReader({ reset = false }: { reset?: boolean } = {}) {
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
    clearReaderPin(); // 列表重置 → 旧的置顶目标已不在列表里
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

    const res = await apiFetch(
      '/api/entries?' + params.toString(),
      ctrl ? { signal: ctrl.signal, timeoutMs: NET_TIMEOUT_MS } : { timeoutMs: NET_TIMEOUT_MS },
    );
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
    if (stale()) return; // 主动取消 / 已被取代，不算失败
    if (!state.rdEntries.length) {
      state.rdReadError = true;
      state.rdReadErrorMsg = '加载失败：' + String((err && err.message) || err);
    } else {
      state.rdLoadMoreErr = true;
    }
  } finally {
    if (readerController === ctrl) readerController = null;
    if (gen !== readerGeneration) return; // 新请求已接管，别动它的状态与滚动副作用
    state.rdLoading = false;
    renderReader();
    // 翻页追加会让列表总高剧变（实测 scrollHeight 21411 → 14797），此前算好的
    // 置顶位置随之失效 —— 这里是唯一需要重校的另一处（另一处是正文异步到达）。
    // 只在置顶窗口内才重校：用户已经滚走（或窗口过期）后再翻页，绝不能把视口拽回去。
    if (pinAlive()) scrollReaderToArt(readerPinnedId!);
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

/** 找列表里某篇的 DOM：按 data-id 比对，避开 id 里特殊字符对 CSS 选择器的影响 */
export function findArtItemEl(id: EntityId): HTMLElement | null {
  const want = String(id);
  const items = document.querySelectorAll<HTMLElement>('#readerList .art-item');
  for (const el of items) if (el.dataset.id === want) return el;
  return null;
}

/** 内容区的滚动容器（App Shell 后文章列表在它里面滚，window 不动） */
export function readerScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#readerView .reader-main');
}

/** 头部高度不是常量：搜索展开、频道条换行、转屏、窗口缩放都会变。
 *  只在置顶那一刻量一次，之后布局一变标题行就停在旧深度上，比头部低一截，
 *  正文从它上方那条空档里滚过去 —— 看起来就是「标题没钉住」。
 *  用 ResizeObserver 盯着头部：尺寸一变就重写两个变量（写的是 position:sticky 的
 *  top 与 scroll-margin，不影响头部自身尺寸，不会自激）。
 *  后台标签页不跑渲染步，回调会推迟到重新可见 —— 恢复时补量正好。 */
let headRO: ResizeObserver | null = null;
let headROEl: Element | null = null;

function trackReaderHeadChange(main: HTMLElement) {
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
  (main as HTMLElement).style.setProperty('--reader-head-h', Math.round(bottom) + 'px');
  const offset = Math.round(bottom) + 8;
  (main as HTMLElement).style.setProperty('--reader-sticky-offset', offset + 'px');
  return offset;
}

/** 把文章列表滚到「某篇的标题行对齐内容区顶部」，并把页面级滚动一并归零。
 *
 *  踩过的坑（「切换文章后新文章不从顶部开始」的老问题）：
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
 *  所有祖先容器（含 window），而我们只想动 .reader-main 一个。
 */
export function scrollReaderToArt(id: EntityId) {
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
      main.classList.remove(HEAD_TUCK_CLASS); // 直接摘，别依赖收展闭包跟踪的是哪个容器
      readerHeadReveal(); // 同步闭包状态，避免下次下滚时 early-return
    }
    // 每帧重算：正文异步到达 / 频道条换行都会改吸顶头部高度，静态量一次会偏
    const headOff = readerHeadOffset();
    main.classList.remove('head-instant');
    // 页面级滚动一并归零：窄屏抽屉态等没有独立滚动容器的场合，
    // 窗口残留的偏移会让「置顶」看起来没生效。
    if (window.scrollY > 0 || document.documentElement.scrollTop > 0) window.scrollTo(0, 0);
    const el = findArtItemEl(want);
    if (!el) return true; // 目标不在列表里（已被换页），交给别的逻辑
    // 目标条目顶边相对内容区视口顶的偏移（正数 = 在视口下方）
    const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top;
    const delta = top - headOff; // >0 说明目标在下方，需要往下滚 delta
    if (Math.abs(delta) <= 1) return true;
    main.scrollTop += delta;
    return false;
  };

  // 收敛循环：最多 12 帧（约 200ms）。每帧都按**当时**的真实布局修正，
  // 覆盖「React 提交 DOM」「正文异步到达」两种时序抖动。
  let frames = 0;
  const step = () => {
    if (place()) return; // 已对齐（或目标不在了）→ 收工
    if (++frames >= 12) return;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- 篇内阅读位置（记录 / 恢复在 reader.articles.ts） ---------- */

/* ---------- 窄屏阅读头部收展（v2.5.0） ----------
 * 手机上吸顶头部是两行（工具行 + 横滑频道条），390×844 下长期占掉 88px。
 * 判据与底部标签栏同一套：向下累计 32px 才收、向上 6px 立刻回、贴顶贴底
 * 强制展开、一帧跨屏（拖滚动条 / 置顶）只更新基准不判方向。
 * 置顶/恢复期间自动展开：readerHeadOffset 量的是头部底边，藏着量会算错落点。 */
const HEAD_HIDE_AFTER = 32;
const HEAD_SHOW_AFTER = 6;
const HEAD_EDGE = 24;

function installReaderHeadTuck() {
  let main: HTMLElement | null = null;
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

  document.addEventListener(
    'scroll',
    (ev) => {
      if (state.tab !== 'reader') return;
      const el = ev.target instanceof HTMLElement ? ev.target : null;
      if (!el || !el.matches('.reader-main')) return;
      if (el !== main) {
        main = el;
        lastTop = el.scrollTop;
        acc = 0;
        if (tucked) {
          tucked = false;
          el.classList.remove(HEAD_TUCK_CLASS);
        }
        return;
      }
      const top = el.scrollTop;
      const dy = top - lastTop;
      lastTop = top;
      // 置顶 / 恢复正在写 scrollTop：这不是用户滚动，露出头部让落点测量准确
      if (readerPinnedId != null) {
        reveal();
        return;
      }
      const max = el.scrollHeight - el.clientHeight;
      if (top <= HEAD_EDGE || top >= max - HEAD_EDGE) {
        reveal();
        return;
      }
      if (Math.abs(dy) > el.clientHeight) {
        acc = 0;
        return;
      }
      // 翻转后必须清零累计：否则收起时留下的正累计要向上翻过它才回弹，
      // 「往回 6px 立刻展开」就变成「先抵消 30 多像素」。
      if (tucked) {
        acc = dy < 0 ? acc + dy : 0;
        if (-acc >= HEAD_SHOW_AFTER) {
          acc = 0;
          reveal();
        }
      } else {
        acc = dy > 0 ? acc + dy : 0;
        if (acc >= HEAD_HIDE_AFTER && Date.now() - lastFlip >= 120) {
          acc = 0;
          hide();
        }
      }
    },
    { capture: true, passive: true },
  );

  on(EVENT.VIEW, reveal);
  window.addEventListener('resize', reveal, { passive: true });
}
installReaderHeadTuck();

/* 侧滑出手势已抽到 src/core/drawer.js（文章页与卡片页共用同一套）。 */

export let readerAutoBusy = false;

export function readerSentinelNear() {
  const el = document.getElementById('readerSentinel');
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.top < window.innerHeight + 500;
}

export async function readerAutoLoad() {
  if (readerAutoBusy) return;
  if (
    state.tab !== 'reader' ||
    state.rdLoading ||
    !state.rdHasMore ||
    state.rdLoadMoreErr ||
    !state.rdEntries.length
  )
    return;
  readerAutoBusy = true;
  try {
    await loadReader();
  } finally {
    readerAutoBusy = false;
    if (state.rdHasMore && !state.rdLoadMoreErr && readerSentinelNear())
      setTimeout(readerAutoLoad, 120);
  }
}

/* 滚动到底自动加载：
 * App Shell 之后阅读列表在 .reader-main 里滚动，window 的 scroll 事件永远不触发 ——
 * 这就是自动加载失灵的根因。scroll 事件不冒泡但**能被捕获**，document 上挂捕获监听
 * 一处收齐所有滚动容器的滚动（侧栏 / 列表 / 窗口），命中与否交给哨兵几何判定，
 * 判定本身用 getBoundingClientRect，天然与「谁在滚」无关。 */
document.addEventListener(
  'scroll',
  () => {
    if (state.tab !== 'reader') return;
    if (state.rdLoading || !state.rdHasMore || state.rdLoadMoreErr || !state.rdEntries.length)
      return;
    if (readerSentinelNear()) readerAutoLoad();
  },
  { capture: true, passive: true },
);
