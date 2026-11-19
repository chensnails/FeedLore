/**
 * 初始管理员密码的说明与重置（仅容器内能跑，不开 HTTP 接口）。
 *
 *   docker exec -it feedlore initial-password           # 告诉你初始密码是什么
 *   docker exec -it feedlore initial-password --reset   # 把它重置回初始密码
 *
 * 镜像把上面这条短命令装在 /usr/local/bin（见 Dockerfile），等价于
 * `pnpm --filter @feedlore/server initial-password`；老镜像没有该命令时用完整形式。
 *
 * 初始密码是固定值（contract 的 INITIAL_ADMIN_PASSWORD），不存在「查不到」的情况；
 * 因此不带参数时只是把它打印出来，附带「改过就失效、用 --reset 找回」的提示。
 *
 * --reset：写出新哈希、把 must_change_password 重新置 true、作废该账号全部会话。
 * 适用于「升级前的老账号忘了密码」与「初始密码被改掉后忘了新密码」两种救援场景 ——
 * 能执行 docker exec 的人本来就能改库，这不扩大权限面。重置后那次登录同样必须先改密，
 * 重置出来的公开口令不会长期有效。
 *
 * 退出码：0 = 成功；1 = 连库失败 / 用户不存在等运行错误。便于脚本化判读。
 */

import { INITIAL_ADMIN_PASSWORD } from '@feedlore/contract';
import { createDb, getPool, sessions, users } from '@feedlore/db';
import { eq } from 'drizzle-orm';
import { getAuth } from '../src/auth';
import { ensureAuthSecret } from '../src/lib/auth-secret';
import { log } from '../src/lib/logger';

const wantJson = process.argv.includes('--json');
const wantReset = process.argv.includes('--reset');

function targetUsername(): string {
  return process.env.ADMIN_USER?.trim() || 'admin';
}

function printCredential(name: string, reset: boolean): void {
  if (wantJson) {
    // --json 是给脚本消费的协议输出，不是日志：必须原样一行 JSON，不套 pino 外壳。
    process.stdout.write(
      JSON.stringify({ ok: true, username: name, password: INITIAL_ADMIN_PASSWORD, reset }) + '\n',
    );
    return;
  }
  log.info(
    reset
      ? 'FeedLore 管理员密码已重置 / admin password reset'
      : 'FeedLore 初始管理员密码 / initial admin password',
  );
  log.info(`  用户名 / username : ${name}`);
  log.info(`  初始密码 / password: ${INITIAL_ADMIN_PASSWORD}`);
  log.info('');
  if (reset) {
    log.info('  旧会话已全部失效，请用上面的密码重新登录 —— 登录后必须先设置新密码。');
    log.info('  All old sessions were revoked. Sign in with it, then set a new password.');
  } else {
    log.info('  这枚密码只在「首次部署、还没改过密码」时有效。改过之后请用 --reset 重置。');
    log.info('  It only works before the first password change; use --reset to restore it.');
  }
}

/**
 * 重置管理员密码：新哈希写库 → 重新置「必须改密」→ 作废旧会话。
 * 返回退出码。密码学全部交给 better-auth，这里不手写哈希。
 */
async function resetPassword(url: string): Promise<number> {
  /* getAuth 需要 AUTH_SECRET：CLI 是新进程，启动自举没跑过，先从 settings 读进环境变量。 */
  await ensureAuthSecret(url);
  const db = createDb(url);
  const name = targetUsername();

  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, name))
    .limit(1);
  if (!row) {
    log.error(
      `[initial-password] User "${name}" does not exist. Set ADMIN_USER to the account you want to reset.`,
    );
    return 1;
  }

  const auth = getAuth(db);
  try {
    await auth.api.setUserPassword({
      body: { userId: row.id, newPassword: INITIAL_ADMIN_PASSWORD },
    });
  } catch (_e) {
    /* setUserPassword 属于 admin 类接口，没有请求上下文时部分版本会要求会话；
     * 退化到内部适配器（同样是 better-auth 自己算哈希）。 */
    try {
      const ctx = await auth.$context;
      const hash = await ctx.password.hash(INITIAL_ADMIN_PASSWORD);
      await ctx.internalAdapter.updatePassword(row.id, hash);
    } catch (e2) {
      log.error(
        `[initial-password] failed to update the password: ${(e2 as Error)?.message ?? e2}`,
      );
      return 1;
    }
  }

  /* 重新置「首次登录必须改密」：重置出的是公开口令，不能让它长期有效。
   * 同时作废该账号所有会话，旧 Cookie 不能继续用。 */
  await db
    .update(users)
    .set({ mustChangePassword: true, updatedAt: new Date() })
    .where(eq(users.id, row.id));
  await db.delete(sessions).where(eq(sessions.userId, row.id));

  printCredential(name, true);
  return 0;
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    log.error('[initial-password] DATABASE_URL is not set (run this inside the app container).');
    return 1;
  }

  if (wantReset) {
    try {
      return await resetPassword(url);
    } catch (e) {
      log.error(`[initial-password] database error: ${(e as Error)?.message ?? e}`);
      return 1;
    }
  }

  /* 不带参数：不碰库，只把约定值说清楚。 */
  printCredential(targetUsername(), false);
  return 0;
}

try {
  const code = await main();
  await getPool()
    ?.end()
    .catch(() => {});
  process.exitCode = code;
} catch (e) {
  log.error('[initial-password] unexpected error:', (e as Error)?.stack ?? e);
  await getPool()
    ?.end()
    .catch(() => {});
  process.exitCode = 1;
}
