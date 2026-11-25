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

import type { AuthInstance } from '@feedlore/auth';
import { INITIAL_ADMIN_PASSWORD } from '@feedlore/contract';
import { createDb, createPool, type Db } from '@feedlore/db';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { getAuth } from './auth';
import { bootstrap, consumeStartupAdmin } from './bootstrap';
import { APP_VERSION, getDatabaseUrl, getPublicUrl, HOST, PORT, validateConfig } from './env';
import { markInterruptedJobs } from './lib/aiJobs';
import { startAiTagScheduler } from './lib/aiTag';
import { startDigestScheduler } from './lib/digest';
import { startScheduler } from './lib/fetchScheduler';
import { log } from './lib/logger';
import { undiciVersionMismatch, undiciVersions } from './lib/net';
import { startPerfIndexBuilder } from './lib/perfIndexes';
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
  const configured = getPublicUrl();
  const url =
    configured ||
    (HOST === '0.0.0.0' || HOST === '::' ? `http://localhost:${port}` : `http://${HOST}:${port}`);
  const note = configured
    ? '（PUBLIC_URL 指定的对外地址）'
    : '（容器网络内地址；对外访问请在 .env 设 PUBLIC_URL=http://你的域名或IP:端口）';
  const rule = '='.repeat(72);
  const banner = [
    '',
    rule,
    'FEEDLORE FIRST RUN / 首次登录凭据',
    rule,
    `访问地址   ${url} ${note}`,
    `初始用户名 ${a.username}`,
    a.customPassword
      ? '初始密码   你在 ADMIN_PASS 里配置的那个密码（此处不回显）'
      : `初始密码   ${INITIAL_ADMIN_PASSWORD}`,
    '',
    '⚠️ 首次登录后必须先设置新密码，改完才能使用其他功能。',
    '   （初始密码是公开的固定值，不改等于站点没上锁。）',
    '忘记密码   docker exec -it feedlore initial-password --reset',
    '',
    `下一步：打开 ${url} → 用上面的用户名/密码登录 → 按提示设置新密码。`,
    rule,
    '',
  ].join('\n');
  /* 结构化字段给机器读；message 保留整块文案，docker logs 里 grep
   * "FEEDLORE FIRST RUN" / "初始密码" 仍能查到，与迁移前一致。 */
  log.info(
    {
      event: 'first_run',
      url,
      username: a.username,
      ...(a.customPassword ? {} : { password: INITIAL_ADMIN_PASSWORD }),
    },
    banner,
  );
}

function scheduleImagePrune(database: Db): void {
  const run = (): void => {
    void pruneImageCache(database)
      .then((n) => {
        if (n > 0) log.info(`[img] pruned ${n} expired image cache rows`);
      })
      .catch(() => {
        /* pruneImageCache 内部已记录 */
      });
  };
  // unref：定时器不阻止进程退出（容器 stop 时不必等它）
  setTimeout(run, 10 * 60_000).unref();
  setInterval(run, 6 * 3600_000).unref();
}

/**
 * 启动前置校验（V3.0 / fail-fast 主体）：配置格式有问题就不再往下起。
 *
 * 只校验「配错会导致运行期诡异行为」的格式/区间（纯函数、不连库）。DB 是否可达在
 * bootstrap 之后单独探测（那一步会改写 DATABASE_URL、建库、迁移，探测必须针对最终库）。
 * 校验失败一律退出，与 STRICT_BOOT 无关 —— 配置写错在任何部署模式下都应立刻暴露。
 */
function assertConfigOrExit(): void {
  const issues = validateConfig();
  if (issues.length === 0) return;
  log.error('[boot] 配置校验失败，拒绝启动 / invalid configuration, refusing to start:');
  for (const it of issues) log.error(`  - ${it.key}: ${it.message}`);
  if (!getDatabaseUrl()) {
    log.error('  (DATABASE_URL 未设置：本地跑单测请用 pnpm test，服务进程必须配置数据库)');
  }
  process.exit(1);
}

/**
 * DB 可达探测（V3.0 / fail-fast 主体）：bootstrap 完成后、装配服务前连一次真库。
 *
 * 故意放在 bootstrap 之后：那一步可能改写 DATABASE_URL（旧库名兜底）并建库，探测的是
 * 最终连接串。连不上直接退出 —— 一个连不上库的站点没有任何可用功能，带病启动只会让
 * 健康检查反复 503、排障信息被淹没。这与「DATABASE_URL 完全没配」是两回事：后者是
 * 本地/单测场景，main() 作为服务进程不该在没库的情况下被拉起。
 */
