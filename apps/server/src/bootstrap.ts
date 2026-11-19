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
 * v1 → v2 的一次性数据迁移已下线（2026-11-19，v2 已稳定运行、1.x 库删除）：
 * 老站点若还需升级，请用 v1.7.4 的离线导出 + v2 的「设置 → 数据 → 导入」。
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

  await ensureTargetDatabase(source);
  migrateV2(source);
  await ensureAuthSecret(source);
  await ensureDefaultAdmin();
}
