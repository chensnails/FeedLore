/* 笺川核心逻辑 · 全局状态 + 账号偏好（布局 / 外观 / 主题）+ 设置宿主与页面滚动锁
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.ts 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

import { get } from '../kernel/bridge.ts';
import { EVENT, emit } from '../kernel/events.ts';
import { state } from '../store/app.ts';
import type { ReaderScope, SortMode, ThemeMode, ViewMode, ViewTab } from './types.ts';
import { apiFetch, emitShell, toast } from './util.ts';

/** 设置弹层宿主暴露给 core 的命令面（经能力桥提供，缺失时静默）。 */
interface LayoutPref {
  view: ViewMode;
  tab: ViewTab;
  collapsedGroups: string[];
  srcGroupsOpen: string[];
  accordion: boolean;
  sections: Record<string, boolean>;
  sort: SortMode;
  rdScope: ReaderScope;
  rdCollapsedGroups: string[];
  readerSideWidth: number;
  digestEnabled: boolean;
  [key: string]: unknown;
}

interface LayoutValues {
  view: readonly string[];
  tab: readonly string[];
  sort: readonly string[];
  rdScope: readonly string[];
  [key: string]: readonly unknown[];
}

interface ThemeMeta {
  auto: { ico: string; label: string };
  light: { ico: string; label: string };
  dark: { ico: string; label: string };
  github: { ico: string; label: string };
  [key: string]: { ico: string; label: string };
}

interface ThemeDataAttr {
  auto: string | null;
  light: string | null;
  dark: string | null;
  github: string | null;
  [key: string]: string | null;
}

interface SettingsHost {
  open?: (tab?: string) => void;
  close?: () => void;
  setAdminFlag?: (v: boolean) => void;
  setRoleFlag?: (v: string) => void;
  setSummary?: (v: string) => void;
}

/* state 真源已迁至 store/app.ts（Zustand）。此处 re-export 同一个 Proxy：
 * 字段名、读写语义、原地修改（push/add/set）全部逐字不变，core 各模块照常用它。
 * 各字段的完整语义注释见 store/app.ts。 */
export { state };

/* ---------------- 常量 ----------------
 * 分页长度固定：卡片页 50 条，文章页 40 篇。
 */
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_READER_PAGE = 40;

/* ---------------- 状态 ----------------
 * 全局可变状态容器：字段会因加载阶段从 null/[] 被替换成任意服务端数据形态，
 * 用精确接口声明其字段（V3.1 类型化：避免 init 值把字段锁成 never）。
 * 各字段的语义见下方注释，读写约定由对应 setter 保证。 */
/* 字段初始化值已迁至 store/app.ts（Zustand 真源）。
 * 下方各字段语义见 store/app.ts 的同名 initial 字段；本模块保留
 * 所有 setter / getter，它们读写的 state 即 store 的 Proxy。 */

/* ---------------- 当前视图的滚动容器 ----------------
 * App Shell 把 body 锁在视口内，三个视图各自是独立滚动容器，window.scrollY 永远是 0。
 * 自动刷新判「是否停在顶部」、浮标回顶、切页回顶、滚动到顶命令都必须落到容器上，
 * 否则要么误判（列表在眼皮底下被换掉），要么点了没反应。
 * 放在 state 是因为 autorefresh 与 ui 都要用，而两边不能互相依赖。 */
export function activeScrollEl() {
  if (state.tab === 'cards') return document.querySelector('#cardsRoot > main.wrap');
  if (state.tab === 'ai') return document.getElementById('aiView');
  return document.querySelector('#readerView .reader-main');
}

export function activeScrollTop() {
  const el = activeScrollEl();
  return el ? el.scrollTop : window.scrollY || 0;
}

/**
 * @param {*} [behavior]
 */

export function scrollActiveTop(behavior: ScrollBehavior = 'auto') {
  const el = activeScrollEl();
  if (!el) {
    window.scrollTo({ top: 0, behavior });
    return;
  }
  // jsdom / 老浏览器没有 Element.scrollTo，退回直接写 scrollTop
  if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior });
  else el.scrollTop = 0;
}

