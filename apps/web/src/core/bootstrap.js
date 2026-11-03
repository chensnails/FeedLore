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
import { restoreReaderArt } from './reader.js';

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
/* 启动层收口：ready 只在首个视图真正渲染后调用；fail 让启动层原地给出错误与「重新加载」，
   而不是留一片白屏 + 一条很快消失的 toast。 */
function bootReady() {
  if (window.__boot) requestAnimationFrame(() => window.__boot.ready());
}
function bootFail(message) {
  if (window.__boot) window.__boot.fail(message);
}
/* switchView 在支持 View Transitions 时是异步落地的（apply 回调在旧画面快照后才执行），
   文章列表又是在 apply 里才发起请求；启动层如果立刻退，会先看到空头部，再等列表补进来。
   这里等到「目标视图已显示 + 首屏数据请求结束 + 列表 DOM 出现」再淡出，
   失败态也放行，让用户在应用内看到错误提示而不是一直卡在启动层。 */
async function waitViewFirstPaint(tab) {
  const viewId = { reader: 'readerView', cards: 'cardsView', ai: 'aiView' }[tab] || 'readerView';
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const el = document.getElementById(viewId);
    if (el && !el.hidden) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (tab === 'reader') {
    while (state.rdLoading && Date.now() - t0 < 12000) await new Promise((r) => setTimeout(r, 50));
    if (state.rdEntries.length && !state.rdReadError) {
      const t = Date.now();
      while (!document.querySelector('#readerList .art-item') && Date.now() - t < 3000) {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
  } else if (tab === 'cards') {
    while (state.loading && Date.now() - t0 < 12000) await new Promise((r) => setTimeout(r, 50));
    if ((state.entries || []).length && !state.loadError) {
      const t = Date.now();
      while (!document.querySelector('#grid .card, #grid .row-item') && Date.now() - t < 3000) {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
  }
  // React 提交后再等两帧，确保首屏内容真正画出来
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

(async function init() {
  // 会话与频道列表互不依赖：并行发出，弱网下省掉一次串行往返。
  // allSettled 一次等齐两个请求，也避免先失败的一方留下未处理的 rejection。
  const [sessionRes, feedsRes] = await Promise.allSettled([
    fetch('/api/session').then((res) => res.json()),
    loadFeeds(),
  ]);

  if (sessionRes.status === 'rejected') {
    bootFail('无法连接服务器，请检查网络后重试');
    return;
  }
  const s = sessionRes.value;
  if (!s.authenticated) {
    // 频道请求若已因 401 跳了登录页（apiFetch 会带上 next），这里不要再覆盖它
    if (feedsRes.status === 'fulfilled') location.replace('/login.html');
    return;
  }
  state.username = s.username;
  state.role = s.role || 'user';
  applyRoleUI();

  if (feedsRes.status === 'rejected') {
    const err = feedsRes.reason;
    bootFail('频道列表加载失败，请重试');
    toast('频道列表加载失败：' + (err && err.message ? err.message : err), false);
    return;
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

  // 打开哪个页面：hash 优先（可分享深链），其次上次记住的，默认「文章」
  // hash 形如 #cards / #reader / #ai，条目级深链是 #reader/art/<id>（进入某篇）
  // ⚠️ 先定目标视图再拉列表（v2.2.0）：以前无条件加载卡片列表，从文章页启动时
  //    白拉一整页用户看不到的卡片和图片请求。
  let tab = currentTab();
  let deepArtId = null;
  if (location.hash.startsWith('#reader/art/')) { tab = 'reader'; deepArtId = location.hash.slice('#reader/art/'.length); }
  else if (location.hash.startsWith('#cards')) tab = 'cards';
  else if (location.hash.startsWith('#favorite')) { tab = 'reader'; state.rdScope = 'favorite'; }
  else if (location.hash.startsWith('#unread')) { tab = 'reader'; state.rdScope = 'unread'; }
  else if (location.hash.startsWith('#reader')) tab = 'reader';
  // #digest 是老深链，那个页面已经升级成「AI」了，仍然认
  else if (location.hash.startsWith('#digest')) tab = 'ai';
  else if (location.hash.startsWith('#ai')) tab = 'ai';

  // 文章页的列表由 switchView 内的 loadReader 拉；卡片页没有自加载，这里补首屏
  if (tab === 'cards') await loadPage(true);
  await switchView(tab);

  if (location.hash.startsWith('#settings')) openSettings();

  // 条目级深链：列表落地后展开那一篇并置顶（与「点下一篇进入」同一策略）
  if (deepArtId) {
    await waitViewFirstPaint('reader');
    await restoreReaderArt(deepArtId);
  } else {
    await waitViewFirstPaint(tab);
  }

  bootReady();
})().catch((err) => {
  bootFail('加载失败：' + (err && err.message ? err.message : '未知错误'));
});
