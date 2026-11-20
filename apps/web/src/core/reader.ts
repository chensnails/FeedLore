/* 笺川核心逻辑 · 文章（阅读页）门面。
 *
 * 原单文件按职责拆到同目录三个模块；这里只做 re-export，保持外部 import 链不变
 * （core/index.ts、core/ui.ts、core/autorefresh.ts、core/bootstrap.ts、core/drawer.ts
 * 仍从 './reader.ts' 按原名导入，签名与语义均未变）：
 *   - reader.flow.ts      加载 / 置顶 / 滚动定位 / 窄屏头部收展 / 自动翻页
 *   - reader.articles.ts  置顶目标 / 手风琴 / 篇内阅读位置 / 深链恢复 / 展开收起 / 条目状态
 *   - reader.view.ts      分组折叠 / 频道·范围·关注切换 / 抽屉 / 批量已读 / 搜索
 * ============================================================ */

export {
  accordionOn,
  applyEntryFlag,
  clearReaderPin,
  collapseReaderArt,
  expandReaderArt,
  focusReaderArt,
  markEntryRead,
  readerAccordionOn,
  readerCollapseAll,
  readerMarkUnread,
  readerReload,
  readerRetryBody,
  readerRetryMore,
  readerToggleAccordion,
  readerToggleArt,
  readerToggleFav,
  restoreReaderArt,
  setEntryFlag,
} from './reader.articles.ts';
export {
  cancelReaderLoad,
  loadReader,
  readerAutoBusy,
  readerAutoLoad,
  readerFilterParams,
  readerSentinelNear,
  renderReader,
  renderReaderChannels,
} from './reader.flow.ts';

export {
  rdCollapsedGroups,
  rdExpandGroup,
  readerCloseDrawer,
  readerDrawerLocked,
  readerOpenSource,
  readerReadAll,
  readerSearch,
  readerSetFeed,
  readerSetGroup,
  readerSetScope,
  readerSetTag,
  readerSetWatch,
  readerToggleAllGroups,
  readerToggleDrawer,
  readerToggleGroupCollapse,
  scrollReaderTop,
  setReaderDrawer,
} from './reader.view.ts';
