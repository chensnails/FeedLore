/**
 * 鉴权端点（按 packages/contract 的 auth 分组实现）。
 *
 * 实现策略：**不重写密码学/会话逻辑**，而是把请求转发给 better-auth 自带的 handler
 * （/api/auth/sign-in/username、/api/auth/sign-out），只做两件事——
 *   1) 把 better-auth 的响应翻译成契约形状并做运行时校验；
 *   2) 原样转发 Set-Cookie（会话 Cookie 由 better-auth 签发）。
 * 这样既守住契约，又不自己造已解决的高危部件。
 */

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AuthInstance } from '@feedlore/auth';
import type { Db } from '@feedlore/db';
import { auth as authSpec, loginBody } from '@feedlore/contract';
import { assertResponse, parseBody } from '../lib/validate';
import { requireAuth, type AppEnv } from '../middleware/auth';

/** Node 22 的 Headers 支持 getSetCookie；这里做一次安全取用，兼容类型差异。 */
function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  return typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
}

function baseURL(): string {
  return process.env.AUTH_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

export function authRoutes(db: Db | null, auth: AuthInstance | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /* ---------------- POST /api/login ---------------- */
  app.post(authSpec.login.path, async (c) => {
    if (!auth) return c.json({ error: '鉴权服务未就绪' }, 503);

    const raw = await c.req.json().catch(() => null);
    const body = parseBody(loginBody, raw, 'POST /api/login');

    // 交给 better-auth 的 username 登录端点（真正校验密码并签发会话）
    const res = await auth.handler(
      new Request(new URL('/api/auth/sign-in/username', baseURL()), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: body.username, password: body.password }),
      }),
    );

    if (!res.ok) {
      // 不区分「用户不存在」与「密码错误」，避免账号枚举
      return c.json({ error: '用户名或密码错误' }, 401);
    }

    const data = (await res.json().catch(() => ({}))) as {
      user?: { username?: string; role?: string };
    };
    const role = data.user?.role === 'admin' ? 'admin' : 'user';

    const payload = assertResponse(
      authSpec.login.response,
      { ok: true, username: data.user?.username ?? body.username, role },
      'POST /api/login',
    );

    const out = c.json(payload);
    for (const sc of setCookiesOf(res)) out.headers.append('Set-Cookie', sc);
    return out;
  });

  /* ---------------- POST /api/logout ---------------- */
  app.post(authSpec.logout.path, requireAuth(auth, 'user'), async (c) => {
    if (!auth) return c.json({ error: '鉴权服务未就绪' }, 503);

    const res = await auth.handler(
      new Request(new URL('/api/auth/sign-out', baseURL()), {
        method: 'POST',
        headers: c.req.raw.headers,
      }),
    );

    const payload = assertResponse(
      authSpec.logout.response,
      { ok: res.ok },
      'POST /api/logout',
    );
    const out = c.json(payload);
    for (const sc of setCookiesOf(res)) out.headers.append('Set-Cookie', sc);
    return out;
  });

  /* ---------------- GET /api/session ---------------- */
  app.get(authSpec.session.path, async (c) => {
    const session = auth ? await auth.api.getSession({ headers: c.req.raw.headers }) : null;

    let dbReady = false;
    if (db) {
      try {
        await db.execute(sql`select 1`);
        dbReady = true;
      } catch {
        dbReady = false;
      }
    }

    const u = session ? (session.user as unknown as { id: string; username?: string; role?: string }) : null;

    const payload = assertResponse(
      authSpec.session.response,
      {
        authenticated: Boolean(session),
        username: u?.username ?? null,
        role: u?.role === 'admin' ? 'admin' : u ? 'user' : null,
        id: u?.id ?? null,
        dbReady,
      },
      'GET /api/session',
    );
    return c.json(payload);
  });

  return app;
}
