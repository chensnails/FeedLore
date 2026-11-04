/**
 * 设备 / 会话管理（契约 `auth.sessionsList / sessionRevoke / sessionsRevokeOthers`）。
 *
 * 三条边界：
 * 1. **只下发展示字段**：`sessions.token` 是凭据本体，绝不进响应；单台吊销按会话 id
 *    在库里删（不经过 better-auth 的 token 入参接口），避免前端接触 token。
 * 2. **只能动自己的会话**：所有语句都带 `user_id = 当前用户`，别人的 id 一律 404，
 *    不泄露「这个会话是否存在」。
 * 3. **不能在这里吊销当前会话**：前端把当前设备单独标出来、不提供下线按钮；真要退出
 *    走「退出登录」，那条路径会正确清 Cookie。
 */

import { Hono } from 'hono';
import { and, desc, eq, gt, ne } from 'drizzle-orm';
import { sessions, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import { auth as authSpec } from '@feedlore/contract';
import { assertResponse } from '../lib/validate';
import { apiError } from '../lib/apiError';
import { requireAuth, type AppEnv } from '../middleware/auth';

export function sessionRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    .get(authSpec.sessionsList.path, requireAuth(auth, 'user'), async (c) => {
      if (!db) return apiError(c, 'E_DB_NOT_READY');
      const me = c.get('user');

      const rows = await db
        .select({
          id: sessions.id,
          ipAddress: sessions.ipAddress,
          userAgent: sessions.userAgent,
          createdAt: sessions.createdAt,
          updatedAt: sessions.updatedAt,
          expiresAt: sessions.expiresAt,
        })
        .from(sessions)
        .where(and(eq(sessions.userId, me.id), gt(sessions.expiresAt, new Date())))
        .orderBy(desc(sessions.updatedAt));

      const list = rows
        .map((r) => ({
          id: r.id,
          current: r.id === me.sessionId,
          ip: r.ipAddress ?? null,
          userAgent: r.userAgent ?? null,
          createdAt: r.createdAt.toISOString(),
          lastSeenAt: r.updatedAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
        }))
        // 本机排最前；其余按最近活动时间（查询已按 updated_at 倒序，sort 只做稳定归位）
        .sort((a, b) => Number(b.current) - Number(a.current));

      return c.json(
        assertResponse(authSpec.sessionsList.response, { sessions: list }, 'GET /api/sessions'),
      );
    })
    .post(authSpec.sessionsRevokeOthers.path, requireAuth(auth, 'user'), async (c) => {
      if (!db) return apiError(c, 'E_DB_NOT_READY');
      const me = c.get('user');
      if (!me.sessionId) return apiError(c, 'E_SERVICE_NOT_READY');

      const removed = await db
        .delete(sessions)
        .where(
          and(
            eq(sessions.userId, me.id),
            ne(sessions.id, me.sessionId),
            gt(sessions.expiresAt, new Date()),
          ),
        )
        .returning({ id: sessions.id });

      console.log(`[sessions] revoked ${removed.length} other session(s) for ${me.username}`);
      return c.json(
        assertResponse(
          authSpec.sessionsRevokeOthers.response,
          { ok: true, revoked: removed.length },
          'POST /api/sessions/revoke-others',
        ),
      );
    })
    .delete(authSpec.sessionRevoke.path, requireAuth(auth, 'user'), async (c) => {
      if (!db) return apiError(c, 'E_DB_NOT_READY');
      const me = c.get('user');
      if (!me.sessionId) return apiError(c, 'E_SERVICE_NOT_READY');

      const id = c.req.param('id');
      if (id === me.sessionId) return apiError(c, 'E_CANNOT_REVOKE_CURRENT');

      const removed = await db
        .delete(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.userId, me.id)))
        .returning({ id: sessions.id });

      if (!removed.length) return apiError(c, 'E_SESSION_NOT_FOUND');
      return c.json(assertResponse(authSpec.sessionRevoke.response, { ok: true }, 'DELETE /api/sessions/:id'));
    });
}
