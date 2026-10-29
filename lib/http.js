'use strict';

/**
 * HTTP 层小工具（v1.7.2-test2 抽出，纯逻辑、无副作用，可直接单测）
 *
 * 为什么要有这个文件：
 *  1. `parseCookies` 原来在 server.js 里裸调 `decodeURIComponent`，一个
 *     `Cookie: feedlore_sid=%E0%A4%A` 就能抛 URIError，而它跑在请求 handler 的
 *     try 之外 → 未捕获异常 → Node 终止进程（未授权远程 DoS，见 S-01）。
 *  2. 错误响应原来统一 502 + `String(err.message)`，把 PG 原文、内部主机名
 *     全回吐给客户端（S-05）。这里把「异常 → 状态码 + 对外文案」收敛成一处。
 */

/** 带语义状态码的错误。status < 500 才允许把 message 回给客户端。 */
class HttpError extends Error {
  constructor(status, message, code) {
    super(message || '请求失败');
    this.name = 'HttpError';
    this.status = Number(status) || 500;
    this.code = code || undefined;
    this.expose = this.status < 500;
  }
}

/** 容错解析 Cookie 头：解不开就保留原文，交给验签判成无效会话，绝不抛。 */
function parseCookies(req) {
  const out = {};
  const raw = String((req && req.headers && req.headers.cookie) || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    const val = part.slice(i + 1).trim();
    try { out[key] = decodeURIComponent(val); } catch (_) { out[key] = val; }
  }
  return out;
}

/* ---------- 异常 → 对外响应 ---------- */

/* PostgreSQL SQLSTATE：
 *   22xxx = data exception（非法输入语法 / 数值越界 / 非法日期 / 编码不认识的字节）
 *   23xxx = integrity constraint（唯一键 / 外键 / 非空）
 * 这些都属于「客户端给的数据不对」，应该是 400 而不是 5xx。
 * 另外 NUL 字节（?q=%00）报的是 "invalid byte sequence for encoding UTF8: 0x00"，也落在 22 段。 */
const PG_CLIENT_ERROR = /^2[23]/;

/* 连不上 / 连上又断 / 连接池耗尽 —— 属于「服务暂时不可用」，503 而不是 500，
 * 让监控与编排层能区分「代码炸了」和「依赖挂了」。 */
const NET_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
  'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
  '08000', '08003', '08006', '08001', '08004', '57P01', '57P02', '57P03', '53300',
]);

const codeOf = (e) => String((e && e.code) || (e && e.cause && e.cause.code) || '');

/**
 * 异常 → { status, message, code }。
 * 5xx 一律换成通用文案（细节只进日志），避免把表结构 / 列类型 / 内部主机名回吐给客户端。
 */
function classifyError(err) {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      message: err.expose ? err.message : '服务器内部错误',
      code: err.code,
    };
  }
  const code = codeOf(err);
  const msg = String((err && err.message) || '');
  if (PG_CLIENT_ERROR.test(code)) return { status: 400, message: '请求参数不合法', code: 'BAD_INPUT' };
  if (NET_CODES.has(code)) return { status: 503, message: '数据库暂时不可用，请稍后重试', code: 'DB_UNAVAILABLE' };
  if (err && err.name === 'AbortError') return { status: 504, message: '请求超时', code: 'TIMEOUT' };
  if (/body too large/i.test(msg)) return { status: 413, message: '请求体过大', code: 'BODY_TOO_LARGE' };
  if (/invalid json/i.test(msg)) return { status: 400, message: '请求体不是合法 JSON', code: 'BAD_JSON' };
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|terminating connection|Connection terminated|timeout exceeded|Connection timeout/i.test(msg)) {
    return { status: 503, message: '数据库暂时不可用，请稍后重试', code: 'DB_UNAVAILABLE' };
  }
  return { status: 500, message: '服务器内部错误', code: 'INTERNAL' };
}

/* ---------- 安全响应头（纵深防御）----------
 * 当前正文全程纯文本渲染，XSS 面很小；这些头是「该有但没有」的第二道保险：
 *  - nosniff：别把用户可控的响应当脚本执行
 *  - X-Frame-Options + frame-ancestors 'none'：禁止被第三方 iframe 嵌套（点击劫持）
 *  - CSP：只允许同源脚本/样式/连接，图片放行 https 外链（频道图标、正文配图走外链）
 *  - Referrer-Policy：跨站只带 origin，不泄露站内路径
 *
 * 注：首页会注入 `window.__APPEARANCE__` 内联脚本，登录页也有少量内联代码，
 * 所以 script-src 保留 'unsafe-inline'（否则得给每个响应发 nonce，收益不抵改动面）。
 * 即便如此，CSP 仍然挡住了「外站脚本 / eval / 表单外发」这几类。 */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
};

/** 给每个响应挂上安全头；https 请求额外加 HSTS（http 上加会被浏览器忽略，纯噪音） */
function applySecurityHeaders(res, { https } = {}) {
  for (const k of Object.keys(SECURITY_HEADERS)) res.setHeader(k, SECURITY_HEADERS[k]);
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

module.exports = {
  HttpError, parseCookies, classifyError, applySecurityHeaders,
  SECURITY_HEADERS, CSP,
};
