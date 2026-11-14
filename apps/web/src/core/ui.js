/* 笺川核心逻辑 · 页面级交互：视图切换 / 刷新 / OPML 导出 / 灯箱 / 顶栏快照 / PWA 安装 / 折叠分组
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { $, apiFetch, httpError, toast, emitShell, emitOverlays, prefersReducedMotion, feedTitle, writeHash, parseHash } from './util.js';
import { state, layoutPref, setLayout, openSettings, closeSettings, lockPageScroll, unlockPageScroll, scrollActiveTop, rememberViewScroll, restoreViewScroll, THEME_MODES, THEME_META, currentThemeMode } from './state.js';
import { TABS, loadFeeds, loadPage, render, subtitleText, setCardsDrawer } from './feeds.js';
import { renderReader, renderReaderChannels, loadReader, setReaderDrawer, scrollReaderTop, markEntryRead, setEntryFlag, focusReaderArt, restoreReaderArt, clearReaderPin } from './reader.js';
import { hideNewPill } from './autorefresh.js';
import { clearImgFail } from '../imgFail.js';
import { emit, EVENT } from '../kernel/events.js';
import { get, isOn } from '../kernel/bridge.js';

/* ============================================================
 * 事件绑定
 * ============================================================ */
// 卡片工具栏（搜索 / 频道 / 排序）与视图模式已随卡片视图 React 化
// （src/views/CardsView.jsx），交互经桥 cardsSearch / cardsFilterFeed / cardsSort /
// cardsView 改共享 state 并重绘；旧 DOM 绑定移除。

/* 刷新：先让服务端去抓一轮最新条目，再重新拉列表。
   ⋮ 溢出菜单的「刷新」项经桥 refresh 调用（src/ui/OverflowMenu.jsx），
   按钮的忙态由组件本地维护，这里只负责数据。 */
/* 连点「刷新」不该叠一串抓取请求：弱网下它们会互相抢带宽，越刷越慢。 */
let refreshing = false;

export async function refreshFeeds() {
  if (refreshing) return;
  refreshing = true;
  hideNewPill();   // 手动刷新了，自动刷新挂的那个「有新内容」提示就作废了
  // 用户主动刷新 = 再给失败图一次机会（图源恢复、换了网络都会走到这里）
  clearImgFail();
  try {
    // 服务端要逐个抓 RSS，本来就慢，给它单独的较长上限；POST 不自动重试。
    const r = await apiFetch('/api/feeds/refresh', { method: 'POST', timeoutMs: 60000 });
    if (!r.ok) throw await httpError(r);
    const data = await r.json();
    await loadFeeds();
    state.tag = null;
    // 阅读页有自己的列表，也一起刷新（顺带更新左侧频道计数）
    renderReaderChannels();
    // 两页列表互不依赖，并行发出：旧实现串行 4 个请求，弱网下延迟直接累加。
    await Promise.all([
      loadPage(true),
      (state.tab === 'reader' || state.rdEntries.length) ? loadReader({ reset: true }) : Promise.resolve(),
    ]);
    if (data.failed && data.failed.length) toast(`已刷新，${data.failed.length} 个频道抓取失败`, false);
    else toast(data.added ? `已刷新，新增 ${data.added} 条` : '已刷新，没有新内容');
  } catch (err) {
    toast('刷新失败：' + (err.message || err), false);
  } finally {
    refreshing = false;
  }
}

// 视图导航（src/ui/ViewNav.jsx）与 ⋮ 菜单已 React 化，
// 交互经桥 openSettings / cycleTheme / refresh / switchView；旧 DOM 绑定移除。
// 设置弹层的关闭按钮 / 遮罩点击 / tab 点击由 src/settings/SettingsModal.jsx 内部处理。

