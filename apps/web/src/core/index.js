/* 笺川核心逻辑的统一入口（原 src/core/app.js，v2.1.0 起拆分为同目录多个模块）。
 *
 * 组件一律 `import { core } from '@core'`（别名见 vite.config.mjs / tests/ui/build.mjs），
 * 不依赖任何 window 全局桥。
 *
 * 导入顺序即模块求值顺序，必须保持单向依赖：
 *   util → state → feeds → reader → autorefresh → ui → bootstrap
 * bootstrap 放在最后，它负责首屏主题 / 视图应用、登录态校验与首次数据加载。
 */
import * as U from './util.js';
import * as J from './aiJob.js';
import * as S from './state.js';
import * as F from './feeds.js';
import * as R from './reader.js';
import './drawer.js';   // 侧滑抽屉手势（文章页 / 卡片页共用），依赖 reader 与 feeds 的 setter
import * as AR from './autorefresh.js';
import * as UI from './ui.js';
import './bootstrap.js';

/**
 * 卡片页标签筛选 0 命中 → 回落到文章页按同一标签检索。
 *
 * 卡片页只显示「卡片开关」打开的频道（scope=cards），未开卡片的频道里即使有该标签
 * 也会被漏掉；文章页看全部内容（scope=all）。用户在卡片页点标签却一条都没有时，
 * 自动带着同一标签切到文章页继续找，避免误以为「没有这个标签的文章」。
 *
 * 只在「本次标签筛选确实仍生效且 0 命中」时回落：连点会改掉 state.tag，
 * 先前那次 await 醒来发现标签已变就不回落，防止误跳。
 */
async function cardsTagFilter(t, ai) {
  const next = t || null;
  const field = ai ? 'aiTag' : 'tag';
  const other = ai ? 'tag' : 'aiTag';
  if (S.state[field] === next && S.state[other] == null) return;
  S.state[field] = next;
  S.state[other] = null;
  await F.loadPage(true);
  S.scrollActiveTop('auto');
  if (!next || S.state.tab !== 'cards') return;
  if (S.state[field] !== next) return;              // 期间用户又点了别的筛选
  if (S.state.loading || S.state.loadError) return; // 加载中 / 失败，不做判断
  if (S.state.total !== 0) return;                  // 卡片页有命中，就地筛即可
  // 回落：带同一标签到文章页（沿用文章页当前频道/范围，只放宽到全部内容）
  S.state.rdTag = ai ? null : next;
  S.state.rdAiTag = ai ? next : null;
  UI.switchView('reader', { skipReaderLoad: true });
  R.loadReader({ reset: true });
  R.scrollReaderTop();
  U.toast(`卡片页没有「${next}」，已切到文章页检索全部内容`);
}

