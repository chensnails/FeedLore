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
import * as S from './state.js';
import * as F from './feeds.js';
import * as R from './reader.js';
import './drawer.js';   // 侧滑抽屉手势（文章页 / 卡片页共用），依赖 reader 与 feeds 的 setter
import * as AR from './autorefresh.js';
import * as UI from './ui.js';
import './bootstrap.js';

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
    if (v === S.state.q && S.state.tag == null) return;
    S.state.q = v;
    S.state.tag = null;
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
  cardsTag: (t) => {
    const next = t || null;
    if (S.state.tag === next) return;
    S.state.tag = next;
    const p = F.loadPage(true);
    S.scrollActiveTop('auto');
    return p;
  },
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