async function probeDatabaseOrExit(url: string): Promise<void> {
  const pool = createPool(url);
  try {
    await pool.query('select 1');
  } catch (e) {
    log.error(
      `[boot] 数据库不可达，拒绝启动 / database unreachable, refusing to start: ${(e as Error)?.message ?? e}`,
    );
    await pool.end().catch(() => {});
    process.exit(1);
  }
  await pool.end().catch(() => {});
}

async function main(): Promise<void> {
  assertConfigOrExit();

  /* 自举可能耗时数分钟（结构迁移）。失败就退出，让容器重启重试 ——
   * 迁移是幂等的，重启不会写出半套数据。 */
  await bootstrap();
  const databaseUrl = getDatabaseUrl();

  /* DB 可达性 fail-fast：所有部署模式都执行。连不上就明确退出，不再带病启动。 */
  if (databaseUrl) await probeDatabaseOrExit(databaseUrl);

  if (databaseUrl) {
    try {
      db = createDb(databaseUrl);
      log.info('[db] connection pool initialized');
    } catch (e) {
      log.error('[db] initialization failed:', (e as Error)?.message ?? e);
    }
  } else {
    log.warn('[boot] DATABASE_URL is not set — data endpoints will return 503');
  }

  if (db) {
    try {
      auth = getAuth(db);
    } catch (e) {
      log.error('[auth] better-auth initialization failed:', (e as Error)?.message ?? e);
    }
  } else {
    log.warn('[boot] database not ready — better-auth is not running, auth endpoints return 503');
  }

  const app = createApp({ db, auth });

  /* 首个 tick 前预热站点参数快照：图片 TTL / 压缩参数 / 抓取间隔都读它，
   * 否则进程刚起的几分钟里会静默用 env 默认值（管理员改过的配置看起来没生效）。 */
  if (db) {
    void reloadSource(db).then((s) => {
      if (s)
        log.info(
          `[settings] fetch parameters: refresh ${s.refreshMinutes} min / concurrency ${s.concurrency} / keep ${s.keepPerFeed} entries per feed`,
        );
    });
  }

  /* 抓取器：每分钟检查到期频道；调度轮与同 URL 回源由 PostgreSQL advisory lock 跨实例协调。 */
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
    void markInterruptedJobs(db).catch(() => {
      /* 内部已记录 */
    });
  }

  /* 图片缓存清理：`image_cache` 随阅读量线性增长，不清会悄悄吃掉磁盘。
   * 首次延迟 10 分钟（别在冷启动和第一轮抓取抢数据库），之后每 6 小时一次。 */
  if (db) scheduleImagePrune(db);

  /* undici 版本对齐：跨大版本会让 IP 钉定失效（1.7.3 全站抓取失败的真凶）。
   * 这里只喊一声，真正的兜底在 lib/net.safeFetch —— 钉定失效时降级重试并告警。 */
  if (undiciVersionMismatch()) {
    const v = undiciVersions();
    log.warn(
      `[net] ⚠️ undici version mismatch (built-in ${v.builtin} / dependency ${v.installed}): ` +
        'IP pinning will break, pin undici in apps/server to the same major version as the Node built-in',
    );
  } else {
    const v = undiciVersions();
    log.info(`[net] undici aligned: built-in ${v.builtin} / dependency ${v.installed}`);
  }

  serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
    log.info(`[v2] FeedLore ${APP_VERSION} started → http://${HOST}:${info.port}`);
    log.info(
      `[v2] endpoints: GET /api/health, GET /api/session, POST /api/login, POST /api/logout, GET /api/feeds(user)`,
    );
    /* 只打一次：bootstrap 在空站点播种管理员时留下用户名，consume 后清空，
     * 后续重启（账号已存在）不会再印横幅 —— 那时密码是用户自己的，没得可印。 */
    const firstRun = consumeStartupAdmin();
    if (firstRun) printFirstRunBanner(firstRun, info.port);

    /* 重型 trigram 索引放到监听之后慢慢建：启动迁移只保留轻量 DDL，
     * 大表建 GIN 不再把 app 挡在监听之前（3.0.1 生产 502 事故）。 */
    if (databaseUrl) startPerfIndexBuilder(databaseUrl);
  });
}

main().catch((e) => {
  log.error('[v2] startup failed:', (e as Error)?.stack ?? e);
  process.exit(1);
});
