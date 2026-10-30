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
import { startScheduler } from './lib/fetcher';
import { undiciVersionMismatch, undiciVersions } from './lib/net';
import { pruneImageCache } from './routes/img';

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

/* 抓取器：进程内调度（每分钟检查一次到期频道）。
 * 不用外部队列是刻意的 P5 决策——单进程足够、少一个故障点；多实例时才需要 BullMQ。 */
if (db) startScheduler(db);

/* 图片缓存清理：`image_cache` 随阅读量线性增长，不清会悄悄吃掉磁盘。
 * 首次延迟 10 分钟（别在冷启动和第一轮抓取抢数据库），之后每 6 小时一次。 */
if (db) scheduleImagePrune(db);

function scheduleImagePrune(database: Db): void {
  const run = (): void => {
    void pruneImageCache(database)
      .then((n) => {
        if (n > 0) console.log(`[img] 清理超期图片缓存 ${n} 条`);
      })
      .catch(() => { /* pruneImageCache 内部已记录 */ });
  };
  // unref：定时器不阻止进程退出（容器 stop 时不必等它）
  setTimeout(run, 10 * 60_000).unref();
  setInterval(run, 6 * 3600_000).unref();
}

/* undici 版本对齐：跨大版本会让 IP 钉定失效（1.7.3 全站抓取失败的真凶）。
 * 这里只喊一声，真正的兜底在 lib/net.safeFetch —— 钉定失效时降级重试并告警。 */
if (undiciVersionMismatch()) {
  const v = undiciVersions();
  console.warn(
    `[net] ⚠️ undici 版本不匹配（内置 ${v.builtin} / 依赖 ${v.installed}）：`
    + 'IP 钉定会失效，请把 apps/server 的 undici 锁到与 Node 内置一致的大版本',
  );
} else {
  const v = undiciVersions();
  console.log(`[net] undici 对齐：内置 ${v.builtin} / 依赖 ${v.installed}`);
}

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`[v2] FeedLore ${APP_VERSION} 已启动 → http://${HOST}:${info.port}`);
  console.log(
    `[v2] 端点：GET /api/health、GET /api/session、POST /api/login、POST /api/logout、GET /api/feeds(user)`,
  );
});
