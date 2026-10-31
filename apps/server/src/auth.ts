/**
 * better-auth 实例（进程内单例）。
 *
 * 挂载方式见 index.ts：better-auth 自带 /api/auth/** 路由；
 * 业务侧另按 packages/contract 的形状提供 /api/login、/api/logout、/api/session。
 */

import { createAuth, type AuthInstance, type TrustedOrigins } from '@feedlore/auth';
import type { Db } from '@feedlore/db';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
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
 */
export function sameOriginCandidates(request?: Request): string[] {
  if (!request) return [];
  const headers = request.headers;
  let urlHost = '';
  try {
    urlHost = new URL(request.url).host;
  } catch { /* 非法 URL 时退回只看头 */ }

  const host = trimmed(headers.get('x-forwarded-host') ?? undefined)
    || trimmed(headers.get('host') ?? undefined)
    || urlHost;
  if (!host) return [];

  const list = [`http://${host}`, `https://${host}`];
  const proto = trimmed(headers.get('x-forwarded-proto') ?? undefined).split(',')[0]?.trim();
  if (proto === 'http' || proto === 'https') list.unshift(`${proto}://${host}`);
  return [...new Set(list)];
}

let _auth: AuthInstance | null = null;

export function getAuth(db: Db): AuthInstance {
  if (_auth) return _auth;

  const secureCookies = process.env.AUTH_SECURE_COOKIES === '1';
  const configuredOrigins = (process.env.AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const trustedOrigins: TrustedOrigins = configuredOrigins.length ? configuredOrigins : sameOriginCandidates;
  const baseURL = trimmed(process.env.AUTH_BASE_URL) || `http://127.0.0.1:${process.env.PORT ?? 3000}`;

  _auth = createAuth({
    db,
    secret: required('AUTH_SECRET'),
    baseURL,
    trustedOrigins,
    secureCookies,
    // 只有真的挂在反代后面才开；直接暴露端口时开它等于让限流按 IP 分桶形同虚设
    trustProxy: process.env.TRUST_PROXY === '1',
  });

  console.log(
    `[auth] better-auth 就绪 | baseURL=${trimmed(process.env.AUTH_BASE_URL) || '(按请求)'}`
      + ` | origins=${configuredOrigins.length || '同源动态'} | secureCookies=${secureCookies}`
      + ` | trustProxy=${process.env.TRUST_PROXY === '1'}`,
  );
  return _auth;
}
