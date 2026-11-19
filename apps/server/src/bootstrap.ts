/**
 * v2 启动自举：结构迁移 + 零配置密钥 + 空站点播种。
 *
 * 每次启动都做三件事（幂等，可重复）：
 *   1. drizzle 结构迁移 —— 2.0.5 的教训：Watchtower / 一键更新 / `up -d --no-deps app`
 *      只重建 app 容器，库会停留在旧结构导致接口 500。迁移挪进启动流程后就不可能漏。
 *      失败**不退出**：外部托管库常无 DDL 权限，直接崩会把本来能跑的站点弄成起不来。
 *   2. AUTH_SECRET 补枚（见 lib/auth-secret.ts）：没设时生成并存 settings，重建会话不掉线。
 *   3. 空站点播种：没有任何账号时建初始管理员，密码固定为 INITIAL_ADMIN_PASSWORD
 *      （ADMIN_PASS 可覆盖），并标记「首次登录必须改密」；首启横幅在监听后打印。
 *      已有账号的站点只提示重置通道，不碰密码、不打标记。
 *
 * TZ=UTC 是硬约束：v2 的 timestamp 列按 UTC 壁钟存值，进程时区一变历史时间整体偏移。
 *
 * 旧版的一次性数据迁移已下线（2026-11-19）：老站点若还需导入数据，请用旧版的
 * 「设置 → 数据 → 导出」+ 本站的「设置 → 数据 → 导入」。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { createDb, createPool, sessions, users } from '@feedlore/db';
import { INITIAL_ADMIN_PASSWORD } from '@feedlore/contract';
import { getAuth } from './auth';
import { ensureAuthSecret } from './lib/auth-secret';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const now = (): string => new Date().toISOString().slice(11, 19);
const log = (...a: unknown[]): void => console.log(`[${now()}] [bootstrap]`, ...a);
const warn = (...a: unknown[]): void => console.warn(`[${now()}] [bootstrap] ⚠️`, ...a);

/** 旧版升级链路遗留的库名：数据写在 feedlore_v2，但很多站点的 .env 仍写 feedlore。 */
const LEGACY_DB_NAME = 'feedlore';
const V2_DB_NAME = 'feedlore_v2';

/** 库探测用的最小查询接口，便于在无真库的单测里注入桩。 */
export interface DbProbe {
  /** 指定库里是否有任意一行（用于判断「库里有账号吗」）。查询失败视为 false。 */
  hasAnyRow(database: string, table: string): Promise<boolean>;
  /** 指定库是否存在。 */
  databaseExists(database: string): Promise<boolean>;
  /** 用完释放连接（真实 PG 实现需要；测试桩可不实现）。 */
  close?(): Promise<void>;
}