/* OPML 导出：把当前账号的订阅源整理成标准 OPML（分组作为文件夹），浏览器下载 */
export function exportOpml() {
  const feeds = state.feedList || [];
  if (!feeds.length) { toast('没有可导出的订阅源', false); return; }
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const feedOutline = (f) => {
    const title = feedTitle(f) || f.url || '未命名订阅源';
    const xml = f.url || '';
    const html = f.siteUrl || '';
    return '    <outline type="rss" text="' + esc(title) + '" title="' + esc(title)
      + '" xmlUrl="' + esc(xml) + '" htmlUrl="' + esc(html) + '"/>';
  };
  // 按分组归类；未分组的放在顶层
  const groups = {};
  const ungrouped = [];
  for (const f of feeds) {
    const g = String(f.groupName || '').trim();
    if (g) (groups[g] = groups[g] || []).push(f);
    else ungrouped.push(f);
  }
  let body = '';
  for (const g of Object.keys(groups).sort((a, b) => a.localeCompare(b, 'zh'))) {
    body += '  <outline text="' + esc(g) + '" title="' + esc(g) + '">\n'
      + groups[g].map(feedOutline).join('\n') + '\n'
      + '  </outline>\n';
  }
  body += ungrouped.map(feedOutline).join('\n') + (ungrouped.length ? '\n' : '');
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<opml version="2.0">\n'
    + '  <head><title>FeedLore 订阅导出</title></head>\n'
    + '  <body>\n' + body + '  </body>\n</opml>\n';
  const blob = new Blob([xml], { type: 'text/x-opml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'feedlore-subscriptions-' + new Date().toISOString().slice(0, 10) + '.opml';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出 ' + feeds.length + ' 个订阅源');
}

/**
 * 触发一次同源 GET 下载。服务端用 Content-Disposition 给文件名，所以不给 download
 * 属性（给了浏览器会覆盖掉服务端命名）。临时锚点即点即弃，不打断当前页面。
 */
export function downloadUrl(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}


/* Esc = 关闭「最上面那一层」。这里只负责设置弹层，但要先看有没有更上层的覆盖物：
   整屏下拉弹层 / 命令面板 / 灯箱 / 确认框开着时，这一击归它们，不能顺手把设置也关掉。 */
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || !isOn('settingsOpen')) return;
  if (document.querySelector('.dd-mask')) return;                    // 移动端整屏下拉
  // 设置里的详情层（列表 → 详情）自己处理 Esc：输入框里第一击只失焦、第二击才关层。
  // 不让位的话，这一击会穿过详情层把整个设置弹层关掉。
  if (document.querySelector('.ds-sheet')) return;
  if (document.querySelector('.rule-scope-pop')) return;              // 规则适用范围浮层
  const cmdk = document.querySelector('.cmdk-mask:not([hidden])');
  if (cmdk) return;                                                  // 命令面板
  if (document.querySelector('.lightbox')) return;                   // 图片灯箱
  if (isOn('confirmOpen')) return;                                  // 统一确认框
  // 最后交给宿主：移动端停在「分区内容」这一层时，Esc 应先退回设置列表，
  // 只有已经在列表上才整层关闭（与「返回」按钮一致）。返回 true = 已消化。
  const host = get('settingsHost');
  if (host && typeof host.escape === 'function' && host.escape()) return;
  closeSettings();
});

/* ============================================================
 * 页面切换（文章 / 卡片 / AI）
 * ============================================================ */
export function switchView(name, opts) {
  if (TABS.indexOf(name) < 0) name = 'reader';
  const o = opts || {};
  const from = state.tab;
  // 切走之前先把「离开的那一页」滚到哪儿记下来；回来时（仅 ViewNav 显式要求）
  // 再恢复。默认仍回顶：换筛选 / 深链 / 命令面板跳转都不该沿用旧列表的位置。
  if (from !== name) rememberViewScroll(from);
  // 日报关掉后这里兜一道：#digest 深链、命令面板遗留项、外部调用都从同一个口子回落，
  // 不用在每个入口各写一遍判断（顶栏按钮的隐藏只是让它平时看不见）
  if (name === 'ai' && layoutPref.digestEnabled === false) name = 'reader';
  const same = from === name;
  // AI 视图按需加载（v2.2.0）：切过去之前先发起 chunk 下载，别等视图切完才开始。
  const mountAi = get('mountAi');
  if (name === 'ai' && typeof mountAi === 'function') {
    const p = mountAi();
    if (p && p.catch) p.catch(() => toast('AI 页面加载失败，请检查网络后重试', false));
  }
  const apply = () => {
    state.tab = name;
    setLayout('tab', name);   // 按账号持久化当前页面，刷新后保持一致
    hideNewPill();   // 浮标里的新内容是上一个页面拉到的，切页就作废
    // 离开文章页时把频道抽屉收掉（否则它会盖在卡片/AI 页上，还占着页面滚动锁）
    if (name !== 'reader') setReaderDrawer(false);
    // 置顶只管当前这一次进入：离开文章页就作废，回来后的翻页不该再按旧目标重校
    if (name !== 'reader') clearReaderPin();
    // 卡片页的频道抽屉同理（v1.3.10）
    if (name !== 'cards') setCardsDrawer(false);

    $('#readerView').hidden = name !== 'reader';
    $('#cardsView').hidden = name !== 'cards';
    $('#aiView').hidden = name !== 'ai';
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
    else if (o.restoreScroll && !same) restoreViewScroll(name);
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
      if (transition && transition.finished && transition.finished.catch) transition.finished.catch(() => {});
      if (transition && transition.ready && transition.ready.catch) transition.ready.catch(() => {});
      // apply 是异步落地的（旧画面快照后才执行）；返回 updateCallbackDone，
      // 让启动流程能等到「视图已切、首屏请求已发出」再做后续判断。
      if (transition && transition.updateCallbackDone) return transition.updateCallbackDone.catch(() => {});
      return Promise.resolve();
    } catch (_) { /* 老实现同步抛错 → 走无动画路径 */ }
    if (!started) apply();
    return Promise.resolve();
  }
  apply();
  return Promise.resolve();
}

