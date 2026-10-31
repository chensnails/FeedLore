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
  focusSearchBox: UI.focusSearchBox, exportOpml: UI.exportOpml,
  shortFeedName: U.shortFeedName, feedTitle: U.feedTitle,
  THEME_MODES: S.THEME_MODES, THEME_META: S.THEME_META,
  refresh: UI.refreshFeeds,
  cycleTheme: S.cycleTheme,
  scrollTop: () => window.scrollTo({ top: 0, behavior: U.prefersReducedMotion() ? 'auto' : 'smooth' }),
  // —— 设置弹层 / 外观 / 关于（v1.3.0 起 React 化） ——
  apiFetch: U.apiFetch, httpError: U.httpError, isAdmin: S.isAdmin, toast: U.toast, confirm: U.confirm,
  // —— 覆盖层（v2.1.0 起 React 化，组件 src/ui/Overlays.jsx） ——
  getToastState: () => U.toastState,
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
  filterEntries: () => F.applyFilters(),
  cardsSearch: (v) => { S.state.q = v; S.state.tag = null; return F.loadPage(true); },
  cardsFilterFeed: (v) => { S.state.feedFilter = v ? v : null; S.state.tag = null; return F.loadPage(true); },
  cardsSort: (v) => { S.state.sort = v; S.setLayout('sort', v); F.render(); },
  cardsView: (m) => F.setViewMode(m),
  cardsTag: (t) => { S.state.tag = t || null; F.render(); window.scrollTo({ top: 0, behavior: U.prefersReducedMotion() ? 'auto' : 'smooth' }); },
  cardsLoadMore: () => F.loadPage(false),
  // 窄屏频道抽屉（与文章页同一套交互，v1.3.10）
  cardsToggleDrawer: F.cardsToggleDrawer, cardsCloseDrawer: F.cardsCloseDrawer,
  cardsSetFlag: (id, patch) => UI.cardSetFlag(id, patch),
  cardsDetailRead: (id) => UI.cardDetailRead(id),
  copyText: U.copyText, openLinkMenu: U.openLinkMenu, fmtDate: U.fmtDate,
  // —— App Shell 顶栏（P4a） ——
  getShell: UI.shellSnapshot,
  // —— 日报开关（账号级，关掉即收起顶栏入口） ——
  digestIsEnabled: UI.digestIsEnabled, setDigestEnabled: UI.setDigestEnabled,
  fmtFull: U.fmtFull,
  // —— 文章视图（P3c） ——
  readerSetScope: R.readerSetScope, readerSetFeed: R.readerSetFeed, readerSetGroup: R.readerSetGroup,
  readerSetWatch: R.readerSetWatch,
  readerOpenSource: R.readerOpenSource,
  readerSearch: R.readerSearch, readerToggleArt: R.readerToggleArt, readerCollapseAll: R.readerCollapseAll,
  readerReadAll: R.readerReadAll,
  readerToggleFav: R.readerToggleFav, readerTagToCards: UI.readerTagToCards,
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
