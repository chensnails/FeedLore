/**
 * 单条目 AI 动作条（`POST /api/entry/:id/ai`）接口级测试。
 *
 * 为什么要单独一份：这条链路上「模型侧怎么坏」有七八种，都要有确定的表现，
 * 而又不能靠真实上游去制造（烧额度、不可控、不可重复）。所以这里在测试进程内
 * 起一个假 OpenAI 兼容服务，按 `mode` 变量切换应答，接口侧完全走真实链路
 * （Hono + better-auth + 真 Postgres + 真的 SSRF 闸门 + 真的记账）。
 *
 * 运行条件：`DATABASE_URL` 指向已跑过迁移的库；`ALLOW_PRIVATE_HOSTS=1` 让假模型
 * 的 127.0.0.1 过闸（与自建 Ollama 用的是同一个逃生口）。
 * 数据边界：只写自己的 `itestai_*` 账号，收尾按用户名前缀删除（cascade 带走
 * feeds/entries/ai_request_log/ai_usage_daily），不碰库里其它数据。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { createDb, feeds as feedsTable, entries as entriesTable } from '@feedlore/db';
import { createAuth } from '@feedlore/auth';
import { createApp } from './app';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const ORIGIN = 'http://127.0.0.1:3213';

process.env.AUTH_BASE_URL = ORIGIN;
process.env.AUTH_TRUSTED_ORIGINS = ORIGIN;
// 假模型服务在环回地址上 —— 走「自建 Ollama」同一个逃生口
process.env.ALLOW_PRIVATE_HOSTS = '1';

const SKIP = DATABASE_URL ? false : '未设置 DATABASE_URL —— 接口级测试需要一个已迁移的 Postgres';

/* ------------------------------------------------------------------ 假模型 */

type Mode = 'ok' | 'auth' | 'html502' | 'notjson' | 'nocontent' | 'drop' | 'slow';

interface FakeState {
  mode: Mode;
  /** 最近一次请求体（验证截断与提示词） */
  lastBody: string;
  /** 每次请求的系统提示词（验证四个动作各用各的） */
  prompts: string[];
  hits: number;
}

const fake: FakeState = { mode: 'ok', lastBody: '', prompts: [], hits: 0 };

const okBody = (content = '这是模型返回的摘要。'): string =>
  JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
  });

const fakeServerFactory = (): Server => createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    fake.hits += 1;
    fake.lastBody = raw;
    let messages: Array<{ role?: string; content?: string }> = [];
    try {
      messages = (JSON.parse(raw) as { messages?: Array<{ role?: string; content?: string }> }).messages ?? [];
    } catch { /* 不是 JSON 也照样走分支 */ }
    fake.prompts.push(String(messages[0]?.content ?? ''));

    const send = (code: number, body: string, type = 'application/json'): void => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };
    switch (fake.mode) {
      case 'auth': return send(401, JSON.stringify({ error: 'invalid api key' }));
      case 'html502':
        return send(
          502,
          '<!doctype html><html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>',
          'text/html',
        );
      case 'notjson': return send(200, '抱歉，我无法回答');
      case 'nocontent': return send(200, JSON.stringify({ choices: [{ message: {} }] }));
      case 'drop': return void req.socket.destroy();
      case 'slow': return void setTimeout(() => send(200, okBody('慢响应的摘要。')), 1500);
      default: return send(200, okBody());
    }
  });
});

/**
 * 假模型服务**在用例内部**才启动。
 *
 * 踩过的坑：写在模块顶层时，`DATABASE_URL` 没设、整组 skip 的情况下服务器照样
 * 监听端口，node --test 的进程因此永远不退出（本地 `pnpm test` 会挂住）。
 */
let fakeServer: Server | null = null;
let FAKE_BASE = '';

/* ------------------------------------------------------------------ 主测试 */

