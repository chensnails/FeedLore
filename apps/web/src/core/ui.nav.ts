/* 页面级交互：刷新 / 视图切换 / 深链恢复 / 视图导航辅助与键盘绑定。
 * 从 ui.ts 抽出（深度重组）：本模块承载所有会改变当前视图的入口，ui.ts 通过
 * export * 保持外部链不变。弱网互斥 / 并行刷新 / 错误空态不重拉的语义逐字保留。 */

import { clearImgFail } from '../imgFail.ts';
import { get, isOn } from '../kernel/bridge.ts';
import { EVENT, emit } from '../kernel/events.ts';
import { drop, qk } from '../kernel/query.ts';
import { hideNewPill } from './autorefresh.ts';
import { loadFeeds, loadPage, render, setCardsDrawer, TABS } from './feeds.ts';
import {
  clearReaderPin,
  focusReaderArt,
  loadReader,
  readerSetTag,
  renderReader,
  renderReaderChannels,
  restoreReaderArt,
  scrollReaderTop,
  setReaderDrawer,
} from './reader.ts';
import {
  closeSettings,
  rememberViewScroll,
  restoreViewScroll,
  scrollActiveTop,
  setLayout,
  state,
} from './state.ts';
import type { EntityId, ReaderScope, ViewTab } from './types.ts';
import {
  $,
  apiFetch,
  emitShell,
  httpError,
  parseHash,
  prefersReducedMotion,
  toast,
  writeHash,
} from './util.ts';

/* 刷新：先让服务端去抓一轮最新条目，再重新拉列表。
   ⋮ 溢出菜单的「刷新」项经桥 refresh 调用（src/ui/OverflowMenu.jsx），
   按钮的忙态由组件本地维护，这里只负责数据。 */
/* 连点「刷新」不该叠一串抓取请求：弱网下它们会互相抢带宽，越刷越慢。 */
let refreshing = false;

export async function refreshFeeds() {
  if (refreshing) return;
  refreshing = true;
  hideNewPill(); // 手动刷新了，自动刷新挂的那个「有新内容」提示就作废了
  // 用户主动刷新 = 再给失败图一次机会（图源恢复、换了网络都会走到这里）
  clearImgFail();
  try {
    // 服务端要逐个抓 RSS，本来就慢，给它单独的较长上限；POST 不自动重试。
    const r = await apiFetch('/api/feeds/refresh', { method: 'POST', timeoutMs: 60000 });
    if (!r.ok) throw await httpError(r);
    const data = await r.json();
    // V4.2：写操作后清掉服务端状态缓存，保证紧随其后的 loadFeeds() 真正重取。
    await drop(qk.feeds, ['entries']);
    await loadFeeds();
    state.tag = null;
    // 阅读页有自己的列表，也一起刷新（顺带更新左侧频道计数）
    renderReaderChannels();
    // 两页列表互不依赖，并行发出：旧实现串行 4 个请求，弱网下延迟直接累加。
    await Promise.all([
      loadPage(true),
      state.tab === 'reader' || state.rdEntries.length
        ? loadReader({ reset: true })
        : Promise.resolve(),
    ]);
    if (data.failed && data.failed.length)
      toast(`已刷新，${data.failed.length} 个频道抓取失败`, false);
    else toast(data.added ? `已刷新，新增 ${data.added} 条` : '已刷新，没有新内容');
  } catch (err) {
    toast('刷新失败：' + (err.message || err), false);
  } finally {
    refreshing = false;
  }
}

// 视图导航（src/ui/ViewNav.jsx）与 ⋮ 菜单已 React 化，
// 交互经桥 openSettings / cycleTheme / refresh / switchView；旧 DOM 绑定移除。
// 设置弹层的关闭按钮 / 遮罩点击 / tab 点击由 src/settings/SettingsModal.tsx 内部处理。

/* Esc = 关闭「最上面那一层」。这里只负责设置弹层，但要先看有没有更上层的覆盖物：
   整屏下拉弹层 / 命令面板 / 灯箱 / 确认框开着时，这一击归它们，不能顺手把设置也关掉。 */
