/* 拾阅核心逻辑 · 通用工具：DOM 选择器、请求封装、格式化、toast、复制、链接标签 / 菜单
 *
 * v2.1.0 起由原单文件 src/core/app.js 拆分而来：按职责切分，模块之间只用普通 import 组合，
 * 由 src/core/index.js 汇总成 `core` 单例（组件统一 `import { core } from '@core'`）。
 * 依赖方向单向：util → state → feeds → reader → autorefresh → ui → bootstrap，无环。
 * ============================================================ */

/* ---------------- DOM ---------------- */
/**
 * @param {*} [s]
 */
export const $ = (s) => document.querySelector(s);

import { EVENT, emit } from '../kernel/events.js';
import { errorText } from './errorText.js';

export { errorText as errText };
/* ---------------- 网络层 ----------------
 * 弱网下「请求挂住不返回」比「请求失败」更糟：调用方的 loading 闸门一直不释放，
 * 重试按钮点了没反应，启动链也会卡死在 await 上被看门狗误报成启动失败。
 * 所以这里统一兜三件事：超时、幂等 GET 的有限重试、尊重调用方的取消信号。
 *   - GET/HEAD：单次 8s，网络错误 / 超时 / 408 / 429 / 5xx 重试一次（短退避）
 *   - 写操作：单次 30s，**绝不自动重试**（POST/PATCH/DELETE 可能已经生效）
 *   - 调用方自带 signal 或显式 timeoutMs:0 时，超时交给调用方，不叠加计时器
 * 长耗时调用（上传归档、LLM 生成、整站刷新）请显式传 timeoutMs。
 */
export const NET_TIMEOUT_MS = 8000;
export const NET_WRITE_TIMEOUT_MS = 30000;
/* AI 类长任务（单篇生成 / 日报 / 测试模型 / 拉模型列表）单独放宽：
 * 服务端一次模型调用允许 180s，前端若还按 30s 写超时，就会在服务端还在跑的时候先掐断，
 * 用户看到「失败」但几分钟后明细里其实成功了（实测截图：前端 30s 报错，服务端 99s 成功）。
 * 留 20s 余量，保证「服务端先返回」的顺序。 */
export const NET_AI_TIMEOUT_MS = 200000;
export const NET_RETRY_DELAY_MS = 400;

/**
 * @param {*} [status]
 */
function isRetryableStatus(status) {
  return status === 408 || status === 429 || (Number(status) >= 500 && Number(status) < 600);
}

/** 单次请求：超时既 abort 真实请求，也用 race 保证「fetch 实现忽略 signal」时仍能结束。
 *  外部 signal（如 AbortSignal.timeout）触发时同步 abort 内部 controller。
 * @param {*} url
 * @param {*} opts
 * @param {*} [timeoutMs]
 * @param {*} [outerSignal]
 */
