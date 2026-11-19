/**
 * 会话中间件（P4：接 better-auth 真实校验）。
 *
 * 与 P3 的区别：P3 是 501 桩（宁可拒绝也不假装放行）；P4 起真正校验会话，
 * 并把 better-auth 的用户映射成契约里的 SessionUser 注入 context。
 */

import type { MiddlewareHandler } from 'hono';
import type { AuthInstance } from '@feedlore/auth';
import type { Role } from '@feedlore/contract';
import { apiError } from '../lib/apiError';
import { normalizeRole } from '../lib/roles';

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  /** 当前请求所用会话的 id（设备管理据此标记「本机」，不把 token 交给前端）。 */
  sessionId: string;
}

export type AppEnv = {
  Variables: {
    user: SessionUser;
    /** 每次请求生成的 CSP nonce，HTML 内的内联脚本必须带同一个值。 */
    cspNonce: string;
  };
};

/** better-auth 的 user 形状随插件变化，这里收窄成我们真正用的字段。 */
interface AuthUserLike {
  id: string;
  username?: string | null;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  /** additionalFields 暴露的「首次登录必须改密」标记。 */
  mustChangePassword?: boolean | null;
}

/**
 * 未完成首次改密时仍放行的接口。
 *
 * 除这两条以外，所有业务接口一律 403 —— 前端隐藏按钮不算防护，直接打接口同样被拒。
 * - `/api/session`：改密页要读当前状态（它本身是公开端点，不经过这里，列上只为意图明确）
 * - `/api/account`：提交新密码的唯一入口（仍要求校验当前密码）
 * better-auth 的直通端点（change-password / sign-out / get-session）不走这个中间件，
 * 天然放行，正好覆盖「登出」这条退路。
 */
const ALLOWED_WHILE_PASSWORD_CHANGE = new Set(['/api/session', '/api/account']);

export function requireAuth(
  auth: AuthInstance | null,
  level: 'user' | 'write' | 'admin',
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!auth) {
      console.error('[auth] better-auth not initialized (missing AUTH_SECRET or database not ready)');
      return apiError(c, 'E_AUTH_NOT_READY');
    }

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return apiError(c, 'E_UNAUTHORIZED');

    const u = session.user as unknown as AuthUserLike;
    const current = session.session as unknown as { id?: string };

    /* 首次登录必须改密：只放行改密本身（见 ALLOWED_WHILE_PASSWORD_CHANGE）。
     * 标记只由空站点播种置位，改密成功后清掉；升级前就存在的账号恒为 false，
     * 所以老用户不会被拦。 */
    if (u.mustChangePassword === true && !ALLOWED_WHILE_PASSWORD_CHANGE.has(c.req.path)) {
      return apiError(c, 'E_PASSWORD_CHANGE_REQUIRED');
    }

    const role = normalizeRole(u.role);
    if (level === 'admin' && role !== 'admin') {
      return apiError(c, 'E_ADMIN_ONLY');
    }
    // 'write'：登录即可，但只读账户只能阅读。配置类写接口一律用它，
    // 不靠前端隐藏按钮兜底（直接调接口也必须被拦）。
    if (level === 'write' && role === 'readonly') {
      return apiError(c, 'E_READONLY_CONFIG');
    }

    c.set('user', {
      id: u.id,
      username: u.username ?? u.name ?? u.email ?? '',
      role,
      sessionId: String(current?.id ?? ''),
    });
    await next();
  };
}
