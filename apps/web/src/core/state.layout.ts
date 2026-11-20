/* 按账号保存的 UI 布局偏好（视图 / 页面 / 分组折叠 / 排序 / 频道栏宽度 / 日报）
 * + 频道栏宽度硬边界 + 状态镜像 + 旧版本机迁移。
 * 从 state.ts 抽出（深度重组）：单一可信源是 window.__LAYOUT__（缺省回落默认）。
 * state.ts 通过 export * 保持外部链不变。 */

import { state } from '../store/app.ts';
import type { ReaderScope, SortMode, ViewMode, ViewTab } from './types.ts';
import { apiFetch, toast } from './util.ts';

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
 * 换设备也一致。首屏初值由 server.js 注入的 window.__LAYOUT__ 提供。 */
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

/* 偏好没存上时必须让用户知道：排序 / 折叠 / 侧栏宽度看起来「改了」，下次刷新却变回去，
 * 用户只会觉得设置自己漂移了。走统一的 apiFetch（写操作 30s 超时、绝不重试），
 * 失败只提示一次，避免连续改几个开关时叠一串 toast。 */
export let prefsSaveTimer: ReturnType<typeof setTimeout> | null = null;
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