/** 用同实例的 admin 连接串实现 DbProbe（连 /postgres 库做跨库探测）。 */
function makePgProbe(adminUrl: string): DbProbe {
  const pool = createPool(adminUrl);
  const exists = async (database: string): Promise<boolean> => {
    const r = await pool.query('select 1 from pg_database where datname = $1', [database]);
    return (r.rowCount ?? 0) > 0;
  };
  return {
    databaseExists: exists,
    hasAnyRow: async (database, table) => {
      if (!(await exists(database))) return false;
      // 库名 / 表名都是内部常量（feedlore_v2 / users），不是外部输入；仍做引号防护。
      const ident = (s: string): string => s.replace(/"/g, '""');
      const r = await pool.query(`select 1 from "${ident(database)}".public."${ident(table)}" limit 1`);
      return (r.rowCount ?? 0) > 0;
    },
    close: async () => { await pool.end().catch(() => {}); },
  };
}

/**
 * 旧库名自动兼容（2.5.4）。
 *
 * 2.5.3 删除了旧版 1.x→v2 升级链路：那条链路曾把 `DATABASE_URL` 从 `feedlore`
 * 改写到 `feedlore_v2`（只在进程内改，从不写回 .env）。老站点的 .env 因此普遍
 * 还是 `PG_DB=feedlore`，但数据实打实躺在 `feedlore_v2`。升级到 2.5.3 并在
 * Watchtower / `up -d` 下重建后，不再有运行时改写 → app 连到空库 `feedlore` →
 * 空站点播种新 admin → 原账号原密码全部失效。这是一次系统性回归。
 *
 * 只在**全部**满足时切换，避免误伤自定义库名与真正的空站点：
 *   1. 连接串里的库名恰好是旧默认 `feedlore`；
 *   2. 同实例存在 `feedlore_v2` 且其 users 表有账号；
 *   3. 当前 `feedlore` 库里没有账号（库不存在也算没有）。
 * 若两边都有账号，说明用户在用旧库名跑真实站点 → 一律不动，交给用户自己决定。
 *
 * 返回改写后的连接串；不写 .env、不迁移、不删数据。函数本身无副作用（除了 probe 查询），
 * 真正的改写由调用方写回 process.env.DATABASE_URL，使后续 migrate / auth / 服务都用新库。
 */
export async function resolveLegacyDatabaseUrl(
  source: string,
  probe: DbProbe,
  logFn: (...a: unknown[]) => void = () => {},
): Promise<string> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return source;
  }
  if (decodeURIComponent(url.pathname.replace(/^\//, '')) !== LEGACY_DB_NAME) return source;

  try {
    if (!(await probe.databaseExists(V2_DB_NAME))) return source;
    if (!(await probe.hasAnyRow(V2_DB_NAME, 'users'))) return source;
    if (await probe.hasAnyRow(LEGACY_DB_NAME, 'users')) return source;
  } catch (e) {
    // 探测失败（权限 / 网络 / 外部托管库）一律不切换，保持原行为，绝不冒险。
    warn(`Legacy database check failed, keeping DATABASE_URL as-is: ${(e as Error)?.message ?? e}`);
    return source;
  }

  url.pathname = `/${V2_DB_NAME}`;
  const rewritten = url.toString();
  logFn(`Detected legacy setup: "${LEGACY_DB_NAME}" has no accounts but "${V2_DB_NAME}" does`);
  logFn(`  Switching DATABASE_URL to "${V2_DB_NAME}" (runtime only; update PG_DB in .env to make it permanent)`);
  return rewritten;
}

/**
 * 目标库不存在就建（兜底）。
 *
 * 现行 compose 里 db 的 `POSTGRES_DB` 已与 app 连的库同名（`feedlore_v2`），全新安装
 * postgres 会直接建好，正常用不到这里。保留它是为了两种旧场景：仍在使用旧版 compose
 * 文件的站点（`POSTGRES_DB=feedlore` + app 连 `feedlore_v2`，曾导致 upgrade 容器下线后
 * 全新安装 crash loop），以及外部托管库被手工删库。
 *
 * 连到同实例的 postgres 库判断 + 创建，幂等。外部托管库无建库权限时只告警不阻断，
 * 让运维按提示手工建库，与结构迁移的容错策略保持一致。
 */
async function ensureTargetDatabase(targetUrl: string): Promise<void> {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return; // 非标准 URL 形式交给后续步骤报错
  }

  const name = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!name || name === 'postgres') return;

  const admin = new URL(targetUrl);
  admin.pathname = '/postgres';
  const pool = createPool(admin.toString());
  try {
    const found = await pool.query('select 1 from pg_database where datname = $1', [name]);
    if (found.rowCount) return;
    // 库名是标识符，不能参数化：双引号包裹并转义内部引号。
    await pool.query(`create database "${name.replace(/"/g, '""')}"`);
    log(`Database "${name}" was missing (fresh install), created it`);
  } catch (e) {
    warn(`Could not ensure database "${name}": ${(e as Error)?.message ?? e}`);
    warn(`Create it manually then restart: CREATE DATABASE "${name}";`);
  } finally {
    await pool.end().catch(() => {});
  }
}

/** 启动时的幂等结构迁移。失败只告警不阻断（外部托管库可能没有 DDL 权限）。 */
function migrateV2(url: string): void {
  log('Database schema migration (drizzle, idempotent)');
  const r = spawnSync('pnpm', ['--filter', '@feedlore/db', 'migrate'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, TZ: 'UTC', DATABASE_URL: url },
  });
  if (r.error) {
    warn(`Schema migration could not start (${r.error.message}): run pnpm --filter @feedlore/db migrate manually, then restart`);
    return;
  }
  if (r.status !== 0) {
    warn(`Schema migration failed (exit code ${r.status}): endpoints will break on missing columns, run pnpm --filter @feedlore/db migrate manually, then restart`);
    return;
  }
  log('Database schema is up to date');
}

