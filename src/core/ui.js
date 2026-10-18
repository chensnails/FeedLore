/* 笺川核心逻辑 · 页面级交互：视图切换 / 刷新 / OPML 导出 / 灯箱 / 键盘导航 / 顶栏快照 / PWA 安装 / 折叠分组
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { $, apiFetch, toast, emitShell, emitOverlays, prefersReducedMotion, feedTitle } from './util.js';
import { state, layoutPref, setLayout, openSettings, closeSettings, lockPageScroll, unlockPageScroll, THEME_MODES, THEME_META, currentThemeMode, isAdmin } from './state.js';
import { TABS, loadFeeds, loadPage, applyFilters, render, subtitleText, setViewMode } from './feeds.js';
import { renderReader, renderReaderChannels, loadReader, setReaderDrawer, scrollReaderTop, readerToggleArt, readerToggleFav, markEntryRead } from './reader.js';
import { hideNewPill } from './autorefresh.js';

/* ============================================================
 * 事件绑定
 * ============================================================ */
// 卡片工具栏（搜索 / 频道 / 排序 / 体积）与视图模式已随卡片视图 React 化
// （src/views/CardsView.jsx），交互经桥 cardsSearch / cardsFilterFeed / cardsSort /
// cardsSize / cardsView 改共享 state 并重绘；旧 DOM 绑定移除。

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
    + '  <head><title>ShiYue 订阅导出</title></head>\n'
    + '  <body>\n' + body + '  </body>\n</opml>\n';
  const blob = new Blob([xml], { type: 'text/x-opml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'shiyue-subscriptions-' + new Date().toISOString().slice(0, 10) + '.opml';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出 ' + feeds.length + ' 个订阅源');
}


document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && window.__settingsOpen) closeSettings();
});

/* ============================================================
 * 页面切换（文章 / 卡片 / AI）
 * ============================================================ */
export function switchView(name) {
  if (TABS.indexOf(name) < 0) name = 'reader';
  const apply = () => {
    state.tab = name;
    setLayout('tab', name);   // 按账号持久化当前页面，刷新后保持一致
    hideNewPill();   // 浮标里的新内容是上一个页面拉到的，切页就作废
    // 离开文章页时把频道抽屉收掉（否则它会盖在卡片/AI 页上，还占着页面滚动锁）
    if (name !== 'reader') setReaderDrawer(false);

    $('#readerView').hidden = name !== 'reader';
    $('#cardsView').hidden = name !== 'cards';
    $('#aiView').hidden = name !== 'ai';
    // 顶栏（视图高亮 + 「条资源」仅卡片页可见）由 React 重绘
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
 */
export let lightboxState = { src: '', show: false };

export function openLightbox(src) {
  if (!src) return;
  lightboxState = { src, show: true };
  emitOverlays();
  lockPageScroll();
}

export function closeLightbox() {
  if (!lightboxState.show) return;
  lightboxState = { src: '', show: false };
  emitOverlays();
  unlockPageScroll();
}

document.addEventListener('click', (ev) => {
  if (lightboxState.show) { closeLightbox(); return; }   // 开着的时候点哪儿都关
  const img = ev.target.closest ? ev.target.closest('.art-img') : null;
  if (img) openLightbox(img.getAttribute('src'));
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && lightboxState.show) closeLightbox();
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
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
  meta.setAttribute('content', dark ? '#171b22' : '#ffffff');
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
 * 现代交互增强（渐进增强，与现有快捷键互不冲突）
 *  1) 顶部阅读进度条（滚动驱动）
 *  2) 命令面板 ⌘K / Ctrl+K（参考 Linear / Vercel）
 *  3) 阅读页键盘导航 j/k 上下、o/↵ 展开、f 收藏、r 已读
 * ============================================================ */