document.addEventListener(
  'keydown',
  /** @param {*} [ev] */ (ev) => {
    if (ev.key !== 'Escape' || !isOn('settingsOpen')) return;
    if (document.querySelector('.dd-mask')) return; // 移动端整屏下拉
    // 设置里的详情层（列表 → 详情）自己处理 Esc：输入框里第一击只失焦、第二击才关层。
    // 不让位的话，这一击会穿过详情层把整个设置弹层关掉。
    if (document.querySelector('.ds-sheet')) return;
    if (document.querySelector('.rule-scope-pop')) return; // 规则适用范围浮层
    const cmdk = document.querySelector('.cmdk-mask:not([hidden])');
    if (cmdk) return; // 命令面板
    if (document.querySelector('.lightbox')) return; // 图片灯箱
    if (isOn('confirmOpen')) return; // 统一确认框
    // 最后交给宿主：移动端停在「分区内容」这一层时，Esc 应先退回设置列表，
    // 只有已经在列表上才整层关闭（与「返回」按钮一致）。返回 true = 已消化。
    const host = get('settingsHost') as { escape?: () => boolean } | undefined;
    if (host && typeof host.escape === 'function' && host.escape()) return;
    closeSettings();
  },
);

/* ============================================================
 * 页面切换（文章 / 卡片 / AI）
 * ============================================================ */
interface SwitchViewOpts {
  skipReaderLoad?: boolean;
  retap?: boolean;
  restoreScroll?: boolean;
}

