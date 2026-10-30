/**
 * AI 日报路由（契约：contract.ai.*）
 *
 * 四个端点，边界刻意划得很窄：
 * - `test-llm`：**失败也返回 200**（`{ok:false,error}`）。这是给用户看的诊断，
 *   用 4xx/5xx 表达会让前端只能弹一个「请求失败」，把人引去查网络而不是改 Key。
 * - `digests` / `digest`：只读自己那份（`owner_id` 进 WHERE），没有跨账号路径。
 * - `generate`：真正的昂贵操作。三道前置检查缺一不可，否则就是「绕过开关烧额度」：
 *   ① 账号自己关了日报入口（`layout.digestEnabled === false`）→ 400；
 *   ② 日期必须是真实日期（`2026-13-99` 会一路走到 PG 才报错）；
 *   ③ 模型地址必须先过 `assertPublicHost`（SSRF：把地址填成本站内部接口，
 *      服务器就会带着 Key POST 过去并把响应当日报存下来）。
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { feeds, userLlm, users, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import { ai as aiSpec, type LlmConfig } from '@feedlore/contract';
import {
  getCryptoSecret,
  generateDigest,
  listDigestDates,
  readDigest,
  resolveUserLlm,
  shanghaiDate,
  testLlm,
  type ResolvedLlm,
} from '@feedlore/ai';
import { assertResponse, BadRequest } from '../lib/validate';
import { assertPublicHost, safeFetch } from '../lib/net';
import { userDigest, userLayout } from '../lib/prefs';
import { resolveDigestScope } from '../lib/digest';
import { requireAuth, type AppEnv } from '../middleware/auth';

/** 真实日期判定：格式对不代表日期存在（`2026-02-30` 也是「格式合法」）。 */
function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 读该账号的模型配置行。 */
async function loadLlmRow(db: Db, uid: string) {
  const [row] = await db
    .select({
      encryptedKey: userLlm.encryptedKey,
      baseUrl: userLlm.baseUrl,
      model: userLlm.model,
      temperature: userLlm.temperature,
      thinking: userLlm.thinking,
      thinkingDepth: userLlm.thinkingDepth,
    })
    .from(userLlm)
    .where(eq(userLlm.userId, uid))
    .limit(1);
  return row;
}

export function aiRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- POST /api/digest/test-llm ---------------- */
    .post(
      aiSpec.testLlm.path,
      requireAuth(auth, 'user'),
      zValidator('json', aiSpec.testLlm.body, (r) => {
        if (!r.success) throw new BadRequest('POST /api/digest/test-llm', r.error.issues);
      }),
      async (c) => {
        if (!db) return c.json({ ok: false, error: '数据库未就绪' });
        const uid = c.get('user').id;
        const body = c.req.valid('json') as { llm?: Partial<LlmConfig> };

        const secret = await getCryptoSecret(db);
        const base = resolveUserLlm(await loadLlmRow(db, uid), secret);
        // 前端可临时覆盖（刚填完还没保存就该能试），留空沿用已保存的
        const llm: ResolvedLlm = { ...base };
        if (body.llm?.baseUrl?.trim()) llm.baseUrl = body.llm.baseUrl.trim().replace(/\/+$/, '');
        if (body.llm?.model?.trim()) llm.model = body.llm.model.trim();
        if (body.llm?.apiKey?.trim()) llm.apiKey = body.llm.apiKey.trim();
        if (typeof body.llm?.thinking === 'boolean') llm.thinking = body.llm.thinking;

        if (!llm.baseUrl || !llm.apiKey || !llm.model) {
          return c.json({ ok: false, error: '模型未配置完整：地址、API Key、模型名都要在本账号填写后才能测试' });
        }

        /* 「测试连接」曾是这个项目最直接的 SSRF 证据：把地址填成本站的 /api/session，
         * 服务器就会自己 POST 过去并把响应带回来。先过出网校验。 */
        try {
          await assertPublicHost(llm.baseUrl);
        } catch (e) {
          return c.json({ ok: false, error: '模型地址不可用：' + ((e as Error)?.message ?? String(e)) });
        }

        const payload = assertResponse(
          aiSpec.testLlm.response,
          await testLlm(llm, safeFetch),
          'POST /api/digest/test-llm',
        );
        return c.json(payload);
      },
    )

    /* ---------------- GET /api/digests ---------------- */
    .get(aiSpec.dates.path, requireAuth(auth, 'user'), async (c) => {
      if (!db) return c.json({ dates: [] });
      const dates = await listDigestDates(db, c.get('user').id);
      return c.json(assertResponse(aiSpec.dates.response, { dates }, 'GET /api/digests'));
    })

    /* ---------------- GET /api/digest ---------------- */
    .get(aiSpec.get.path, requireAuth(auth, 'user'), async (c) => {
      const raw = c.req.query('date') ?? '';
      const date = raw || shanghaiDate();
      if (!isRealDate(date)) throw new HTTPException(400, { message: '日期不合法，应为 YYYY-MM-DD 的真实日期' });
      if (!db) return c.json({ date, digest: null });

      const digest = await readDigest(db, c.get('user').id, date);
      return c.json(assertResponse(aiSpec.get.response, { date, digest }, 'GET /api/digest'));
    })

    /* ---------------- POST /api/digest/generate ---------------- */
    .post(
      aiSpec.generate.path,
      requireAuth(auth, 'user'),
      zValidator('json', aiSpec.generate.body, (r) => {
        if (!r.success) throw new BadRequest('POST /api/digest/generate', r.error.issues);
      }),
      async (c) => {
        if (!db) return c.json({ error: '数据库未就绪' }, 503);
        const uid = c.get('user').id;
        const body = c.req.valid('json');

        const [userRow] = await db.select({ prefs: users.prefs }).from(users).where(eq(users.id, uid)).limit(1);
        if (!userRow) return c.json({ error: '用户不存在' }, 401);

        // 账号自己关掉了日报：手动生成也一并挡掉，别留一条绕过开关烧额度的路
        if (userLayout(userRow.prefs).digestEnabled === false) {
          throw new HTTPException(400, { message: '日报已在本账号关闭。要在「设置 · 日报」里重新开启才能生成。' });
        }

        const date = (body.date ?? '').trim() || shanghaiDate();
        if (!isRealDate(date)) throw new HTTPException(400, { message: '日期不合法，应为 YYYY-MM-DD 的真实日期' });

        const cfg = userDigest(userRow.prefs);
        const secret = await getCryptoSecret(db);
        const llm = resolveUserLlm(await loadLlmRow(db, uid), secret);

        // 地址不可用就别往下跑：等 180 秒超时再把日报降级，体验比直接报错差得多
        if (llm.baseUrl) {
          try {
            await assertPublicHost(llm.baseUrl);
          } catch (e) {
            throw new HTTPException(400, { message: '模型地址不可用：' + ((e as Error)?.message ?? String(e)) });
          }
        }

        const scope = await resolveDigestScope(db, uid, body.feeds ?? null, cfg);

        const result = await generateDigest({
          db,
          ownerId: uid,
          feedIds: scope,
          date,
          force: body.force === true,
          llm,
          style: cfg.style,
          limits: { maxPerFeed: cfg.maxPerFeed, maxTotal: cfg.maxTotal, keepDays: cfg.keepDays },
          fetchImpl: safeFetch,
        });

        // 自动生成跑过这一轮就记下「今天已处理」，避免同一分钟内被 tick 重复触发
        return c.json(
          assertResponse(
            aiSpec.generate.response,
            { ok: true, cached: result.cached, digest: result.digest },
            'POST /api/digest/generate',
          ),
        );
      },
    );
}