/* ---------- 1) 阅读进度条 / 2) 命令面板（均已迁移为 React 组件） ----------
   进度条见 src/shell/TopBar.jsx 的 ReadProgress；
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
export function jumpToFeed(id) {
  switchView('reader');
  state.rdScope = 'all';
  state.rdFeedId = Number(id);
  state.rdGroup = null;
  renderReaderChannels();
  loadReader({ reset: true });
  emitShell();
  setReaderDrawer(false);
  scrollReaderTop();
}
export function focusSearchBox() {
  if (state.tab === 'cards') {
    if (window.__cardsFocusSearch) window.__cardsFocusSearch();   // 卡片搜索框已 React 化
    return;
  }
  if (state.tab !== 'reader') switchView('reader');
  if (window.__readerFocusSearch) window.__readerFocusSearch();
}

/* ---------- 3) 阅读页键盘导航 ---------- */
export let kbdIdx = -1;
export function kbdItems() {
  if (state.tab === 'reader') return Array.prototype.slice.call(document.querySelectorAll('#readerList .art-item'));
  if (state.tab === 'cards') return Array.prototype.slice.call(document.querySelectorAll(state.view === 'list' ? '#grid .row-item' : '#grid .card'));
  return [];
}
export function clearKbdFocus() {
  document.querySelectorAll('.art-item.kbd-focus, .card.kbd-focus, .row-item.kbd-focus')
    .forEach((el) => el.classList.remove('kbd-focus'));
  kbdIdx = -1;
}
export function moveKbd(d) {
  const items = kbdItems();
  if (!items.length) return;
  kbdIdx = kbdIdx < 0 ? (d > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, kbdIdx + d));
  items.forEach((el, i) => el.classList.toggle('kbd-focus', i === kbdIdx));
  if (items[kbdIdx]) items[kbdIdx].scrollIntoView({ block: 'nearest' });
}
export function isTypingTarget(el) {
  if (!el) return false;
  const t = el.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'BUTTON' || t === 'SELECT' || t === 'A' || el.isContentEditable;
}
document.addEventListener('keydown', (ev) => {
  // 面板开着时不响应 j/k（命令面板 / 设置弹层均已 React 化，
  // 通过 window.__cmdkOpen / window.__settingsOpen 同步开合状态）
  if (window.__cmdkOpen || window.__settingsOpen) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (isTypingTarget(document.activeElement)) return;
  if (window.__settingsOpen || !lightbox.hidden) return;
  const items = kbdItems();
  if (ev.key === 'j' || ev.key === 'k') {
    ev.preventDefault();
    moveKbd(ev.key === 'j' ? 1 : -1);
  } else if (kbdIdx >= 0 && items[kbdIdx]) {
    const el = items[kbdIdx];
    const onCards = state.tab === 'cards';
    if (ev.key === 'o' || ev.key === 'Enter') {
      ev.preventDefault();
      if (onCards) { const b = el.querySelector('.btn-open'); if (b) b.click(); }
      else readerToggleArt(el.dataset.id);
    } else if (ev.key === 'f') {
      ev.preventDefault();
      if (onCards) cardSetFlag(el.dataset.id, { isFavorite: !isCardFav(el.dataset.id) });
      else readerToggleFav(el.dataset.id);
    } else if (ev.key === 'r') {
      ev.preventDefault();
      if (onCards) cardSetFlag(el.dataset.id, { isRead: true });
      else markEntryRead(el.dataset.id);
    }
  }
});
// 列表重绘（翻页 / 筛选 / 点击）后清掉键盘焦点态，避免错位
// 阅读页列表由 React 渲染，用事件委托清键盘焦点态
document.addEventListener('click', (ev) => { if (ev.target.closest && ev.target.closest('#readerList')) clearKbdFocus(); });
// 卡片列表由 React 渲染，用事件委托清键盘焦点态（旧 grid 常量已移除）
document.addEventListener('click', (ev) => { if (ev.target.closest && ev.target.closest('#grid')) clearKbdFocus(); });

/* 卡片页条目收藏/已读：复用与阅读页相同的 /api/entries PATCH，但作用于卡片列表 state.entries */
export function isCardFav(id) {
  const e = (state.entries || []).find((x) => String(x.id) === String(id));
  return !!(e && e.isFavorite);
}
export async function cardSetFlag(id, patch) {
  const list = state.entries || [];
  const e = list.find((x) => String(x.id) === String(id));
  if (!e) return false;
  const before = { isRead: !!e.isRead, isFavorite: !!e.isFavorite };
  Object.assign(e, patch);
  render();   // 卡片由 React 渲染：改共享 state 后 tick 重绘（旧 paintCardFlag 就地改 DOM 移除）
  try {
    const res = await apiFetch('/api/entries/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return true;
  } catch (err) {
    Object.assign(e, before); render();
    toast('标记失败：' + (err.message || err), false);
    return false;
  }
}

/** App Shell（顶栏）一次性快照：React 的 TopBar 经桥 getShell() 读取 */
export function shellSnapshot() {
  const mode = THEME_MODES.indexOf(currentThemeMode()) >= 0 ? currentThemeMode() : 'auto';
  const meta = THEME_META[mode];
  return {
    stat: state.entries.length,
    subtitle: subtitleText(),
    view: state.tab,
    themeLabel: meta.label,
    themeIco: meta.ico,
    installReady: !!deferredInstall,
    statVisible: state.tab === 'cards',
  };
}
