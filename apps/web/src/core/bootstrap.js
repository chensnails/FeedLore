/* 笺川核心逻辑 · 启动：首屏主题 / 视图应用 + 登录态校验 + 首次数据加载 + 深链定位
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { toast, emitShell } from './util.js';
import { state, applyRoleUI, applyTheme, currentThemeMode, openSettings } from './state.js';
import { currentViewMode, applyViewMode, currentTab, loadFeeds } from './feeds.js';
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
/* 同样要定时兜底：后台标签页不排帧，只等帧的话首屏主题 / 视图模式会一直不落地，
   用户切过来才跳一下（bootThemeAndView 幂等，双通道重复执行没有副作用）。 */
requestAnimationFrame(() => requestAnimationFrame(bootThemeAndView));
setTimeout(bootThemeAndView, 300);

/* ============================================================
 * 启动
 * ============================================================ */
/* 启动层收口：ready 只在首个视图真正渲染后调用；fail 让启动层原地给出错误与「重新加载」，
   而不是留一片白屏 + 一条很快消失的 toast。 */
function bootReady() {
  if (!window.__boot) return;
  /* 帧信号 + 定时兜底双通道：不可见页面不排帧（后台标签页里 rAF 永不触发），
     只等帧的话 12s 看门狗会把「用户还在别的标签页」误报成「加载超时」。
     index.html 的 dismiss 自带 done 幂等，谁先到算谁。 */
  requestAnimationFrame(() => window.__boot.ready());
  setTimeout(() => window.__boot.ready(), 300);
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
  // React 提交后再等两帧，确保首屏内容真正画出来。
  // 后台标签页不排帧，只等帧会让整条启动链卡在这里（启动层于是被看门狗判成超时），
  // 所以给帧一个定时兜底：拿不到帧也放行。
  await Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    new Promise((r) => setTimeout(r, 300)),
  ]);
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

  // 首屏列表统一由 switchView 触发（唯一入口），这里**不再 await 数据请求**。
  // 旧实现在卡片页先串行等完列表请求才切视图：弱网下请求一挂住，整条启动链
  // 就停在 await 上，bootReady 永远不来，12s 看门狗把「还在等数据」误报成启动失败，
  // 错误层盖住整页，连应用内那个带「重试」的错误空态都没机会渲染（实测复现）。
  // 启动层只负责「外壳已经画出来」；数据的骨架 / 失败态 / 重试交给应用内自己负责。
  await switchView(tab);

  if (location.hash.startsWith('#settings')) openSettings();

  // 外壳就绪即收口（bootReady 自带帧 + 定时双通道，后台标签页也不会被看门狗误伤）。
  // dismiss 本身至少留 350ms，正常网络下首屏数据这时已经落地，不会有空白跳变。
  bootReady();

  // 条目级深链要等列表落地才能展开那一篇；此刻启动层已淡出，等待不会锁死页面。
  if (deepArtId) {
    await waitViewFirstPaint('reader');
    await restoreReaderArt(deepArtId);
  }
})().catch((err) => {
  bootFail('加载失败：' + (err && err.message ? err.message : '未知错误'));
});
