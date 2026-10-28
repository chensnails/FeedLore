/* 笺川核心逻辑 · 全局状态 + 账号偏好（布局 / 外观 / 主题）+ 设置宿主与页面滚动锁
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { toast, emitShell } from './util.js';

/* ---------------- 常量 ----------------
 * 分页长度固定：卡片页 50 条，文章页 40 篇。
 */
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_READER_PAGE = 40;

/* ---------------- 状态 ---------------- */
export const state = {
  entries: [],
  offset: 0,
  hasMore: true,
  loading: false,
  loadError: false,   // 首屏加载失败（React 卡片视图据此显示错误空态）
  q: '',
  sort: 'new',        // 阅读页排序：new 最新 / old 最早 / name 名称（按账号持久化）
  tag: null,
  view: 'grid',       // 'grid' 卡片视图 | 'list' 列表视图（按账号持久化）
  pageSize: DEFAULT_PAGE_SIZE,
  readerPageSize: DEFAULT_READER_PAGE,
  tagline: '拾取值得读的',
  feedFilter: null,   // 列表页的频道筛选：null = 全部已开启卡片开关的频道
  feedList: null,     // /api/feeds 的 feeds 数组
  feedMeta: null,     // /api/feeds 的整体信息（total / enabled / cardEnabled / groups）
  groupOrder: [],     // 分组顺序（显式保存的串名数组，未分组不计入）
  collapsedGroups: new Set(),  // 分组折叠状态（折叠的分组名集合，按账号持久化）
  tags: [],           // 服务端返回的标签计数
  username: null,
  role: null,         // 'admin' | 'user' —— 决定设置里哪些 tab / 分组可见

  /* ---- 阅读页（文章）----
   * 跟卡片页各自持有自己的一份列表，互不干扰：阅读页按「当前选中的频道」拉，
   * 卡片页按工具栏的筛选条件拉。展开状态只存在内存里，刷新页面就回到全部收起。 */
  tab: 'reader',        // 当前页面：reader 文章 / cards 卡片 / ai AI（按账号持久化）
  rdScope: 'all',       // 阅读页默认范围：all 全部 / unread 未读 / favorite 收藏（按账号持久化）
  rdFeedId: null,       // 阅读页选中的频道：null = 全部已开启频道
  rdGroup: null,        // 阅读页选中的分组：null = 不限分组；'' 表示「未分组」
  rdWatch: null,        // 关注 / 屏蔽虚拟视图（v21）：null 常规 / 'watch' 关注 / 'block' 屏蔽。
                        // 命中条目不打搬动、只打标记（entries.watch_state），这里选中的是
                        // 「WHERE watch_state = ?」的聚合视图，与范围（未读/收藏）可叠加。
  rdQ: '',              // 阅读页搜索关键词（走服务端检索）
  rdFlags: { total: 0, unread: 0, favorite: 0, watching: 0, blocked: 0 },   // 侧栏计数（含关注/屏蔽命中数）
  rdEntries: [],
  rdOffset: 0,
  rdHasMore: true,
  rdLoading: false,
  rdExpanded: new Set(),   // 已展开的条目 id
  rdBody: new Map(),       // id -> 正文（展开时才拉，拉过就缓存）
  rdBodyErr: new Set(),    // 拉正文失败的 id，避免反复重试
  rdReadError: false,      // 首屏加载失败（React 阅读页据此显示错误空态）
  rdReadErrorMsg: '',
  /* 刚从卡片页跳过来、要在文章框上闪一下高亮的那条 id（字符串比较）；
     只活一瞬（core/reader.js 的 focusReaderArt 设、定时器清），不落任何持久化。 */
  rdFlashId: null,
};

/* ---------------- 频道栏宽度 ----------------
 * 实际生效的是 :root 上的 --reader-side-w（.reader 网格第一列引用它）。
 * 拖拽跟手期间由组件直接写这个变量（一次拖拽几十帧，走 state 会把整棵阅读页重渲染），
 * 松手才调一次 setReaderSideWidth 落账号偏好 —— 与主题 / 字号同一条防抖写入通道。
 * 两道上限：持久化只按硬边界 180~400 收（换设备屏幕不同，不该把值改没），
 * 渲染时再按 40vw 自适应收紧（窄笔记本上拖不爆内容区）。 */