/* ---------------- 视图滚动位置记忆（移动端底部标签栏） ----------------
 * 三个视图是三个独立滚动容器，「切走再切回」时如果一律回顶，用户得重新翻回
 * 刚才看到的位置。这里按视图 id 记一份 scrollTop：切页前存当前页、切回时恢复。
 * 只活在内存里（刷新后回到顶部是合理的），也不参与账号偏好持久化。
 *
 * 注意：selectScope / jumpToFeed 这类「换了筛选条件」的入口仍应显式回顶 ——
 * 旧位置属于旧列表，恢复它反而会停在半截。所以默认 switchView 仍回顶，
 * 只有视图导航（ViewNav）明确传 restoreScroll 时才走这里。 */
const viewScroll = new Map();

/**
 * @param {*} [tab]
 */

export function rememberViewScroll(tab = state.tab) {
  const el = activeScrollEl();
  if (!el) return;
  const top = Math.max(0, Number(el.scrollTop) || 0);
  if (top > 0) viewScroll.set(tab, top);
  else viewScroll.delete(tab);
}

/* 列表被重置（换筛选 / 搜索 / 后台重拉）时调用：旧位置属于旧列表，
   再恢复只会把新列表夹到底部，甚至触发触底自动翻页的连环。 */
/**
 * @param {*} [tab]
 */
export function forgetViewScroll(tab = state.tab) {
  viewScroll.delete(tab);
}

/**
 * @param {*} [tab]
 */

export function restoreViewScroll(tab = state.tab) {
  if (tab !== state.tab) return;
  const want = viewScroll.get(tab) || 0;
  if (!want) return;
  let frames = 0;
  /**
   * @param {*} [el]
   * @param {*} [top]
   */
  const write = (el: Element, top: number) => {
    // 与 scrollActiveTop 同一套兜底：jsdom / 老浏览器没有 Element.scrollTo
    if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'auto' });
    else el.scrollTop = top;
  };
  const apply = () => {
    // 途中又切走了：这次恢复作废，别把新页的容器滚走
    if (tab !== state.tab) return;
    const el = activeScrollEl();
    if (!el) {
      window.scrollTo({ top: want, behavior: 'auto' });
      return;
    }
    const sh = el.scrollHeight || 0;
    const ch = el.clientHeight || 0;
    // 读不到布局（jsdom / 隐藏视图）：照旧写原值，由浏览器自己的夹取规则兜底
    if (!sh && !ch) {
      write(el, want);
      return;
    }
    /* 列表还没铺开（首屏在途 / 图片尚未占位）：此刻写进去会被夹到当前最大高度，
       等布局随后撑开，停下的位置就不是离开时那一处 —— 用户看到「自己滚到了底部」。
       等容器可滚动再落地，最多等约 0.5s；超时就按当前可达位置恢复。 */
    const max = Math.max(0, sh - ch);
    if (max <= 0 && frames < 30 && typeof requestAnimationFrame === 'function') {
      frames += 1;
      requestAnimationFrame(apply);
      return;
    }
    // 恢复值夹在当前可达范围里：旧位置属于更长的列表时，硬写只会停在底部
    write(el, Math.min(want, max));
  };
  apply();
}

/* ---------------- 频道栏宽度 ----------------
 * 实际生效的是 :root 上的 --reader-side-w（.reader 网格第一列引用它）。
 * 拖拽跟手期间由组件直接写这个变量（一次拖拽几十帧，走 state 会把整棵阅读页重渲染），
 * 松手才调一次 setReaderSideWidth 落账号偏好 —— 与主题 / 字号同一条防抖写入通道。
 * 两道上限：持久化只按硬边界 180~400 收（换设备屏幕不同，不该把值改没），
 * 渲染时再按 40vw 自适应收紧（窄笔记本上拖不爆内容区）。 */
export const READER_SIDE_DEFAULT = 232; // 与 style.css 里 --reader-side-w 的回退值同源
export const READER_SIDE_MIN = 180;
export const READER_SIDE_MAX = 400;

/** 持久化用的硬边界：非法值（0 / NaN / 串）一律回落默认
 *@param {*} [px]
 */
export function clampReaderSide(px: number | string) {
  const n = Math.round(Number(px));
  if (!Number.isFinite(n) || n <= 0) return READER_SIDE_DEFAULT;
  return Math.min(READER_SIDE_MAX, Math.max(READER_SIDE_MIN, n));
}

