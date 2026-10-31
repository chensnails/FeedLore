/**
 * v2 启动自举：让 1.x 站点被 Watchtower 静默换成 v2 镜像后**零配置**完成切换。
 *
 * 触发条件只有一个：`DATABASE_URL` 指向的库是 1.x 结构（`public.users.password_hash`
 * 存在）。Watchtower 重建容器时环境变量、端口、挂载原样继承，所以 v2 拿到的是
 * 1.x 的连接串 —— 这正是自举需要的输入：
 *
 *   0. 快照：在同一个 Postgres 实例里把 1.x 库原样拷成 `<库名>_backup`
 *   1. 建库：建 `<库名>_v2` 并把库级时区钉成 UTC
 *   2. 结构：drizzle 迁移（幂等，兼作后续版本的库结构升级）
 *   3. 数据：调用 migrate:legacy（只读 1.x，写入新库；密码无损、可重复跑）
 *   4. 校验：数量 / 凭据 / 站点主密钥，任一不符就抛错 → 容器退出 → 重启重试
 *   5. 标记：成功后写 settings.v1Upgrade；之后每次启动只做一次探测就切到新库
 *
 * 之后 `process.env.DATABASE_URL` 被改写成新库，进程其余部分（以及下次启动）
 * 都当作普通 v2 站点运行。1.x 的库**从头到尾只读**，随时可以回退。
 *
 * 为什么必须 TZ=UTC：1.x 的时间列是 timestamptz、v2 是 timestamp，迁移把绝对
 * 时刻写成 v2 的壁钟值。进程时区不是 UTC 时历史时间会整体偏移（东八区差 8 小时），
 * 所以这里第一时间固化成 UTC，且建库时把库级时区也钉成 UTC 兜住 defaultNow()。
 *
 * 已经升级过的站点（含 compose 里 upgrade 一次性任务跑过的）会命中 v1Upgrade
 * 标记，只做探测 + 切连接串，不重复迁移。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { createDb, createPool, users } from '@feedlore/db';
import { getAuth } from './auth';
import { ensureAuthSecret } from './lib/auth-secret';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MARKER_KEY = 'v1Upgrade';

const now = (): string => new Date().toISOString().slice(11, 19);
const log = (...a: unknown[]): void => console.log(`[${now()}] [bootstrap]`, ...a);
const warn = (...a: unknown[]): void => console.warn(`[${now()}] [bootstrap] ⚠️`, ...a);

type Pool = ReturnType<typeof createPool>;

function dbNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** 把连接串的库名换成另一个（用于连 postgres 维护库 / 派生新库）。 */
function withDb(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const isIdentifier = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

async function hasTable(pool: Pool, table: string): Promise<boolean> {
  const r = await pool.query(
    `select 1 from information_schema.tables where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return Boolean(r.rowCount);
}

/** 1.x 判据：只有 1.x 的 users 表有 password_hash 列（v2 用的是 accounts.password）。 */
async function isV1Schema(pool: Pool): Promise<boolean> {
  const r = await pool.query(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'users' and column_name = 'password_hash'`,
  );
  return Boolean(r.rowCount);
}

async function detectV1(url: string): Promise<boolean> {
  const pool = createPool(url);
  try {
    return await isV1Schema(pool);
  } catch (e) {
    // 连不上时保持原有行为：进程照常启动，健康检查报 db.ready=false
    warn(`探测 ${dbNameOf(url)} 失败（${(e as Error).message}）：按普通 v2 站点启动`);
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

/* ============================ 0. 快照 ============================ */

/**
 * 用 `CREATE DATABASE … TEMPLATE` 做实例内快照。
 *
 * 前提是**没有其它连接占用 1.x 库**：Watchtower 先停旧容器再起新容器，正常路径成立。
 * 失败（比如有人正连着库）只告警不中断 —— 迁移本身只读 1.x，快照是额外保险，
 * 不能因为保险买不上就让站点起不来；但必须把代价喊出来。
 */
async function snapshotSource(src: string): Promise<void> {
  if (process.env.UPGRADE_SKIP_BACKUP === '1') {
    log('已跳过 1.x 库快照（UPGRADE_SKIP_BACKUP=1）');
    return;
  }
  const source = dbNameOf(src);
  const backup = `${source}_backup`;
  if (!isIdentifier(source) || !isIdentifier(backup)) {
    warn(`库名 ${source} 含特殊字符，跳过快照；回滚前请自行 pg_dump`);
    return;
  }

  const admin = createPool(withDb(src, 'postgres'));
  try {
    const found = await admin.query('select 1 from pg_database where datname = $1', [backup]);
    if (found.rowCount) {
      log(`快照库 ${backup} 已存在，跳过`);
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await admin.query(`create database "${backup}" template "${source}"`);
        log(`已创建 1.x 库快照 ${backup}（原库只读拷贝，回退时数据不丢）`);
        return;
      } catch (e) {
        if (attempt === 3) {
          warn(`快照创建失败（${(e as Error).message}）：继续升级，建议随后自行 pg_dump 备份 ${source}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  } finally {
    await admin.end().catch(() => {});
  }
}

/* ============================ 1. 目标库 ============================ */

/** 目标库连接串：`V2_DATABASE_URL` 显式指定 > 同实例 `<库名>_v2`。 */
function resolveTargetUrl(src: string): string {
  const explicit = process.env.V2_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const name = process.env.V2_DB_NAME?.trim() || `${dbNameOf(src)}_v2`;
  return withDb(src, name);
}

async function prepareTarget(targetUrl: string): Promise<void> {
  if (process.env.V2_DATABASE_URL?.trim()) {
    log('使用 V2_DATABASE_URL 指定的目标库，跳过自动建库');
    return;
  }
  const name = dbNameOf(targetUrl);
  if (!isIdentifier(name)) {
    throw new Error(`目标库名不合法：${name}（只允许字母、数字、下划线；可用 V2_DB_NAME 改名）`);
  }

  const admin = createPool(withDb(targetUrl, 'postgres'));
  try {
    const found = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (!found.rowCount) {
      log(`创建数据库 ${name}`);
      await admin.query(`create database "${name}"`);
    }
    // 1.x 的 Postgres 容器时区是 Asia/Shanghai；库级时区不钉住，
    // defaultNow() 写进 timestamp 列的就是 +08 壁钟，读回来整体偏 8 小时。
    await admin.query(`alter database "${name}" set timezone to 'UTC'`);
  } catch (e) {
    throw new Error(
      `准备目标库 ${name} 失败：${(e as Error).message}\n`
        + '  → 数据库账号需要 CREATEDB 权限；外部托管数据库请先手动建库并授权，'
        + '或在环境变量里用 V2_DATABASE_URL 直接指定目标库',
    );
  } finally {
    await admin.end().catch(() => {});
  }
}

/* ============================ 2/3. 子进程步骤 ============================ */

function runStep(title: string, args: string[], extraEnv: Record<string, string>): void {
  log(title);
  const r = spawnSync('pnpm', args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, TZ: 'UTC', ...extraEnv },
  });
  if (r.error) throw new Error(`${title} 无法启动：${r.error.message}`);
  if (r.status !== 0) throw new Error(`${title} 失败（退出码 ${r.status}）`);
}

/* ============================ 4. 校验 ============================ */

interface Counts {
  users: number;
  feeds: number;
  entries: number;
}

async function countOf(pool: Pool, table: string): Promise<number> {
  const r = await pool.query<{ n: number }>(`select count(*)::int as n from public.${table}`);
  return r.rows[0]?.n ?? 0;
}

async function verify(legacyUrl: string, targetUrl: string): Promise<Counts> {
  const legacy = createPool(legacyUrl);
  const target = createPool(targetUrl);
  try {
    const l: Counts = {
      users: await countOf(legacy, 'users'),
      feeds: await countOf(legacy, 'feeds'),
      entries: await countOf(legacy, 'entries'),
    };
    const v: Counts = {
      users: await countOf(target, 'users'),
      feeds: await countOf(target, 'feeds'),
      entries: await countOf(target, 'entries'),
    };
    log(`用户 ${l.users}→${v.users} / 频道 ${l.feeds}→${v.feeds} / 条目 ${l.entries}→${v.entries}`);

    if (v.users < l.users) throw new Error(`用户数少于 1.x（${v.users} < ${l.users}）：迁移不完整`);
    if (v.feeds < l.feeds) throw new Error(`频道数少于 1.x（${v.feeds} < ${l.feeds}）：迁移不完整`);
    if (v.entries < l.entries) throw new Error(`条目数少于 1.x（${v.entries} < ${l.entries}）：迁移不完整`);

    const cred = (await target.query<{ n: number }>(
      `select count(*)::int as n from accounts where provider_id = 'credential' and coalesce(password, '') <> ''`,
    )).rows[0]?.n ?? 0;
    const legacyPw = (await legacy.query<{ n: number }>(
      `select count(*)::int as n from users where password_hash is not null and password_hash <> ''`,
    )).rows[0]?.n ?? 0;
    if (cred < legacyPw) throw new Error(`有 1.x 账号没有写入登录凭据（${cred} < ${legacyPw}）：升级后会登不进来`);
    log(`凭据齐全：${cred} 个（1.x 密码原样可登录，首次登录自动升级哈希）`);

    const [ls] = (await legacy.query<{ v: string | null }>(
      `select value::text as v from settings where key = 'cryptoSecret'`,
    )).rows;
    const [vs] = (await target.query<{ v: string | null }>(
      `select value::text as v from settings where key = 'cryptoSecret'`,
    )).rows;
    if (ls?.v && ls.v !== vs?.v) throw new Error('站点主密钥 cryptoSecret 未正确迁移：模型 Key 会解不开');
    if (ls?.v) log('站点主密钥：一致（模型 Key 可继续解密）');

    return v;
  } finally {
    await legacy.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

/* ============================ 5. 标记 / 密钥 / 播种 ============================ */

async function isUpgraded(targetUrl: string): Promise<boolean> {
  const pool = createPool(targetUrl);
  try {
    if (!(await hasTable(pool, 'settings'))) return false;
    const r = await pool.query('select 1 from settings where key = $1 limit 1', [MARKER_KEY]);
    return Boolean(r.rowCount);
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function writeMarker(targetUrl: string, counts: Counts): Promise<void> {
  const value = { at: new Date().toISOString(), ...counts };
  const pool = createPool(targetUrl);
  try {
    await pool.query(
      `insert into settings (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [MARKER_KEY, JSON.stringify(value)],
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

/** 空站点播种：没有任何账号时创建初始管理员（默认 admin/admin，可用 ADMIN_USER/ADMIN_PASS 覆盖）。 */
async function ensureDefaultAdmin(): Promise<void> {
  const db = createDb();
  let count = 0;
  try {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    count = row?.n ?? 0;
  } catch (e) {
    warn(`数据库尚未就绪（可能还没跑结构迁移），跳过初始管理员：${(e as Error)?.message ?? e}`);
    return;
  }
  if (count > 0) return;

  const username = process.env.ADMIN_USER?.trim() || 'admin';
  const password = process.env.ADMIN_PASS?.trim() || 'admin';
  try {
    const auth = getAuth(db);
    // 与 seed.ts 一致：better-auth 必须要有 email，登录标识仍是 username
    await auth.api.signUpEmail({
      body: {
        email: `${username.replace(/[^\w.-]/g, '_')}@example.com`,
        password,
        name: username,
        username,
      } as never,
    });
    await db.update(users).set({ role: 'admin' }).where(eq(users.username, username));
  } catch (e) {
    warn(`创建初始管理员失败：${(e as Error)?.message ?? e}`);
    return;
  }

  if (password === 'admin') {
    warn(`空站点：已创建初始管理员 ${username}/admin —— 请登录后立即修改密码`);
  } else {
    log(`空站点：已用 ADMIN_USER=${username} 创建管理员`);
  }
}

/* ============================ 主流程 ============================ */

export async function bootstrap(): Promise<void> {
  process.env.TZ = 'UTC';

  const source = process.env.DATABASE_URL?.trim();
  if (!source) return;

  if (!(await detectV1(source))) {
    // 普通 v2 站点（compose 升级路径 / 全新安装）：补零配置密钥，空站点再建初始管理员
    await ensureAuthSecret(source);
    await ensureDefaultAdmin();
    return;
  }

  const target = resolveTargetUrl(source);
  if (target === source) {
    throw new Error('V2_DATABASE_URL / V2_DB_NAME 指向了 1.x 库本身：v2 必须写到新库');
  }
  log(`检测到 1.x 数据库 ${dbNameOf(source)} → 目标库 ${dbNameOf(target)}`);

  if (await isUpgraded(target)) {
    process.env.DATABASE_URL = target;
    await ensureAuthSecret(target);
    await ensureDefaultAdmin();
    log('v2 库已就绪（命中升级标记），直接使用');
    return;
  }

  const started = Date.now();
  await snapshotSource(source);
  await prepareTarget(target);
  runStep('① 数据库结构迁移（drizzle，幂等）', ['--filter', '@feedlore/db', 'migrate'], {
    DATABASE_URL: target,
  });
  await ensureAuthSecret(target);
  runStep('② 1.x 数据迁移（migrate:legacy，幂等）', ['--filter', '@feedlore/server', 'migrate:legacy'], {
    LEGACY_DATABASE_URL: source,
    DATABASE_URL: target,
  });
  const counts = await verify(source, target);
  await writeMarker(target, counts);

  process.env.DATABASE_URL = target;
  await ensureDefaultAdmin();
  log(`自举完成（${((Date.now() - started) / 1000).toFixed(0)}s）：v2 使用 ${dbNameOf(target)}`);
}
