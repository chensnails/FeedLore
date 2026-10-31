/**
 * v1 → v2 镜像内一键升级（一次性任务）。
 *
 * 由发布版 compose 的 `upgrade` 服务调用（`pnpm --filter @feedlore/server upgrade:v1`），
 * 天然拿到的是「同一台数据库服务器上的 v1 库 + 新 v2 库」，因此不需要宿主机脚本。
 * 入口脚本只做编排，真正的数据语义仍在 `migrate-legacy.ts` —— 那里有三条纪律
 * （幂等 / 密码无损 / 不搬图片缓存），这里只补上它不管的部分：
 *
 *   0. 建库：在同一 Postgres 实例里建 v2 库，并把库级时区钉成 UTC
 *   1. 结构：drizzle 迁移（每次启动都跑，兼作未来版本的库结构升级）
 *   2. 数据：调用 migrate:legacy（只读 v1，写入 v2）
 *   3. 缓存：搬 image_cache（迁移脚本刻意不搬；这里按行搬，UTC 对齐）
 *   4. 校验：数量 / 凭据 / 站点主密钥，任一不符就非零退出 —— compose 的
 *      `service_completed_successfully` 会把 v2 应用挡在启动之前，v1 继续服务
 *
 * 幂等：成功后在 v2 的 settings 表写一条 `v1Upgrade` 标记；再次执行只跑结构迁移。
 *
 * 为什么必须 TZ=UTC：
 * v1 的时间列是 timestamptz，v2 是 timestamp。迁移把「绝对时刻」写成 v2 的
 * 壁钟值，必须由 UTC 进程序列化；否则历史时间整体偏移（东八区差 8 小时）。
 * 库级 `timezone=UTC` 还兜住了 `defaultNow()` 这类由数据库求值的默认值。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createDb, createPool, getPool, settings, type Db } from '@feedlore/db';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const DB_PKG = path.join(REPO_ROOT, 'packages/db');

const LEGACY_URL = process.env.LEGACY_DATABASE_URL ?? '';
const V2_URL = process.env.DATABASE_URL ?? '';
const SKIP_IMAGE_CACHE = process.env.UPGRADE_SKIP_IMAGE_CACHE === '1';
const MARKER_KEY = 'v1Upgrade';
const IMAGE_BATCH = 200;

const now = (): string => new Date().toISOString().slice(11, 19);
const log = (...a: unknown[]): void => console.log(`[${now()}]`, ...a);
const warn = (...a: unknown[]): void => console.warn(`[${now()}] ⚠️`, ...a);

function fail(msg: string): never {
  console.error(`[upgrade] ${msg}`);
  process.exit(1);
}

function dbNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** 把连接串的库名换成另一个（用于连 postgres 维护库）。 */
function withDb(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

type Pool = ReturnType<typeof createPool>;

async function count(pool: Pool, table: string): Promise<number> {
  const r = await pool.query<{ n: number }>(`select count(*)::int as n from public.${table}`);
  return r.rows[0]?.n ?? 0;
}

/* ============================ 0. 目标库 ============================ */

async function ensureTargetDatabase(): Promise<void> {
  const name = dbNameOf(V2_URL);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    fail(`目标库名不合法：${name}（只允许字母、数字、下划线）`);
  }

  const admin = createPool(withDb(V2_URL, 'postgres'));
  try {
    const found = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (!found.rowCount) {
      log(`创建数据库 ${name}`);
      await admin.query(`create database "${name}"`);
    }
    /* 关键：v1 的 Postgres 容器时区是 Asia/Shanghai。库级时区不钉住，v2 里
     * `defaultNow()` 写进 timestamp 列的就是 +08 壁钟，读回来整体偏 8 小时。 */
    await admin.query(`alter database "${name}" set timezone to 'UTC'`);
  } catch (e) {
    fail(
      `准备目标库 ${name} 失败：${(e as Error).message}\n`
        + '  → 需要数据库账号有 CREATEDB 权限（官方 postgres 镜像的 POSTGRES_USER 即有）；\n'
        + '     外部托管数据库请先手动 create database 并授予 owner 后重试',
    );
  } finally {
    await admin.end().catch(() => {});
  }
}

/* ============================ 1/2. 子进程步骤 ============================ */