/**
 * 本次启动播种的初始管理员，供 index.ts 在**服务真正监听之后**打印首启横幅。
 * 只在空站点新建账号时设置；已有账号的站点为 null（升级不产生任何横幅）。
 * 横幅必须在 listen 之后打：启动自举可能耗时，早打的横幅会被迁移日志埋掉。
 */
let startupAdmin: { username: string; customPassword: boolean } | null = null;
export function consumeStartupAdmin(): { username: string; customPassword: boolean } | null {
  const a = startupAdmin;
  startupAdmin = null;
  return a;
}

/** 空站点播种：没有任何账号时创建初始管理员（ADMIN_USER/ADMIN_PASS 可覆盖）。 */
async function ensureDefaultAdmin(): Promise<void> {
  const db = createDb();
  let count = 0;
  try {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    count = row?.n ?? 0;
  } catch (e) {
    warn(`Database is not ready yet (the schema migration may not have run), skipping the initial admin: ${(e as Error)?.message ?? e}`);
    return;
  }
  if (count > 0) {
    /* 已有账号：**不动密码、不置强制改密标记**。这是升级路径的核心承诺 ——
     * 老用户升级后照旧登录，不会被要求改密，权限也不变。
     * 只把「忘记密码怎么救」喊清楚，否则升级部署后只看到一堆启动日志会以为配错了。 */
    log(`数据库已有 ${count} 个账号：沿用原有密码，不重置、不要求改密 / existing accounts found, keeping the current password`);
    log('  忘记密码？在容器内执行 / forgot it? run inside the container:');
    log('    docker exec -it feedlore initial-password --reset');
    return;
  }

  const username = process.env.ADMIN_USER?.trim() || 'admin';
  /* 固定初始密码（contract 常量，文档里公开）。没设 ADMIN_PASS 时用它；
   * 该账号带 must_change_password 标记，首次登录必须改密，改完这枚公开口令即失效。 */
  const custom = process.env.ADMIN_PASS?.trim();
  const password = custom || INITIAL_ADMIN_PASSWORD;
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
    await db
      .update(users)
      .set({ role: 'admin', mustChangePassword: true })
      .where(eq(users.username, username));
    /* 进程内 signUpEmail 会顺带签一张会话（better-auth 默认 autoSignIn），
     * 但令牌没交给任何人；留着它会在「登录设备」里多出一台来路不明的设备。
     * 顺带说明：让用户必须自己登录一次，改密标记才会在真实会话上生效。 */
    const created = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (created[0]) await db.delete(sessions).where(eq(sessions.userId, created[0].id));
  } catch (e) {
    warn(`Failed to create the initial admin: ${(e as Error)?.message ?? e}`);
    return;
  }

  startupAdmin = { username, customPassword: Boolean(custom) };
  log(`Empty site: created the initial admin "${username}"; the first sign-in must change the password`);
}

/* ============================ 主流程 ============================ */

export async function bootstrap(): Promise<void> {
  process.env.TZ = 'UTC';

  const source = process.env.DATABASE_URL?.trim();
  if (!source) return;

  /* 旧库名兼容：必须在任何 createDb()/迁移之前，让连接串指向真正有数据的库。
   * 探测失败 / 非旧库名 / 两边都有账号时原样返回，行为与 2.5.3 完全一致。 */
  let target = source;
  try {
    const admin = new URL(source);
    admin.pathname = '/postgres';
    const probe = makePgProbe(admin.toString());
    try {
      target = await resolveLegacyDatabaseUrl(source, probe, log);
    } finally {
      await probe.close?.();
    }
  } catch (e) {
    warn(`Could not check legacy database name, continuing with the configured URL: ${(e as Error)?.message ?? e}`);
  }
  if (target !== source) process.env.DATABASE_URL = target;

  await ensureTargetDatabase(target);
  migrateV2(target);
  await ensureAuthSecret(target);
  await ensureDefaultAdmin();
}
