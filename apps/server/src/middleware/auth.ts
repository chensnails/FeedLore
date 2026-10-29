/**
 * 会话中间件（P3 骨架）。
 *
 * P3 只搭骨架：better-auth 尚未接入，因此这里不假装鉴权生效——
 * 未开测试开关时直接返回 501「未实现」，避免留下一个看似有鉴权实则全放行的坑。
 * P4 接入 better-auth 后，改为 auth.api.getSession 并按 level 校验 role。
 */

import type { MiddlewareHandler } from 'hono';
import { AUTH_DISABLED } from '../env';

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

/** 测试容器里的固定开发身份（仅 V2_AUTH_DISABLED=1 时使用）。 */
const DEV_USER: SessionUser = { id: '0', username: 'dev', role: 'admin' };

export function requireAuth(level: 'user' | 'admin'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (AUTH_DISABLED) {
      c.set('user', DEV_USER);
      await next();
      return;
    }
    // TODO(P4): 接入 better-auth：const s = await auth.api.getSession({ headers: c.req.raw.headers })
    //          未登录 → 401；level==='admin' 且 role!=='admin' → 403
    console.warn(`[auth] 会话校验未接入，拒绝 ${level} 级访问 ${c.req.path}`);
    return c.json({ error: '会话校验尚未接入（P4 进行中）' }, 501);
  };
}