/* 浏览器前进 / 后退：按地址栏 hash 恢复视图与文章。
 * 策略与「进入一篇文章」完全一致——回到哪篇，就从那篇的开头看起（不保留离开时的滚动位置：
 * 列表是服务端分页的，位置未必还能落在同一篇上，保留它反而会停在半截正文）。
 * 正常情况下本应用只用 replaceState（不产生同文档历史），这里兜住手动改 hash / 站内返回等场景。 */
window.addEventListener('popstate', () => {
  const { tab, artId } = parseHash(location.hash);
  if (tab && tab !== state.tab) switchView(tab);
  if (tab === 'reader' && artId) restoreReaderArt(artId);
});

/** 正文里的标签：跳到卡片页按这个标签筛选 */
export function readerTagToCards(tag) {  state.tag = tag;
  switchView('cards');
  render();   // 卡片视图重绘
  toast('已按标签筛选：#' + tag);
}

/* ---------- 图片灯箱 ----------
 * index.html 与 style.css 里一直有 .lightbox，但之前没有任何 JS 接上它，
 * 于是图片上写着「点击查看大图」却点不动。这里补齐：点图看大图，点任意处或 Esc 关闭。
 * v2.1.0 起灯箱 DOM 改由 src/ui/Overlays.jsx 渲染，核心只维护状态并派发 __overlaysTick。
 * v1.6.0-test4 起：同一篇正文里的图组成一组，支持 ← → 翻看；关闭时把焦点还给触发图。
 */
export let lightboxState = { src: '', show: false, list: [], index: 0 };
/** 触发灯箱的元素（不放进 state：它是 DOM 引用，进 state 会跟着快照到处传） */
let lightboxOpener = null;

export function openLightbox(src, opts) {
  if (!src) return;
  const o = opts || {};
  const list = Array.isArray(o.list) && o.list.length ? o.list : [src];
  const i = list.indexOf(src);
  lightboxOpener = o.opener || null;
  lightboxState = { src, show: true, list, index: i < 0 ? 0 : i };
  emitOverlays();
  lockPageScroll();
}

export function closeLightbox() {
  if (!lightboxState.show) return;
  lightboxState = { src: '', show: false, list: [], index: 0 };
  emitOverlays();
  unlockPageScroll();
  // 焦点归还触发图：不还的话关掉后焦点掉到 body，键盘用户得从头 Tab。
  // 正文图是 <img>、默认不可聚焦，临时补 tabindex="-1"（不进 Tab 序列，但可程序聚焦）。
  const op = lightboxOpener;
  lightboxOpener = null;
  if (op && document.contains(op) && typeof op.focus === 'function') {
    if (!op.hasAttribute('tabindex') && !op.matches('a[href],button,input,select,textarea')) {
      op.setAttribute('tabindex', '-1');
    }
    op.focus();
  }
}

/** 组内翻页（±1）。只有一张图时是空操作。 */
export function stepLightbox(d) {
  const st = lightboxState;
  if (!st.show || !st.list || st.list.length < 2) return;
  const n = st.list.length;
  const i = ((st.index + d) % n + n) % n;
  lightboxState = { ...st, src: st.list[i], index: i };
  emitOverlays();
}

