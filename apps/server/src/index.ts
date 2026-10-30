/**
 * FeedLore v2 —— apps/server（Hono）入口。
 *
 * 设计要点：
 * - 路由只做编排；数据访问走 packages/db，请求/响应形状由 packages/contract 强制。
 * - DATABASE_URL 缺失时仍启动（健康检查报 db.ready=false），便于容器排错。
 * - 鉴权交给 better-auth：其自带 /api/auth/** 直接挂载，业务侧另按契约提供
 *   /api/login、/api/logout、/api/session。
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createDb, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import { APP_VERSION, DATABASE_URL, HOST, PORT } from './env';
import { getAuth } from './auth';
import type { AppEnv } from './middleware/auth';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { feedsRoutes } from './routes/feeds';

let db: Db | null = null;
if (DATABASE_URL) {
  try {
    db = createDb(DATABASE_URL);
    console.log('[db] 已初始化连接池');
  } catch (e) {
    console.error('[db] 初始化失败：', (e as Error)?.message ?? e);
  }
} else {
  console.warn('[boot] 未设置 DATABASE_URL —— 数据类端点将返回 503');
}

let auth: AuthInstance | null = null;
if (db) {
  try {
    auth = getAuth(db);
  } catch (e) {
    console.error('[auth] better-auth 初始化失败：', (e as Error)?.message ?? e);
  }
} else {
  console.warn('[boot] 数据库未就绪 —— better-auth 未启动，鉴权端点返回 503');
}

const app = new Hono<AppEnv>();

// better-auth 自带路由（sign-in/username、sign-out、get-session …）
if (auth) {
  const authInstance = auth;
  app.on(['GET', 'POST'], '/api/auth/**', (c) => authInstance.handler(c.req.raw));
}

app.onError((err, c) => {
  // 自定义错误（ContractViolation/BadRequest）带 status；Hono 的 HTTPResponseError 不带。
  const raw = err as unknown as { status?: unknown };
  const s = typeof raw.status === 'number' ? raw.status : 500;
  if (s >= 500) console.error('[error]', err);
  const body = { error: s >= 500 ? '服务器内部错误' : err.message };
  if (s === 400) return c.json(body, 400);
  if (s === 401) return c.json(body, 401);
  if (s === 403) return c.json(body, 403);
  if (s === 501) return c.json(body, 501);
  if (s === 503) return c.json(body, 503);
  return c.json(body, 500);
});

app.notFound((c) => c.json({ error: '接口不存在' }, 404));

app.route('/', healthRoutes(db));
app.route('/', authRoutes(db, auth));
app.route('/', feedsRoutes(db, auth));

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[v2] FeedLore ${APP_VERSION} 已启动 → http://${HOST}:${info.port}`);
  console.log(
    `[v2] 端点：GET /api/health、GET /api/session、POST /api/login、POST /api/logout、GET /api/feeds(user)`,
  );
});