/** 渲染上限：硬边界之内再按屏幕宽度收一道 */
export function readerSideCap() {
  return Math.max(
    READER_SIDE_MIN,
    Math.min(READER_SIDE_MAX, Math.floor((window.innerWidth || 1280) * 0.4)),
  );
}

/**
 * @param {*} [px]
 */

export function applyReaderSideWidth(px: number | string) {
  const w = Math.min(readerSideCap(), clampReaderSide(px));
  document.documentElement.style.setProperty('--reader-side-w', w + 'px');
  return w;
}

/**
 * @param {*} [px]
 */

export function setReaderSideWidth(px: number | string) {
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
export const LAYOUT_DEFAULTS: LayoutPref = {
  view: 'grid',
  tab: 'reader',
  collapsedGroups: [],
  srcGroupsOpen: [],
  accordion: true,
  sections: {},
  sort: 'new',
  rdScope: 'all',
  rdCollapsedGroups: [],
  readerSideWidth: READER_SIDE_DEFAULT,
  digestEnabled: true,
};
export const LAYOUT_VALUES: LayoutValues = {
  view: ['grid', 'list'],
  tab: ['reader', 'cards', 'ai'],
  sort: ['new', 'old', 'name'],
  rdScope: ['all', 'unread', 'favorite'],
};
/**
 * @param {*} [raw]
 */
export function sanitizeLayoutLocal(raw: unknown): LayoutPref {
  const out = Object.assign({}, LAYOUT_DEFAULTS);
  const r = raw as Partial<LayoutPref> | null;
  if (r && typeof r === 'object') {
    if (r.view && LAYOUT_VALUES.view.indexOf(r.view) >= 0) out.view = r.view;
    if (r.tab && LAYOUT_VALUES.tab.indexOf(r.tab) >= 0) out.tab = r.tab;
    if (Array.isArray(r.collapsedGroups)) {
      out.collapsedGroups = r.collapsedGroups
        .filter((g: unknown): g is string => typeof g === 'string')
        .map((g: string) => g.slice(0, 40));
    }
    // 数据源面板展开的分组（A 方案默认收起，这里记「显式展开」的组名）
    if (Array.isArray(r.srcGroupsOpen)) {
      out.srcGroupsOpen = r.srcGroupsOpen
        .filter((g: unknown): g is string => typeof g === 'string')
        .map((g: string) => g.slice(0, 40));
    }
    out.accordion = r.accordion !== false;
    if (r.sections && typeof r.sections === 'object') {
      const src = r.sections;
      const sec: Record<string, boolean> = {};
      Object.keys(src).forEach((k: string) => {
        sec[k] = src[k] === true;
      });
      out.sections = sec;
    }
    if (r.sort && LAYOUT_VALUES.sort.indexOf(r.sort) >= 0) out.sort = r.sort;
    if (r.rdScope && LAYOUT_VALUES.rdScope.indexOf(r.rdScope) >= 0) out.rdScope = r.rdScope;
    // 阅读页频道栏的分组折叠：与设置面板的 collapsedGroups 各存一份，互不影响
    if (Array.isArray(r.rdCollapsedGroups)) {
      out.rdCollapsedGroups = r.rdCollapsedGroups
        .filter((g: unknown): g is string => typeof g === 'string')
        .map((g: string) => g.slice(0, 40));
    }
    out.readerSideWidth = clampReaderSide(r.readerSideWidth ?? READER_SIDE_DEFAULT);
    // 日报对本账号是否开启（与服务端 lib/prefs.js 同一口径：只有显式 false 才关）
    out.digestEnabled = r.digestEnabled !== false;
  }
  return out;
}
export let layoutPref: LayoutPref = sanitizeLayoutLocal(window.__LAYOUT__);

// 频道栏宽度首屏生效（偏好来自服务端注入，晚一步会让侧栏先按默认宽画一帧再跳）
applyReaderSideWidth(layoutPref.readerSideWidth);
// 窗口变窄时重新收一道上限：40vw 是个跟随屏幕的边界，不重算就会把内容区挤没
window.addEventListener('resize', () => applyReaderSideWidth(layoutPref.readerSideWidth));

// 排序方式与默认阅读范围：从账号偏好取初值（服务端未注入时回落默认）
state.sort = layoutPref.sort;
state.rdScope = layoutPref.rdScope;
// 频道栏折叠集合同理（React 侧把它当 memo key，必须能在 state 上读到）
state.rdCollapsedGroups = layoutPref.rdCollapsedGroups;
// 数据源面板展开的分组（A 方案）：初值取自账号偏好，缺省空数组 = 命名分组全收起
state.srcGroupsOpen = layoutPref.srcGroupsOpen;

/* ============================================================
 * 设置面板
 * ============================================================ */
// 设置弹层外壳 React 化（挂载点 #settingsRoot，组件见 src/settings/）：
// 开合状态由 React 组件同步到 window.__settingsOpen，旧 #settingsMask / #settingsSummary
// DOM 已移除；openSettings / closeSettings 委托给 React 宿主 window.__settingsHost。

export const isAdmin = () => state.role === 'admin';
/** 只读账户只能阅读：配置类入口在前端隐藏，服务端另有 403 兜底。 */
export const isReadonly = () => state.role === 'readonly';
/** 可执行配置写操作（管理员 / 普通用户）；会话未加载时按可写处理，交给服务端判定。 */
export const isWritable = () => state.role !== 'readonly';

/** 按角色显隐：设置弹层的管理员专属 tab 由 React 外壳过滤；
 *  采集参数 / 用户管理 分别在各自 React 面板内按 admin 显隐（P3a 起 AI 视图亦 React 化） */
export function applyRoleUI() {
  const admin = isAdmin();
  // 设置弹层 tab 已 React 化：按角色过滤交给宿主（管理员专属 tab 由外壳不再渲染）
  const host = get('settingsHost') as SettingsHost | undefined;
  if (host && host.setAdminFlag) host.setAdminFlag(admin);
  if (host && host.setRoleFlag) host.setRoleFlag(state.role || '');
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
  window.scrollTo(0, scrollLockY); // 回到打开弹层前的位置
}

/** 打开设置弹层（外壳 React 化后仅作为委托入口：锁屏 / tab 副作用 / 面板加载
 *  都由 SettingsModal 挂载后自行完成）。
 *  注意：tab 要原样透传、不要在这里兜底成 'source' —— 移动端用「有没有指定分区」
 *  区分「进设置列表」和「直达某分区」（见 SettingsModal 的 mobilePane 判定）；
 *  桌面端的默认分区由 SettingsModal 自己兜底，语义不变。
 *@param {*} [tab]
 */

export function openSettings(tab?: string) {
  const host = get('settingsHost') as SettingsHost | undefined;
  if (host && host.open) {
    host.open(tab);
    return;
  }
  // 设置弹层自 v2.2.0 起按需加载：宿主还没注册时交给入口去拉 chunk，
  // 拉完由 SettingsModal 读取 __settingsPending 补上这次打开。
  const mount = get('mountSettings') as ((tab?: string) => Promise<unknown>) | undefined;
  if (typeof mount === 'function') {
    const p = mount(tab);
    if (p && p.catch) p.catch(() => toast('设置页面加载失败，请检查网络后重试', false));
  }
}

export function closeSettings() {
  const host = get('settingsHost') as SettingsHost | undefined;
  if (host && host.close) host.close();
}

/** 设置弹层副标题文本（纯计算：React 宿主打开弹层时也要用同一份） */
export function getSettingsSummary() {
  const meta = state.feedMeta;
  const total = meta?.total || 0;
  if (!total) return '还没有订阅源';
  const on = meta?.enabled || 0;
  const card = meta?.cardEnabled == null ? on : meta.cardEnabled;
  return `共 ${total} 个订阅源 · 采集开启 ${on} 个 · 卡片展示 ${card} 个`;
}

/** 推送副标题给 React 外壳（宿主未就绪时静默）
 *@param {*} [text]
 */

export function setSettingsSummary(text: string) {
  const host = get('settingsHost') as SettingsHost | undefined;
  if (host && host.setSummary) host.setSummary(text);
}

/* ============================================================
 * 主题（跟随系统 / 浅色 / 深色）
 * 首屏由 index.html <head> 的内联脚本先定好 data-theme，这里只负责
 * 后续切换、持久化，以及「跟随系统」时响应系统偏好变化。
 * ============================================================ */
// 4 档：跟随系统 / 浅色 / 暖灰 / 暗黑。
// 前两档保持原样（dark 是中性偏暖的一档），github 是整包主题，不进「跟随系统」
// —— 跟随系统只在浅色与暖灰之间切，想要暗黑必须显式选。
export const THEME_MODES: ThemeMode[] = ['auto', 'light', 'dark', 'github'];
export const THEME_META: ThemeMeta = {
  auto: { ico: 'theme-auto', label: '跟随系统' },
  light: { ico: 'sun', label: '浅色' },
  dark: { ico: 'moon', label: '暖灰' },
  github: { ico: 'github', label: '暗黑' },
};
// 每档主题实际写进 data-theme 的值：github 主题另外用一套 CSS 变量块，
// 主色固定 GitHub 蓝（不对应 6 套 accent，所以外观页要把主色调板禁掉）。
export const THEME_DATA_ATTR: ThemeDataAttr = {
  auto: null,
  light: 'light',
  dark: 'dark',
  github: 'github',
};
// 这些主题自带主色，不随 6 套主色调板变
export const THEME_FIXED_ACCENT: Record<string, string> = { github: '#1f6feb' };
// GitHub 主题自带主色：切到它时把当前主色暂存，切回浅/暗时恢复（仅会话内有效，不落本机）
export let githubKeepAccent: string | null = null;

export function prefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

export function currentThemeMode(): ThemeMode {
  const t = appearancePref?.theme;
  return t && (THEME_MODES as string[]).indexOf(t) >= 0 ? (t as ThemeMode) : 'auto';
}

/**
 * @param {*} [mode]
 * @param {*} [animate]
 */

export function applyTheme(mode: ThemeMode | string, animate: boolean) {
  const m: ThemeMode = (THEME_MODES as string[]).indexOf(mode) >= 0 ? (mode as ThemeMode) : 'auto';
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
    el.setAttribute(
      'data-accent',
      (APPR_VALUES.accent ?? []).indexOf(accent) >= 0 ? accent : 'blue',
    );
    githubKeepAccent = null;
  }
  el.setAttribute('data-fixed-accent', fixed ? 'github' : '');
  applyAppearance(readAppearance());

  // 主题与其余外观项同存本机（feedlore.appearance.v2）
  if (m !== (appearancePref && appearancePref.theme)) {
    appearancePref.theme = m;
    saveAppearance(appearancePref);
  }

  // 首屏兜底有亮 / 暗两条带 media 的 theme-color，浏览器只认命中的那条：
  // 全部改成同一个值，免得另一条还留着旧主题的颜色。
  // 取 --bg 而不是 --panel：系统栏和页面顶部贴的是页面底色，取面板色会差一档灰。
  const cssRoot = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
  const bg = cssRoot ? String(cssRoot.getPropertyValue('--bg') || '').trim() : '';
  const color = bg || (dark ? '#242424' : '#f4f5f7');
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach(/** @param {*} [tc] */ (tc) => tc.setAttribute('content', color));
  emitShell(); // ⋮ 菜单里的夜间模式图标由 React 重绘

  // 外观页的主题分段控件已 React 化：选中态由窗口级 __appearanceChanged 事件回流，
  // 不再在这里直接操作 DOM
}