function fetchOnce(url, opts, timeoutMs, outerSignal) {
  const clean = { ...opts };
  delete clean.timeoutMs;
  delete clean.retry;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  if (ctrl) clean.signal = ctrl.signal;

  const onOuterAbort = () => {
    if (ctrl) ctrl.abort();
  };
  if (ctrl && outerSignal) {
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }

  const req = fetch(url, clean);
  req.catch(() => {}); // 超时胜出后，被 abort 的请求可能晚一步 reject，别留悬空 rejection
  /** @type {*} */
  let timer = null;
  /** @type {*} */
  let timeoutErr = null;
  const timeout =
    timeoutMs > 0
      ? new Promise(
          /** @param {*} [_] @param {*} [reject] */ (_, reject) => {
            timer = setTimeout(() => {
              /* 顺序很重要：先把可读错误交给 race，再 abort 真实请求。
               * 反过来的话，abort 会让 fetch 立刻 reject 一个底层英文
               * （Chrome 是 `signal is aborted without reason`），它抢在中文提示前面，
               * 用户看到的就是这句天书 —— 实测线上截图就是这个。 */
              const err = new Error(
                `网络请求超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试`,
              );
              err.name = 'TimeoutError';
              timeoutErr = err;
              reject(err);
              if (ctrl) {
                // 带 reason 的 abort：个别实现即使同步 reject，拿到的也是我们的可读错误
                try {
                  ctrl.abort(err);
                } catch {
                  ctrl.abort();
                }
              }
            }, timeoutMs);
          },
        )
      : null;

  const raced = timeout ? Promise.race([req, timeout]) : req;
  return raced
    .catch(
      /** @param {*} [err] */ (err) => {
        // 兜一层：某些实现对 abort 是同步 reject，仍可能抢在中文错误前面
        if (timeoutErr && err !== timeoutErr) throw timeoutErr;
        throw err;
      },
    )
    .finally(() => {
      if (timer) clearTimeout(timer);
      if (ctrl && outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    });
}

/** 带登录态处理的 fetch：401 时跳登录页；GET 失败有限重试；所有请求都有超时上限。
 *@param {*} [url]
 * @param {*} opts
 */
export async function apiFetch(url, opts = {}) {
  const o = opts || {};
  const method = String(o.method || 'GET').toUpperCase();
  const idempotent = method === 'GET' || method === 'HEAD';
  const attempts = idempotent && o.retry !== false ? 2 : 1;
  // 调用方自带 signal 且没写 timeoutMs → 由它自己负责超时；
  // 显式给了 timeoutMs（哪怕同时带 signal，比如列表请求的取消链）→ 仍按这个上限超时。
  const timeoutMs =
    o.timeoutMs === 0
      ? 0
      : o.signal && o.timeoutMs == null
        ? 0
        : o.timeoutMs || (idempotent ? NET_TIMEOUT_MS : NET_WRITE_TIMEOUT_MS);

  /** @type {any} */
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetchOnce(url, o, timeoutMs, o.signal);
      if (res.status === 401) {
        location.replace(
          '/login.html?next=' + encodeURIComponent(location.pathname + location.search),
        );
        throw new Error('未登录');
      }
      /* 首次登录未改密：服务端对所有业务接口回 403 E_PASSWORD_CHANGE_REQUIRED。
       * 这里统一把人送到改密页 —— 各调用方自己弹「未授权」只会让人以为账号坏了。
       * clone() 读码不消费原响应体，调用方拿到 res 仍能正常解析。 */
      if (res.status === 403 && !o.skipPasswordGate) {
        const body = await res
          .clone()
          .json()
          .catch(() => null);
        if (body && body.error === 'E_PASSWORD_CHANGE_REQUIRED') {
          location.replace('/change-password.html');
          throw new Error('需要先修改初始密码');
        }
      }
      if (i + 1 < attempts && idempotent && isRetryableStatus(res.status)) {
        lastErr = new Error('HTTP ' + res.status); // 不消费 body，留给最终那次响应
      } else {
        return res;
      }
    } catch (err) {
      if (err && err.message === '未登录') throw err; // 401 不重试
      if (o.signal && o.signal.aborted) throw err; // 调用方主动取消
      lastErr = err;
      if (i + 1 >= attempts) throw err;
    }
    await new Promise(/** @param {*} [r] */ (r) => setTimeout(r, NET_RETRY_DELAY_MS * (i + 1)));
  }
  throw lastErr || new Error('网络请求失败');
}

/** 回登录页。整站还原会清空会话，单独收成一个函数便于测试与复用。 */
export function goLogin() {
  location.replace('/login.html');
}

/**
 * 上传导出包：请求体就是文件本身（服务端按 `application/gzip` 原始流接收），
 * 不套 multipart。浏览器给 File 请求体自动带 Content-Length；同源 POST 自带
 * Origin / Referer，CSRF 中间件照常放行。401 仍由 apiFetch 统一跳登录页。
 * @param {*} [url]
 * @param {*} [file]
 */
export async function uploadArchive(url, file) {
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip' },
    body: file,
    timeoutMs: 0, // 导入 / 还原包可能几十 MB，弱网下上传很久，别被 30s 写超时误杀
  });
}

