/* 笺川核心逻辑 · 启动：首屏主题 / 视图应用 + 登录态校验 + 首次数据加载 + 深链定位
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { toast, emitShell } from './util.js';
import { state, applyRoleUI, applyTheme, currentThemeMode, openSettings } from './state.js';
import { currentViewMode, applyViewMode, currentTab, loadFeeds, loadPage } from './feeds.js';
import { scheduleAutoRefresh } from './autorefresh.js';
import { switchView } from './ui.js';

// ⚠️ 执行顺序：applyTheme() 内部会读外观偏好（APPR_* 常量定义在更下面），
// 而这个文件是 defer 脚本、模块顶层就往下跑。直接在这里同步调用会踩 const 的
// TDZ（"Cannot access 'APPR_DEFAULTS' before initialization"），整页 JS 中断。
// 所以主题 / 视图 / 外观的首次应用统一延后到本 tick 之后 —— DOM 早已就绪，
// 属性写晚一个 tick 不闪（<head> 内联脚本已经先写好首屏值了）。
export function bootThemeAndView() {
  applyTheme(currentThemeMode(), false);
  applyViewMode(currentViewMode(), false);
}
requestAnimationFrame(() => requestAnimationFrame(bootThemeAndView));

/* ============================================================
 * 启动
 * ============================================================ */
(async function init() {
  // 校验登录态（未登录由 apiFetch 自动跳转）
  try {
    const res = await fetch('/api/session');
    const s = await res.json();
    if (!s.authenticated) {
      location.replace('/login.html');
      return;
    }
    state.username = s.username;
    state.role = s.role || 'user';
  } catch (_) { /* 忽略 */ }
  applyRoleUI();

  try {
    await loadFeeds();
  } catch (err) {
    toast('频道列表加载失败：' + (err.message || err), false);
  }
  // 频道接口顺带带回了「页面自动刷新」间隔，据此起定时器
  scheduleAutoRefresh();

  // 分享链接 ?feed=<id> 可直接筛到某个频道（卡片页和阅读页都生效）
  const urlFeed = new URLSearchParams(location.search).get('feed');
  if (urlFeed && (state.feedList || []).some((f) => String(f.id) === urlFeed && f.enabled)) {
    state.feedFilter = Number(urlFeed);
    state.rdFeedId = Number(urlFeed);
  }

  emitShell();
  await loadPage(true);

  // 打开哪个页面：hash 优先（可分享深链），其次上次记住的，默认「文章」
  let tab = currentTab();
  if (location.hash.startsWith('#cards')) tab = 'cards';
  else if (location.hash.startsWith('#favorite')) { tab = 'reader'; state.rdScope = 'favorite'; }
  else if (location.hash.startsWith('#unread')) { tab = 'reader'; state.rdScope = 'unread'; }
  else if (location.hash.startsWith('#reader')) tab = 'reader';
  // #digest 是老深链，那个页面已经升级成「AI」了，仍然认
  else if (location.hash.startsWith('#digest')) tab = 'ai';
  else if (location.hash.startsWith('#ai')) tab = 'ai';
  switchView(tab);

  if (location.hash.startsWith('#settings')) openSettings();
})();
