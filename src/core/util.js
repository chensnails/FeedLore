/* 拾阅核心逻辑 · 通用工具：DOM 选择器、请求封装、格式化、toast、复制、链接标签 / 菜单
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

/* ---------------- DOM ---------------- */
export const $ = (s) => document.querySelector(s);
/* ---------------- 工具 ---------------- */
/** 带登录态处理的 fetch：401 时跳登录页 */
export async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
    throw new Error('未登录');
  }
  return res;
}

/** 完整时间戳，用于 title 提示与展开体的发布时间 */
export function fmtFull(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 文章日期：始终显示到分钟。今天/昨天给「今天 HH:mm」，同年给「MM-DD HH:mm」，跨年补上年份 */
export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  if (sameDay) return `今天 ${hm}`;
  if (yesterday) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

export function sizeToMB(s) {
  if (!s) return null;
  const m = String(s).match(/([\d.]+)\s*(TB|GB|G|MB|M|KB|K)?/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (isNaN(v)) return null;
  const unit = (m[2] || 'MB').toUpperCase();
  const mult = { TB: 1024 * 1024, GB: 1024, G: 1024, MB: 1, M: 1, KB: 1 / 1024, K: 1 / 1024 }[unit] || 1;
  return v * mult;
}

/** 轻提示。v2.1.0 起不再直接改 DOM，改为写状态 + 通知 src/ui/Overlays.jsx 重绘 */
export let toastTimer = null;
export let toastState = { msg: '', ok: true, show: false };
export function toast(msg, ok = true) {
  toastState = { msg, ok, show: true };
  emitOverlays();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastState = { msg, ok, show: false };
    emitOverlays();
  }, 1900);
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* 降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function shortFeedName(n) {
  return String(n || '').replace(/\s*-\s*Telegram Channel\s*$/i, '').trim();
}

/** 频道的展示名：自定义名优先，否则抓取来的标题，再否则 url */
export function feedTitle(f) {
  if (!f || typeof f !== 'object') return f || '';
  return f.customTitle || f.title || f.url || '';
}

/** 通知 App Shell（顶栏，src/shell/TopBar.jsx）重绘：它监听 __shellTick 后重读 getShell() */
export function emitShell() { window.dispatchEvent(new Event('__shellTick')); }

/** 通知覆盖层（src/ui/Overlays.jsx）重绘：toast / 新内容浮标 / 图片灯箱都归它渲染 */
export function emitOverlays() { window.dispatchEvent(new Event('__overlaysTick')); }

/* ---------------- 链接：标签 / 复制 / 打开原文 ---------------- */

/** 常见网盘域名 → 中文标签，其余用主机名 */
export const HOST_LABELS = [
  [/pan\.quark\.cn$|(^|\.)quark\.cn$/, '夸克'],
  [/pan\.baidu\.com$/, '百度网盘'],
  [/aliyundrive\.(com|net)$|(^|\.)alipan\.com$/, '阿里云盘'],
  [/cloud\.189\.cn$/, '天翼云盘'],
  [/(^|\.)115\.com$/, '115 网盘'],
  [/123pan\.com$|123684\.com$/, '123 网盘'],
  [/mypikpak\.com$/, 'PikPak'],
  [/(^|\.)t\.me$|(^|\.)telegram\.me$/, 'Telegram'],
];
export function linkLabel(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return '链接'; }
  for (const [re, name] of HOST_LABELS) if (re.test(host)) return name;
  return host.replace(/^www\./, '');
}
/** 菜单里显示的短地址：去协议、超长中间省略 */
export function shortUrl(url) {
  const s = String(url).replace(/^https?:\/\//i, '');
  return s.length > 46 ? s.slice(0, 30) + '…' + s.slice(-12) : s;
}

/* 链接选择菜单：多条链接时从按钮旁弹出（fixed 定位，自动避让视口边缘） */
export let linkMenuEl = null;
export function closeLinkMenu() {
  if (!linkMenuEl) return;
  linkMenuEl.remove();
  linkMenuEl = null;
  document.removeEventListener('click', onLinkMenuDocClick, true);
  document.removeEventListener('keydown', onLinkMenuKey, true);
  window.removeEventListener('resize', closeLinkMenu);
  window.removeEventListener('scroll', closeLinkMenu, true);
}
export function onLinkMenuDocClick(ev) {
  if (linkMenuEl && !linkMenuEl.contains(ev.target)) closeLinkMenu();
}
export function onLinkMenuKey(ev) { if (ev.key === 'Escape') closeLinkMenu(); }

export function openLinkMenu(anchor, urls, onPick) {
  closeLinkMenu();
  const menu = document.createElement('div');
  menu.className = 'link-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = urls.map((u, i) => `
    <button type="button" class="link-menu-item" role="menuitem" data-i="${i}">
      <span class="link-menu-label">${escapeHtml(linkLabel(u))}</span>
      <span class="link-menu-url">${escapeHtml(shortUrl(u))}</span>
    </button>`).join('');
  document.body.appendChild(menu);
  linkMenuEl = menu;

  const r = anchor.getBoundingClientRect();
  const gap = 6;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - menu.offsetWidth - 8));
  let top = r.bottom + gap;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - gap);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  menu.addEventListener('click', (ev) => {
    const item = ev.target.closest('.link-menu-item');
    if (!item) return;
    const u = urls[Number(item.getAttribute('data-i'))];
    closeLinkMenu();
    if (u) onPick(u);
  });
  // 延后一帧再挂「点外面关闭」，否则这次点击本身就会把刚弹出的菜单关掉
  setTimeout(() => {
    document.addEventListener('click', onLinkMenuDocClick, true);
    document.addEventListener('keydown', onLinkMenuKey, true);
    window.addEventListener('resize', closeLinkMenu);
    window.addEventListener('scroll', closeLinkMenu, true);
  }, 0);
}

export function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
