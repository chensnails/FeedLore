/* 笺川核心逻辑 · 页面级交互：视图切换 / 刷新 / OPML 导出 / 灯箱 / 顶栏快照 / PWA 安装 / 折叠分组
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { $, apiFetch, httpError, toast, emitShell, emitOverlays, prefersReducedMotion, feedTitle } from './util.js';
import { state, layoutPref, setLayout, openSettings, closeSettings, lockPageScroll, unlockPageScroll, THEME_MODES, THEME_META, currentThemeMode } from './state.js';
import { TABS, loadFeeds, loadPage, render, subtitleText, setCardsDrawer } from './feeds.js';
import { renderReader, renderReaderChannels, loadReader, setReaderDrawer, scrollReaderTop, markEntryRead, focusReaderArt } from './reader.js';
import { hideNewPill } from './autorefresh.js';

/* ============================================================
 * 事件绑定
 * ============================================================ */
// 卡片工具栏（搜索 / 频道 / 排序）与视图模式已随卡片视图 React 化
// （src/views/CardsView.jsx），交互经桥 cardsSearch / cardsFilterFeed / cardsSort /
// cardsView 改共享 state 并重绘；旧 DOM 绑定移除。

/* 刷新：先让服务端去抓一轮最新条目，再重新拉列表。
   顶栏「刷新」按钮已 React 化（src/shell/TopBar.jsx），经桥 switchView / refresh 调用。
   按钮的忙态（disabled + 图标自旋）由组件本地维护，这里只负责数据。 */
export async function refreshFeeds() {
  hideNewPill();   // 手动刷新了，自动刷新挂的那个「有新内容」提示就作废了
  try {
    const r = await apiFetch('/api/feeds/refresh', { method: 'POST' });
    const data = await r.json();
    await loadFeeds();
    state.tag = null;
    await loadPage(true);
    // 阅读页有自己的列表，也一起刷新（顺带更新左侧频道计数）
    renderReaderChannels();
    if (state.tab === 'reader' || state.rdEntries.length) await loadReader({ reset: true });
    if (data.failed && data.failed.length) toast(`已刷新，${data.failed.length} 个频道抓取失败`, false);
    else toast(data.added ? `已刷新，新增 ${data.added} 条` : '已刷新，没有新内容');
  } catch (err) {
    toast('刷新失败：' + (err.message || err), false);
  }
}

// 顶栏（设置 / 主题 / 刷新 / 视图导航）已随 App Shell React 化，
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


/* Esc = 关闭「最上面那一层」。这里只负责设置弹层，但要先看有没有更上层的覆盖物：
   整屏下拉弹层 / 命令面板 / 灯箱 / 确认框开着时，这一击归它们，不能顺手把设置也关掉。 */
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || !window.__settingsOpen) return;
  if (document.querySelector('.dd-mask')) return;                    // 移动端整屏下拉
  const cmdk = document.querySelector('.cmdk-mask:not([hidden])');
  if (cmdk) return;                                                  // 命令面板
  if (document.querySelector('.lightbox')) return;                   // 图片灯箱
  if (window.__confirmOpen) return;                                  // 统一确认框
  // 最后交给宿主：移动端停在「分区内容」这一层时，Esc 应先退回设置列表，
  // 只有已经在列表上才整层关闭（与「返回」按钮一致）。返回 true = 已消化。
  const host = window.__settingsHost;
  if (host && typeof host.escape === 'function' && host.escape()) return;
  closeSettings();
});

/* ============================================================
 * 页面切换（文章 / 卡片 / AI）
 * ============================================================ */
export function switchView(name) {
  if (TABS.indexOf(name) < 0) name = 'reader';
  // 日报关掉后这里兜一道：#digest 深链、命令面板遗留项、外部调用都从同一个口子回落，
  // 不用在每个入口各写一遍判断（顶栏按钮的隐藏只是让它平时看不见）
  if (name === 'ai' && layoutPref.digestEnabled === false) name = 'reader';
  const apply = () => {
    state.tab = name;
    setLayout('tab', name);   // 按账号持久化当前页面，刷新后保持一致
    hideNewPill();   // 浮标里的新内容是上一个页面拉到的，切页就作废
    // 离开文章页时把频道抽屉收掉（否则它会盖在卡片/AI 页上，还占着页面滚动锁）
    if (name !== 'reader') setReaderDrawer(false);
    // 卡片页的频道抽屉同理（v1.3.10）
    if (name !== 'cards') setCardsDrawer(false);

    $('#readerView').hidden = name !== 'reader';
    $('#cardsView').hidden = name !== 'cards';
    $('#aiView').hidden = name !== 'ai';
    // 顶栏（视图高亮 / 副标题 / 主题态）由 React 重绘
    emitShell();

    if (name === 'reader') {
      renderReaderChannels();
      // 已经有数据就不重新拉，避免来回切页面时列表闪一下
      if (!state.rdEntries.length) loadReader({ reset: true });
      else renderReader();
    }
    // AI 视图已 React 化：通知 AiView 激活 / 隐去（切到 ai 时由组件自行加载子页数据）
    window.dispatchEvent(new CustomEvent('__viewChanged', { detail: name }));

    window.scrollTo({ top: 0 });
  };
  // View Transitions API：视图切换时整页交叉淡入（渐进增强，减少动态效果时跳过）
  if (document.startViewTransition && !prefersReducedMotion()) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}

