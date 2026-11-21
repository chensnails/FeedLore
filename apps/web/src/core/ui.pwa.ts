/* PWA：Service Worker 注册、安装到手机、主题色同步。从 ui.ts 抽出（深度重组），
 * ui.ts 通过 export * 保持外部链不变。 */

import { emitShell, toast } from './util.ts';

/* ============================================================
 * PWA：Service Worker + 「添加到手机」
 * ============================================================ */
// 注册 Service Worker（仅 https / localhost 会生效；用 http 的局域网 IP 访问时静默忽略）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 非安全上下文，忽略 */
    });
  });
}

// 安装到手机：Chromium 系（Edge / Chrome）满足条件时会触发 beforeinstallprompt
/** 浏览器尚未把 beforeinstallprompt 纳入 lib.dom，按实际用到的面声明。 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
export let deferredInstall: BeforeInstallPromptEvent | null = null; // 捕获到的事件（账号面板「一键安装」经桥 promptInstall 触发）

window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  deferredInstall = ev as BeforeInstallPromptEvent;
  emitShell(); // 账号面板「一键安装」区据此刷新可用态（顶栏不再放安装按钮）
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
  try {
    ({ outcome } = await deferredInstall.userChoice);
  } catch (_) {
    /* 忽略 */
  }
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
  const cs =
    typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
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
  metas.forEach(/** @param {*} [meta] */ (meta) => meta.setAttribute('content', color));
}
syncThemeColor();
new MutationObserver(syncThemeColor).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
});