document.addEventListener('click', (ev) => {
  if (lightboxState.show) { closeLightbox(); return; }   // 开着的时候点哪儿都关
  const img = ev.target.closest ? ev.target.closest('.art-img') : null;
  if (!img) return;
  // 同一篇正文内的图算一组：卡片详情 / 文章页正文 / 列表展开体
  const scope = img.closest('.art-body, .cd-body, .cd-modal, .art-item') || document;
  const list = Array.prototype.map
    .call(scope.querySelectorAll('.art-img'), (el) => el.getAttribute('src'))
    .filter(Boolean);
  openLightbox(img.getAttribute('src'), { list, opener: img });
});

document.addEventListener('keydown', (ev) => {
  if (!lightboxState.show) return;
  if (ev.key === 'Escape') closeLightbox();
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); stepLightbox(1); }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepLightbox(-1); }
});

/* ============================================================
 * PWA：Service Worker + 「添加到手机」
 * ============================================================ */
// 注册 Service Worker（仅 https / localhost 会生效；用 http 的局域网 IP 访问时静默忽略）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 非安全上下文，忽略 */ });
  });
}

// 安装到手机：Chromium 系（Edge / Chrome）满足条件时会触发 beforeinstallprompt
export let deferredInstall = null;   // 捕获到的 beforeinstallprompt 事件（账号面板「一键安装」经桥 promptInstall 触发）

window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  deferredInstall = ev;
  emitShell();   // 顶栏「添加到手机」按钮由 React 按 installReady 显隐
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  emitShell();
  toast('已添加到手机');
});

/** 触发安装（返回是否真的弹了；顶栏按钮与账号面板「一键安装」共用） */
export async function promptInstall() {
  if (!deferredInstall) return false;
  deferredInstall.prompt();
  let outcome = 'dismissed';
  try { ({ outcome } = await deferredInstall.userChoice); } catch (_) { /* 忽略 */ }
  deferredInstall = null;
  emitShell();
  if (outcome === 'accepted') toast('已添加到手机');
  return true;
}

// 让浏览器地址栏 / 状态栏颜色跟随主题（取页面底色 --bg，系统栏与页面顶部不会差一档灰）
export function syncThemeColor() {
  // 首页有亮 / 暗两条带 media 的兜底 meta，浏览器按系统深浅命中其中一条：
  // 只改第一条会让另一条一直留着首屏的旧色，必须全部写成同一个值。
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  // 与主题同源：取当前主题的 --bg（亮/暗/GitHub 三主题各自不同）。
  // 不取 --panel —— 页面顶部与底栏下方露出的都是 --bg，报 --panel 会差一档灰。
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const bg = cs ? String(cs.getPropertyValue('--bg') || '').trim() : '';
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const color = bg || (dark ? '#242424' : '#f4f5f7');
  if (!metas.length) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
    meta.setAttribute('content', color);
    return;
  }
  metas.forEach((meta) => meta.setAttribute('content', color));
}
syncThemeColor();
new MutationObserver(syncThemeColor).observe(document.documentElement, {
  attributes: true, attributeFilter: ['data-theme'],
});

/* ============================================================
 * 可折叠分组（<details class="sec" data-sec="…">）
 * 用原生 <details>/<summary>（键盘可操作、无障碍语义天然正确），
 * 这里只做两件事：按 data-sec 记住每组的开合状态、由各表单更新摘要行。
 * 开合状态按账号持久化（users.prefs.layout.sections），不再落浏览器 localStorage。
 * ============================================================ */
export function savedSections() {
  return (layoutPref.sections && typeof layoutPref.sections === 'object') ? layoutPref.sections : {};
}

export function saveSectionState(key, open) {
  const next = Object.assign({}, layoutPref.sections || {}, { [key]: !!open });
  setLayout('sections', next);
}

/**
 * 给 root 里所有 details.sec 套上记住的开合状态，并挂上变化监听。
 * 静态区域在启动时调一次就够；**动态重绘的区域每次渲染后都要再调一次**
 * —— 状态页每 30s 重绘一遍，不重新绑定的话展开态会被冲掉。
 */
export function bindSections(root) {
  const saved = savedSections();
  (root || document).querySelectorAll('details.sec[data-sec]').forEach((d) => {
    if (d.dataset.secBound === '1') return;   // 已经绑过，别重复挂监听
    d.dataset.secBound = '1';
    const k = d.getAttribute('data-sec');
    if (k in saved) d.open = !!saved[k];
    d.addEventListener('toggle', () => saveSectionState(k, d.open));
  });
}

bindSections(document);