export const READER_SIDE_DEFAULT = 232;   // 与 style.css 里 --reader-side-w 的回退值同源
export const READER_SIDE_MIN = 180;
export const READER_SIDE_MAX = 400;

/** 持久化用的硬边界：非法值（0 / NaN / 串）一律回落默认 */
export function clampReaderSide(px) {
  const n = Math.round(Number(px));
  if (!Number.isFinite(n) || n <= 0) return READER_SIDE_DEFAULT;
  return Math.min(READER_SIDE_MAX, Math.max(READER_SIDE_MIN, n));
}

/** 渲染上限：硬边界之内再按屏幕宽度收一道 */
export function readerSideCap() {
  return Math.max(READER_SIDE_MIN, Math.min(READER_SIDE_MAX, Math.floor((window.innerWidth || 1280) * 0.4)));
}

export function applyReaderSideWidth(px) {
  const w = Math.min(readerSideCap(), clampReaderSide(px));
  document.documentElement.style.setProperty('--reader-side-w', w + 'px');
  return w;
}

export function setReaderSideWidth(px) {
  const hard = clampReaderSide(px);
  applyReaderSideWidth(hard);
  if (hard === layoutPref.readerSideWidth) return;
  setLayout('readerSideWidth', hard);
}

/* ---------------- 按账号保存的 UI 布局偏好 ----------------
 * 视图模式 / 当前页面 / 分组折叠 / 阅读手风琴 /
 * 阅读页排序方式 / 阅读页默认范围 / 阅读页频道栏折叠 / 频道栏宽度 / 日报是否开启，
 * 统一按账号维度持久化到服务端（users.prefs.layout），不再落浏览器 localStorage，
 * 换设备也一致。首屏初值由 server.js 注入的 window.__LAYOUT__ 提供。
 * 单一可信源是 window.__LAYOUT__（缺省回落默认）。 */
export const LAYOUT_DEFAULTS = { view: 'grid', tab: 'reader', collapsedGroups: [], accordion: true, sections: {}, sort: 'new', rdScope: 'all', rdCollapsedGroups: [], readerSideWidth: READER_SIDE_DEFAULT, digestEnabled: true };
export const LAYOUT_VALUES = { view: ['grid', 'list'], tab: ['reader', 'cards', 'ai'], sort: ['new', 'old', 'name'], rdScope: ['all', 'unread', 'favorite'] };
export function sanitizeLayoutLocal(raw) {
  const out = Object.assign({}, LAYOUT_DEFAULTS);
  if (raw && typeof raw === 'object') {
    if (LAYOUT_VALUES.view.indexOf(raw.view) >= 0) out.view = raw.view;
    if (LAYOUT_VALUES.tab.indexOf(raw.tab) >= 0) out.tab = raw.tab;
    if (Array.isArray(raw.collapsedGroups)) {
      out.collapsedGroups = raw.collapsedGroups.filter((g) => typeof g === 'string').map((g) => g.slice(0, 40));
    }
    out.accordion = raw.accordion === false ? false : true;
    if (raw.sections && typeof raw.sections === 'object') {
      const sec = {};
      Object.keys(raw.sections).forEach((k) => { sec[k] = raw.sections[k] === true; });
      out.sections = sec;
    }
    if (LAYOUT_VALUES.sort.indexOf(raw.sort) >= 0) out.sort = raw.sort;
    if (LAYOUT_VALUES.rdScope.indexOf(raw.rdScope) >= 0) out.rdScope = raw.rdScope;
    // 阅读页频道栏的分组折叠：与设置面板的 collapsedGroups 各存一份，互不影响
    if (Array.isArray(raw.rdCollapsedGroups)) {
      out.rdCollapsedGroups = raw.rdCollapsedGroups.filter((g) => typeof g === 'string').map((g) => g.slice(0, 40));
    }
    out.readerSideWidth = clampReaderSide(raw.readerSideWidth);
    // 日报对本账号是否开启（与服务端 lib/prefs.js 同一口径：只有显式 false 才关）
    out.digestEnabled = raw.digestEnabled === false ? false : true;
  }
  return out;
}
export let layoutPref = sanitizeLayoutLocal(window.__LAYOUT__);

