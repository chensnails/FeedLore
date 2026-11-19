/**
 * 查询初始管理员的一次性密码（仅容器内能跑，不开 HTTP 接口）。
 *
 *   docker exec -it feedlore pnpm --filter @feedlore/server initial-password
 *
 * 只在「空站点首次启动、且没设 ADMIN_PASS」时有可查凭据；
 * 生成满 24 小时后查询窗口关闭，之后只能让管理员在页面重置密码。
 *
 * 退出码：0 = 查到并打印；2 = 没有可查凭据（过期 / 已改密 / 显式配了密码）；
 *         1 = 连库失败等运行错误。便于脚本化判读。
 */

import { createDb, getPool } from '@feedlore/db';
import { readInitialAdmin, formatRemaining } from '../src/lib/initialPassword';

const wantJson = process.argv.includes('--json');

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('[initial-password] DATABASE_URL is not set (run this inside the app container).');
    return 1;
  }

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

  const payload = {
    ok: true,
    username: cred.username,
    password: cred.password,
    expiresAt: cred.expiresAt,
    remaining: formatRemaining(cred.expiresAt),
  };
  if (wantJson) {
    console.log(JSON.stringify(payload));
  } else {
    console.log('FeedLore 初始管理员凭据 / initial admin credentials');
    console.log(`  用户名 / username : ${payload.username}`);
    console.log(`  初始密码 / password: ${payload.password}`);
    console.log(`  查询窗口 / query window: ${payload.remaining}（截至 ${payload.expiresAt}）`);
    console.log('  请登录后立即修改密码。 / Sign in and change this password now.');
  }
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