export const core = {
  state: S.state,
  switchView: UI.switchView, applyTheme: S.applyTheme, openSettings: S.openSettings,
  selectScope: UI.selectScope, jumpToFeed: UI.jumpToFeed,
  focusSearchBox: UI.focusSearchBox, exportOpml: UI.exportOpml, downloadUrl: UI.downloadUrl,
  shortFeedName: U.shortFeedName, feedTitle: U.feedTitle,
  THEME_MODES: S.THEME_MODES, THEME_META: S.THEME_META,
  refresh: UI.refreshFeeds,
  cycleTheme: S.cycleTheme,
  scrollTop: () => S.scrollActiveTop(U.prefersReducedMotion() ? 'auto' : 'smooth'),
  activeScrollTop: S.activeScrollTop,
  // —— 设置弹层 / 外观 / 关于（v1.3.0 起 React 化） ——
  apiFetch: U.apiFetch, httpError: U.httpError, errText: U.errText, uploadArchive: U.uploadArchive, goLogin: U.goLogin,
  // 模型调用的前端上限（200s）：AI 相关 POST 一律传 timeoutMs: core.AI_TIMEOUT_MS，
  // 否则会被 30s 写超时误杀（服务端一次调用允许 180s）
  AI_TIMEOUT_MS: U.NET_AI_TIMEOUT_MS,
  // AI 异步任务：提交即返回 jobId，前端按 1.5s 间隔轮询（见 core/aiJob.js）
  submitAiJob: (body) => J.submitAiJob(core, body),
  pollAiJob: (jobId, opts) => J.pollAiJob(core, jobId, opts),
  AI_JOB_POLL_MS: J.AI_JOB_POLL_MS,
  AI_JOB_FAST_POLL_MS: J.AI_JOB_FAST_POLL_MS,
  isAdmin: S.isAdmin, isReadonly: S.isReadonly, isWritable: S.isWritable,
  toast: U.toast, confirm: U.confirm,
  // —— 覆盖层（v2.1.0 起 React 化，组件 src/ui/Overlays.jsx） ——
  getToastState: () => U.toastState,
  runToastAction: U.runToastAction,
  getConfirmState: () => U.confirmState,
  settleConfirm: U.settleConfirm, cancelConfirm: U.cancelConfirm,
  getNewPillState: () => AR.newPillState,
  getLightboxState: () => UI.lightboxState,
  stepLightbox: UI.stepLightbox,
  applyPendingFresh: AR.applyPendingFresh,
  closeLightbox: UI.closeLightbox,
  lockPageScroll: S.lockPageScroll, unlockPageScroll: S.unlockPageScroll,
  getSettingsSummary: S.getSettingsSummary,
  getAppearance: S.readAppearance, setAppearance: S.setAppearance, resetAppearance: S.resetAppearance,
  // —— 数据源面板（P2c） ——
  loadFeeds: F.loadFeeds, loadPage: F.loadPage, renderReaderChannels: R.renderReaderChannels,
  scheduleAutoRefresh: AR.scheduleAutoRefresh, setLayout: S.setLayout, setSettingsSummary: S.setSettingsSummary,
  bindSections: UI.bindSections, groupFeeds: F.groupFeeds,
  // —— 账号 / 状态面板（P2d） ——
  promptInstall: UI.promptInstall,
  linkLabel: U.linkLabel,
  // —— 卡片视图（P3b） ——
  /* 换频道 / 分组 / 搜索词都算「换了列表」，落筛选后立刻回顶（瞬时，与文章页
     selectScope / jumpToFeed 的 scrollReaderTop 一致）。不回顶的话旧位置会被
     浏览器夹到新内容的底部，底部哨兵一露头就自动续拉，越拉越贴底 —— 表现为
     切换频道后列表自己一直往下滚。 */
  filterEntries: () => F.applyFilters(),
  firstPageSize: F.firstPageSize,
  cardsSearch: (v) => {
    // 同值不重拉：去抖到期 / 回车时词没变，重拉只会白闪骨架并把页面拽回顶部。
    // 但挂着标签时清标签本身就是变化，仍要重置。
    if (v === S.state.q && S.state.tag == null && S.state.aiTag == null) return;
    S.state.q = v;
    S.state.tag = null;
    S.state.aiTag = null;
    const p = F.loadPage(true);
    S.scrollActiveTop('auto');
    return p;
  },
  cardsFilterFeed: (v) => {
    const next = v ? v : null;
    // 再点同一频道不重拉：ChannelTabs / 侧栏的 retap 会平滑回顶，重拉只会白闪骨架。
    // 频道 id 有 number / string 两种来源（标签条传 id、下拉传 String(id)），按串比。
    // 挂着分组筛选时点频道是「换筛选」，仍要重置。
    const same = next == null
      ? S.state.feedFilter == null
      : S.state.feedFilter != null && String(next) === String(S.state.feedFilter);
    if (same && S.state.cardGroup == null) return;
    S.state.feedFilter = next;
    S.state.cardGroup = null;
    S.state.tag = null;
    S.state.aiTag = null;
    const p = F.loadPage(true);
    S.scrollActiveTop('auto');
    return p;
  },
  /* 卡片页「只看这组」：与文章页 readerSetGroup 同一套交互 ——
   * 再点同一个组取消筛选；选中分组时清掉频道筛选、展开该组（否则点了却看不见）。 */
  cardsFilterGroup: (g) => {
    const next = g === S.state.cardGroup ? null : g;
    S.state.cardGroup = next;
    if (next != null) {
      S.state.feedFilter = null;
      S.state.tag = null;
      S.state.aiTag = null;
      R.rdExpandGroup(next);
    }
    const p = F.loadPage(true);
    S.scrollActiveTop('auto');
    return p;
  },
  /* 排序 / 标签都已是服务端筛选（loadPage 带 sort / tag）：改它们 = 换列表，
     必须重置重载并瞬时回顶，与换频道 / 搜索同一套。只 render() 不重拉的话，
     用户看到的还是旧顺序 / 旧标签的那一页。同值直接返回，不白闪骨架。 */
  cardsSort: (v) => {
    if (S.state.sort === v) return;
    S.setLayout('sort', v);   // LAYOUT_MIRROR 会把值回填到 state.sort
    const p = F.loadPage(true);
    S.scrollActiveTop('auto');
    return p;
  },
  cardsView: (m) => F.setViewMode(m),
  cardsTag: (t) => cardsTagFilter(t, false),
  /* AI 标签与手动标签物理隔离，筛选也必须分开：点「AI 标签」组走 aiTag 参数，
   * 不能塞进 tag（那只查 entries.tags，会把人带到 0 条或错误结果）。
   * 卡片页 0 命中时统一回落到文章页（见 cardsTagFilter）。 */
  cardsAiTag: (t) => cardsTagFilter(t, true),
  cardsLoadMore: () => F.loadPage(false),
  cardsRetryMore: () => { S.state.loadMoreErr = false; return F.loadPage(false); },
  // 窄屏频道抽屉（与文章页同一套交互，v1.3.10）
  cardsToggleDrawer: F.cardsToggleDrawer, cardsCloseDrawer: F.cardsCloseDrawer,
  cardsSetFlag: (id, patch) => UI.cardSetFlag(id, patch),
  cardsDetailRead: (id) => UI.cardDetailRead(id),
  copyText: U.copyText, openLinkMenu: U.openLinkMenu, fmtDate: U.fmtDate,
  // —— 视图导航 / ⋮ 菜单快照 ——
  getShell: UI.shellSnapshot,
  // —— 日报开关（账号级，关掉即收起三视图导航里的日报入口） ——
  digestIsEnabled: UI.digestIsEnabled, setDigestEnabled: UI.setDigestEnabled,
  fmtFull: U.fmtFull, fmtBadge: U.fmtBadge,
  // —— 文章视图（P3c） ——
  readerSetScope: R.readerSetScope, readerSetFeed: R.readerSetFeed, readerSetGroup: R.readerSetGroup,
  readerSetWatch: R.readerSetWatch,
  readerOpenSource: R.readerOpenSource,
  readerSearch: R.readerSearch, readerToggleArt: R.readerToggleArt, readerCollapseAll: R.readerCollapseAll,
  readerReadAll: R.readerReadAll,
  readerToggleFav: R.readerToggleFav, readerMarkUnread: R.readerMarkUnread,
  readerReload: R.readerReload, readerRetryBody: R.readerRetryBody, readerRetryMore: R.readerRetryMore,
  readerSetTag: R.readerSetTag,
  // 旧入口保留兼容：就地筛选，不再跳卡片页（见 reader.js#readerSetTag）
  readerTagToCards: UI.readerTagToCards,
  restoreReaderArt: R.restoreReaderArt,
  readerToggleAccordion: R.readerToggleAccordion, readerAccordionOn: R.readerAccordionOn,
  readerToggleDrawer: R.readerToggleDrawer, readerCloseDrawer: R.readerCloseDrawer,
  // —— 频道栏分组折叠 + 栏宽（v1.4.0-test） ——
  readerCollapsedGroups: R.rdCollapsedGroups,
  readerToggleGroupCollapse: R.readerToggleGroupCollapse,
  readerToggleAllGroups: R.readerToggleAllGroups,
  getReaderSideWidth: () => S.layoutPref.readerSideWidth,
  setReaderSideWidth: S.setReaderSideWidth, applyReaderSideWidth: S.applyReaderSideWidth,
  readerSideCap: S.readerSideCap, READER_SIDE_DEFAULT: S.READER_SIDE_DEFAULT,
  READER_SIDE_MIN: S.READER_SIDE_MIN, READER_SIDE_MAX: S.READER_SIDE_MAX,
};
