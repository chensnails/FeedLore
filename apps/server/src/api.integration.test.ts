/**
 * 接口级集成测试（需要真 Postgres）。
 *
 * 为什么纯函数单测不够：这一层守的全是「**只有装起来、连上库才暴露**」的问题，
 * 而且每一条在 v2 开发里都真实发生过一次：
 *
 * - better-auth 的 `drizzleAdapter` 漏了 `usePlural:true` → 运行期 SchemaMismatchError，
 *   tsc 全绿、所有 /api/auth/** 全 500；
 * - `username()` 插件少 `display_username` 列 → 注册/登录 500；
 * - 纯 HTTP 下 Cookie 被 `secure:true` 锁死 → 「登录成功但后续仍 401」；
 * - 带 Cookie 的状态变更请求缺 `Origin` → 403 MISSING_OR_NULL_ORIGIN（curl 不带、浏览器带）；
 * - `users.id` 是 better-auth 的 cuid 而非 bigserial，契约照抄 `IdSchema` →
 *   在 `assertResponse` 处 500（服务端类型检查看不出来，只有真跑一次才炸）；
 * - `app.onError` 用 `if (s===400) …` 穷举，把 409 静默降级成 500。
 *
 * 这些的共同点是：**状态码与适配器行为**。单测碰不到，浏览器脚本能碰到但要人工跑。
 * 所以本文件把「真的起一个 Hono + 真的连库 + 真的走 better-auth」这一层自动化。
 *
 * 运行条件：`DATABASE_URL` 指向一个**已跑过迁移**的库（CI 由 service 容器 + migrate 步骤保证）。
 * 没设、或库里还没有 users 表时整组 skip —— 本地 `pnpm test` 不该因为「这台机器没数据库」变红。
 *
 * ⚠️ 本文件对**真实数据库**做写入（注册用户、插频道与条目）。收尾用 `delete from users`
 *    级联清掉（schema 里所有业务表对 users 都是 on delete cascade），但请只指向测试库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { createDb, feeds as feedsTable, entries as entriesTable } from '@feedlore/db';
import { createAuth } from '@feedlore/auth';
import {
  feedsListResponse,
  entriesListResponse,
  HealthSchema,
  SessionSchema,
} from '@feedlore/contract';
import { createApp } from './app';

const DATABASE_URL = process.env.DATABASE_URL ?? '';

/** better-auth 的 baseURL / trustedOrigins 必须是同一个源，否则 Cookie 签发即失效。 */
const ORIGIN = 'http://127.0.0.1:3211';

/* routes/auth.ts 在**调用时**读 env（不是模块加载时），这里赋值仍然有效。 */
process.env.AUTH_BASE_URL = ORIGIN;
process.env.AUTH_TRUSTED_ORIGINS = ORIGIN;

const SKIP = DATABASE_URL
  ? false
  : '未设置 DATABASE_URL —— 接口级测试需要一个已迁移的 Postgres';

/** 断言语义：这些响应必须能被契约 schema 原样解析。 */
function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    assert.fail(`${what} 的响应不符合契约：${JSON.stringify(r.error.issues)}`);
  }
  return r.data;
}

