import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, openAPI, username } from 'better-auth/plugins';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * @feedlore/auth — better-auth 集成骨架（v2 P1 脚手架）。
 *
 * 设计要点见同目录 DESIGN.md。本文件是可编译的骨架，表明 better-auth + Hono + Drizzle
 * 的组合在类型层面成立；真正落地需等 packages/db 的 auth schema 就绪（P3）。
 */

export interface CreateAuthOptions {
  /** Drizzle pg 实例（来自 packages/db）。 */
  db: NodePgDatabase;
  /** 会话加密密钥（对应 AUTH_SECRET / BETTER_AUTH_SECRET）。 */
  secret: string;
  /** 后端基础 URL，better-auth 用于拼接回调。 */
  baseURL: string;
  /** 受信前端源（SPA 跨域携带 Cookie 必需）。 */
  trustedOrigins: string[];
}

export function createAuth(opts: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(opts.db, { provider: 'pg' }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 4,
      requireEmailVerification: false,
    },
    // username：保持 legacy「用户名即登录标识」的体验（better-auth 默认走 email）
    // admin：提供 /api/auth/admin/* 与 user.role 列，替代手写 isAdmin()
    // openAPI：可选，便于生成客户端与文档
    plugins: [username(), admin(), openAPI()],
    advanced: {
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: 'none' },
    },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;
/** 注入到 Hono context 的会话类型（c.get('user') / c.get('session')）。 */
export type SessionUser = AuthInstance['$Infer']['Session']['user'];
export type SessionData = AuthInstance['$Infer']['Session']['session'];
