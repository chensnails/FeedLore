/**
 * 查询 / 重置管理员的一次性密码（仅容器内能跑，不开 HTTP 接口）。
 *
 *   docker exec -it feedlore pnpm --filter @feedlore/server initial-password
 *   docker exec -it feedlore pnpm --filter @feedlore/server initial-password --reset
 *
 * 不带参数：查回「空站点首次启动、且没设 ADMIN_PASS」时生成的那枚口令，
 * 只有生成后 24 小时内可取（过期、已改密、显式配了密码都返回退出码 2）。
 *
 * --reset：给已有站点用。生成一枚新随机口令、把管理员密码改成它、
 * 作废该账号的全部会话，并写进 24h 查询窗口，所以之后还能用不带参数的
 * 形式查回。适用于「忘了初始密码、日志也轮转没了」的救援场景 ——
 * 能执行 docker exec 的人本来就能改库，这不会扩大权限面。
 *
 * 退出码：0 = 查到/重置成功；2 = 没有可查凭据（过期 / 已改密 / 显式配了密码）；
 *         1 = 连库失败等运行错误。便于脚本化判读。
 */

import { eq } from 'drizzle-orm';
import { createDb, getPool, sessions, users } from '@feedlore/db';
import { readInitialAdmin, formatRemaining, newOneTimePassword, saveInitialAdmin } from '../src/lib/initialPassword';
import { ensureAuthSecret } from '../src/lib/auth-secret';
import { getAuth } from '../src/auth';

const wantJson = process.argv.includes('--json');
const wantReset = process.argv.includes('--reset');

function printCredential(username: string, password: string, expiresAt: string, note?: string): void {
  const remaining = formatRemaining(expiresAt);
  if (wantJson) {
    console.log(JSON.stringify({ ok: true, username, password, expiresAt, remaining, reset: wantReset }));
    return;
  }
  console.log(wantReset ? 'FeedLore 管理员密码已重置 / admin password reset' : 'FeedLore 初始管理员凭据 / initial admin credentials');
  console.log(`  用户名 / username : ${username}`);
  console.log(`  初始密码 / password: ${password}`);
  console.log(`  查询窗口 / query window: ${remaining}（截至 ${expiresAt}）`);
  if (note) console.log(`  ${note}`);
  console.log('  请登录后立即修改密码。 / Sign in and change this password now.');
}

/**
 * 重置管理员密码：生成新口令 → better-auth 算哈希写库 → 作废旧会话 → 写 24h 查询窗口。
 * 返回退出码。密码学全部交给 better-auth，这里不手写哈希。
 */
async function resetPassword(url: string): Promise<number> {
  /* getAuth 需要 AUTH_SECRET：CLI 是新进程，启动自举没跑过，先从 settings 读进环境变量。 */
  await ensureAuthSecret(url);
  const db = createDb(url);
  const username = process.env.ADMIN_USER?.trim() || 'admin';

  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!row) {
    console.error(`[initial-password] User "${username}" does not exist. Set ADMIN_USER to the account you want to reset.`);
    return 1;
  }

  const password = newOneTimePassword();
  const auth = getAuth(db);
  try {
    await auth.api.setUserPassword({ body: { userId: row.id, newPassword: password } });
  } catch (e) {
    /* setUserPassword 属于 admin 类接口，没有请求上下文时部分版本会要求会话；
     * 退化到内部适配器（同样是 better-auth 自己算哈希）。 */
    try {
      const ctx = await auth.$context;
      const hash = await ctx.password.hash(password);
      await ctx.internalAdapter.updatePassword(row.id, hash);
    } catch (e2) {
      console.error(`[initial-password] failed to update the password: ${(e2 as Error)?.message ?? e2}`);
      return 1;
    }
  }

  // 改密后作废该账号所有会话：旧 Cookie 不能继续用。
  await db.delete(sessions).where(eq(sessions.userId, row.id));

  const cred = await saveInitialAdmin(db, username, password);
  printCredential(cred.username, cred.password, cred.expiresAt,
    '旧会话已全部失效，需要用上面的新密码重新登录。');
  return 0;
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('[initial-password] DATABASE_URL is not set (run this inside the app container).');
    return 1;
  }

  if (wantReset) return resetPassword(url);

  let cred;
  try {
    cred = await readInitialAdmin(createDb(url));
  } catch (e) {
    console.error(`[initial-password] database error: ${(e as Error)?.message ?? e}`);
    return 1;
  }

  if (!cred) {
    const msg =
      '[initial-password] No retrievable initial password. It may have expired (24h window), ' +
      'already been used, or ADMIN_PASS was set at first start. Reset it from Settings → Account as admin.';
    if (wantJson) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    return 2;
  }

  printCredential(cred.username, cred.password, cred.expiresAt);
  return 0;
}

try {
  const code = await main();
  await getPool()?.end().catch(() => {});
  process.exitCode = code;
} catch (e) {
  console.error('[initial-password] unexpected error:', (e as Error)?.stack ?? e);
  await getPool()?.end().catch(() => {});
  process.exitCode = 1;
}