export function cycleTheme() {
  const cur = currentThemeMode() as ThemeMode;
  const next = THEME_MODES[(THEME_MODES.indexOf(cur) + 1) % THEME_MODES.length]!;
  applyTheme(next, true);
  toast('主题：' + THEME_META[next]!.label);
}

try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentThemeMode() === 'auto') applyTheme('auto', false);
  });
} catch (_) {
  /* 老浏览器不支持 addEventListener，忽略 */
}

/* ============================================================
 * 外观偏好（主题 / 主色调 / 字号 / 阅读字体 / 行高 / 阅读宽度）
 * 只存本机 localStorage：外观是「这台设备看起来怎样」的偏好，不跟账号走。
 * 不做旧账号值迁移 —— 首次使用按全「中」默认；旧版账号里的 appearance 已停用。
 * 首屏由 index.html <head> 的内联脚本读同一份数据（否则会先闪一下默认值），
 * 这里负责后续修改、持久化与界面回填。
 * ============================================================ */
export const APPR_STORAGE_KEY = 'feedlore.appearance.v2';
// 默认值：尺寸类一律中间档，主题跟随系统、主色蓝、正文字体无衬线
export const APPR_DEFAULTS: Record<string, string> = {
  theme: 'auto',
  accent: 'blue',
  fontSize: 'm',
  density: 'compact',
  listDensity: 'compact',
  readerFont: 'sans',
  readerLh: 'm',
  readerFs: 'm',
  readerWidth: 'm',
};
// 键名 → html 属性名；同时这个属性名就是控件上用来标值的 data 属性名
export const APPR_ATTR: Record<string, string> = {
  accent: 'data-accent',
  fontSize: 'data-font-size',
  density: 'data-density',
  listDensity: 'data-list-density',
  readerFont: 'data-reader-font',
  readerLh: 'data-reader-lh',
  readerFs: 'data-reader-fs',
  readerWidth: 'data-reader-width',
};
export const APPR_VALUES: Record<string, readonly string[]> = {
  theme: ['auto', 'light', 'dark', 'github'],
  accent: ['blue', 'violet', 'teal', 'green', 'amber', 'rose'],
  fontSize: ['s', 'm', 'l'],
  density: ['cozy', 'compact'],
  listDensity: ['cozy', 'compact'],
  readerFont: ['sans', 'serif'],
  readerLh: ['s', 'm', 'l'],
  readerFs: ['xs', 's', 'm', 'l', 'xl'],
  readerWidth: ['s', 'm', 'l', 'full'],
};
// 注：旧 APPR_GROUP 控件选择器表随外观面板 React 化移除（React 侧自行渲染控件）