// 频道栏宽度首屏生效（偏好来自服务端注入，晚一步会让侧栏先按默认宽画一帧再跳）
applyReaderSideWidth(layoutPref.readerSideWidth);
// 窗口变窄时重新收一道上限：40vw 是个跟随屏幕的边界，不重算就会把内容区挤没
window.addEventListener('resize', () => applyReaderSideWidth(layoutPref.readerSideWidth));

// 排序方式与默认阅读范围：从账号偏好取初值（服务端未注入时回落默认）
state.sort = layoutPref.sort;
state.rdScope = layoutPref.rdScope;

/* ============================================================
 * 设置面板
 * ============================================================ */
// 设置弹层自 v1.3.0 起外壳 React 化（挂载点 #settingsRoot，组件见 src/settings/）：
// 开合状态由 React 组件同步到 window.__settingsOpen，旧 #settingsMask / #settingsSummary
// DOM 已移除；openSettings / closeSettings 委托给 React 宿主 window.__settingsHost。

export const isAdmin = () => state.role === 'admin';

/** 按角色显隐：设置弹层的管理员专属 tab 由 React 外壳过滤；
 *  采集参数 / 用户管理 分别在各自 React 面板内按 admin 显隐（P3a 起 AI 视图亦 React 化） */
export function applyRoleUI() {
  const admin = isAdmin();
  // 设置弹层 tab 已 React 化：按角色过滤交给宿主（管理员专属 tab 由外壳不再渲染）
  const host = window.__settingsHost;
  if (host && host.setAdminFlag) host.setAdminFlag(admin);
}

/* ---------- 弹层打开时锁住背景页面 ----------
 * 弹层本身是 position:fixed，但背景页面照样能滚：滚到弹层内容尽头后，滚轮会「接力」给
 * body，页面就跟着跑了。只给 body 加 overflow:hidden 在 iOS 上无效（惯性滚动挡不住），
 * 所以用 position:fixed + 负 top 把页面钉在原处，关掉时再滚回去。
 * 用计数是因为「设置弹层」和「图片灯箱」可能同时开着。
 */
export let scrollLockCount = 0;
export let scrollLockY = 0;

export function lockPageScroll() {
  scrollLockCount += 1;
  if (scrollLockCount > 1) return;
  scrollLockY = window.scrollY || window.pageYOffset || 0;
  // 页面滚动条会消失，先量出它的宽度补到右内边距上，否则整页会往右跳一下
  const sbw = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  document.body.style.setProperty('--sbw', sbw + 'px');
  document.body.style.top = `-${scrollLockY}px`;
  document.body.classList.add('modal-open');
}

export function unlockPageScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount > 0) return;
  if (!document.body.classList.contains('modal-open')) return;
  document.body.classList.remove('modal-open');
  document.body.style.top = '';
  document.body.style.removeProperty('--sbw');
  window.scrollTo(0, scrollLockY);   // 回到打开弹层前的位置
}

/** 打开设置弹层（外壳 React 化后仅作为委托入口：锁屏 / tab 副作用 / 面板加载
 *  都由 SettingsModal 挂载后自行完成）。
 *  注意：tab 要原样透传、不要在这里兜底成 'source' —— 移动端用「有没有指定分区」
 *  区分「进设置列表」和「直达某分区」（见 SettingsModal 的 mobilePane 判定）；
 *  桌面端的默认分区由 SettingsModal 自己兜底，语义不变。 */
export function openSettings(tab) {
  const host = window.__settingsHost;
  if (host && host.open) host.open(tab);
}

export function closeSettings() {
  const host = window.__settingsHost;
  if (host && host.close) host.close();
}

/** 设置弹层副标题文本（纯计算：React 宿主打开弹层时也要用同一份） */
export function getSettingsSummary() {
  const meta = state.feedMeta || {};
  const total = meta.total || 0;
  if (!total) return '还没有订阅源';
  const on = meta.enabled || 0;
  const card = meta.cardEnabled == null ? on : meta.cardEnabled;
  return `共 ${total} 个订阅源 · 采集开启 ${on} 个 · 卡片展示 ${card} 个`;
}

