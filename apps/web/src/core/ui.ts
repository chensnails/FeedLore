/* 笺川核心逻辑 · 页面级交互枢纽（详情标记 / 日报开关 / 顶栏快照）
 *
 * 深度重组后：刷新 / 视图切换 / 深链 / 键盘 → ui.nav.ts，
 * OPML → ui.opml.ts，灯箱 → ui.lightbox.ts，PWA / 主题色 → ui.pwa.ts，
 * 折叠分组 → ui.sections.ts。本文件保留两页共享的详情标记与快照，
 * 并统一 re-export，外部引用链（core/index.ts 与各模块）完全不变。
 * ============================================================ */

import { subtitleText } from './feeds.ts';
import { markEntryRead, setEntryFlag } from './reader.ts';
import {
  currentThemeMode,
  layoutPref,
  setLayout,
  state,
  THEME_META,
  THEME_MODES,
} from './state.ts';
import type { EntityId, EntryFlagPatch } from './types.ts';
import { deferredInstall } from './ui.pwa.ts';
import { emitShell } from './util.ts';

export * from './ui.lightbox.ts';
export * from './ui.nav.ts';
export * from './ui.opml.ts';
export * from './ui.pwa.ts';
export * from './ui.sections.ts';

/* 卡片页条目收藏/已读：与阅读页走同一套标记逻辑（reader.ts 的 setEntryFlag）——
 * 两页列表各持一份条目对象，统一入口才能保证改一处、两边同时换新对象并同步计数。 */
export function cardSetFlag(id: EntityId, patch: EntryFlagPatch) {
  return setEntryFlag(id, patch);
}

/* 卡片详情弹窗打开即算读过：与文章页展开同样走 markEntryRead（状态同步到两页列表）。
 * 同一条只发一次 PATCH —— 已读过就直接跳过，避免每次点开都打一次请求。 */
export function cardDetailRead(id: EntityId) {
  markEntryRead(id);
}

/** 日报对本账号是否开启（顶栏入口、命令面板项、设置面板的开关都读这一个判据） */
export const digestIsEnabled = () => layoutPref.digestEnabled !== false;

/** 开 / 关日报（设置面板的开关经桥调用）。
 *  探索页常驻：关掉日报只隐藏页内「日报」tab，不再把人带离探索页。
 */
export function setDigestEnabled(on: boolean) {
  const next = on !== false;
  if (digestIsEnabled() === next) return;
  setLayout('digestEnabled', next);
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