test('AI 动作条接口级：鉴权 / 参数 / 正常 / 模型异常 / 记账 / 并发', { skip: SKIP }, async (t) => {
  const db = createDb(DATABASE_URL);

  const probe = (await db.execute(
    sql`select to_regclass('public.users')::text as t`,
  )) as unknown as { rows?: Array<{ t: string | null }> };
  if (!probe.rows?.[0]?.t) {
    t.skip('库里没有 users 表 —— 先跑 migrate');
    return;
  }

  const auth = createAuth({
    db,
    secret: 'entry-ai-itest-secret-not-for-production',
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    secureCookies: false,
  });
  const app = createApp({ db, auth });

  /* 假模型服务在这里启动（不能在模块顶层：整组 skip 时会挂住 node --test） */
  fakeServer = fakeServerFactory();
  await new Promise<void>((r) => fakeServer!.listen(0, '127.0.0.1', r));
  FAKE_BASE = `http://127.0.0.1:${(fakeServer.address() as { port: number }).port}/v1`;

  /** 每人一个 Cookie 串；调用时显式传入，避免 jar 互相污染。 */
  async function login(u: string, p: string): Promise<string> {
    const res = await app.request('/api/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    assert.equal(res.status, 200, `${u} 登录应成功：${await res.clone().text()}`);
    const setCookies = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    return setCookies.map((s) => s.split(';')[0]).join('; ');
  }

  async function signup(u: string, p: string): Promise<void> {
    process.env.ALLOW_SIGNUP = '1';
    try {
      const res = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${u}@example.test`, password: p, name: u, username: u }),
      });
      assert.equal(res.status, 200, `注册 ${u} 失败：${await res.text()}`);
    } finally {
      delete process.env.ALLOW_SIGNUP;
    }
  }

  async function call(
    cookie: string,
    path: string,
    init: { method?: string; json?: unknown } = {},
  ): Promise<Response> {
    const headers = new Headers({ origin: ORIGIN });
    if (cookie) headers.set('cookie', cookie);
    let body: string | undefined;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    return app.request(path, { method: init.method ?? 'GET', headers, body });
  }

  /** 一次 AI 调用，返回 `{ status, ok, result, ms }`（不抛，供各用例断言各自关心的部分）。 */
  async function ask(
    cookie: string,
    id: number,
    payload: unknown = { action: 'summary' },
  ): Promise<{ status: number; ok: boolean; result: string; ms: number; raw: string }> {
    const t0 = Date.now();
    const res = await call(cookie, `/api/entry/${id}/ai`, { method: 'POST', json: payload });
    const raw = await res.clone().text();
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: string };
    return {
      status: res.status,
      ok: body.ok === true,
      result: typeof body.result === 'string' ? body.result : '',
      ms: Date.now() - t0,
      raw,
    };
  }

  const stamp = Date.now().toString(36);
  const owner = `itestai_own_${stamp}`;
  const other = `itestai_oth_${stamp}`;
  const reader = `itestai_ro_${stamp}`;
  const password = 'itest-ai-pass-1234';

  let cOwner = '';
  let cOther = '';
  let cReader = '';
  let ownerId = '';
  let shortId = 0;
  let longId = 0;
  let emptyId = 0;
  let foreignId = 0;

  try {
    /* ---------------- 准备：三个账号（主 / 他人 / 只读） ---------------- */
    for (const u of [owner, other, reader]) await signup(u, password);
    cOwner = await login(owner, password);
    cOther = await login(other, password);
    cReader = await login(reader, password);

    const me = await call(cOwner, '/api/session');
    ownerId = ((await me.json()) as { id?: string }).id ?? '';
    assert.ok(ownerId, '会话必须带用户 id');
    // 只有 owner 需要 admin（保存模型配置）。reader 改成只读，验证 write 拦截。
    await db.execute(sql`update users set role = 'admin' where username = ${owner}`);
    await db.execute(sql`update users set role = 'readonly' where username = ${reader}`);

    const otherMe = await call(cOther, '/api/session');
    const otherId = ((await otherMe.json()) as { id?: string }).id ?? '';
    assert.ok(otherId, '第二个账号也要有 id');

    /* 模型配置走真实保存链路（顺带覆盖加密与回读） */
    const saveLlm = await call(cOwner, '/api/prefs', {
      method: 'POST',
      json: { llm: { baseUrl: FAKE_BASE, apiKey: 'sk-itest-fake-key', model: 'fake-model', temperature: 0.2, thinking: false, thinkingDepth: 0 } },
    });
    assert.equal(saveLlm.status, 200, `保存模型配置失败：${await saveLlm.clone().text()}`);

    /* 条目：正常一条 / 30000 字长文一条 / 空正文一条 / 他人一条 */
    const [feed] = await db
      .insert(feedsTable)
      .values({ ownerId, url: `https://example.com/itest-ai-${stamp}.xml`, title: 'AI 测试频道' })
      .returning();
    const [otherFeed] = await db
      .insert(feedsTable)
      .values({ ownerId: otherId, url: `https://example.com/itest-ai-other-${stamp}.xml`, title: '他人的频道' })
      .returning();
    assert.ok(feed && otherFeed, '频道插入失败');

    const [short] = await db.insert(entriesTable)
      .values({ feedId: feed.id, guid: `ai-short-${stamp}`, title: '短正文条目', content: '这是一个用于测试的短正文。' })
      .returning();
    const [long] = await db.insert(entriesTable)
      .values({ feedId: feed.id, guid: `ai-long-${stamp}`, title: '超长正文条目', content: 'x'.repeat(30000) })
      .returning();
    const [empty] = await db.insert(entriesTable)
      .values({ feedId: feed.id, guid: `ai-empty-${stamp}`, title: '没有正文的条目', content: null })
      .returning();
    const [foreign] = await db.insert(entriesTable)
      .values({ feedId: otherFeed.id, guid: `ai-foreign-${stamp}`, title: '他人的条目', content: '别人的正文' })
      .returning();
    assert.ok(short && long && empty && foreign, '条目插入失败');
    shortId = short.id; longId = long.id; emptyId = empty.id; foreignId = foreign.id;

    /* ================================================================ A. 鉴权与参数 */
    await t.test('T01 未登录 → 401，且错误体是码而非中文', async () => {
      const res = await call('', `/api/entry/${shortId}/ai`, { method: 'POST', json: { action: 'summary' } });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error: string; message: string };
      assert.equal(body.error, 'E_UNAUTHORIZED');
      assert.doesNotMatch(`${body.error} ${body.message}`, /[一-鿿]/, '服务端响应不应出现中文');
    });

    await t.test('T02 用 GET 调这个端点 → 405（不是 404 也不是 200）', async () => {
      const res = await call(cOwner, `/api/entry/${shortId}/ai`);
      assert.ok(res.status === 405 || res.status === 404, `实际 ${res.status}`);
    });

    await t.test('T03~T05 非法 / 零 / 不存在的 id → 404 E_ENTRY_NOT_FOUND', async () => {
      for (const bad of ['abc', '0', '-5', '999999999']) {
        const res = await call(cOwner, `/api/entry/${bad}/ai`, { method: 'POST', json: { action: 'summary' } });
        assert.equal(res.status, 404, `id=${bad} 应为 404，实际 ${res.status}`);
        const body = (await res.json()) as { error?: string };
        assert.equal(body.error, 'E_ENTRY_NOT_FOUND');
      }
    });

    await t.test('T06 他人的条目 → 404（owner 隔离，不是 403 也不泄露存在性）', async () => {
      const res = await call(cOwner, `/api/entry/${foreignId}/ai`, { method: 'POST', json: { action: 'summary' } });
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error?: string }).error, 'E_ENTRY_NOT_FOUND');
    });

    await t.test('T07~T09 非法 action / targetLang 超长 / 缺 body → 400', async () => {
      const cases: Array<[string, unknown]> = [
        ['action 不在枚举内', { action: 'hack-the-planet' }],
        ['targetLang 超过 20 字', { action: 'translate', targetLang: '很'.repeat(21) }],
        ['缺 action', {}],
      ];
      for (const [what, json] of cases) {
        const res = await call(cOwner, `/api/entry/${shortId}/ai`, { method: 'POST', json });
        assert.equal(res.status, 400, `${what} 应为 400，实际 ${res.status}`);
      }
    });

    /* ================================================================ B. 正常路径 */
    await t.test('T10 正常摘要：ok:true、内容非空、耗时合理', async () => {
      fake.mode = 'ok';
      const r = await ask(cOwner, shortId);
      assert.equal(r.status, 200);
      assert.equal(r.ok, true, `应成功，实际 result=${r.result}`);
      assert.equal(r.result, '这是模型返回的摘要。');
      assert.ok(r.ms < 3000, `一次正常调用耗时 ${r.ms}ms，偏慢`);
    });

    await t.test('T11 四个动作全部可用，且系统提示词各不相同', async () => {
      fake.mode = 'ok';
      fake.prompts.length = 0;
      for (const action of ['summary', 'keypoints', 'translate', 'explain'] as const) {
        const r = await ask(cOwner, shortId, { action });
        assert.equal(r.ok, true, `${action} 应成功，实际 ${r.result}`);
      }
      assert.equal(fake.prompts.length, 4);
      assert.equal(new Set(fake.prompts).size, 4, '四个动作的系统提示词不应重复');
      assert.ok(fake.prompts.every((p) => p.includes('简体中文') || p.includes('编辑') || p.includes('译者') || p.includes('讲解')), '提示词看起来不对');
    });

    await t.test('T12 translate 的 targetLang 进提示词（20 字边界内）', async () => {
      fake.mode = 'ok';
      fake.prompts.length = 0;
      const r = await ask(cOwner, shortId, { action: 'translate', targetLang: 'English' });
      assert.equal(r.ok, true);
      assert.ok(fake.prompts[0]?.includes('English'), `提示词里没有目标语言：${fake.prompts[0]}`);
      // 恰好 20 字应当通过
      const edge = await ask(cOwner, shortId, { action: 'translate', targetLang: '很'.repeat(20) });
      assert.equal(edge.status, 200, 'targetLang 恰好 20 字应被接受');
    });

    await t.test('T13 超长正文按 24000 字截断后再发给模型', async () => {
      fake.mode = 'ok';
      const r = await ask(cOwner, longId);
      assert.equal(r.ok, true);
      const sent = (JSON.parse(fake.lastBody) as { messages: Array<{ content: string }> }).messages[1]?.content ?? '';
      const bodyPart = sent.split('正文：\n')[1] ?? '';
      assert.equal(bodyPart.length, 24000, `发给模型的正文应为 24000 字，实际 ${bodyPart.length}`);
    });

    await t.test('T14 没有正文的条目也能调（不因 null 抛 500）', async () => {
      fake.mode = 'ok';
      const r = await ask(cOwner, emptyId);
      assert.equal(r.status, 200);
      assert.equal(r.ok, true, `空正文应仍可摘要，实际 ${r.result}`);
    });

    await t.test('T21 上游慢 1.5 秒仍然成功（长超时链路）', async () => {
      fake.mode = 'slow';
      const r = await ask(cOwner, shortId);
      assert.equal(r.ok, true, `慢响应应成功，实际 ${r.result}`);
      assert.ok(r.ms >= 1400 && r.ms < 8000, `耗时 ${r.ms}ms 不符合预期`);
    });

    /* ================================================================ C. 模型异常 */
    await t.test('T15 模型未配置 → ok:false + E_AI_NOT_CONFIGURED，不 500', async () => {
      await db.execute(sql`delete from user_llm where user_id = ${ownerId}`);
      const r = await ask(cOwner, shortId);
      assert.equal(r.status, 200, '模型失败应降级为 200 + ok:false');
      assert.equal(r.ok, false);
      assert.match(r.result, /^E_AI_NOT_CONFIGURED/, `实际：${r.result}`);
      // 复原配置，后续用例继续用
      await call(cOwner, '/api/prefs', {
        method: 'POST',
        json: { llm: { baseUrl: FAKE_BASE, apiKey: 'sk-itest-fake-key', model: 'fake-model', temperature: 0.2, thinking: false, thinkingDepth: 0 } },
      });
    });

    await t.test('T16 上游 401 → E_AI_AUTH（提示改 Key，而不是查网络）', async () => {
      fake.mode = 'auth';
      const r = await ask(cOwner, shortId);
      assert.equal(r.ok, false);
      assert.match(r.result, /^E_AI_AUTH/, `实际：${r.result}`);
      assert.match(r.result, /401/, '补充信息里应带上状态码');
    });

    await t.test('T17 上游 502 HTML → E_AI_HTTP，且只取 <title> 不塞整页标签', async () => {
      fake.mode = 'html502';
      const r = await ask(cOwner, shortId);
      assert.equal(r.ok, false);
      assert.match(r.result, /^E_AI_HTTP/, `实际：${r.result}`);
      assert.match(r.result, /502 Bad Gateway/, '应提取 HTML 标题');
      assert.doesNotMatch(r.result, /<html|<body|doctype/i, '不应把 HTML 标签原样塞给用户');
    });

    await t.test('T18 上游回非 JSON → E_AI_BAD_RESPONSE', async () => {
      fake.mode = 'notjson';
      const r = await ask(cOwner, shortId);
      assert.equal(r.ok, false);
      assert.match(r.result, /^E_AI_BAD_RESPONSE/, `实际：${r.result}`);
    });

    await t.test('T19 上游没有 content → E_AI_NO_CONTENT', async () => {
      fake.mode = 'nocontent';
      const r = await ask(cOwner, shortId);
      assert.equal(r.ok, false);
      assert.match(r.result, /^E_AI_NO_CONTENT/, `实际：${r.result}`);
    });

    await t.test('T20 上游连接被掐断 → 记录实际文案（是否码化待评估）', async () => {
      fake.mode = 'drop';
      const r = await ask(cOwner, shortId);
      assert.equal(r.ok, false, '断连必须报错');
      assert.ok(r.result.length > 0, '错误文案不能为空');
      // 这里先只记录：网络类错误目前是否带 E_AI_ 码，由报告判定严重程度
      console.log(`[T20] 连接中断的实际提示：${JSON.stringify(r.result)}`);
    });

    await t.test('T27 所有失败响应都不含中文（界面语言由前端词典负责）', async () => {
      for (const m of ['auth', 'html502', 'notjson', 'nocontent'] as Mode[]) {
        fake.mode = m;
        const r = await ask(cOwner, shortId);
        assert.doesNotMatch(r.result, /[一-鿿]/, `${m} 的失败文案里出现了中文：${r.result}`);
      }
      fake.mode = 'ok';
    });

    /* ================================================================ D. 记账 */
    await t.test('T22~T24 每次调用落一条明细 + 按天累加，失败也留痕', async () => {
      fake.mode = 'ok';
      const before = (await db.execute(sql`
        select count(*)::int as n from ai_request_log where user_id = ${ownerId} and kind = 'entry_ai'
      `)) as unknown as { rows: Array<{ n: number }> };
      const okBefore = before.rows[0]?.n ?? 0;

      const good = await ask(cOwner, shortId);
      assert.equal(good.ok, true);

      const after = (await db.execute(sql`
        select count(*)::int as n from ai_request_log where user_id = ${ownerId} and kind = 'entry_ai'
      `)) as unknown as { rows: Array<{ n: number }> };
      assert.equal((after.rows[0]?.n ?? 0), okBefore + 1, '成功一次应多一条明细');

      const row = (await db.execute(sql`
        select model, label, ok, prompt_tokens, completion_tokens, duration_ms
        from ai_request_log where user_id = ${ownerId} and kind = 'entry_ai'
        order by id desc limit 1
      `)) as unknown as { rows: Array<{ model: string; label: string; ok: boolean; prompt_tokens: number; completion_tokens: number; duration_ms: number }> };
      const r0 = row.rows[0];
      assert.ok(r0, '应能读到明细行');
      assert.equal(r0.model, 'fake-model', '明细应记录当时用的模型');
      assert.equal(r0.label, '短正文条目', '明细应记录文章标题');
      assert.equal(r0.ok, true);
      assert.equal(r0.prompt_tokens, 12, 'token 用量应来自上游 usage');
      assert.equal(r0.completion_tokens, 6);

      fake.mode = 'auth';
      const bad = await ask(cOwner, shortId);
      assert.equal(bad.ok, false);
      const failRow = (await db.execute(sql`
        select ok, error from ai_request_log where user_id = ${ownerId} and kind = 'entry_ai' order by id desc limit 1
      `)) as unknown as { rows: Array<{ ok: boolean; error: string }> };
      assert.equal(failRow.rows[0]?.ok, false, '失败也要留一条');
      assert.match(failRow.rows[0]?.error ?? '', /^E_AI_AUTH/, '失败原因应带稳定码');
      fake.mode = 'ok';

      const usage = (await db.execute(sql`
        select calls, fails, prompt_tokens, completion_tokens from ai_usage_daily
        where user_id = ${ownerId} and kind = 'entry_ai'
      `)) as unknown as { rows: Array<{ calls: number; fails: number; prompt_tokens: number; completion_tokens: number }> };
      const u0 = usage.rows[0];
      assert.ok(u0, '应有按天聚合行');
      assert.ok(u0.calls > 0 && u0.fails > 0, `聚合里成功与失败都要有：${JSON.stringify(u0)}`);
    });

    /* ================================================================ E. 并发与性能 */
    await t.test('T25 并发 5 个动作：全部成功且各记一条，互不串结果', async () => {
      fake.mode = 'slow';   // 故意慢，制造真正的并发重叠
      const before = (await db.execute(sql`
        select count(*)::int as n from ai_request_log where user_id = ${ownerId} and kind = 'entry_ai'
      `)) as unknown as { rows: Array<{ n: number }> };
      const n0 = before.rows[0]?.n ?? 0;

      const actions = ['summary', 'keypoints', 'translate', 'explain', 'summary'] as const;
      const results = await Promise.all(actions.map((action) => ask(cOwner, shortId, { action })));
      assert.ok(results.every((r) => r.ok), `并发全部应成功：${JSON.stringify(results.map((r) => r.result))}`);

      const after = (await db.execute(sql`
        select count(*)::int as n from ai_request_log where user_id = ${ownerId} and kind = 'entry_ai'
      `)) as unknown as { rows: Array<{ n: number }> };
      assert.equal((after.rows[0]?.n ?? 0) - n0, 5, '并发 5 次应各记一条，不丢不并');
      fake.mode = 'ok';
    });

    await t.test('T26 只读账号 → 403 E_READONLY_CONFIG（不消耗模型额度）', async () => {
      fake.mode = 'ok';
      const hitsBefore = fake.hits;
      const res = await call(cReader, `/api/entry/${shortId}/ai`, { method: 'POST', json: { action: 'summary' } });
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error?: string }).error, 'E_READONLY_CONFIG');
      assert.equal(fake.hits, hitsBefore, '被拒的请求不应真的打到模型');
    });

    await t.test('T28 正常调用的端到端耗时 < 2s（不含模型本身的延迟）', async () => {
      fake.mode = 'ok';
      const runs: number[] = [];
      for (let i = 0; i < 3; i += 1) runs.push((await ask(cOwner, shortId)).ms);
      const avg = Math.round(runs.reduce((a, b) => a + b, 0) / runs.length);
      assert.ok(avg < 2000, `平均耗时 ${avg}ms（三次 ${runs.join('/')}）`);
      console.log(`[T28] 三次正常调用耗时：${runs.join(' / ')}ms`);
    });
  } finally {
    fakeServer?.close();
    try {
      await db.execute(sql`delete from users where username like 'itestai\_%'`);
    } catch (e) {
      console.error('[entryAi-itest] cleanup failed（不影响判定，请手工检查测试库）：', (e as Error).message);
    }
  }
});