/** 非 2xx 时构造带「服务端原因」的 Error，调用方一律 `throw await httpError(res)`。
 *
 *  以前各处写的是 `throw new Error('HTTP ' + res.status)`，用户只会看到
 *  「操作失败：HTTP 500」—— 而服务端其实已经回了可读原因，白白丢掉，
 *  出问题时既没法自助也没法反馈。
 *
 *  服务端现在回的是错误码（`{ error: 'E_XXX', message: '<英文>' }`），
 *  中文文案由 src/core/errorText.js 的词典负责；没命中码表时退回英文原文。
 *
 *  ⚠️ 会消费 res 的 body，只能在失败分支调用；成功分支的 `res.json()` 各走各的，
 *  互斥分支不受影响（各处本来就是这个结构）。
 *@param {*} [res]
 */
export async function httpError(res) {
  let msg = '';
  try {
    const d = await res.json();
    msg = errorText(d);
  } catch (_e) {
    /* 非 JSON（网关 HTML、空 body、被截断）→ 退回状态码 */
  }
  /** @type {any} */
  const err = new Error(msg || 'HTTP ' + res.status);
  err.status = res.status;
  return err;
}

/** 侧栏计数徽标：用 k / w / 亿 压缩，不封顶。
 *
 *  计数会随文章无限增长，直接显示会把频道行撑变形。不足 1000 原样显示；
 *  之后按量级换单位，并保留一位小数（四舍五入；到 10 个单位以上只用整数），
 *  例如 1234 → 1.2k、9999 → 10k、12345 → 1.2w。精确值仍放在 tooltip 里。
 * @param {*} [v]
 * @param {*} [unit]
 */
function compactUnit(v, unit) {
  const tenths = Math.round(v / (unit / 10));
  if (tenths >= 100) return String(Math.round(tenths / 10));
  return (tenths / 10).toFixed(1).replace(/\.0$/, '');
}

/**
 * @param {*} [n]
 */
export function fmtBadge(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v >= 100000000) return compactUnit(v, 100000000) + '亿';
  if (v >= 10000) return compactUnit(v, 10000) + 'w';
  return compactUnit(v, 1000) + 'k';
}

/** 完整时间戳，用于 title 提示与展开体的发布时间
 *@param {*} [ts]
 */
export function fmtFull(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  /**
   * @param {*} [n]
   */
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 文章日期：始终显示到分钟。今天/昨天给「今天 HH:mm」，同年给「MM-DD HH:mm」，跨年补上年份
 *@param {*} [ts]
 */
export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  /**
   * @param {*} [n]
   */
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  if (sameDay) return `今天 ${hm}`;
  if (yesterday) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear())
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/** 轻提示。v2.1.0 起不再直接改 DOM，改为写状态 + 通知 src/ui/Overlays.jsx 重绘。
 *  第三参可选 `{ action, actionText, ms }`：带一个行内动作按钮（批量已读的「撤销」）。
 *  有动作时默认停留 6 秒，给用户留出反应时间；没有动作仍是最短的 1.9 秒。 */
/** @type {any} */
export let toastTimer = null;
/** @type {any} */
export let toastState = { msg: '', ok: true, show: false, action: null, actionText: '' };
/* 带「撤销」的提示还在倒计时时，后来的普通提示先排队：
 * 否则一次成功的复制 / 自动刷新一来，撤销按钮就在用户眼皮底下被换掉了。 */
/** @type {*} */
/** @type {any} */
let pendingToast = null;

/**
 * @param {*} [msg]
 * @param {*} [ok]
 * @param {*} [action]
 * @param {*} [actionText]
 * @param {*} [ms]
 */
function showToastNow(msg, ok, action, actionText, ms) {
  toastState = { msg, ok, show: true, action, actionText };
  emitOverlays();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastState = { msg, ok, show: false, action: null, actionText: '' };
    emitOverlays();
    if (pendingToast) {
      const p = pendingToast;
      pendingToast = null;
      showToastNow(p.msg, p.ok, null, '', p.ms);
    }
  }, ms);
}

/**
 * @param {*} [msg]
 * @param {*} [ok]
 * @param {*} opts
 */