function runStep(title: string, args: string[], cwd: string): void {
  log(title);
  const r = spawnSync('pnpm', args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, TZ: 'UTC' },
  });
  if (r.error) fail(`${title} 无法启动：${r.error.message}`);
  if (r.status !== 0) fail(`${title} 失败（退出码 ${r.status}）`);
}

/* ============================ 3. 图片缓存 ============================ */

async function copyImageCache(): Promise<void> {
  if (SKIP_IMAGE_CACHE) {
    log('已跳过图片缓存搬运（UPGRADE_SKIP_IMAGE_CACHE=1）');
    return;
  }

  const legacy = createPool(LEGACY_URL);
  const target = createPool(V2_URL);
  try {
    const has = await legacy.query(
      `select 1 from information_schema.tables where table_schema = 'public' and table_name = 'image_cache'`,
    );
    if (!has.rowCount) {
      log('v1 没有 image_cache 表，跳过图片缓存');
      return;
    }

    const existing = (await target.query<{ n: number }>('select count(*)::int as n from image_cache')).rows[0]?.n ?? 0;
    if (existing > 0) {
      log(`v2 已有 ${existing} 条图片缓存，跳过搬运（避免覆盖新站点自己抓的图）`);
      return;
    }

    const total = await count(legacy, 'image_cache');
    if (total === 0) {
      log('v1 图片缓存为空，跳过');
      return;
    }

    log(`搬运 ${total} 条图片缓存…`);
    let lastKey = '';
    let copied = 0;
    for (;;) {
      /* keyset 分页而不是 offset：v1 在迁移期间仍在写缓存，offset 会重行/漏行。 */
      const { rows } = await legacy.query<{
        key: string;
        content_type: string;
        data: Buffer;
        width: number | null;
        height: number | null;
        orig_size: number | null;
        size: number;
        created_at: Date;
      }>(
        `select key, content_type, data, width, height, orig_size, size, created_at
           from image_cache where key > $1 order by key limit $2`,
        [lastKey, IMAGE_BATCH],
      );
      if (!rows.length) break;
      lastKey = rows[rows.length - 1]!.key;

      const tuples: string[] = [];
      const params: unknown[] = [];
      for (const r of rows) {
        const base = params.length;
        params.push(r.key, r.content_type, r.data, r.width, r.height, r.orig_size, r.size, r.created_at);
        tuples.push(`(${Array.from({ length: 8 }, (_, i) => `$${base + i + 1}`).join(', ')})`);
      }
      await target.query(
        `insert into image_cache (key, content_type, data, width, height, orig_size, size, created_at)
         values ${tuples.join(', ')} on conflict (key) do nothing`,
        params,
      );
      copied += rows.length;
      if (copied % (IMAGE_BATCH * 5) === 0) log(`  图片缓存 ${copied}/${total}`);
    }
    log(`图片缓存完成：${copied} 条`);
  } finally {
    await legacy.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

/* ============================ 4. 校验与标记 ============================ */

interface Counts {
  users: number;
  feeds: number;
  entries: number;
}

async function verify(): Promise<Counts> {
  const legacy = createPool(LEGACY_URL);
  const target = createPool(V2_URL);
  try {
    const l: Counts = {
      users: await count(legacy, 'users'),
      feeds: await count(legacy, 'feeds'),
      entries: await count(legacy, 'entries'),
    };
    const v: Counts = {
      users: await count(target, 'users'),
      feeds: await count(target, 'feeds'),
      entries: await count(target, 'entries'),
    };
    log(`用户 ${l.users}→${v.users} / 频道 ${l.feeds}→${v.feeds} / 条目 ${l.entries}→${v.entries}`);

    if (v.users < l.users) fail(`用户数少于 v1（${v.users} < ${l.users}）：迁移不完整，v2 不会启动`);
    if (v.feeds < l.feeds) fail(`频道数少于 v1（${v.feeds} < ${l.feeds}）：迁移不完整，v2 不会启动`);
    if (v.entries < l.entries) fail(`条目数少于 v1（${v.entries} < ${l.entries}）：迁移不完整，v2 不会启动`);

    const cred = (await target.query<{ n: number }>(
      `select count(*)::int as n from accounts where provider_id = 'credential' and coalesce(password, '') <> ''`,
    )).rows[0]?.n ?? 0;
    const legacyPw = (await legacy.query<{ n: number }>(
      `select count(*)::int as n from users where password_hash is not null and password_hash <> ''`,
    )).rows[0]?.n ?? 0;
    if (cred < legacyPw) fail(`有 v1 账号没有写入登录凭据（${cred} < ${legacyPw}）：升级后会登不进来`);
    log(`凭据齐全：${cred} 个（v1 密码原样可登录，首次登录自动升级哈希）`);

    const [ls] = (await legacy.query<{ v: string | null }>(
      `select value::text as v from settings where key = 'cryptoSecret'`,
    )).rows;
    const [vs] = (await target.query<{ v: string | null }>(
      `select value::text as v from settings where key = 'cryptoSecret'`,
    )).rows;
    if (ls?.v && ls.v !== vs?.v) fail('站点主密钥 cryptoSecret 未正确迁移：模型 Key 会解不开');
    if (ls?.v) log('站点主密钥：一致（模型 Key 可继续解密）');

    return v;
  } finally {
    await legacy.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

async function hasMarker(db: Db): Promise<boolean> {
  const [row] = await db.select({ key: settings.key }).from(settings).where(eq(settings.key, MARKER_KEY)).limit(1);
  return Boolean(row);
}

async function writeMarker(db: Db, c: Counts): Promise<void> {
  const value = { at: new Date().toISOString(), users: c.users, feeds: c.feeds, entries: c.entries };
  await db
    .insert(settings)
    .values({ key: MARKER_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/* ============================ 主流程 ============================ */

async function main(): Promise<void> {
  if (!LEGACY_URL) fail('缺少 LEGACY_DATABASE_URL（v1 的库）');
  if (!V2_URL) fail('缺少 DATABASE_URL（v2 的新库，不能与 LEGACY_DATABASE_URL 相同）');
  if (!process.env.AUTH_SECRET) fail('缺少 AUTH_SECRET（必须与 v2 服务用的是同一个值）');
  if (LEGACY_URL === V2_URL) fail('LEGACY_DATABASE_URL 与 DATABASE_URL 相同：v2 必须写到新库（如 feedlore_v2）');

  /* 时区不对会**静默**写偏历史时间，宁可在这里停下。 */
  const offsetHours = -new Date().getTimezoneOffset() / 60;
  if (offsetHours !== 0) {
    fail(`进程时区不是 UTC（当前偏移 ${offsetHours} 小时）：历史时间会整体偏移。请在 compose 里设 TZ: UTC`);
  }

  const legacyName = dbNameOf(LEGACY_URL);
  const v2Name = dbNameOf(V2_URL);
  log(`源库 ${legacyName} → 目标库 ${v2Name}`);

  await ensureTargetDatabase();
  runStep('数据库结构迁移（drizzle，幂等）', ['migrate'], DB_PKG);

  const db = createDb(V2_URL);
  if (await hasMarker(db)) {
    log('检测到已完成的 v1 迁移标记，跳过数据迁移（结构迁移已执行）');
    return;
  }

  const legacy = createPool(LEGACY_URL);
  let isV1 = false;
  let legacyUsers = 0;
  try {
    const col = await legacy.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'users' and column_name = 'password_hash'`,
    );
    isV1 = Boolean(col.rowCount);
    if (isV1) legacyUsers = await count(legacy, 'users');
  } catch (e) {
    fail(`读取源库失败：${(e as Error).message}`);
  } finally {
    await legacy.end().catch(() => {});
  }

  if (!isV1) {
    log('源库不是 v1（users.password_hash 不存在）→ 按全新安装处理，跳过数据迁移');
    return;
  }
  if (legacyUsers === 0) {
    warn('源库没有账号：按空站点继续。若这是全新安装，请用 seed 脚本创建管理员');
    return;
  }

  runStep('v1 数据迁移（migrate:legacy，幂等）', ['--filter', '@feedlore/server', 'migrate:legacy'], REPO_ROOT);
  await copyImageCache();
  const counts = await verify();
  await writeMarker(db, counts);
  log('升级完成：v2 数据已就绪，应用容器可以启动');
}

main()
  .then(async () => {
    await getPool()?.end().catch(() => {});
  })
  .catch(async (e) => {
    console.error('[upgrade] 未捕获异常：', (e as Error)?.stack ?? e);
    await getPool()?.end().catch(() => {});
    process.exit(1);
  });
