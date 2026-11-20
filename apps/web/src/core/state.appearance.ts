/* 主题（跟随系统 / 浅色 / 深色）+ 外观偏好（主色 / 字号 / 行高 / 阅读宽度）。
 * 从 state.ts 抽出（深度重组）：外观只存本机 localStorage，不跟账号走。
 * 首屏由 index.html <head> 内联脚本先定好 data-theme，这里负责后续切换、
 * 持久化与界面回填。state.ts 通过 export * 保持外部链不变。 */

import { EVENT, emit } from '../kernel/events.ts';
import type { ThemeMode } from './types.ts';
import { emitShell, toast } from './util.ts';

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

/* ============================================================
 * 主题（跟随系统 / 浅色 / 深色）
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