export function switchView(name: string = 'reader', opts: SwitchViewOpts = {}): Promise<void> {
  // 守卫后 name 必是 TABS 之一，收敛成精确联合类型供 state 使用。
  name = (TABS.indexOf(name) >= 0 ? name : 'reader') as ViewTab;
  const view = name as ViewTab;
  const o = opts || {};
  const from = state.tab;
  // 切走之前先把「离开的那一页」滚到哪儿记下来；回来时（仅 ViewNav 显式要求）
  // 再恢复。默认仍回顶：换筛选 / 深链 / 命令面板跳转都不该沿用旧列表的位置。
  if (from !== name) rememberViewScroll(from);
  /* 探索页常驻（问答不依赖日报开关）：v2.4.8 起不再因 digestEnabled=false 把 ai 回落到 reader。
   * 日报开关只控制探索页里的「日报」tab（AiView 里按 digestIsEnabled 隐藏/禁入），
   * 关掉日报的用户仍能用探索问答。 */
  const same = from === name;
  // AI 视图按需加载（v2.2.0）：切过去之前先发起 chunk 下载，别等视图切完才开始。
  const mountAi = get('mountAi');
  if (name === 'ai' && typeof mountAi === 'function') {
    const p = mountAi();
    if (p && p.catch) p.catch(() => toast('AI 页面加载失败，请检查网络后重试', false));
  }
  const apply = () => {
    state.tab = view;
    setLayout('tab', name); // 按账号持久化当前页面，刷新后保持一致
    hideNewPill(); // 浮标里的新内容是上一个页面拉到的，切页就作废
    // 离开文章页时把频道抽屉收掉（否则它会盖在卡片/AI 页上，还占着页面滚动锁）
    if (name !== 'reader') setReaderDrawer(false);
    // 置顶只管当前这一次进入：离开文章页就作废，回来后的翻页不该再按旧目标重校
    if (name !== 'reader') clearReaderPin();
    // 卡片页的频道抽屉同理
    if (name !== 'cards') setCardsDrawer(false);

    ($('#readerView') as HTMLElement).hidden = name !== 'reader';
    ($('#cardsView') as HTMLElement).hidden = name !== 'cards';
    ($('#aiView') as HTMLElement).hidden = name !== 'ai';
    // 地址栏记下当前视图（只 replaceState，不进浏览器历史：
    // 见 util.writeHash 的说明——「后退」不该在文章之间逐条回退）。
    if (name !== 'reader') writeHash('#' + name);
    // 顶栏（视图高亮 / 副标题 / 主题态）由 React 重绘
    emitShell();

    if (name === 'reader') {
      renderReaderChannels();
      /* skipReaderLoad：入口自己带了首屏请求（jumpToFeed 要等加载落地再展开目标篇）。
         这里再补一次重置会排进同一轮加载，等它落地时把刚展开的文章整篇清掉 ——
         表现为点了「在文章页查看」却停在一篇收起的行上。 */
      if (o.skipReaderLoad) renderReader();
      // 已经有数据就不重新拉，避免来回切页面时列表闪一下
      // 首屏失败时也不要自动重拉：错误空态里已经给了「重试」，来回切页不该一直转圈
      else if (!state.rdEntries.length && !state.rdReadError) loadReader({ reset: true });
      else renderReader();
    }
    // 卡片页同理：文章页里点掉的未读要在这里立刻反映（圆点 / 计数），已有数据不重拉
    if (name === 'cards') {
      render();
      // 启动时只加载当前页的列表（v2.2.0）；第一次切到卡片页再拉首屏，别留空白。
      // loadError 时不自动补拉，由用户点「重试」决定，否则一次切页就多一个弱网请求。
      if (!state.entries.length && !state.loading && !state.loadError) loadPage(true);
    }
    // AI 视图已 React 化：通知 AiView 激活 / 隐去（切到 ai 时由组件自行加载子页数据）
    emit(EVENT.VIEW, name);

    // 新视图的容器切完后处理它自己的滚动位置（window.scrollTo 在这里是空操作）：
    // - 点的是当前视图（底部标签栏再点一次）→ 平滑回顶；
    // - 视图导航切回来 → 恢复上次离开的位置；
    // - 其它入口（筛选 / 深链 / 命令面板）→ 保持旧行为，回到顶部。
    if (same && o.retap) scrollActiveTop(prefersReducedMotion() ? 'auto' : 'smooth');
    else if (o.restoreScroll && !same) restoreViewScroll(view);
    else scrollActiveTop('auto');
  };
  // View Transitions API：视图切换时整页交叉淡入（渐进增强，减少动态效果时跳过）
  if (document.startViewTransition && !prefersReducedMotion()) {
    let started = false;
    try {
      const transition = document.startViewTransition(apply);
      started = true;
      // 快速连续切页时浏览器会跳过上一段过渡并抛 AbortError；
      // 视图已经切过去了，这里只需吞掉悬空的 rejection，避免控制台噪声。
      if (transition && transition.finished && transition.finished.catch)
        transition.finished.catch(() => {});
      if (transition && transition.ready && transition.ready.catch)
        transition.ready.catch(() => {});
      // apply 是异步落地的（旧画面快照后才执行）；返回 updateCallbackDone，
      // 让启动流程能等到「视图已切、首屏请求已发出」再做后续判断。
      if (transition && transition.updateCallbackDone)
        return transition.updateCallbackDone.catch(() => {});
      return Promise.resolve();
    } catch (_) {
      /* 老实现同步抛错 → 走无动画路径 */
    }
    if (!started) apply();
    return Promise.resolve();
  }
  apply();
  return Promise.resolve();
}

/* 浏览器前进 / 后退：按地址栏 hash 恢复视图与文章（V5：弹层返回键栈已移除，
 * 浮层关闭由 Radix DismissableLayer / 自研 Esc 处理，popstate 只管视图）。
 * 策略与「进入一篇文章」完全一致——回到哪篇，就从那篇的开头看起（不保留离开时的滚动位置：
 * 列表是服务端分页的，位置未必还能落在同一篇上，保留它反而会停在半截正文）。
 * 正常情况下本应用只用 replaceState（不产生同文档历史），这里兜住手动改 hash / 站内返回等场景。 */
