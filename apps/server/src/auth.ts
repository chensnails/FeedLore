/**
 * better-auth 实例（进程内单例）。
 *
 * 挂载方式见 index.ts：better-auth 自带 /api/auth/** 路由；
 * 业务侧另按 packages/contract 的形状提供 /api/login、/api/logout、/api/session。
 */

import { createAuth, type AuthInstance } from '@feedlore/auth';
import type { Db } from '@feedlore/db';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

let _auth: AuthInstance | null = null;

export function getAuth(db: Db): AuthInstance {
  if (_auth) return _auth;

  const secureCookies = process.env.AUTH_SECURE_COOKIES === '1';
  const trustedOrigins = (process.env.AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  _auth = createAuth({
    db,
    secret: required('AUTH_SECRET'),
    baseURL: process.env.AUTH_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`,
    trustedOrigins,
    secureCookies,
  });

  console.log(
    `[auth] better-auth 就绪 | baseURL=${process.env.AUTH_BASE_URL ?? '(默认)'} | secureCookies=${secureCookies} | trustedOrigins=${trustedOrigins.length}`,
  );
  return _auth;
}