/** 推送副标题给 React 外壳（宿主未就绪时静默） */
export function setSettingsSummary(text) {
  const host = window.__settingsHost;
  if (host && host.setSummary) host.setSummary(text);
}

/* ============================================================
 * 主题（跟随系统 / 浅色 / 深色）
 * 首屏由 index.html <head> 的内联脚本先定好 data-theme，这里只负责
 * 后续切换、持久化，以及「跟随系统」时响应系统偏好变化。
 * ============================================================ */
// 4 档：跟随系统 / 浅色 / CommaFeed 暗色 / GitHub 暗黑。
// 前两档保持原样（dark 是 CommaFeed 中性灰），github 是整包主题，不进「跟随系统」
// —— 跟随系统只在浅色与 CommaFeed 暗之间切，想要 GitHub 暗黑必须显式选。
export const THEME_MODES = ['auto', 'light', 'dark', 'github'];
export const THEME_META = {
  auto: { ico: 'theme-auto', label: '跟随系统', color: null },
  light: { ico: 'sun', label: '浅色', color: '#ffffff' },
  dark: { ico: 'moon', label: 'CommaFeed 暗色', color: '#242424' },
  github: { ico: 'github', label: 'GitHub 暗黑', color: '#0d1117' },
};
// 每档主题实际写进 data-theme 的值：github 主题另外用一套 CSS 变量块，
// 主色固定 GitHub 蓝（不对应 6 套 accent，所以外观页要把主色调板禁掉）。
export const THEME_DATA_ATTR = {
  auto: null, light: 'light', dark: 'dark', github: 'github',
};
// 这些主题自带主色，不随 6 套主色调板变
export const THEME_FIXED_ACCENT = { github: '#1f6feb' };
// GitHub 主题自带主色：切到它时把当前主色暂存，切回浅/暗时恢复（仅会话内有效，不落本机）
export let githubKeepAccent = null;

export function prefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function currentThemeMode() {
  return (appearancePref && THEME_MODES.indexOf(appearancePref.theme) >= 0) ? appearancePref.theme : 'auto';
}

export function applyTheme(mode, animate) {
  const m = THEME_MODES.indexOf(mode) >= 0 ? mode : 'auto';
  // auto 只看系统深浅（不出 GitHub），其余三档各自写自己的 CSS 变量块
  const resolved = m === 'auto' ? null : THEME_DATA_ATTR[m];
  const eff = resolved || (prefersDark() ? 'dark' : 'light');
  const dark = eff === 'dark' || eff === 'github';
  const el = document.documentElement;

  if (animate) {
    el.classList.add('theme-anim');
    setTimeout(() => el.classList.remove('theme-anim'), 260);
  }
  el.setAttribute('data-theme', eff);
  el.setAttribute('data-theme-mode', m);

  // github 主题自带主色，不跟随 6 套主色调板：切到它时把当前主色暂存，
  // 切回浅/暗时恢复成暂存值（会话内有效，不写本机 localStorage）。
  const fixed = THEME_FIXED_ACCENT[m];
  const accent = (appearancePref && appearancePref.accent) || githubKeepAccent || 'blue';
  if (fixed) {
    githubKeepAccent = accent;
    el.setAttribute('data-accent', 'github');
  } else {
    el.setAttribute('data-accent', APPR_VALUES.accent.indexOf(accent) >= 0 ? accent : 'blue');
    githubKeepAccent = null;
  }
  el.setAttribute('data-fixed-accent', fixed ? 'github' : '');
  applyAppearance(readAppearance());

  // 主题持久化到服务端（按账号维度），与外观配置同一份
  if (m !== (appearancePref && appearancePref.theme)) {
    appearancePref.theme = m;
    saveAppearance(appearancePref);
  }

  const meta = THEME_META[m];
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute('content', meta.color || (dark ? '#242424' : '#ffffff'));
  emitShell();   // 顶栏主题按钮的图标与提示由 React 重绘

  // 外观页的主题分段控件已 React 化：选中态由窗口级 __appearanceChanged 事件回流，
  // 不再在这里直接操作 DOM
}

