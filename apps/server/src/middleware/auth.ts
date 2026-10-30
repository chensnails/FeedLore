/**
 * 会话中间件（P4：接 better-auth 真实校验）。
 *
 * 与 P3 的区别：P3 是 501 桩（宁可拒绝也不假装放行）；P4 起真正校验会话，
 * 并把 better-auth 的用户映射成契约里的 SessionUser 注入 context。
 */

import type { MiddlewareHandler } from 'hono';
import type { AuthInstance } from '@feedlore/auth';

export interface SessionUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export type AppEnv = {
  Variables: {
    user: SessionUser;
  };
};

/** better-auth 的 user 形状随插件变化，这里收窄成我们真正用的字段。 */
interface AuthUserLike {
  id: string;
  username?: string | null;
  name?: string | null;
  email?: string | null;
  role?: string | null;
}

export function requireAuth(
  auth: AuthInstance | null,
  level: 'user' | 'admin',
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!auth) {
      console.error('[auth] better-auth 未初始化（缺少 AUTH_SECRET 或数据库未就绪）');
      return c.json({ error: '鉴权服务未就绪' }, 503);
    }

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: '未登录' }, 401);

    const u = session.user as unknown as AuthUserLike;
    const role: 'admin' | 'user' = u.role === 'admin' ? 'admin' : 'user';
    if (level === 'admin' && role !== 'admin') {
      return c.json({ error: '需要管理员权限' }, 403);
    }

    c.set('user', {
      id: u.id,
      username: u.username ?? u.name ?? u.email ?? '',
      role,
    });
    await next();
  };
}
