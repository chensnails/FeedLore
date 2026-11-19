/**
 * FeedLore v2 —— apps/server（Hono）进程入口。
 *
 * 只做副作用：自举（建库 / 结构迁移 / 密钥 / 播种）、连库、初始化 better-auth、装配 app、监听端口。
 * 路由与类型在 app.ts（那里导出的 AppType 供前端 hc 推导）。
 *
 * - 启动前先跑 `bootstrap()`：目标库不存在时先建库，再做结构迁移、补一枚零配置
 *   AUTH_SECRET、空站点播种（见 bootstrap.ts）。
 * - DATABASE_URL 缺失时仍启动（健康检查报 db.ready=false），便于容器排错。
 * - 鉴权交给 better-auth：其自带 /api/auth/** 直接挂载，业务侧另按契约提供
 *   /api/login、/api/logout、/api/session。
 */

import { serve } from '@hono/node-server';
import { createDb, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import { INITIAL_ADMIN_PASSWORD } from '@feedlore/contract';
import { APP_VERSION, HOST, PORT } from './env';
import { getAuth } from './auth';
import { createApp } from './app';
import { bootstrap, consumeStartupAdmin } from './bootstrap';
import { startScheduler } from './lib/fetcher';
import { startDigestScheduler } from './lib/digest';
import { startAiTagScheduler } from './lib/aiTag';
import { markInterruptedJobs } from './lib/aiJobs';
import { undiciVersionMismatch, undiciVersions } from './lib/net';
import { reloadSource } from './lib/settings';
import { pruneImageCache } from './routes/img';

let db: Db | null = null;
let auth: AuthInstance | null = null;

/**
 * 首启横幅：只在本次「空站点播种初始管理员」时打印一次。
 *
 * 为什么在 listen 回调里打：启动自举可能耗时，早打的横幅会被迁移日志冲掉，
 * 用户还以为服务没起来。这里 print 时端口已确定可访问。
 *
 * 访问地址优先读 PUBLIC_URL（反代域名 / 对外 IP:端口），没有就用容器内的
 * HOST:PORT —— 明确标注后者只在容器网络内可达，免得用户拿 0.0.0.0:3000 去浏览器。
 *
 * 密码是公开的固定值（contract 的 INITIAL_ADMIN_PASSWORD），所以日志里写明文没有
 * 额外泄露面；真正的保护是「首次登录必须改密」的服务端拦截。用 ADMIN_PASS 覆盖时
 * 不打印明文（那是用户自己 .env 里的值，且会长期留在 docker logs 里）。
 */
function printFirstRunBanner(a: { username: string; customPassword: boolean }, port: number): void {
  const configured = process.env.PUBLIC_URL?.trim();
  const url = configured || (HOST === '0.0.0.0' || HOST === '::'
    ? `http://localhost:${port}`
    : `http://${HOST}:${port}`);
  const note = configured
    ? '（PUBLIC_URL 指定的对外地址）'
    : '（容器网络内地址；对外访问请在 .env 设 PUBLIC_URL=http://你的域名或IP:端口）';
  const rule = '='.repeat(72);
  const line = (s: string): void => console.log(`  ${s}`);
  console.log('');
  console.log(rule);
  line('FEEDLORE FIRST RUN / 首次登录凭据');
  console.log(rule);
  line(`访问地址   ${url} ${note}`);
  line(`初始用户名 ${a.username}`);
  line(a.customPassword
    ? '初始密码   你在 ADMIN_PASS 里配置的那个密码（此处不回显）'
    : `初始密码   ${INITIAL_ADMIN_PASSWORD}`);
  line('');
  line('⚠️ 首次登录后必须先设置新密码，改完才能使用其他功能。');
  line('   （初始密码是公开的固定值，不改等于站点没上锁。）');
  line('忘记密码   docker exec -it feedlore initial-password --reset');
  line('');
  line(`下一步：打开 ${url} → 用上面的用户名/密码登录 → 按提示设置新密码。`);
  console.log(rule);
  console.log('');
}

function scheduleImagePrune(database: Db): void {
  const run = (): void => {
    void pruneImageCache(database)
      .then((n) => {
        if (n > 0) console.log(`[img] pruned ${n} expired image cache rows`);
      })
      .catch(() => { /* pruneImageCache 内部已记录 */ });
  };
  // unref：定时器不阻止进程退出（容器 stop 时不必等它）
  setTimeout(run, 10 * 60_000).unref();
  setInterval(run, 6 * 3600_000).unref();
}

async function main(): Promise<void> {
  /* 自举可能耗时数分钟（结构迁移）。失败就退出，让容器重启重试 ——
   * 迁移是幂等的，重启不会写出半套数据。 */
  await bootstrap();
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';

  if (databaseUrl) {
    try {
      db = createDb(databaseUrl);
      console.log('[db] connection pool initialized');
    } catch (e) {
      console.error('[db] initialization failed:', (e as Error)?.message ?? e);
    }
  } else {
    console.warn('[boot] DATABASE_URL is not set — data endpoints will return 503');
  }

  if (db) {
    try {
      auth = getAuth(db);
    } catch (e) {
      console.error('[auth] better-auth initialization failed:', (e as Error)?.message ?? e);
    }
  } else {
    console.warn('[boot] database not ready — better-auth is not running, auth endpoints return 503');
  }

  const app = createApp({ db, auth });

  /* 首个 tick 前预热站点参数快照：图片 TTL / 压缩参数 / 抓取间隔都读它，
   * 否则进程刚起的几分钟里会静默用 env 默认值（管理员改过的配置看起来没生效）。 */
  if (db) {
    void reloadSource(db).then((s) => {
      if (s) console.log(`[settings] fetch parameters: refresh ${s.refreshMinutes} min / concurrency ${s.concurrency} / keep ${s.keepPerFeed} entries per feed`);
    });
  }

  /* 抓取器：进程内调度（每分钟检查一次到期频道）。
   * 不用外部队列是刻意的 P5 决策——单进程足够、少一个故障点；多实例时才需要 BullMQ。 */
  if (db) startScheduler(db);

  /* 日报调度：每分钟检查一次「谁的 08:00 到了」。与抓取器同款进程内调度，
   * 理由相同（单进程够用、少一个故障点）。账号没配模型时会先落「今天已处理」再跳过，
   * 所以不会每分钟重复烧额度。 */
  if (db) startDigestScheduler(db);

  /* AI 智能标签调度：每分钟给「开启该功能的账号」打一批未打标条目。与抓取器/日报同款
   * 进程内调度（单进程够用、少一个故障点）；没配模型的账号会被跳过，不会无限重试。 */
  if (db) startAiTagScheduler(db);

  /* AI 异步任务清扫：上一次进程里的 queued/running 不可能再有人推进了，
   * 不标失败的话前端会一直轮询到一个永远不变的 running。
   * 不自动续跑：模型调用不幂等，用户很可能已经重试过。 */
  if (db) {
    void markInterruptedJobs(db).catch(() => { /* 内部已记录 */ });
  }

  /* 图片缓存清理：`image_cache` 随阅读量线性增长，不清会悄悄吃掉磁盘。
   * 首次延迟 10 分钟（别在冷启动和第一轮抓取抢数据库），之后每 6 小时一次。 */
  if (db) scheduleImagePrune(db);

  /* undici 版本对齐：跨大版本会让 IP 钉定失效（1.7.3 全站抓取失败的真凶）。
   * 这里只喊一声，真正的兜底在 lib/net.safeFetch —— 钉定失效时降级重试并告警。 */
  if (undiciVersionMismatch()) {
    const v = undiciVersions();
    console.warn(
      `[net] ⚠️ undici version mismatch (built-in ${v.builtin} / dependency ${v.installed}): `
      + 'IP pinning will break, pin undici in apps/server to the same major version as the Node built-in',
    );
  } else {
    const v = undiciVersions();
    console.log(`[net] undici aligned: built-in ${v.builtin} / dependency ${v.installed}`);
  }

  serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
    console.log(`[v2] FeedLore ${APP_VERSION} started → http://${HOST}:${info.port}`);
    console.log(
      `[v2] endpoints: GET /api/health, GET /api/session, POST /api/login, POST /api/logout, GET /api/feeds(user)`,
    );
    /* 只打一次：bootstrap 在空站点播种管理员时留下用户名，consume 后清空，
     * 后续重启（账号已存在）不会再印横幅 —— 那时密码是用户自己的，没得可印。 */
    const firstRun = consumeStartupAdmin();
    if (firstRun) printFirstRunBanner(firstRun, info.port);
  });
}

main().catch((e) => {
  console.error('[v2] startup failed:', (e as Error)?.stack ?? e);
  process.exit(1);
});
