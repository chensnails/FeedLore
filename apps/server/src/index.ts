/**
 * FeedLore v2 —— apps/server（Hono）进程入口。
 *
 * 只做副作用：连库、初始化 better-auth、装配 app、监听端口。
 * 路由与类型在 app.ts（那里导出的 AppType 供前端 hc 推导）。
 *
 * - DATABASE_URL 缺失时仍启动（健康检查报 db.ready=false），便于容器排错。
 * - 鉴权交给 better-auth：其自带 /api/auth/** 直接挂载，业务侧另按契约提供
 *   /api/login、/api/logout、/api/session。
 */

import { serve } from '@hono/node-server';
import { createDb, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import { APP_VERSION, DATABASE_URL, HOST, PORT } from './env';
import { getAuth } from './auth';
import { createApp } from './app';

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

const app = createApp({ db, auth });

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[v2] FeedLore ${APP_VERSION} 已启动 → http://${HOST}:${info.port}`);
  console.log(
    `[v2] 端点：GET /api/health、GET /api/session、POST /api/login、POST /api/logout、GET /api/feeds(user)`,
  );
});
