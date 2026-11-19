/**
 * v2 启动自举：结构迁移 + 零配置密钥 + 空站点播种。
 *
 * 每次启动都做三件事（幂等，可重复）：
 *   1. drizzle 结构迁移 —— 2.0.5 的教训：Watchtower / 一键更新 / `up -d --no-deps app`
 *      只重建 app 容器，库会停留在旧结构导致接口 500。迁移挪进启动流程后就不可能漏。
 *      失败**不退出**：外部托管库常无 DDL 权限，直接崩会把本来能跑的站点弄成起不来。
 *   2. AUTH_SECRET 补枚（见 lib/auth-secret.ts）：没设时生成并存 settings，重建会话不掉线。
 *   3. 空站点播种：没有任何账号时建初始管理员；随机口令加密落库 + 首启横幅打印一次
 *      （见 lib/initialPassword.ts）。
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
import { createDb, sessions, users } from '@feedlore/db';
import { getAuth } from './auth';
import { ensureAuthSecret } from './lib/auth-secret';
import { newOneTimePassword, saveInitialAdmin, type InitialAdminCredential } from './lib/initialPassword';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const now = (): string => new Date().toISOString().slice(11, 19);
const log = (...a: unknown[]): void => console.log(`[${now()}] [bootstrap]`, ...a);
const warn = (...a: unknown[]): void => console.warn(`[${now()}] [bootstrap] ⚠️`, ...a);

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
 * 本次启动生成的初始凭据，供 index.ts 在**服务真正监听之后**打印首启横幅。
 * 只在空站点随机生成时设置；配了 ADMIN_PASS 的不算「一次性口令」，不进这里。
 * 横幅必须在 listen 之后打：启动自举可能耗时，早打的横幅会被迁移日志埋掉。
 */
let startupCredential: InitialAdminCredential | null = null;
export function consumeStartupCredential(): InitialAdminCredential | null {
  const c = startupCredential;
  startupCredential = null;
  return c;
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
    /* 已有账号时不动密码，但要把「怎么拿到密码」喊出来 —— 否则用户升级部署后
     * 只看到一堆启动日志、找不到凭据。口令是哈希存的，这里给的是重置通道。 */
    log(`Existing site (${count} account${count === 1 ? '' : 's'}): admin password unchanged.`);
    log('  Forgot it? Run inside the container:');
    log('    docker exec -it feedlore pnpm --filter @feedlore/server initial-password --reset');
    return;
  }

  const username = process.env.ADMIN_USER?.trim() || 'admin';
  /* 不再回落到 admin/admin：默认口令等于把刚部署、还没来得及改密的实例直接送人。
   * 没设 ADMIN_PASS 时生成一次性随机密码：加密落库（24h 查询窗口），
   * 明文只在启动横幅里出现一次，不再用 warn 长期留在 docker logs 里。 */
  const configuredPassword = process.env.ADMIN_PASS?.trim();
  const password = configuredPassword || newOneTimePassword();
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
    /* 进程内 signUpEmail 会顺带签一张会话（better-auth 默认 autoSignIn），
     * 但令牌没交给任何人；留着它会在「登录设备」里多出一台来路不明的设备。 */
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

  if (!configuredPassword) {
    /* 加密落库失败不能让站点起不来：口令已经在 signUpEmail 里生效，
     * 至少启动横幅还会完整打印一次，管理员仍能登录进去改密。
     * 这里刻意不把 password 写进任何 warn —— 那正是要消除的旧行为。 */
    try {
      startupCredential = await saveInitialAdmin(db, username, password);
      log(`Empty site: created initial admin ${username}; one-time password saved (queryable for 24h via CLI)`);
    } catch (e) {
      startupCredential = {
        username,
        password,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      };
      warn(`Initial admin created, but the password could not be saved for later query: ${(e as Error)?.message ?? e}`);
    }
  } else {
    log(`Empty site: created the admin with ADMIN_USER=${username}`);
  }
}

/* ============================ 主流程 ============================ */

export async function bootstrap(): Promise<void> {
  process.env.TZ = 'UTC';

  const source = process.env.DATABASE_URL?.trim();
  if (!source) return;

  migrateV2(source);
  await ensureAuthSecret(source);
  await ensureDefaultAdmin();
}