/* ============================================================
 * 现代交互增强（渐进增强）
 *  1) 顶部阅读进度条（滚动驱动）—— 已移除（滚动卡顿来源）
 *  2) 命令面板 ⌘K / Ctrl+K（参考 Linear / Vercel，已迁移为 React 组件）
 * ============================================================ */

/* ---------- 1) 阅读进度条 / 2) 命令面板（均已迁移为 React 组件） ----------
   顶部阅读进度条已移除（与 sticky 顶栏的 backdrop-filter 同为滚动卡顿来源）；
   实现在 src/cmdk/CommandPalette.jsx，由 <script type="module" src="/src/main.jsx">
   挂载到 index.html 的 #cmdkRoot；旧 DOM（#cmdkMask 等）与 PINYIN 表已一并移除。
   下面的 selectScope / jumpToFeed / focusSearchBox 是普通页面函数，
   通过文件末尾导出的 `core` 单例供 React 组件调用（v2.0.0 起改为模块引用）。 */

export function selectScope(scope) {
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
 *  focusId 只在这一次跳转里用，不写进任何持久化偏好。 */
export function jumpToFeed(id, focusId) {
  // 先落筛选条件再切页：switchView 在列表为空时会自动加载，用目标频道的筛选才不白拉一次
  state.rdScope = 'all';
  state.rdFeedId = Number(id);
  state.rdGroup = null;
  state.rdWatch = null;   // 从关注/屏蔽视图点进具体频道，得退出聚合视图
  if (focusId != null) state.rdQ = '';   // 搜索框里的旧关键词会把目标文章筛掉
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
    const focusCards = get('cardsFocusSearch');
    if (focusCards) focusCards();   // 卡片搜索框已 React 化
    return;
  }
  if (state.tab !== 'reader') switchView('reader');
  const focusReader = get('readerFocusSearch');
  if (focusReader) focusReader();
}

// 「/」聚焦搜索：命令面板里一直写着这个提示，之前却没有对应的按键处理。
// 正在输入框里打字时不抢（用户可能真的要打斜杠），任何弹层开着时也不抢。
document.addEventListener('keydown', (ev) => {
  if (ev.key !== '/' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const t = ev.target;
  if (t && (t.isContentEditable || (t.matches && t.matches('input,textarea,select')))) return;
  if (isOn('settingsOpen') || isOn('cmdkOpen') || isOn('confirmOpen')) return;
  // 设置弹层常驻挂载（关闭时只是 hidden），必须排除隐藏态，否则「/」永远被它吃掉
  if (document.querySelector('.lightbox, .modal-mask:not([hidden]), .dd-mask:not([hidden])')) return;
  ev.preventDefault();
  focusSearchBox();
});


/* 卡片页条目收藏/已读：与阅读页走同一套标记逻辑（reader.js 的 setEntryFlag）——
 * 两页列表各持一份条目对象，统一入口才能保证改一处、两边同时换新对象并同步计数。 */
export function cardSetFlag(id, patch) {
  return setEntryFlag(id, patch);
}

/* 卡片详情弹窗打开即算读过：与文章页展开同样走 markEntryRead（状态同步到两页列表）。
 * 同一条只发一次 PATCH —— 已读过就直接跳过，避免每次点开都打一次请求。 */
export function cardDetailRead(id) {
  markEntryRead(id);
}

/** 日报对本账号是否开启（顶栏入口、命令面板项、设置面板的开关都读这一个判据） */
export const digestIsEnabled = () => layoutPref.digestEnabled !== false;

/** 开 / 关日报（设置面板的开关经桥调用）。
 *  关掉时如果正停在日报页，得把人带走 —— 否则入口消失了、页面还杵在那儿。 */
export function setDigestEnabled(on) {
  const next = on !== false;
  if (digestIsEnabled() === next) return;
  setLayout('digestEnabled', next);
  if (!next && state.tab === 'ai') switchView('reader');
  emitShell();
}

/** 视图导航 / ⋮ 菜单的一次性快照：React 组件经桥 getShell() 读取 */
export function shellSnapshot() {
  const mode = THEME_MODES.indexOf(currentThemeMode()) >= 0 ? currentThemeMode() : 'auto';
  const meta = THEME_META[mode];
  return {
    subtitle: subtitleText(),
    view: state.tab,
    themeLabel: meta.label,
    themeIco: meta.ico,
    installReady: !!deferredInstall,
    digestVisible: digestIsEnabled(),
  };
}