test('接口级：真库 + 真鉴权 + 契约校验', { skip: SKIP }, async (t) => {
  const db = createDb(DATABASE_URL);

  /* 迁移是否跑过：没跑就 skip 而不是让 30 个断言一起炸成「500」，
   * 那样报错信息只会说「期望 200 实际 500」，看不出是忘了 migrate。 */
  const probe = (await db.execute(
    sql`select to_regclass('public.users')::text as t`,
  )) as unknown as { rows?: Array<{ t: string | null }> };
  if (!probe.rows?.[0]?.t) {
    t.skip('库里没有 users 表 —— 先跑 pnpm --filter @feedlore/db migrate');
    return;
  }

  const auth = createAuth({
    db,
    secret: 'integration-test-secret-not-for-production',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    // 测试走纯 HTTP，secure Cookie 不会被回传 → 「登录成功仍 401」
    secureCookies: false,
  });
  const app = createApp({ db, auth });

  /* ---------------------------------------------------------------- 请求助手
   * 自己维护 Cookie 罐：Node 的 fetch 不会自动保存 Set-Cookie。
   * 每个请求都带 Origin —— 这正是浏览器行为，也是 better-auth 的 CSRF 前提。 */
  let jar = '';
  async function call(
    path: string,
    init: { method?: string; json?: unknown; body?: string } = {},
  ): Promise<Response> {
    const headers = new Headers({ origin: ORIGIN });
    if (jar) headers.set('cookie', jar);
    let body: string | undefined;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    } else if (init.body !== undefined) {
      body = init.body;
    }
    const res = await app.request(path, { method: init.method ?? 'GET', headers, body });
    const setCookies =
      (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    if (setCookies.length) jar = setCookies.map((s) => s.split(';')[0]).join('; ');
    return res;
  }

  const username = `itest_${Date.now().toString(36)}`;
  const email = `${username}@example.test`;
  const password = 'itest-pass-1234';
  let userId = '';

  try {
    /* ---------------------------------------------------------------- 公开端点 */
    await t.test('健康检查：库真的连上了（不是 503 降级）', async () => {
      const res = await call('/api/health');
      assert.equal(res.status, 200);
      const body = parse(HealthSchema, await res.json(), 'GET /api/health');
      assert.equal(body.db.ready, true, 'db.ready 应为 true —— 否则说明 DATABASE_URL 不通');
    });

    await t.test('未登录访问受保护端点：401 而不是 500', async () => {
      for (const path of ['/api/feeds', '/api/entries', '/api/users', '/api/prefs']) {
        const res = await call(path);
        assert.equal(res.status, 401, `${path} 未登录应为 401（500 说明中间件或 DB 抛了）`);
      }
    });

    await t.test('未知路径：404 + 统一错误体', async () => {
      const res = await call('/api/does-not-exist');
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: '接口不存在' });
    });

    /* ---------------------------------------------------------------- 鉴权链路 */
    await t.test('better-auth 的 HTTP 端点真的可达（不是被路由吞掉的 404）', async () => {
      /* 这条守的是一个极隐蔽的 bug：路由表里 `:id/refresh` 与 `reorder` 并存会让
       * Hono 的 RegExpRouter 放弃、退化成 TrieRouter，而 TrieRouter 不认 `**`，
       * 于是 `/api/auth/**` 静默 404 —— 全套 better-auth 端点在线上不可达，
       * 但 /api/login 走的是进程内 auth.handler，所以「登录能用」完全掩盖了它。 */
      const res = await call('/api/auth/get-session');
      assert.equal(res.status, 200, 'get-session 应为 200；404 说明 /api/auth/* 又被路由吞了');
      assert.notDeepEqual(await res.json(), { error: '接口不存在' });
    });

    await t.test('公开注册默认关闭（修通路由不能顺手把注册口开出去）', async () => {
      const res = await call('/api/auth/sign-up/email', {
        method: 'POST',
        json: { email, password, name: username, username },
      });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: '未开放注册' });
    });

    await t.test('注册 → 登录 → 会话（better-auth 适配器真的对得上）', async () => {
      process.env.ALLOW_SIGNUP = '1';
      try {
        const reg = await call('/api/auth/sign-up/email', {
          method: 'POST',
          json: { email, password, name: username, username },
        });
        assert.equal(reg.status, 200, `注册失败：${await reg.clone().text()}`);
      } finally {
        delete process.env.ALLOW_SIGNUP;
      }

      const login = await call('/api/login', {
        method: 'POST',
        json: { username, password },
      });
      assert.equal(login.status, 200);
      const l = (await login.json()) as { ok: boolean; username: string; role: string };
      assert.equal(l.ok, true);
      assert.equal(l.username, username);
      assert.equal(l.role, 'user');
      assert.ok(jar.includes('='), '登录响应必须带回会话 Cookie');

      const res = await call('/api/session');
      const s = parse(SessionSchema, await res.json(), 'GET /api/session');
      assert.equal(s.authenticated, true);
      assert.equal(s.username, username);
      assert.equal(s.dbReady, true);
      assert.ok(s.id, '会话必须带用户 id');
      userId = s.id as string;
    });

    /* ---------------------------------------------------------------- 读接口 */
    await t.test('GET /api/feeds：空库也返回契约形状', async () => {
      const res = await call('/api/feeds');
      assert.equal(res.status, 200);
      const body = parse(feedsListResponse, await res.json(), 'GET /api/feeds');
      assert.equal(body.total, 0);
      assert.deepEqual(body.feeds, []);
      /* autoRefreshMinutes 是「曾经有界面、没实现」的那一项，这里钉住它确实是数字，
       * 而不是 undefined 被 JSON 丢掉（前端读 undefined 会静默算成 NaN 分钟）。 */
      assert.equal(typeof body.autoRefreshMinutes, 'number');
    });

    await t.test('直接落库后，列表与条目计数一致', async () => {
      const [feed] = await db
        .insert(feedsTable)
        .values({
          ownerId: userId,
          url: 'https://example.com/itest-feed.xml',
          title: '集成测试频道',
          groupName: '测试分组',
          sortOrder: 10,
        })
        .returning({ id: feedsTable.id });
      assert.ok(feed);

      await db.insert(entriesTable).values([
        {
          feedId: feed.id,
          guid: 'itest-1',
          title: '条目一',
          link: 'https://example.com/1',
          publishedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          feedId: feed.id,
          guid: 'itest-2',
          title: '条目二',
          link: 'https://example.com/2',
          publishedAt: new Date('2026-01-02T00:00:00Z'),
        },
      ]);

      const fr = await call('/api/feeds');
      const f = parse(feedsListResponse, await fr.json(), 'GET /api/feeds');
      assert.equal(f.total, 1);
      assert.deepEqual(f.groups, ['测试分组']);
      assert.equal(f.feeds[0]?.title, '集成测试频道');

      const er = await call('/api/entries?limit=10');
      assert.equal(er.status, 200);
      const e = parse(entriesListResponse, await er.json(), 'GET /api/entries');
      assert.equal(e.total, 2);
      assert.equal(e.entries.length, 2);
      // 默认「新→旧」；契约里卡片标题叫 name（不是 title），频道名走 join 来的 feedName
      assert.equal(e.entries[0]?.name, '条目二');
      assert.equal(e.entries[0]?.feedName, '集成测试频道');

      // 只看未读 / 只看某频道：查询参数解析（z.coerce）真的生效
      const unread = parse(
        entriesListResponse,
        await (await call('/api/entries?unread=1')).json(),
        'GET /api/entries?unread=1',
      );
      assert.equal(unread.total, 2);

      const other = parse(
        entriesListResponse,
        await (await call('/api/entries?feeds=999999')).json(),
        'GET /api/entries?feeds=999999',
      );
      assert.equal(other.total, 0);
    });

    /* ---------------------------------------------------------------- 写接口的守卫 */
    await t.test('SSRF：内网地址与非法协议在建频道时就被 400 挡下', async () => {
      for (const url of [
        'http://127.0.0.1:6379/x',
        'http://169.254.169.254/latest/meta-data/',
        'file:///etc/passwd',
        'ftp://example.com/feed.xml',
      ]) {
        const res = await call('/api/feeds', { method: 'POST', json: { url } });
        assert.equal(res.status, 400, `${url} 应被拒（400），实际 ${res.status}`);
      }
    });

    await t.test('契约校验：缺字段的请求体是 400 不是 500', async () => {
      const res = await call('/api/feeds', { method: 'POST', json: { title: '没有 url' } });
      assert.equal(res.status, 400);
    });

    await t.test('越权：删别人的频道 → 404（不泄露存在性）', async () => {
      const res = await call('/api/feeds/999999', { method: 'DELETE' });
      assert.equal(res.status, 404);
    });

    /* ---------------------------------------------------------------- 管理员链路 */
    await t.test('提权后 /api/users 通过契约（cuid 不是数字的守门）', async () => {
      await db.execute(sql`update users set role = 'admin' where id = ${userId}`);

      const s = parse(SessionSchema, await (await call('/api/session')).json(), 'GET /api/session');
      assert.equal(s.role, 'admin', '改库后会话应立刻反映新角色（不能有进程内缓存）');

      const res = await call('/api/users');
      assert.equal(res.status, 200);
      const body = (await res.json()) as { users: Array<{ id: string; username: string }> };
      assert.ok(Array.isArray(body.users));
      /* 这条是核心：users.id 是 better-auth 的 cuid 字符串。
       * 契约若误用给 bigserial 的 IdSchema，assertResponse 会让这里变 500。 */
      const me = body.users.find((u) => u.username === username);
      assert.ok(me, '管理员列表里应能看到自己');
      assert.equal(typeof me.id, 'string');
    });

    /* ---------------------------------------------------------------- 登出 */
    await t.test('登出后会话失效（不是「返回 ok 但 Cookie 还有效」）', async () => {
      const out = await call('/api/logout', { method: 'POST' });
      assert.equal(out.status, 200);
      assert.equal(((await out.json()) as { ok: boolean }).ok, true);

      const s = parse(SessionSchema, await (await call('/api/session')).json(), 'GET /api/session');
      assert.equal(s.authenticated, false);
    });
  } finally {
    /* 级联清库：users 下所有业务表都是 on delete cascade，删这一行就够。
     * 再按用户名前缀兜一层，防止中途 return 留下孤儿（比如注册成功但没走到取 id）。 */
    try {
      await db.execute(sql`delete from users where username like 'itest\_%' or username = ${username}`);
    } catch (e) {
      console.error('[itest] 清理失败（不影响测试结论，但请手工检查测试库）：', (e as Error).message);
    }
  }
});