export function toast(msg, ok = true, opts = {}) {
  const action = opts && typeof opts.action === 'function' ? opts.action : null;
  const actionText = (opts && opts.actionText) || '撤销';
  const ms = (opts && opts.ms) || (action ? 6000 : 1900);
  // 失败提示照旧立刻出现（比撤销更急）；普通成功提示排队，别把撤销按钮挤掉
  if (!action && ok && toastState.show && typeof toastState.action === 'function') {
    pendingToast = { msg, ok, ms }; // 排队，等撤销窗口结束后再露出来
    return;
  }
  pendingToast = null;
  showToastNow(msg, ok, action, actionText, ms);
}

/** 点 toast 里的动作按钮：先收起提示（避免重复点），再执行动作 */
export function runToastAction() {
  const action = toastState.action;
  if (typeof action !== 'function') return;
  clearTimeout(toastTimer);
  toastState = {
    msg: toastState.msg,
    ok: toastState.ok,
    show: false,
    action: null,
    actionText: '',
  };
  emitOverlays();
  /** @type {*} */
  const queued = pendingToast;
  pendingToast = null;
  action();
  // 动作自己弹了新提示就让新提示留下，排队那条放弃
  if (queued && !toastState.show) showToastNow(queued.msg, queued.ok, null, '', queued.ms);
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
  open: false,
  title: '',
  desc: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
  input: null,
};
/** @type {*} */
let confirmResolve = null;

/** 打开确认框；返回 Promise<boolean|string|null>
 *@param {*} opts
 */
export function confirm(opts = {}) {
  // 上一个还没结束就先按「取消」结算，避免 Promise 永久挂起
  if (confirmResolve) {
    const prev = confirmResolve;
    confirmResolve = null;
    prev(confirmState.input ? null : false);
  }
  const o = typeof opts === 'string' ? { title: opts } : opts || {};
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
  return new Promise(
    /** @param {*} [resolve] */ (resolve) => {
      confirmResolve = resolve;
    },
  );
}

/** 结算确认框：ok=true 时返回 true（或有输入框时返回输入值）
 *@param {*} [ok]
 * @param {*} [value]
 */
export function settleConfirm(ok, value) {
  /** @type {*} */
  const r = confirmResolve;
  confirmResolve = null;
  const withInput = !!confirmState.input;
  confirmState = { ...confirmState, open: false };
  emitOverlays();
  if (!r) return;
  if (!ok) {
    r(withInput ? null : false);
    return;
  }
  r(withInput ? String(value == null ? '' : value) : true);
}

/** 点遮罩 / 右键 / Esc 都走「取消」 */
export function cancelConfirm() {
  settleConfirm(false);
}

/**
 * @param {*} [text]
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    /* 降级 */
  }
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
  } catch (_) {
    return false;
  }
}

/**
 * @param {*} [s]
 */
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {*} [n]
 */
export function shortFeedName(n) {
  return String(n || '')
    .replace(/\s*-\s*Telegram Channel\s*$/i, '')
    .trim();
}

/** 频道的展示名：自定义名优先，否则抓取来的标题，再否则 url
 *@param {*} [f]
 */
export function feedTitle(f) {
  if (!f || typeof f !== 'object') return f || '';
  return f.customTitle || f.title || f.url || '';
}

/** 通知视图导航 / ⋮ 菜单重绘：它们监听 __shellTick 后重读 getShell() */
export function emitShell() {
  emit(EVENT.SHELL);
}

/** 通知覆盖层（src/ui/Overlays.jsx）重绘：toast / 新内容浮标 / 图片灯箱都归它渲染 */
export function emitOverlays() {
  emit(EVENT.OVERLAYS);
}

/* ---------------- 链接：标签 / 复制 / 打开原文 ---------------- */

/** 常见网盘域名 → 中文标签，其余用主机名 */
/** @type {any[]} */
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
/**
 * @param {*} [url]
 */
export function linkLabel(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (_) {
    return '链接';
  }
  for (const [re, name] of HOST_LABELS) if (re.test(host)) return name;
  return host.replace(/^www\./, '');
}
/** 菜单里显示的短地址：去协议、超长中间省略
 *@param {*} [url]
 */