/** 正文里的标签：跳到卡片页按这个标签筛选 */
export function readerTagToCards(tag) {
  state.tag = tag;
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

// 全局快捷键：按 "/" 聚焦当前视图的搜索框（阅读页 / 卡片页）。输入框内正在打字时不拦截，
// 也不拦截带修饰键的组合（如 Ctrl+/），避免和浏览器/系统快捷键打架
document.addEventListener('keydown', (ev) => {
  if (ev.key !== '/' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  if (state.tab === 'cards') {
    // 卡片视图的搜索框已 React 化，聚焦经 window.__cardsFocusSearch 委托
    if (!window.__cardsFocusSearch) return;
    ev.preventDefault();
    window.__cardsFocusSearch();
    return;
  }
  if (state.tab !== 'reader') return;
  // 阅读页搜索框已 React 化，聚焦经 window.__readerFocusSearch 委托
  if (!window.__readerFocusSearch) return;
  ev.preventDefault();
  window.__readerFocusSearch();
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
export let deferredInstall = null;   // 捕获到的 beforeinstallprompt 事件（顶栏安装按钮经桥 promptInstall 触发）

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

// 让浏览器地址栏 / 状态栏颜色跟随主题（取顶栏底色 --panel，PWA 独立窗口更协调）
export function syncThemeColor() {
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
  // 与主题同源：直接取当前主题的 --panel（亮/暗/GitHub 三主题各自不同），
  // 不再硬编码 #171b22 / #ffffff（旧写法在 GitHub 主题下与页面底色不一致）。
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const panel = cs ? String(cs.getPropertyValue('--panel') || '').trim() : '';
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  meta.setAttribute('content', panel || (dark ? '#171b22' : '#ffffff'));
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
  if (focusId != null) state.rdQ = '';   // 搜索框里的旧关键词会把目标文章筛掉
  switchView('reader');
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
    if (window.__cardsFocusSearch) window.__cardsFocusSearch();   // 卡片搜索框已 React 化
    return;
  }
  if (state.tab !== 'reader') switchView('reader');
  if (window.__readerFocusSearch) window.__readerFocusSearch();
}


/* 卡片页条目收藏/已读：复用与阅读页相同的 /api/entries PATCH，但作用于卡片列表 state.entries。
 * 条目对象按「换一个新的」处理，不原地改字段：卡片是 React.memo 组件，引用不变就不会重绘。 */
export async function cardSetFlag(id, patch) {
  const list = state.entries || [];
  const idx = list.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) return false;
  const before = list[idx];
  const applied = Object.assign({}, before, patch);
  const withPatch = (entry) => {
    const arr = state.entries.slice();
    const i = arr.findIndex((x) => String(x.id) === String(id));
    if (i >= 0) arr[i] = entry;
    state.entries = arr;
  };
  withPatch(applied);
  render();   // 卡片由 React 渲染：改共享 state 后 tick 重绘（旧 paintCardFlag 就地改 DOM 移除）
  try {
    const res = await apiFetch('/api/entries/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (!res.ok) throw await httpError(res);
    return true;
  } catch (err) {
    withPatch(before); render();
    toast('标记失败：' + (err.message || err), false);
    return false;
  }
}

/* 卡片详情弹窗打开即算读过：卡片页本身不显示已读态，只把状态写回条目（文章页共享同一行）。
 * 同一条只发一次 PATCH —— 已读过就直接跳过，避免每次点开都打一次请求。 */
export function cardDetailRead(id) {
  const c = (state.entries || []).find((x) => String(x.id) === String(id));
  if (c && c.isRead) return;
  if ((state.rdEntries || []).some((x) => String(x.id) === String(id))) {
    // PATCH 与文章页列表同步交给 markEntryRead，卡片侧只落标记
    if (c) {
      state.entries = (state.entries || []).map((x) => (String(x.id) === String(id) ? Object.assign({}, x, { isRead: true }) : x));
    }
    markEntryRead(id);
    return;
  }
  cardSetFlag(id, { isRead: true });
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

/** App Shell（顶栏）一次性快照：React 的 TopBar 经桥 getShell() 读取 */
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
