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
import { gunzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDb, feeds as feedsTable, entries as entriesTable } from '@feedlore/db';
import { createAuth } from '@feedlore/auth';
import { ENCRYPTED_PREFIX, decryptSecret, getCryptoSecret } from '@feedlore/ai';
import {
  feedsListResponse,
  entriesListResponse,
  HealthSchema,
  SessionDeviceSchema,
  SessionSchema,
} from '@feedlore/contract';
import { createApp } from './app';
import { createTarGz } from './lib/tar';

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

/** 用服务端同一套归档器造上传包，避免测试自己手搓 tar 头。 */
async function buildArchive(files: Record<string, string>): Promise<Buffer> {
  const ar = createTarGz();
  for (const [name, data] of Object.entries(files)) await ar.add(name, data);
  await ar.close();
  const chunks: Buffer[] = [];
  for await (const chunk of ar.readable) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** 解开导出包（我们只写 ustar，不写 PAX），返回 文件名 → 内容。 */
function readTarGz(raw: ArrayBuffer): Map<string, Buffer> {
  const tar = gunzipSync(Buffer.from(raw));
  const files = new Map<string, Buffer>();
  let off = 0;
  for (;;) {
    const h = tar.subarray(off, off + 512);
    if (h.length < 512 || h.every((b) => b === 0)) break;
    const text = (from: number, to: number) => h.subarray(from, to).toString('utf8').replace(/\0[\s\S]*$/, '');
    const name = text(0, 100);
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0[\s\S]*$/, '').trim() || '0', 8);
    files.set(name, tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
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
    init: { method?: string; json?: unknown; body?: string | Uint8Array } = {},
  ): Promise<Response> {
    const headers = new Headers({ origin: ORIGIN });
    if (jar) headers.set('cookie', jar);
    let body: string | Uint8Array | undefined;
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

  /** 单独登录一个账号并返回它自己的 Cookie 串（不污染主 jar）。
   *  userAgent 会随登录请求透传，用于验证「登录设备」里的浏览器识别。 */
  async function loginAs(u: string, p: string, userAgent = ''): Promise<string> {
    const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' };
    if (userAgent) headers['user-agent'] = userAgent;
    const res = await app.request('/api/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: u, password: p }),
    });
    assert.equal(res.status, 200, `${u} 登录应成功`);
    const setCookies =
      (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    return setCookies.map((s) => s.split(';')[0]).join('; ');
  }

  const username = `itest_${Date.now().toString(36)}`;
  const email = `${username}@example.test`;
  const password = 'itest-pass-1234';
  let userId = '';
  let userArchive = Buffer.alloc(0);
  let siteArchive = Buffer.alloc(0);

  try {
    /* ---------------------------------------------------------------- 公开端点 */
    await t.test('健康检查：库真的连上了（不是 503 降级）', async () => {
      const res = await call('/api/health');
      assert.equal(res.status, 200);
      const body = parse(HealthSchema, await res.json(), 'GET /api/health');
      assert.equal(body.db.ready, true, 'db.ready 应为 true —— 否则说明 DATABASE_URL 不通');
    });

    await t.test('未登录访问受保护端点：401 而不是 500', async () => {
      for (const path of ['/api/feeds', '/api/entries', '/api/users', '/api/prefs', '/api/export', '/api/backup']) {
        const res = await call(path);
        assert.equal(res.status, 401, `${path} 未登录应为 401（500 说明中间件或 DB 抛了）`);
      }
    });

    await t.test('未知路径：404 + 错误码（不是中文文案）', async () => {
      const res = await call('/api/does-not-exist');
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), {
        error: 'E_ROUTE_NOT_FOUND',
        message: 'Endpoint not found',
        status: 404,
      });
    });

    await t.test('错误体一律是「码 + 英文说明」，界面语言由前端词典负责', async () => {
      /* 这一条守的是整个 i18n 边界：服务端任何形式的失败都不许把中文塞进响应，
       * 否则前端词典就失去了唯一入口，同一句话会在两处各自演化。 */
      const res = await call('/api/entries'); // 未登录 → 中间件拒绝
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: string; message: string };
      assert.equal(body.error, 'E_UNAUTHORIZED');
      assert.equal(body.message, 'Not signed in');
      assert.doesNotMatch(`${body.error} ${body.message}`, /[一-鿿]/, '响应里不应出现中文');
    });

    /* ---------------------------------------------------------------- 鉴权链路 */
    await t.test('better-auth 的 HTTP 端点真的可达（不是被路由吞掉的 404）', async () => {
      /* 这条守的是一个极隐蔽的 bug：路由表里 `:id/refresh` 与 `reorder` 并存会让
       * Hono 的 RegExpRouter 放弃、退化成 TrieRouter，而 TrieRouter 不认 `**`，
       * 于是 `/api/auth/**` 静默 404 —— 全套 better-auth 端点在线上不可达，
       * 但 /api/login 走的是进程内 auth.handler，所以「登录能用」完全掩盖了它。 */
      const res = await call('/api/auth/get-session');
      assert.equal(res.status, 200, 'get-session 应为 200；404 说明 /api/auth/* 又被路由吞了');
      // 未登录时 better-auth 的响应体是字面量 null，所以这里必须按可空处理
      const j = (await res.json()) as { error?: string } | null;
      assert.notEqual(j?.error, 'E_ROUTE_NOT_FOUND');
    });

    await t.test('直连 better-auth 登录端点被拒（登录只能走 /api/login 的限流入口）', async () => {
      const res = await call('/api/auth/sign-in/username', {
        method: 'POST',
        json: { username, password },
      });
      assert.equal(res.status, 403);
    });

    await t.test('安全响应头与 API 不落盘', async () => {
      const res = await call('/api/session');
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /script-src 'self' 'nonce-[^']+'/, 'CSP 必须用 nonce 放行内联脚本');
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(res.headers.get('permissions-policy'));
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });

    await t.test('公开注册默认关闭（修通路由不能顺手把注册口开出去）', async () => {
      const res = await call('/api/auth/sign-up/email', {
        method: 'POST',
        json: { email, password, name: username, username },
      });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), {
        error: 'E_SIGNUP_DISABLED',
        message: 'Sign-up is disabled',
        status: 403,
      });
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

    /* ---------------------------------------------------------------- 会话吊销 */
    await t.test('管理员重置密码后，目标用户的旧会话立即失效', async () => {
      const victim = `itest_v_${Date.now().toString(36)}`;
      const created = await call('/api/users', {
        method: 'POST',
        json: { username: victim, password: 'victim-pass-1234', role: 'user' },
      });
      assert.equal(created.status, 200);
      const victimId = ((await created.json()) as { user: { id: string } }).user.id;

      const victimJar = await loginAs(victim, 'victim-pass-1234');
      assert.equal(
        (await app.request('/api/feeds', { headers: { cookie: victimJar } })).status,
        200,
      );

      const reset = await call(`/api/users/${victimId}`, {
        method: 'PATCH',
        json: { password: 'victim-pass-5678' },
      });
      assert.equal(reset.status, 200);

      assert.equal(
        (await app.request('/api/feeds', { headers: { cookie: victimJar } })).status,
        401,
        '改密后旧 Cookie 必须失效',
      );
    });

    await t.test('自助改密：当前设备保持登录，其它设备立即失效', async () => {
      const name = `itest_self_${Date.now().toString(36)}`;
      const created = await call('/api/users', {
        method: 'POST',
        json: { username: name, password: 'self-pass-1234', role: 'user' },
      });
      assert.equal(created.status, 200);

      const first = await loginAs(name, 'self-pass-1234');
      const second = await loginAs(name, 'self-pass-1234');
      assert.equal((await app.request('/api/feeds', { headers: { cookie: first } })).status, 200);
      assert.equal((await app.request('/api/feeds', { headers: { cookie: second } })).status, 200);

      const changed = await app.request('/api/account', {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: first, 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'self-pass-1234', newPassword: 'self-pass-5678' }),
      });
      assert.equal(changed.status, 200);

      /* changePassword 内部会删掉全部会话；这里必须显式只清「其它」会话，
       * 否则当前设备也会被踢下线（浏览器拿不到直调 API 产生的新 Cookie）。 */
      assert.equal(
        (await app.request('/api/feeds', { headers: { cookie: first } })).status,
        200,
        '当前设备应保持登录',
      );
      assert.equal(
        (await app.request('/api/feeds', { headers: { cookie: second } })).status,
        401,
        '其它设备应被踢下线',
      );
      await loginAs(name, 'self-pass-5678');
    });

    /* ---------------------------------------------------------------- 设备管理 */
    await t.test('设备清单：只列本账号活跃会话，标记本机且不泄露 token', async () => {
      const name = `itest_dev_${Date.now().toString(36)}`;
      await call('/api/users', { method: 'POST', json: { username: name, password: 'dev-pass-1234', role: 'user' } });
      const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0';
      const UA_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile Safari/604.1';
      const first = await loginAs(name, 'dev-pass-1234', UA_DESKTOP);
      const second = await loginAs(name, 'dev-pass-1234', UA_PHONE);

      const res = await app.request('/api/sessions', { headers: { cookie: first } });
      assert.equal(res.status, 200);
      const raw = await res.text();
      assert.doesNotMatch(raw, /token/i, '会话 token 是登录凭据，绝不能下发到前端');
      const body = parse(
        z.object({ sessions: z.array(SessionDeviceSchema) }),
        JSON.parse(raw),
        'GET /api/sessions',
      );
      assert.ok(body.sessions.length >= 2, `应至少看到两台设备，实际 ${body.sessions.length}`);
      assert.equal(body.sessions.filter((s) => s.current).length, 1, '有且只有一条是当前设备');
      assert.equal(body.sessions[0]?.current, true, '当前设备排在最前');
      const uas = body.sessions.map((s) => s.userAgent);
      assert.ok(uas.includes(UA_DESKTOP), `设备清单应带上登录时的 UA，实际 ${JSON.stringify(uas)}`);
      assert.ok(uas.includes(UA_PHONE), '手机登录也要能被识别成另一台设备');

      const other = body.sessions.find((s) => !s.current);
      assert.ok(other, '应能定位另一台设备');

      // 单台吊销：另一台立即失效，本机不受影响
      const del = await app.request(`/api/sessions/${other.id}`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie: first },
      });
      assert.equal(del.status, 200);
      assert.equal((await app.request('/api/feeds', { headers: { cookie: second } })).status, 401);
      assert.equal((await app.request('/api/feeds', { headers: { cookie: first } })).status, 200);

      // 不能「吊销本机」：应提示改用退出登录，而不是 200 后把自己踢掉
      const mine = body.sessions.find((s) => s.current);
      assert.ok(mine);
      const selfRevoke = await app.request(`/api/sessions/${mine.id}`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie: first },
      });
      assert.equal(selfRevoke.status, 400);
      assert.equal(((await selfRevoke.json()) as { error: string }).error, 'E_CANNOT_REVOKE_CURRENT');
      assert.equal((await app.request('/api/feeds', { headers: { cookie: first } })).status, 200);

      // 不存在的 id → 404 而不是 500
      const missing = await app.request('/api/sessions/not-a-real-session', {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie: first },
      });
      assert.equal(missing.status, 404);
      assert.equal(((await missing.json()) as { error: string }).error, 'E_SESSION_NOT_FOUND');

      // 「退出其它设备」：一次清掉，自己留下
      const third = await loginAs(name, 'dev-pass-1234');
      const revokeOthers = await app.request('/api/sessions/revoke-others', {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: first },
      });
      assert.equal(revokeOthers.status, 200);
      const out = (await revokeOthers.json()) as { ok: boolean; revoked: number };
      assert.equal(out.ok, true);
      assert.ok(out.revoked >= 1, `应至少吊销 1 台，实际 ${out.revoked}`);
      assert.equal((await app.request('/api/feeds', { headers: { cookie: third } })).status, 401);
      assert.equal((await app.request('/api/feeds', { headers: { cookie: first } })).status, 200);
    });

    /* ---------------------------------------------------------------- CSRF */
    await t.test('写接口必须带本站 Origin/Referer（缺失或外站都 403）', async () => {
      const body = JSON.stringify({ layout: { view: 'list' } });
      const post = (headers: Record<string, string>) =>
        app.request('/api/prefs', {
          method: 'POST',
          headers: { cookie: jar, 'content-type': 'application/json', ...headers },
          body,
        });

      assert.equal((await post({})).status, 403, '没有 Origin/Referer 时应拒绝');
      assert.equal((await post({ origin: 'https://evil.example' })).status, 403, '外站 Origin 应拒绝');
      assert.equal(
        (await post({ referer: 'https://evil.example/phish.html' })).status,
        403,
        '外站 Referer 也应拒绝',
      );
      assert.equal(
        (await post({ referer: `${ORIGIN}/settings` })).status,
        200,
        '本站 Referer（没有 Origin 的旧浏览器）应放行',
      );
      // 读取不受影响：无 Origin 的普通 GET 仍可用
      assert.equal((await app.request('/api/feeds', { headers: { cookie: jar } })).status, 200);
    });

    /* ---------------------------------------------------------------- 数据导出 */
    await t.test('账号导出：tar.gz 只含本人数据，默认不带模型 Key 与会话', async () => {
      const res = await call('/api/export');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/gzip/);
      assert.match(
        res.headers.get('content-disposition') ?? '',
        /^attachment; filename="feedlore-.+\.tar\.gz"$/,
      );
      const raw = await res.arrayBuffer();
      userArchive = Buffer.from(raw);
      const files = readTarGz(raw);

      const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as {
        kind: string; username: string; counts: { feeds: number; entries: number };
      };
      assert.equal(manifest.kind, 'user');
      assert.equal(manifest.username, username);
      assert.equal(manifest.counts.feeds, 1);
      assert.equal(manifest.counts.entries, 2);

      const feeds = JSON.parse(files.get('feeds.json')!.toString('utf8')) as Array<{ url: string }>;
      assert.deepEqual(feeds.map((f) => f.url), ['https://example.com/itest-feed.xml']);

      const batches = [...files.keys()].filter((k) => /^entries-\d{4}\.jsonl$/.test(k));
      assert.equal(batches.length, 1, '两条条目应只写一个批次文件');
      const rows = files
        .get(batches[0]!)!
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.feedUrl, 'https://example.com/itest-feed.xml');
      // 库内自增 id / feedId 不外泄，换机导入靠 feedUrl 对应
      assert.ok(rows.every((r) => !('id' in r) && !('feedId' in r)));

      assert.ok(files.has('digests.json'));
      assert.ok(files.has('prefs.json'));
      assert.ok(!files.has('llm.json'), '未勾选时不应出现 llm.json');
      assert.ok(![...files.keys()].some((k) => /session|verification/i.test(k)), '包里不应有会话文件');
    });

    await t.test('账号导出：勾选后才带 llm.json', async () => {
      const res = await call('/api/export?llm=1');
      assert.equal(res.status, 200);
      const files = readTarGz(await res.arrayBuffer());
      assert.ok(files.has('llm.json'));
      // 测试账号没配模型：文件存在但内容为 null，说明走的是同一套分支
      assert.equal(JSON.parse(files.get('llm.json')!.toString('utf8')), null);
    });

    await t.test('整站备份：管理员可下，含账号与设置，不含会话', async () => {
      // 图片代理的宽度变体键带 `:w640` 后缀：备份必须能写入，还原也必须能认回
      await db.execute(sql`
        insert into image_cache (key, content_type, data, size)
        values ('itestimg', 'image/webp', decode('00', 'hex'), 1),
               ('itestimg:w640', 'image/webp', decode('0102', 'hex'), 2)
      `);
      const res = await call('/api/backup');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/gzip/);
      const raw = await res.arrayBuffer();
      siteArchive = Buffer.from(raw);
      const files = readTarGz(raw);

      const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as {
        kind: string; includes: { sessions: boolean };
      };
      assert.equal(manifest.kind, 'site');
      assert.equal(manifest.includes.sessions, false);

      const users = JSON.parse(files.get('users.json')!.toString('utf8')) as Array<{ username: string }>;
      assert.ok(users.some((u) => u.username === username), '备份应包含本账号');
      for (const name of ['accounts.json', 'settings.json', 'user_llm.json', 'image_cache.json', 'feeds.json']) {
        assert.ok(files.has(name), `备份缺 ${name}`);
      }
      assert.ok(files.has('images/itestimg:w640'), '备份应包含宽度变体的图片缓存');
      assert.ok(![...files.keys()].some((k) => /^sessions|verification/i.test(k)));
    });

    /* ---------------------------------------------------------------- 数据导入 */
    await t.test('账号导入：重复导入自己的导出包是幂等的，不改动现有标记', async () => {
      const fd = (await db.execute(
        sql`select id from feeds where owner_id = ${userId} and url = 'https://example.com/itest-feed.xml'`,
      )) as unknown as { rows: Array<{ id: string }> };
      const feedId = Number(fd.rows[0]!.id);

      // 导出包里的这两条是「未读 / 未收藏」；导入必须跳过它们，而不是把标记刷回去
      await db.execute(sql`update entries set is_read = true, is_favorite = true where feed_id = ${feedId}`);
      const res = await call('/api/import', { method: 'POST', body: userArchive });
      assert.equal(res.status, 200, await res.clone().text());
      const out = (await res.json()) as {
        ok: boolean; kind: string;
        feeds: { inserted: number; skipped: number };
        entries: { inserted: number; skipped: number };
        prefs: boolean;
      };
      assert.equal(out.ok, true);
      assert.equal(out.kind, 'user');
      assert.deepEqual(out.feeds, { inserted: 0, skipped: 1 });
      assert.deepEqual(out.entries, { inserted: 0, skipped: 2 });
      assert.equal(out.prefs, false, '已有偏好时不应被导出包覆盖');

      const flags = (await db.execute(
        sql`select bool_and(is_read) as read, bool_and(is_favorite) as fav from entries where feed_id = ${feedId}`,
      )) as unknown as { rows: Array<{ read: boolean; fav: boolean }> };
      assert.equal(flags.rows[0]!.read, true, '已读状态应保留');
      assert.equal(flags.rows[0]!.fav, true, '收藏状态应保留');
    });

    await t.test('账号导入：补缺失频道与文章，按 (频道, guid) 去重', async () => {
      const archive = await buildArchive({
        'manifest.json': JSON.stringify({ format: 'feedlore-backup', formatVersion: 1, kind: 'user' }),
        'feeds.json': JSON.stringify([
          { url: 'https://example.com/import-feed.xml', title: '导入频道' },
        ]),
        'digests.json': '[]',
        'entries-0001.jsonl': [
          // 新频道的新文章：应写入，且保留包里的已读标记
          { feedUrl: 'https://example.com/import-feed.xml', guid: 'imp-1', title: '导入文章', isRead: true },
          // 已有文章的 guid：应跳过，且不把库里的标记改回 false
          { feedUrl: 'https://example.com/itest-feed.xml', guid: 'itest-1', title: '冲突文章', isRead: false },
        ].map((r) => JSON.stringify(r)).join('\n'),
      });

      const res = await call('/api/import', { method: 'POST', body: archive });
      assert.equal(res.status, 200, await res.clone().text());
      const out = (await res.json()) as {
        feeds: { inserted: number; skipped: number };
        entries: { inserted: number; skipped: number };
      };
      assert.deepEqual(out.feeds, { inserted: 1, skipped: 0 });
      assert.deepEqual(out.entries, { inserted: 1, skipped: 1 });

      const added = (await db.execute(sql`
        select e.is_read from entries e join feeds f on f.id = e.feed_id
        where f.url = 'https://example.com/import-feed.xml' and e.guid = 'imp-1'
      `)) as unknown as { rows: Array<{ is_read: boolean }> };
      assert.equal(added.rows[0]?.is_read, true, '新文章应带上包里的已读状态');

      const conflict = (await db.execute(sql`
        select e.is_read from entries e join feeds f on f.id = e.feed_id
        where f.url = 'https://example.com/itest-feed.xml' and e.guid = 'itest-1'
      `)) as unknown as { rows: Array<{ is_read: boolean }> };
      assert.equal(conflict.rows[0]?.is_read, true, '冲突文章不应被改成未读');

      // 再导一次：全部跳过（幂等）
      const again = await call('/api/import', { method: 'POST', body: archive });
      assert.equal(again.status, 200);
      const out2 = (await again.json()) as {
        feeds: { inserted: number; skipped: number };
        entries: { inserted: number; skipped: number };
      };
      assert.deepEqual(out2.feeds, { inserted: 0, skipped: 1 });
      assert.deepEqual(out2.entries, { inserted: 0, skipped: 2 });
    });

    await t.test('账号导入：包里的模型配置只补空，Key 用本机主密钥重新加密', async () => {
      const prevEscape = process.env.ALLOW_PRIVATE_HOSTS;
      delete process.env.ALLOW_PRIVATE_HOSTS; // 出网校验的逃生口会整体放行，本组断言要求它关着
      try {
        const llmFile = (patch: Record<string, unknown>) =>
          JSON.stringify({ baseUrl: 'https://api.example.com/v1', model: 'gpt-test', apiKey: 'sk-plain-123', ...patch });
        const baseFiles: Record<string, string> = {
          'manifest.json': JSON.stringify({ format: 'feedlore-backup', formatVersion: 1, kind: 'user' }),
          'feeds.json': JSON.stringify([{ url: 'https://example.com/llm-feed.xml', title: '模型频道' }]),
          'digests.json': '[]',
        };
        const withLlm = (llmJson: string) => ({ ...baseFiles, 'llm.json': llmJson });

        const res = await call('/api/import', { method: 'POST', body: await buildArchive(withLlm(llmFile({ temperature: 0.3, thinking: true, thinkingDepth: 3 }))) });
        assert.equal(res.status, 200, await res.clone().text());
        const out = (await res.json()) as { llm: string; feeds: { inserted: number } };
        assert.equal(out.llm, 'applied');
        assert.deepEqual(out.feeds, { inserted: 1, skipped: 0 }, '模型地址合规时不应拖累其余数据的导入');

        const secret = await getCryptoSecret(db);
        const stored = (await db.execute(sql`
          select encrypted_key, base_url, model, temperature, thinking, thinking_depth
          from user_llm where user_id = ${userId}
        `)) as unknown as {
          rows: Array<{
            encrypted_key: string | null; base_url: string | null; model: string | null;
            temperature: number | null; thinking: boolean; thinking_depth: string | null;
          }>;
        };
        assert.equal(stored.rows.length, 1);
        const row = stored.rows[0]!;
        assert.ok(row.encrypted_key?.startsWith(ENCRYPTED_PREFIX), '入库的应是本机加密格式');
        assert.ok(!row.encrypted_key!.includes('sk-plain-123'), '明文 Key 不得落库');
        assert.equal(decryptSecret(row.encrypted_key, secret), 'sk-plain-123', '必须能用本机主密钥解回');
        assert.equal(row.base_url, 'https://api.example.com/v1');
        assert.equal(row.model, 'gpt-test');
        assert.equal(row.temperature, 0.3);
        assert.equal(row.thinking, true);
        assert.equal(row.thinking_depth, 3);

        // 已经有配置了：再导一次只报「未覆盖」，库里那行一个字都不能动
        await db.execute(sql`update user_llm set model = 'keep-me', encrypted_key = NULL where user_id = ${userId}`);
        const twiceBody = await buildArchive(withLlm(llmFile({})));
        const twiceRes = await call('/api/import', { method: 'POST', body: twiceBody });
        assert.equal(twiceRes.status, 200);
        assert.equal(((await twiceRes.json()) as { llm: string }).llm, 'already-configured');
        const after = (await db.execute(
          sql`select model, encrypted_key from user_llm where user_id = ${userId}`,
        )) as unknown as { rows: Array<{ model: string | null; encrypted_key: string | null }> };
        assert.equal(after.rows[0]!.model, 'keep-me', '已有配置不应被包内的那份覆盖');
        assert.equal(after.rows[0]!.encrypted_key, null);

        // 内网地址：整条模型配置跳过，但数据照常导入
        await db.execute(sql`delete from user_llm where user_id = ${userId}`);
        const blockedRes = await call('/api/import', {
          method: 'POST',
          body: await buildArchive(withLlm(llmFile({ baseUrl: 'http://127.0.0.1:11434/v1' }))),
        });
        const blockedOut = (await blockedRes.json()) as { llm: string; feeds: { inserted: number; skipped: number } };
        assert.equal(blockedRes.status, 200);
        assert.equal(blockedOut.llm, 'url-blocked');
        assert.deepEqual(blockedOut.feeds, { inserted: 0, skipped: 1 }, '这份包的频道上一轮已并入');
        const none = (await db.execute(
          sql`select 1 as one from user_llm where user_id = ${userId}`,
        )) as unknown as { rows: unknown[] };
        assert.equal(none.rows.length, 0, '被拦截的配置不应写库');

        // 没勾选导出的包：根本没有 llm.json
        const absentRes = await call('/api/import', { method: 'POST', body: await buildArchive(baseFiles) });
        assert.equal(absentRes.status, 200);
        assert.equal(((await absentRes.json()) as { llm: string }).llm, 'absent');
      } finally {
        if (prevEscape !== undefined) process.env.ALLOW_PRIVATE_HOSTS = prevEscape;
      }
    });

    await t.test('导入拒绝坏包，整站包不能走账号导入入口', async () => {
      const bad = await call('/api/import', { method: 'POST', body: Buffer.from('not a tar.gz') });
      assert.equal(bad.status, 400);
      assert.equal(((await bad.json()) as { error: string }).error, 'E_IMPORT_INVALID');

      const wrongKind = await call('/api/import', { method: 'POST', body: siteArchive });
      assert.equal(wrongKind.status, 400);
      assert.equal(((await wrongKind.json()) as { error: string }).error, 'E_ARCHIVE_IS_SITE_BACKUP');

      // 反过来：账号导出包传进整站还原，应指出该去「数据导入」，而不是笼统的坏包
      const wrongRestore = await call('/api/restore', { method: 'POST', body: userArchive });
      assert.equal(wrongRestore.status, 400);
      assert.equal(((await wrongRestore.json()) as { error: string }).error, 'E_ARCHIVE_IS_USER_EXPORT');
    });

    /* ---------------------------------------------------------------- 只读角色 */
    await t.test('只读：读接口照常，配置写接口一律 403', async () => {
      await db.execute(sql`update users set role = 'readonly' where id = ${userId}`);

      const s = parse(SessionSchema, await (await call('/api/session')).json(), 'GET /api/session');
      assert.equal(s.role, 'readonly');

      // 阅读类 GET 不受影响
      assert.equal((await call('/api/feeds')).status, 200);
      assert.equal((await call('/api/prefs')).status, 200);
      assert.equal((await call('/api/entries/flags')).status, 200);

      // 阅读体验偏好（外观 / 布局）仍可写
      assert.equal((await call('/api/prefs', { method: 'POST', json: { layout: { view: 'list' } } })).status, 200);

      // 配置写接口被服务端拒绝（不能只靠前端隐藏按钮）
      const denied: Array<[string, string, unknown]> = [
        ['POST', '/api/feeds', { url: 'https://example.com/feed.xml' }],
        ['POST', '/api/feeds/refresh', undefined],
        ['POST', '/api/feeds/reorder', { feeds: [] }],
        ['POST', '/api/feeds/import', { opml: '<opml></opml>' }],
        ['POST', '/api/watch/apply', undefined],
        ['POST', '/api/digest/generate', {}],
        ['POST', '/api/digest/test-llm', {}],
        ['POST', '/api/prefs', { filters: [] }],
        ['POST', '/api/prefs', { watchRules: [] }],
        ['POST', '/api/prefs', { digest: { auto: true } }],
        ['POST', '/api/account', { currentPassword: password, username }],
      ];
      for (const [method, path, json] of denied) {
        const res = await call(path, { method, json });
        assert.equal(res.status, 403, `${method} ${path} 应被 403，实际 ${res.status}`);
      }

      // 阅读动作（标已读 / 收藏）仍然允许：空数组明确表示「什么都不标」
      const readAll = await call('/api/entries/read-all', { method: 'POST', json: { feeds: [] } });
      assert.equal(readAll.status, 200);
      const patch = await call('/api/entries/999999', { method: 'PATCH', json: { isRead: true } });
      assert.equal(patch.status, 404, '鉴权应通过，只是条目不存在');
    });

    await t.test('只读：能导出自己的数据，但不能下整站备份', async () => {
      const own = await call('/api/export');
      assert.equal(own.status, 200);
      await own.arrayBuffer(); // 消费掉流，避免测试结束时还有挂起的归档任务
      assert.equal((await call('/api/backup')).status, 403);
    });

    /* ---------------------------------------------------------------- 登出 */
    await t.test('登出后会话失效（不是「返回 ok 但 Cookie 还有效」）', async () => {
      const out = await call('/api/logout', { method: 'POST' });
      assert.equal(out.status, 200);
      assert.equal(((await out.json()) as { ok: boolean }).ok, true);

      const s = parse(SessionSchema, await (await call('/api/session')).json(), 'GET /api/session');
      assert.equal(s.authenticated, false);
    });

    /* ---------------------------------------------------------------- 整站还原
     * 放在最后：它会清空并重建全库，之后的用例都不该再有登录态。 */
    await t.test('整站还原：替换数据、旧会话失效、账号可重新登录', async () => {
      // 只读用例把当前账号降过级，还原入口要求管理员
      await db.execute(sql`update users set role = 'admin' where id = ${userId}`);
      const before = await loginAs(username, password);
      await db.execute(sql`
        insert into feeds (owner_id, url, title)
        values (${userId}, 'https://example.com/only-before-restore.xml', '还原前临时源')
      `);

      jar = before;   // 登出用例已经清空了主 Cookie 罐
      const res = await call('/api/restore', { method: 'POST', body: siteArchive });
      assert.equal(res.status, 200, await res.clone().text());
      const out = (await res.json()) as {
        ok: boolean; kind: string; counts: { users: number; feeds: number; entries: number; images: number };
      };
      assert.equal(out.ok, true);
      assert.equal(out.kind, 'site');
      assert.ok(out.counts.users >= 1);
      assert.equal(out.counts.feeds, 1);
      assert.equal(out.counts.entries, 2, '备份包里只有两条文章');
      assert.equal(out.counts.images, 2, '默认图与 :w640 变体都应还原');

      const gone = (await db.execute(sql`
        select count(*)::int as n from feeds where url = 'https://example.com/only-before-restore.xml'
      `)) as unknown as { rows: Array<{ n: number }> };
      assert.equal(gone.rows[0]!.n, 0, '还原应清掉备份之后新增的数据');

      const oldSession = await app.request('/api/session', { headers: { cookie: before } });
      const s = parse(SessionSchema, await oldSession.json(), 'GET /api/session (before restore)');
      assert.equal(s.authenticated, false, '还原后旧会话必须失效');

      // 账号与密码哈希随备份恢复：能重新登录，频道也回来了
      const afterCookie = await loginAs(username, password);
      const feedsRes = await app.request('/api/feeds', { headers: { cookie: afterCookie } });
      assert.equal(feedsRes.status, 200);
      const list = (await feedsRes.json()) as { feeds: Array<{ url: string }> };
      assert.ok(list.feeds.some((f) => f.url === 'https://example.com/itest-feed.xml'));
    });
  } finally {
    /* 级联清库：users 下所有业务表都是 on delete cascade，删这一行就够。
     * 再按用户名前缀兜一层，防止中途 return 留下孤儿（比如注册成功但没走到取 id）。 */
    try {
      await db.execute(sql`delete from users where username like 'itest\_%' or username = ${username}`);
      // image_cache 没有 owner，不属于 users 级联范围：跑失败时也要清掉测试键
      await db.execute(sql`delete from image_cache where key like 'itestimg%'`);
    } catch (e) {
      console.error('[itest] cleanup failed (test verdict is unaffected, but check the test database manually):', (e as Error).message);
    }
  }
});