// localStorage 是用户可改的，脏值 / 坏 JSON 一律回落默认，不让页面崩掉
/**
 * @param {*} [raw]
 */
export function sanitizeAppearanceLocal(raw: unknown): Record<string, string> {
  const out = Object.assign({}, APPR_DEFAULTS);
  const r = raw as Record<string, string> | null;
  if (r && typeof r === 'object') {
    for (const k of Object.keys(APPR_DEFAULTS)) {
      const rv = r[k];
      const allowed = APPR_VALUES[k];
      if (rv !== undefined && allowed && allowed.indexOf(rv) >= 0) out[k] = rv;
    }
  }
  return out;
}

function readAppearanceStorage() {
  try {
    return sanitizeAppearanceLocal(JSON.parse(localStorage.getItem(APPR_STORAGE_KEY) || 'null'));
  } catch (_) {
    return sanitizeAppearanceLocal(null);
  }
}

export let appearancePref = readAppearanceStorage();

export function readAppearance() {
  return sanitizeAppearanceLocal(appearancePref);
}

// 布局仍按账号保存（跨设备一致），外观只落本机，两者不再共用一次写入
export let prefsSaveTimer: ReturnType<typeof setTimeout> | null = null;
/* 偏好没存上时必须让用户知道：排序 / 折叠 / 侧栏宽度看起来「改了」，下次刷新却变回去，
 * 用户只会觉得设置自己漂移了。走统一的 apiFetch（写操作 30s 超时、绝不重试），
 * 失败只提示一次，避免连续改几个开关时叠一串 toast。 */
