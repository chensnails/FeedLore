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
  /**
   * Drizzle pg 实例（来自 packages/db）。
   * 泛型放开：db 包导出的是带具体 schema 的 NodePgDatabase<typeof schema>，
   * 而 better-auth 的 drizzleAdapter 只按运行时形态访问表；若把泛型收紧成
   * Record<string, never>，传入具体实例会因 dbName 不兼容而编译失败。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>;
  /** 会话加密密钥（对应 AUTH_SECRET / BETTER_AUTH_SECRET）。 */
  secret: string;
  /** 后端基础 URL，better-auth 用于拼接回调。 */
  baseURL: string;
  /** 受信前端源（SPA 跨域携带 Cookie 必需）。 */
  trustedOrigins: string[];
  /**
   * Cookie 是否仅限 HTTPS。
   * ⚠️ 默认 true（生产正确），但在**纯 HTTP 环境（如内网测试容器）下浏览器/客户端
   * 不会回传 secure Cookie**，表现为「登录成功但后续请求仍 401」。测试栈必须显式传 false。
   */
  secureCookies?: boolean;
  /**
   * 是否信任反代的客户端 IP 头（`X-Forwarded-For` / `X-Real-IP`）。
   *
   * ⚠️ 只有**确实挂在反代后面**时才开：直接暴露端口时开它，任何人都能伪造该头，
   * 把登录限流按 IP 分桶的防护变成一句空话（换一个 header 就是一次新配额）。
   * 不开的代价是 better-auth 拿不到客户端 IP → 限流退化成「全站共用一个桶」，
   * 别人连错几次密码就可能把你也锁在门外。生产（1Panel 反代 → 3211）应当开启。
   */
  trustProxy?: boolean;
}

export function createAuth(opts: CreateAuthOptions) {
  return betterAuth({
    // ⚠️ usePlural 必须显式开启：better-auth 默认按**单数**表名（user/session/account/
    // verification）查找，而 packages/db 的 schema 是复数（users/sessions/...）。
    // 漏掉这一项时编译期一切正常，运行期才抛 SchemaMismatchError（Missing tables）。
    database: drizzleAdapter(opts.db, { provider: 'pg', usePlural: true }),
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
      // secure Cookie 在纯 HTTP 下不会被回传 → 登录成功却仍 401，测试栈务必传 false。
      defaultCookieAttributes: {
        secure: opts.secureCookies ?? true,
        httpOnly: true,
        sameSite: (opts.secureCookies ?? true) ? 'none' : 'lax',
      },
      // 反代后面才信任 XFF：见 CreateAuthOptions.trustProxy 注释
      ...(opts.trustProxy
        ? { ipAddress: { ipAddressHeaders: ['x-forwarded-for', 'x-real-ip'] } }
        : {}),
    },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;
/** 注入到 Hono context 的会话类型（c.get('user') / c.get('session')）。 */
export type SessionUser = AuthInstance['$Infer']['Session']['user'];
export type SessionData = AuthInstance['$Infer']['Session']['session'];
