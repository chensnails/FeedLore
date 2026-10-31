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

/** 非 2xx 时构造带「服务端原因」的 Error，调用方一律 `throw await httpError(res)`。
 *
 *  以前各处写的是 `throw new Error('HTTP ' + res.status)`，用户只会看到
 *  「操作失败：HTTP 500」—— 而服务端其实已经回了「服务器开小差了」这类可读原因，
 *  白白丢掉，出问题时既没法自助也没法反馈。
 *
 *  ⚠️ 会消费 res 的 body，只能在失败分支调用；成功分支的 `res.json()` 各走各的，
 *  互斥分支不受影响（各处本来就是这个结构）。 */
export async function httpError(res) {
  let msg = '';
  try {
    const d = await res.json();
    if (d && typeof d.error === 'string' && d.error) msg = d.error;
    else if (d && typeof d.message === 'string' && d.message) msg = d.message;
  } catch (e) {
    /* 非 JSON（网关 HTML、空 body、被截断）→ 退回状态码 */
  }
  const err = new Error(msg || 'HTTP ' + res.status);
  err.status = res.status;
  return err;
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

/* ---------------- 统一确认框（替代原生 confirm / prompt） ----------------
 * 全站弹层都是自绘玻璃语言，唯独破坏性操作交给浏览器原生框会割裂（移动端还显示
 * 「localhost 显示…」）。这里只维护状态，视图由 src/ui/Overlays.jsx 渲染；
 * 调用方 `await confirm(...)` 即可，确认返回 true / 输入值，取消返回 false / null。
 *
 * 用法：
 *   if (!(await confirm({ title: '删除订阅', desc: '…', danger: true, confirmText: '删除' }))) return;
 *   const pwd = await confirm({ title: '设置新密码', input: { placeholder: '至少 4 位', type: 'password' } });
 */
export let confirmState = {
  open: false, title: '', desc: '', confirmText: '确定', cancelText: '取消',
  danger: false, input: null,
};
let confirmResolve = null;

/** 打开确认框；返回 Promise<boolean|string|null> */
export function confirm(opts = {}) {
  // 上一个还没结束就先按「取消」结算，避免 Promise 永久挂起
  if (confirmResolve) {
    const prev = confirmResolve;
    confirmResolve = null;
    prev(confirmState.input ? null : false);
  }
  const o = typeof opts === 'string' ? { title: opts } : (opts || {});
  confirmState = {
    open: true,
    title: o.title || '确认操作',
    desc: o.desc || '',
    confirmText: o.confirmText || '确定',
    cancelText: o.cancelText || '取消',
    danger: !!o.danger,
    input: o.input || null,
  };
  emitOverlays();
  return new Promise((resolve) => { confirmResolve = resolve; });
}

/** 结算确认框：ok=true 时返回 true（或有输入框时返回输入值） */
export function settleConfirm(ok, value) {
  const r = confirmResolve;
  confirmResolve = null;
  const withInput = !!confirmState.input;
  confirmState = { ...confirmState, open: false };
  emitOverlays();
  if (!r) return;
  if (!ok) { r(withInput ? null : false); return; }
  r(withInput ? String(value == null ? '' : value) : true);
}

/** 点遮罩 / 右键 / Esc 都走「取消」 */
export function cancelConfirm() { settleConfirm(false); }

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

/** 通知视图导航 / ⋮ 菜单重绘：它们监听 __shellTick 后重读 getShell() */
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

/* ---------------- 地址栏 hash（进入文章的深链） ----------------
 * 策略：笺川**不把文章写进浏览器历史**（只用 replaceState，不 push）——
 * 否则读完点 20 次「下一篇」之后，按一次后退要按 20 次才能离开，
 * 那不是「后退」，是罚站。地址栏只留当前状态（视图 / 当前篇），
 * 刷新或从别处回来时按它恢复，并统一滚到该篇顶部。
 * 与「进入一篇文章」的滚动策略一致：谁进来都从文章开头看起。 */
export function writeHash(hash) {
  try {
    if (!hash) return;
    if (location.hash === hash) return;
    history.replaceState(null, '', hash);
  } catch (_) { /* 老浏览器 / 沙箱环境忽略 */ }
}

/** 从 hash 里解析「视图 + 条目」：#cards / #reader / #reader/art/<id> / #ai … */
export function parseHash(hash) {
  const h = hash || '';
  if (h.startsWith('#reader/art/')) return { tab: 'reader', artId: h.slice('#reader/art/'.length) };
  if (h.startsWith('#cards')) return { tab: 'cards', artId: null };
  if (h.startsWith('#ai') || h.startsWith('#digest')) return { tab: 'ai', artId: null };
  if (h.startsWith('#reader')) return { tab: 'reader', artId: null };
  return { tab: null, artId: null };
}
