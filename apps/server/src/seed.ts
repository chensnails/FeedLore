/**
 * 播种管理员（幂等，可重复执行）。
 *
 * 用法：
 *   ADMIN_USER=admin ADMIN_PASS='强密码' pnpm --filter @feedlore/server seed
 *
 * 说明：
 * - 这里直接调 better-auth 的服务端 API，密码哈希由库自己算，不手写加密。
 *   不用 HTTP 打 `/api/auth/sign-up/email` 也不是因为「没有该端点」——该端点一直是有的，
 *   真相是 Hono 的 router 退化让 `/api/auth/**` 常年 404（详见 app.ts 的长注释）；
 *   即便修通，公开注册也按策略默认关闭（`ALLOW_SIGNUP=1` 才开）。
 *   播种/加人走进程内 API 更省事，也绕开了限流与 CSRF 的无关复杂度。
 * - username 插件启用后 signUpEmail 的 body 可带 username，之后即可用用户名登录。
 */

import { eq } from 'drizzle-orm';
import { createDb, schema } from '@feedlore/db';
import { getAuth } from './auth';

async function main(): Promise<void> {
  const username = process.env.ADMIN_USER ?? 'admin';
  const password = process.env.ADMIN_PASS;
  if (!password) {
    console.error('[seed] 缺少环境变量 ADMIN_PASS');
    process.exit(1);
  }

  const db = createDb();
  const auth = getAuth(db);

  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);

  if (existing.length === 0) {
    await auth.api.signUpEmail({
      body: {
        email: `${username}@example.com`,
        password,
        name: username,
        username,
      } as never, // username 字段由 username 插件扩展，类型未覆盖
    });
    console.log(`[seed] 已创建用户 ${username}`);
  } else {
    console.log(`[seed] 用户 ${username} 已存在，跳过创建`);
  }

  await db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.username, username));
  console.log(`[seed] 已将 ${username} 提升为 admin`);

  const row = await db
    .select({ id: schema.users.id, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);
  console.log('[seed] 校验：', JSON.stringify(row[0]));
  process.exit(0);
}

main().catch((e) => {
  console.error('[seed] 失败：', (e as Error)?.message ?? e);
  process.exit(1);
});