export function cycleTheme() {
  const next = THEME_MODES[(THEME_MODES.indexOf(currentThemeMode()) + 1) % THEME_MODES.length];
  applyTheme(next, true);
  toast('主题：' + THEME_META[next].label);
}

try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentThemeMode() === 'auto') applyTheme('auto', false);
  });
} catch (_) { /* 老浏览器不支持 addEventListener，忽略 */ }

/* ============================================================
 * 外观偏好（主题 / 主色调 / 字号 / 阅读字体 / 行高 / 阅读宽度）
 * 按账号维度持久化到服务端（users.prefs.appearance），不再落本机 localStorage，
 * 换设备也一致。
 * 首屏由 index.html <head> 的内联脚本从服务端注入的 window.__APPEARANCE__ 应用
 * （否则会先闪一下默认值），这里负责后续修改、持久化与界面回填。
 * ============================================================ */
// 默认值与合法值表（与服务端 APPEARANCE_DEFAULTS / APPEARANCE_KEYS 对齐）
export const APPR_DEFAULTS = { theme: 'auto', accent: 'blue', fontSize: 'm', density: 'cozy', readerFont: 'sans', readerLh: 'm', readerFs: 'm', readerWidth: 'm' };
// 键名 → html 属性名；同时这个属性名就是控件上用来标值的 data 属性名
export const APPR_ATTR = {
  accent: 'data-accent',
  fontSize: 'data-font-size',
  density: 'data-density',
  readerFont: 'data-reader-font',
  readerLh: 'data-reader-lh',
  readerFs: 'data-reader-fs',
  readerWidth: 'data-reader-width',
};
export const APPR_VALUES = {
  theme: ['auto', 'light', 'dark', 'github'],
  accent: ['blue', 'violet', 'teal', 'green', 'amber', 'rose'],
  fontSize: ['s', 'm', 'l'],
  density: ['cozy', 'compact'],
  readerFont: ['sans', 'serif'],
  readerLh: ['s', 'm', 'l'],
  readerFs: ['s', 'm', 'l'],
  readerWidth: ['s', 'm', 'l', 'full'],
};
// 注：旧 APPR_GROUP 控件选择器表随外观面板 React 化移除（React 侧自行渲染控件）

// 单一可信源：优先服务端注入的 window.__APPEARANCE__，缺省回落默认（登录页等无注入场景）
export function sanitizeAppearanceLocal(raw) {
  const out = Object.assign({}, APPR_DEFAULTS);
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(APPR_DEFAULTS)) {
      if (APPR_VALUES[k] && APPR_VALUES[k].indexOf(raw[k]) >= 0) out[k] = raw[k];
    }
  }
  return out;
}
export let appearancePref = sanitizeAppearanceLocal(window.__APPEARANCE__);

export function readAppearance() {
  return sanitizeAppearanceLocal(appearancePref);
}

// 统一按账号持久化：外观与布局共用一次防抖 POST（避免两路并发互相覆盖）
export let prefsSaveTimer = null;
export function saveUserPrefs() {
  clearTimeout(prefsSaveTimer);
  prefsSaveTimer = setTimeout(() => {
    fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appearance: appearancePref, layout: layoutPref }),
    }).catch(() => { /* 离线 / 网络异常时静默，下次改动再试 */ });
  }, 150);
}

// 布局单键修改：替换对应键后写账号（sections / collapsedGroups 由调用方传完整对象）
export function setLayout(key, value) {
  layoutPref = sanitizeLayoutLocal(Object.assign({}, layoutPref, { [key]: value }));
  saveUserPrefs();
}

export function saveAppearance(pref) {
  appearancePref = sanitizeAppearanceLocal(pref);
  // 防抖后写服务端（按账号持久化，不再落本机 localStorage）
  saveUserPrefs();
}

/** 写进 <html> 属性（样式全挂在属性选择器上）。
 *  控件选中态自 v1.3.0 起由 React 外观面板（src/settings/AppearancePane.jsx）从
 *  偏好数据直接推导、不再回写 DOM；末尾派发 __appearanceChanged 通知面板同步，
 *  覆盖顶栏主题按钮、恢复默认、localStorage 迁移等一切外部改动。 */
