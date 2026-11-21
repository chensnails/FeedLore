/* 网络层：统一超时 + 幂等 GET 有限重试 + 写操作绝不重试 + 登录态处理。
 * 从 util.ts 抽出（深度重组）：I/O 端口，apiFetch 实现签名与调用约定逐字不变，
 * util.ts 通过 export * 保持外部链不变。 */

import { errorText } from './errorText.ts';
import type { ApiFetchOpts } from './types.ts';

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
/* 限流恢复由服务端说了算：429 带 Retry-After 时以它为准（取它与固定退避的较大值），
 * 但设 5s 上限，免得一个异常大的值把界面挂住。 */
export const NET_RETRY_AFTER_MAX_MS = 5000;

/** 超时文案的唯一口径：主站网络层与 login.html / change-password.html 两个独立文档共用。
 *  两个独立页拿不到模块，由 login-main.ts 把本函数挂到 window.netTimeout.text。
 *  改文案只改这里，不要在各页内联脚本里另写一套「xx 秒无响应」。 */
export function timeoutText(timeoutMs: number): string {
  return `网络请求超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试`;
}

/** 解析 Retry-After（秒数或 HTTP 日期）；无效/过去的时间返回 0。 */
export function parseRetryAfter(header: string | null, now = Date.now()): number {
  if (!header) return 0;
  const s = header.trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) {
    const sec = Number(s);
    return Number.isFinite(sec) && sec >= 0 ? Math.min(sec * 1000, NET_RETRY_AFTER_MAX_MS) : 0;
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.min(t - now, NET_RETRY_AFTER_MAX_MS));
}

/**
 * @param {*} [status]
 */
function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/** 单次请求：超时既 abort 真实请求，也用 race 保证「fetch 实现忽略 signal」时仍能结束。
 *  外部 signal（如 AbortSignal.timeout）触发时同步 abort 内部 controller。
 * @param {*} url
 * @param {*} opts
 * @param {*} [timeoutMs]
 * @param {*} [outerSignal]
 */

function fetchOnce(
  url: string,
  opts: RequestInit & { timeoutMs?: number; retry?: boolean; skipPasswordGate?: boolean },
  timeoutMs: number,
  outerSignal?: AbortSignal | null,
): Promise<Response> {
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
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timeoutErr: Error | null = null;
  const timeout =
    timeoutMs > 0
      ? new Promise((_: unknown, reject: (reason?: unknown) => void) => {
          timer = setTimeout(() => {
            /* 顺序很重要：先把可读错误交给 race，再 abort 真实请求。
             * 反过来的话，abort 会让 fetch 立刻 reject 一个底层英文
             * （Chrome 是 `signal is aborted without reason`），它抢在中文提示前面，
             * 用户看到的就是这句天书 —— 实测线上截图就是这个。 */
            const err = new Error(timeoutText(timeoutMs));
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
        })
      : null;

  const raced: Promise<Response> = timeout
    ? (Promise.race([req, timeout]) as Promise<Response>)
    : req;
  return raced
    .catch((err: unknown) => {
      // 兜一层：某些实现对 abort 是同步 reject，仍可能抢在中文错误前面
      if (timeoutErr && err !== timeoutErr) throw timeoutErr;
      throw err;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
      if (ctrl && outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    });
}

/** 带登录态处理的 fetch：401 时跳登录页；GET 失败有限重试；所有请求都有超时上限。
 *@param {*} [url]
 * @param {*} opts
 */
export async function apiFetch(url: string, opts: ApiFetchOpts = {}): Promise<Response> {
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
  let lastErr = null;
  let retryAfterMs = 0; // 仅 429 分支写入，下一次循环开始前消费
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
        if (res.status === 429) retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'));
      } else {
        return res;
      }
    } catch (err) {
      if (err && err.message === '未登录') throw err; // 401 不重试
      if (o.signal && o.signal.aborted) throw err; // 调用方主动取消
      lastErr = err;
      if (i + 1 >= attempts) throw err;
    }
    const backoff = Math.max(NET_RETRY_DELAY_MS * (i + 1), retryAfterMs);
    retryAfterMs = 0;
    await new Promise(/** @param {*} [r] */ (r) => setTimeout(r, backoff));
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
 */
export async function uploadArchive(url: string, file: Blob): Promise<Response> {
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
 *  中文文案由 src/core/errorText.ts 的词典负责；没命中码表时退回英文原文。
 *
 *  ⚠️ 会消费 res 的 body，只能在失败分支调用；成功分支的 `res.json()` 各走各的，
 *  互斥分支不受影响（各处本来就是这个结构）。
 */
export async function httpError(res: Response): Promise<Error & { status: number }> {
  let msg = '';
  try {
    const d = await res.json();
    msg = errorText(d);
  } catch (_e) {
    /* 非 JSON（网关 HTML、空 body、被截断）→ 退回状态码 */
  }
  const err = new Error(msg || 'HTTP ' + res.status) as Error & { status: number };
  err.status = res.status;
  return err;
}