window.addEventListener('popstate', () => {
  const { tab, artId } = parseHash(location.hash);
  if (tab && tab !== state.tab) switchView(tab);
  if (tab === 'reader' && artId) restoreReaderArt(artId);
});

/** 正文里的标签：跳到卡片页按这个标签筛选。
 *  ai=true 表示来自文章页的「AI 标签」组（独立表），必须走 aiTag 而非 tag，
 *  否则后端只查手动标签列，结果为空或牛头不对马嘴。 */
/** 旧入口兼容：文章页点标签改为就地筛选，不再跳卡片页（卡片页受 cardEnabled 限制会漏文章）。
 *  统一走 reader.js#readerSetTag，两排标签同一套逻辑。
 */
export function readerTagToCards(tag: string, ai = false) {
  readerSetTag(tag, ai);
}

/* 现代交互增强（均已迁移为 React 组件）：阅读进度条已移除（滚动卡顿来源），
 * 命令面板在 src/cmdk/CommandPalette.jsx。下面几个普通页面函数经 core 单例供组件调用。 */

export function selectScope(scope: ReaderScope) {
  if (state.tab !== 'reader') switchView('reader');
  state.rdScope = scope;
  setLayout('rdScope', scope);
  state.rdFeedId = null;
  state.rdGroup = null;
  renderReaderChannels();
  loadReader({ reset: true });
  emitShell();
  setReaderDrawer(false);
  scrollReaderTop();
}
/** 跳到阅读页并锁定某个频道；传了 focusId 就把那篇文章指给用户看（滚过去 + 闪一下高亮）。
 *  focusId 只在这一次跳转里用，不写进任何持久化偏好。
 */
export function jumpToFeed(id: EntityId, focusId?: EntityId | null) {
  // 先落筛选条件再切页：switchView 在列表为空时会自动加载，用目标频道的筛选才不白拉一次
  state.rdScope = 'all';
  state.rdFeedId = Number(id);
  state.rdGroup = null;
  state.rdWatch = null; // 从关注/屏蔽视图点进具体频道，得退出聚合视图
  if (focusId != null) state.rdQ = ''; // 搜索框里的旧关键词会把目标文章筛掉
  // 首屏请求由下面这一处发：让 switchView 别再补一次重置（见 apply 里的 skipReaderLoad）
  switchView('reader', { skipReaderLoad: focusId != null });
  renderReaderChannels();
  emitShell();
  setReaderDrawer(false);
  scrollReaderTop();
  const p = loadReader({ reset: true });
  // 即便这里因为「加载中」被排队（返回的 promise 立刻 resolve），focusReaderArt 内部会等加载落地再找
  if (focusId != null) p.then(() => focusReaderArt(focusId));
}
export function focusSearchBox() {
  if (state.tab === 'cards') {
    const focusCards = get('cardsFocusSearch') as (() => void) | undefined;
    if (focusCards) focusCards(); // 卡片搜索框已 React 化
    return;
  }
  if (state.tab !== 'reader') switchView('reader');
  const focusReader = get('readerFocusSearch') as (() => void) | undefined;
  if (focusReader) focusReader();
}

// 「/」聚焦搜索：命令面板里一直写着这个提示，之前却没有对应的按键处理。
// 正在输入框里打字时不抢（用户可能真的要打斜杠），任何弹层开着时也不抢。
document.addEventListener(
  'keydown',
  /** @param {*} [ev] */ (ev) => {
    if (ev.key !== '/' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target;
    if (t instanceof HTMLElement && (t.isContentEditable || t.matches('input,textarea,select')))
      return;
    if (isOn('settingsOpen') || isOn('cmdkOpen') || isOn('confirmOpen')) return;
    // 设置弹层常驻挂载（关闭时只是 hidden），必须排除隐藏态，否则「/」永远被它吃掉
    if (document.querySelector('.lightbox, .modal-mask:not([hidden]), .dd-mask:not([hidden])'))
      return;
    ev.preventDefault();
    focusSearchBox();
  },
);