let prefsFailToast = false;
export function saveUserPrefs() {
  if (prefsSaveTimer) clearTimeout(prefsSaveTimer);
  prefsSaveTimer = setTimeout(() => {
    apiFetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: layoutPref }),
    })
      .then(
        /** @param {*} [res] */ (res) => {
          if (res && res.ok) {
            prefsFailToast = false;
            return;
          }
          if (!prefsFailToast) {
            prefsFailToast = true;
            toast('界面设置没有同步到服务器，稍后会自动重试', false);
          }
        },
      )
      .catch(() => {
        if (!prefsFailToast) {
          prefsFailToast = true;
          toast('界面设置没有同步到服务器，稍后会自动重试', false);
        }
      });
  }, 150);
}

// 布局单键修改：替换对应键后写账号（sections / collapsedGroups 由调用方传完整对象）
/* 偏好与 state 的镜像关系：这几项既在 layoutPref 里持久化，也挂在 state 上给
 * 渲染层做即时判断（排序、默认范围、频道栏折叠集合）。只写 layoutPref 不回填
 * state 的话，读 state 的一方永远看不到变化 —— 折叠点击「写进去了但界面不动」
 * 就是这么来的（1.7.2 回归）。新增同类项请一并登记在这里。 */
const LAYOUT_MIRROR: (keyof import('../core/types.ts').AppState)[] = [
  'sort',
  'rdScope',
  'rdCollapsedGroups',
  'srcGroupsOpen',
];

