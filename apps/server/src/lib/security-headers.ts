/**
 * 应用层安全响应头。
 *
 * 图片代理（/api/img）自带一套更严格的头和长缓存，这里整体跳过它，
 * 否则全局头会把 `default-src 'none'; sandbox` 和 Cache-Control 覆盖掉。
 */

import { randomBytes } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../middleware/auth';

/**
 * 内联脚本一律用 nonce 放行（HTML 入口里都有首屏主题脚本，注入的偏好脚本也是内联的）。
 * 样式仍允许 inline：v1 的样式注入大量依赖 style 属性与内联 <style>。
 * 图片全部经 /api/img 同源代理，因此 img-src 不需要放行外部域。
 */
const CSP_TEMPLATE = [
  "default-src 'self'",
  "script-src 'self' 'nonce-__NONCE__'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function isHttps(c: Context<AppEnv>): boolean {
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (proto) return proto === 'https';
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const nonce = randomBytes(16).toString('base64');
    c.set('cspNonce', nonce);

    // 图片代理自己设置整套响应头（含沙箱 CSP 与长缓存），不能被全局值覆盖
    if (!c.req.path.startsWith('/api/img')) {
      c.header('Content-Security-Policy', CSP_TEMPLATE.replace('__NONCE__', nonce));
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('X-Frame-Options', 'DENY');
      c.header('Referrer-Policy', 'same-origin');
      c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
      // COOP / HSTS 只在安全上下文生效：HTTP 下浏览器会忽略并打一条控制台错误
      if (isHttps(c)) {
        c.header('Cross-Origin-Opener-Policy', 'same-origin');
        // 不写 includeSubDomains / preload：子域是否全站 HTTPS 由部署方决定
        c.header('Strict-Transport-Security', 'max-age=31536000');
      }
    }

    await next();
  };
}

/**
 * 给 HTML 里所有 `<script>` 打上本次请求的 nonce。
 * 外部脚本带 nonce 也无害；内联脚本没有它会被 CSP 直接拦掉。
 */
export function applyCspNonce(html: string, nonce: string): string {
  if (!nonce) return html;
  return html.replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
}
