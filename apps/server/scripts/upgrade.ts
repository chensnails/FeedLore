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
import { ensureAuthSecret } from '../src/lib/auth-secret';

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
    fail(`Invalid target database name: ${name} (letters, digits and underscores only)`);
  }

  const admin = createPool(withDb(V2_URL, 'postgres'));
  try {
    const found = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (!found.rowCount) {
      log(`Creating database ${name}`);
      await admin.query(`create database "${name}"`);
    }
    /* 关键：v1 的 Postgres 容器时区是 Asia/Shanghai。库级时区不钉住，v2 里
     * `defaultNow()` 写进 timestamp 列的就是 +08 壁钟，读回来整体偏 8 小时。 */
    await admin.query(`alter database "${name}" set timezone to 'UTC'`);
  } catch (e) {
    fail(
      `Failed to prepare target database ${name}: ${(e as Error).message}\n`
        + '  → the database account needs CREATEDB privileges (the official postgres image grants it to POSTGRES_USER);\n'
        + '     for a managed database, run create database manually and grant owner, then retry',
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
  if (r.error) fail(`${title} could not start: ${r.error.message}`);
  if (r.status !== 0) fail(`${title} failed (exit code ${r.status})`);
}

/* ============================ 3. 图片缓存 ============================ */

async function copyImageCache(): Promise<void> {
  if (SKIP_IMAGE_CACHE) {
    log('Skipped the image cache copy (UPGRADE_SKIP_IMAGE_CACHE=1)');
    return;
  }

  const legacy = createPool(LEGACY_URL);
  const target = createPool(V2_URL);
  try {
    const has = await legacy.query(
      `select 1 from information_schema.tables where table_schema = 'public' and table_name = 'image_cache'`,
    );
    if (!has.rowCount) {
      log('v1 has no image_cache table, skipping the image cache');
      return;
    }

    const existing = (await target.query<{ n: number }>('select count(*)::int as n from image_cache')).rows[0]?.n ?? 0;
    if (existing > 0) {
      log(`v2 already has ${existing} image cache rows, skipping the copy (would overwrite images the new site fetched itself)`);
      return;
    }

    const total = await count(legacy, 'image_cache');
    if (total === 0) {
      log('v1 image cache is empty, skipping');
      return;
    }

    log(`Copying ${total} image cache rows…`);
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
      if (copied % (IMAGE_BATCH * 5) === 0) log(`  image cache ${copied}/${total}`);
    }
    log(`Image cache done: ${copied} rows`);
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
    log(`users ${l.users}→${v.users} / feeds ${l.feeds}→${v.feeds} / entries ${l.entries}→${v.entries}`);

    if (v.users < l.users) fail(`Fewer users than in v1 (${v.users} < ${l.users}): migration incomplete, v2 will not start`);
    if (v.feeds < l.feeds) fail(`Fewer feeds than in v1 (${v.feeds} < ${l.feeds}): migration incomplete, v2 will not start`);
    if (v.entries < l.entries) fail(`Fewer entries than in v1 (${v.entries} < ${l.entries}): migration incomplete, v2 will not start`);

    const cred = (await target.query<{ n: number }>(
      `select count(*)::int as n from accounts where provider_id = 'credential' and coalesce(password, '') <> ''`,
    )).rows[0]?.n ?? 0;
    const legacyPw = (await legacy.query<{ n: number }>(
      `select count(*)::int as n from users where password_hash is not null and password_hash <> ''`,
    )).rows[0]?.n ?? 0;
    if (cred < legacyPw) fail(`Some v1 accounts have no login credential (${cred} < ${legacyPw}): they would not be able to sign in after the upgrade`);
    log(`Credentials complete: ${cred} accounts (v1 passwords still work as-is; hashes upgrade on first sign-in)`);

    const [ls] = (await legacy.query<{ v: string | null }>(
      `select value::text as v from settings where key = 'cryptoSecret'`,
    )).rows;
    const [vs] = (await target.query<{ v: string | null }>(
      `select value::text as v from settings where key = 'cryptoSecret'`,
    )).rows;
    if (ls?.v && ls.v !== vs?.v) fail('Site master key cryptoSecret was not migrated correctly: model keys cannot be decrypted');
    if (ls?.v) log('Site master key: consistent (model keys still decrypt)');

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
  if (!LEGACY_URL) fail('Missing LEGACY_DATABASE_URL (the v1 database)');
  if (!V2_URL) fail('Missing DATABASE_URL (the new v2 database; it must differ from LEGACY_DATABASE_URL)');
  if (LEGACY_URL === V2_URL) fail('LEGACY_DATABASE_URL and DATABASE_URL are the same: v2 must write to a new database (e.g. feedlore_v2)');

  /* 时区不对会**静默**写偏历史时间，宁可在这里停下。 */
  const offsetHours = -new Date().getTimezoneOffset() / 60;
  if (offsetHours !== 0) {
    fail(`Process timezone is not UTC (current offset ${offsetHours}h): historical timestamps would all shift. Set TZ: UTC in compose`);
  }

  const legacyName = dbNameOf(LEGACY_URL);
  const v2Name = dbNameOf(V2_URL);
  log(`Source database ${legacyName} → target database ${v2Name}`);

  await ensureTargetDatabase();
  runStep('database schema migration (drizzle, idempotent)', ['migrate'], DB_PKG);

  const db = createDb(V2_URL);
  if (await hasMarker(db)) {
    log('Completed v1 migration marker found, skipping the data migration (schema migration already ran)');
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
    fail(`Failed to read the source database: ${(e as Error).message}`);
  } finally {
    await legacy.end().catch(() => {});
  }

  if (!isV1) {
    log('Source database is not v1 (users.password_hash is missing) → treating it as a fresh install, skipping the data migration');
    return;
  }
  if (legacyUsers === 0) {
    warn('Source database has no accounts: continuing as an empty site. The app will create the initial admin at startup and print a one-time random password');
    return;
  }

  /* AUTH_SECRET 只被 migrate:legacy 用来建账号；没配就自动生成并持久化到 v2 库，
   * app 启动时读同一枚（见 src/lib/auth-secret.ts），用户不必先编辑 .env。 */
  await ensureAuthSecret(V2_URL);
  runStep('v1 data migration (migrate:legacy, idempotent)', ['--filter', '@feedlore/server', 'migrate:legacy'], REPO_ROOT);
  await copyImageCache();
  const counts = await verify();
  await writeMarker(db, counts);
  log('Upgrade complete: v2 data is ready, the app container can start');
}

main()
  .then(async () => {
    await getPool()?.end().catch(() => {});
  })
  .catch(async (e) => {
    console.error('[upgrade] uncaught exception:', (e as Error)?.stack ?? e);
    await getPool()?.end().catch(() => {});
    process.exit(1);
  });