/**
 * @param {*} [key]
 * @param {*} [value]
 */
export function setLayout(key: string, value: unknown) {
  layoutPref = sanitizeLayoutLocal(Object.assign({}, layoutPref, { [key]: value }));
  if ((LAYOUT_MIRROR as string[]).indexOf(key) >= 0)
    (state as unknown as Record<string, unknown>)[key] = layoutPref[key];
  saveUserPrefs();
}

/**
 * @param {*} [pref]
 */

export function saveAppearance(pref: Record<string, string>) {
  appearancePref = sanitizeAppearanceLocal(pref);
  try {
    localStorage.setItem(APPR_STORAGE_KEY, JSON.stringify(appearancePref));
  } catch (_) {
    /* 隐私模式 / 配额满：本次会话仍生效，只是不持久化 */
  }
}

/** 写进 <html> 属性（样式全挂在属性选择器上）。
 *  控件选中态由 React 外观面板（src/settings/AppearancePane.jsx）从
 *  偏好数据直接推导、不再回写 DOM；末尾派发 __appearanceChanged 通知面板同步，
 *  覆盖 ⋮ 菜单的主题图标、恢复默认、localStorage 迁移等一切外部改动。
 *@param {*} [pref]
 */

export function applyAppearance(pref: Record<string, string>) {
  const el = document.documentElement;
  Object.keys(APPR_ATTR).forEach((k) => el.setAttribute(APPR_ATTR[k] ?? '', pref[k] ?? ''));
  emit(EVENT.APPEARANCE);
}

/**
 * @param {*} [key]
 * @param {*} [value]
 */
export function setAppearance(key: string, value: string) {
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

// 旧版把布局偏好存在本机 localStorage：升级后迁移到账号（仅执行一次），随后清掉本机副本。
// 外观不走这条迁移：外观改存本机 feedlore.appearance.v2，旧账号里的 appearance 不再读取。
(function migrateLegacyLayoutPrefs() {
  const lpref = Object.assign({}, layoutPref);
  let lChanged = false;
  try {
    const v = localStorage.getItem('feedlore.view.v1') || '';
    if (LAYOUT_VALUES.view.indexOf(v) >= 0) {
      lpref.view = v as ViewMode;
      lChanged = true;
    }
    const tb = localStorage.getItem('feedlore.tab.v1') || '';
    if (LAYOUT_VALUES.tab.indexOf(tb) >= 0) {
      lpref.tab = tb as ViewTab;
      lChanged = true;
    }
    const cg = JSON.parse(localStorage.getItem('feedlore.collapsedGroups.v1') || 'null');
    if (Array.isArray(cg)) {
      lpref.collapsedGroups = cg
        .filter((g: unknown): g is string => typeof g === 'string')
        .map((g: string) => g.slice(0, 40));
      lChanged = true;
    }
    const ac = localStorage.getItem('feedlore.reader.accordion.v1');
    if (ac === '0' || ac === '1') {
      lpref.accordion = ac !== '0';
      lChanged = true;
    }
    const sec = JSON.parse(localStorage.getItem('feedlore.settings.sections.v1') || 'null');
    if (sec && typeof sec === 'object') {
      lpref.sections = sec;
      lChanged = true;
    }
  } catch (_) {
    return;
  }
  if (lChanged) {
    layoutPref = sanitizeLayoutLocal(lpref);
    // 迁移是整体替换 layoutPref 的另一条写入路径，镜像字段要一并回填
    LAYOUT_MIRROR.forEach((k) => {
      (state as unknown as Record<string, unknown>)[k] = layoutPref[k];
    });
    saveUserPrefs();
  }
  try {
    [
      'feedlore.view.v1',
      'feedlore.tab.v1',
      'feedlore.collapsedGroups.v1',
      'feedlore.reader.accordion.v1',
      'feedlore.settings.sections.v1',
    ].forEach(/** @param {*} [k] */ (k) => localStorage.removeItem(k));
  } catch (_) {
    /* 忽略 */
  }
})();