export function shortUrl(url) {
  const s = String(url).replace(/^https?:\/\//i, '');
  return s.length > 46 ? s.slice(0, 30) + '…' + s.slice(-12) : s;
}

/* 链接选择菜单：多条链接时从按钮旁弹出（fixed 定位，自动避让视口边缘） */
/** @type {any} */
export let linkMenuEl = null;
/** @type {*} */
let linkMenuReturnFocus = null;
export function closeLinkMenu() {
  if (!linkMenuEl) return;
  linkMenuEl.remove();
  linkMenuEl = null;
  document.removeEventListener('click', onLinkMenuDocClick, true);
  document.removeEventListener('keydown', onLinkMenuKey, true);
  window.removeEventListener('resize', closeLinkMenu);
  window.removeEventListener('scroll', closeLinkMenu, true);
  // 菜单是键盘可达的：关掉时把焦点还给打开它的按钮，别让用户掉到 body
  /** @type {*} */
  const back = linkMenuReturnFocus;
  linkMenuReturnFocus = null;
  if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
}
/**
 * @param {*} [ev]
 */
export function onLinkMenuDocClick(ev) {
  if (linkMenuEl && !linkMenuEl.contains(ev.target)) closeLinkMenu();
}
/**
 * @param {*} [ev]
 */
export function onLinkMenuKey(ev) {
  if (!linkMenuEl) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    closeLinkMenu();
    return;
  }
  if (ev.key === 'Tab') {
    closeLinkMenu();
    return;
  }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Home' || ev.key === 'End') {
    ev.preventDefault();
    ev.stopPropagation();
    const items = Array.from(linkMenuEl.querySelectorAll('.link-menu-item'));
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement);
    let next;
    if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = items.length - 1;
    else
      next = Math.max(
        0,
        Math.min(items.length - 1, Math.max(idx, 0) + (ev.key === 'ArrowDown' ? 1 : -1)),
      );
    items[next].focus();
  }
}

/**
 * @param {*} [anchor]
 * @param {*} [urls]
 * @param {*} [onPick]
 */
export function openLinkMenu(anchor, urls, onPick) {
  closeLinkMenu();
  linkMenuReturnFocus = document.activeElement;
  const menu = document.createElement('div');
  menu.className = 'link-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = urls
    .map(
      /** @param {*} [u] @param {*} [i] */ (u, i) => `
    <button type="button" class="link-menu-item" role="menuitem" data-i="${i}">
      <span class="link-menu-label">${escapeHtml(linkLabel(u))}</span>
      <span class="link-menu-url">${escapeHtml(shortUrl(u))}</span>
    </button>`,
    )
    .join('');
  document.body.appendChild(menu);
  linkMenuEl = menu;

  const r = anchor.getBoundingClientRect();
  const gap = 6;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - menu.offsetWidth - 8));
  let top = r.bottom + gap;
  if (top + menu.offsetHeight > window.innerHeight - 8)
    top = Math.max(8, r.top - menu.offsetHeight - gap);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  // 弹出即入焦首项，↑↓ 漫游（见 onLinkMenuKey）
  /** @type {any} */
  const first = menu.querySelector('.link-menu-item');
  if (first) first.focus();

  menu.addEventListener(
    'click',
    /** @param {*} [ev] */ (ev) => {
      const item = ev.target.closest('.link-menu-item');
      if (!item) return;
      const u = urls[Number(item.getAttribute('data-i'))];
      closeLinkMenu();
      if (u) onPick(u);
    },
  );
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
/**
 * @param {*} [hash]
 */
export function writeHash(hash) {
  try {
    if (!hash) return;
    if (location.hash === hash) return;
    history.replaceState(null, '', hash);
  } catch (_) {
    /* 老浏览器 / 沙箱环境忽略 */
  }
}

/** 从 hash 里解析「视图 + 条目」：#cards / #reader / #reader/art/<id> / #ai …
 *@param {*} [hash]
 */
export function parseHash(hash) {
  const h = hash || '';
  if (h.startsWith('#reader/art/')) return { tab: 'reader', artId: h.slice('#reader/art/'.length) };
  if (h.startsWith('#cards')) return { tab: 'cards', artId: null };
  if (h.startsWith('#ai') || h.startsWith('#digest')) return { tab: 'ai', artId: null };
  if (h.startsWith('#reader')) return { tab: 'reader', artId: null };
  return { tab: null, artId: null };
}