export function applyAppearance(pref) {
  const el = document.documentElement;
  Object.keys(APPR_ATTR).forEach((k) => el.setAttribute(APPR_ATTR[k], pref[k]));
  window.dispatchEvent(new Event('__appearanceChanged'));
}

export function setAppearance(key, value) {
  if (!APPR_VALUES[key] || APPR_VALUES[key].indexOf(value) < 0) return;
  const pref = readAppearance();
  pref[key] = value;
  saveAppearance(pref);
  applyAppearance(pref);
}

// 外观面板的控件点击 / 「恢复默认」已 React 化：经桥 setAppearance / resetAppearance
// 回调到这里，状态与持久化逻辑不变，仅 DOM 绑定移除

/** 恢复默认外观（React 外观面板的「恢复默认」按钮经桥调用）：
 *  主题一并带回「跟随系统」，避免默认主色 + GitHub 主题的错配 */
export function resetAppearance() {
  appearancePref = Object.assign({}, APPR_DEFAULTS);
  saveAppearance(appearancePref);
  applyTheme('auto', true);
  applyAppearance(readAppearance());
  toast('外观已恢复默认');
}

applyAppearance(readAppearance());

// 旧版把外观 / 布局偏好存在本机 localStorage：升级后迁移到账号（仅执行一次），随后清掉本机副本
(function migrateLocalPrefs() {
  let apref = Object.assign({}, appearancePref);
  let lpref = Object.assign({}, layoutPref);
  let aChanged = false, lChanged = false;
  try {
    // —— 外观 ——
    const a = JSON.parse(localStorage.getItem('feedlore.appearance.v1') || '{}');
    if (a && typeof a === 'object') {
      ['accent', 'fontSize', 'readerFont', 'readerLh', 'readerFs', 'readerWidth'].forEach((k) => {
        if (APPR_VALUES[k] && APPR_VALUES[k].indexOf(a[k]) >= 0) { apref[k] = a[k]; aChanged = true; }
      });
    }
    const t = localStorage.getItem('feedlore.theme.v1');
    if (t && APPR_VALUES.theme.indexOf(t) >= 0 && t !== 'auto') { apref.theme = t; aChanged = true; }
    // —— 布局 ——
    const v = localStorage.getItem('feedlore.view.v1');
    if (LAYOUT_VALUES.view.indexOf(v) >= 0) { lpref.view = v; lChanged = true; }
    const tb = localStorage.getItem('feedlore.tab.v1');
    if (LAYOUT_VALUES.tab.indexOf(tb) >= 0) { lpref.tab = tb; lChanged = true; }
    const cg = JSON.parse(localStorage.getItem('feedlore.collapsedGroups.v1') || 'null');
    if (Array.isArray(cg)) {
      lpref.collapsedGroups = cg.filter((g) => typeof g === 'string').map((g) => g.slice(0, 40));
      lChanged = true;
    }
    const ac = localStorage.getItem('feedlore.reader.accordion.v1');
    if (ac === '0' || ac === '1') { lpref.accordion = ac !== '0'; lChanged = true; }
    const sec = JSON.parse(localStorage.getItem('feedlore.settings.sections.v1') || 'null');
    if (sec && typeof sec === 'object') { lpref.sections = sec; lChanged = true; }
  } catch (_) { return; }
  if (aChanged) appearancePref = sanitizeAppearanceLocal(apref);
  if (lChanged) layoutPref = sanitizeLayoutLocal(lpref);
  if (aChanged || lChanged) saveUserPrefs();   // 一次合并写账号
  try {
    ['feedlore.appearance.v1', 'feedlore.theme.v1', 'feedlore.appearance.accent.v1',
     'feedlore.view.v1', 'feedlore.tab.v1', 'feedlore.collapsedGroups.v1',
     'feedlore.reader.accordion.v1', 'feedlore.settings.sections.v1']
      .forEach((k) => localStorage.removeItem(k));
  } catch (_) { /* 忽略 */ }
})();
