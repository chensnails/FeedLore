/**
 * better-auth 实例（进程内单例）。
 *
 * 挂载方式见 index.ts：better-auth 自带 /api/auth/** 路由；
 * 业务侧另按 packages/contract 的形状提供 /api/login、/api/logout、/api/session。
 */

import { type AuthInstance, createAuth, type TrustedOrigins } from '@feedlore/auth';
import type { Db } from '@feedlore/db';
import {
  getAuthBaseUrl,
  getAuthTrustedOrigins,
  isAuthSecureCookies,
  isTrustProxy,
  PORT,
} from './env';
import { log } from './lib/logger';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const trimmed = (v: string | undefined): string => v?.trim() ?? '';

/**
 * 零配置部署：没有 AUTH_TRUSTED_ORIGINS 时，把「请求自己访问的 Host」当作唯一可信来源。
 *
 * ⚠️ 只信 Host（含请求 URL 里的 host），**绝不信 Origin 头**：Origin 是待校验的
 * 那一方，拿它当白名单等于没有白名单。
 *
 * 同时给 http/https 两种协议：容器里看不到反代的 TLS 终结，而站点实际用哪种协议
 * 只有浏览器知道。多给一种协议不会放宽跨站防护 —— 攻击者页面的 Origin 是它自己的
 * 域名，永远不会等于本站 Host。
 *
 * ⚠️ 为何这里**刻意不按 `TRUST_PROXY` 门控** `x-forwarded-host/proto`（与限流的
 * pickClientIp 语义不同）：这两个头用来推导「本站可信来源」，不是用来取客户端 IP。
 * 反代部署（本站演示站就是 CF → OpenResty → 容器）常常没设 TRUST_PROXY，但容器看到的
 * Host 是内网地址；若此时忽略转发头，CSRF 白名单就会变成内网 host，浏览器带公网 Origin
 * 的写请求全部 403，站点直接不可用。而攻击者无法在受害者浏览器里伪造自定义头（跨站
 * fetch 自定义头会触发 CORS 预检并被拒），所以这里的宽松不等于 CSRF 失守；真正需要
 * 严格门控的是取客户端 IP 做限流，那已由 pickClientIp 处理。
 */
export function sameOriginCandidates(request?: Request): string[] {
  if (!request) return [];
  const headers = request.headers;
  let urlHost = '';
  try {
    urlHost = new URL(request.url).host;
  } catch {
    /* 非法 URL 时退回只看头 */
  }

  const host =
    trimmed(headers.get('x-forwarded-host') ?? undefined) ||
    trimmed(headers.get('host') ?? undefined) ||
    urlHost;
  if (!host) return [];

  const list = [`http://${host}`, `https://${host}`];
  const proto = trimmed(headers.get('x-forwarded-proto') ?? undefined)
    .split(',')[0]
    ?.trim();
  if (proto === 'http' || proto === 'https') list.unshift(`${proto}://${host}`);
  return [...new Set(list)];
}

let _auth: AuthInstance | null = null;

export function getAuth(db: Db): AuthInstance {
  if (_auth) return _auth;

  const secureCookies = isAuthSecureCookies();
  const configuredOrigins = getAuthTrustedOrigins()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const trustedOrigins: TrustedOrigins = configuredOrigins.length
    ? configuredOrigins
    : sameOriginCandidates;
  const baseURL = getAuthBaseUrl() || `http://127.0.0.1:${PORT}`;

  _auth = createAuth({
    db,
    secret: required('AUTH_SECRET'),
    baseURL,
    trustedOrigins,
    secureCookies,
    // 只有真的挂在反代后面才开；直接暴露端口时开它等于让限流按 IP 分桶形同虚设
    trustProxy: isTrustProxy(),
  });

  log.info(
    `[auth] better-auth ready | baseURL=${getAuthBaseUrl() || '(from request Host)'}` +
      ` | origins=${configuredOrigins.length || 'same-origin (dynamic)'} | secureCookies=${secureCookies}` +
      ` | trustProxy=${isTrustProxy()}`,
  );
  return _auth;
}
