/**
 * 会话中间件（P4：接 better-auth 真实校验）。
 *
 * 与 P3 的区别：P3 是 501 桩（宁可拒绝也不假装放行）；P4 起真正校验会话，
 * 并把 better-auth 的用户映射成契约里的 SessionUser 注入 context。
 */

import type { MiddlewareHandler } from 'hono';
import type { AuthInstance } from '@feedlore/auth';
import type { Role } from '@feedlore/contract';
import { normalizeRole } from '../lib/roles';

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
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
  level: 'user' | 'write' | 'admin',
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!auth) {
      console.error('[auth] better-auth 未初始化（缺少 AUTH_SECRET 或数据库未就绪）');
      return c.json({ error: '鉴权服务未就绪' }, 503);
    }

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: '未登录' }, 401);

    const u = session.user as unknown as AuthUserLike;
    const role = normalizeRole(u.role);
    if (level === 'admin' && role !== 'admin') {
      return c.json({ error: '需要管理员权限' }, 403);
    }
    // 'write'：登录即可，但只读账户只能阅读。配置类写接口一律用它，
    // 不靠前端隐藏按钮兜底（直接调接口也必须被拦）。
    if (level === 'write' && role === 'readonly') {
      return c.json({ error: '只读账户不能修改配置，请联系管理员' }, 403);
    }

    c.set('user', {
      id: u.id,
      username: u.username ?? u.name ?? u.email ?? '',
      role,
    });
    await next();
  };
}
