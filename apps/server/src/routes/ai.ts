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
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql } from 'drizzle-orm';
import { entries as entriesTable, entryAiTags, feeds, users, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import { ai as aiSpec, type EntryAiBody, type LlmConfig } from '@feedlore/contract';
import {
  chat,
  type ChatMessage,
  getCryptoSecret,
  generateDigest,
  listDigestDates,
  readDigest,
  resolveUserLlm,
  shanghaiDate,
  suggestEntryTags,
  AI_TAG_PROMPT_VERSION,
  testLlm,
  type ResolvedLlm,
} from '@feedlore/ai';
import { loadLlmRow } from '../lib/llm';
import { assertResponse, BadRequest } from '../lib/validate';
import { apiError, ApiException, apiErrorBody, apiErrorKey } from '../lib/apiError';
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

/** 单条目 AI 喂给模型的正文上限：与 MCP 工具保持一致（24000 字符）。 */
const ENTRY_AI_MAX_CHARS = 24_000;
function truncateForAi(text: string): { content: string; truncated: boolean } {
  if (text.length <= ENTRY_AI_MAX_CHARS) return { content: text, truncated: false };
  return { content: text.slice(0, ENTRY_AI_MAX_CHARS), truncated: true };
}

/**
 * 按动作构造系统提示词。用户自定义只在此范围内生效（不接收外部 prompt 注入），
 * 保证输出是「对本人订阅内容的安全摘要」，不会把任意指令透传给模型。
 */
function entryAiSystemPrompt(action: EntryAiBody['action'], targetLang: string): string {
  const lang = targetLang || '简体中文';
  switch (action) {
    case 'summary':
      return '你是一个严谨的中文编辑。请为下面的文章生成一段摘要，3-5 句，抓住核心事实与结论。只输出摘要本身，不要加「摘要：」等前缀。';
    case 'keypoints':
      return '你是一个严谨的中文编辑。请提炼下面文章的关键要点，用 3-6 条无序列表（每条一行，以「- 」开头）呈现，每条一句话。只输出列表。';
    case 'translate':
      return `你是一个专业译者。请将下面文章全文翻译成${lang}，保留原有段落结构；正文里的专有名词可保留原文并在括号里给译文。只输出译文，不要加「译文：」等前缀。`;
    case 'explain':
      return `你是一个善于科普的讲解者。请用通俗易懂的语言向非专业读者解释下面这篇文章在讲什么、为什么重要，使用${lang}，3-5 句。只输出解释本身。`;
  }
}

export function aiRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- POST /api/digest/test-llm ---------------- */
    .post(
      aiSpec.testLlm.path,
      requireAuth(auth, 'write'),
      zValidator('json', aiSpec.testLlm.body, (r) => {
        if (!r.success) throw new BadRequest('POST /api/digest/test-llm', r.error.issues);
      }),
      async (c) => {
        if (!db) return c.json({ ok: false, error: apiErrorBody('E_DB_NOT_READY').error });
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
          return c.json({ ok: false, error: apiErrorBody('E_MODEL_INCOMPLETE').error });
        }

        /* 「测试连接」曾是这个项目最直接的 SSRF 证据：把地址填成本站的 /api/session，
         * 服务器就会自己 POST 过去并把响应带回来。先过出网校验。 */
        try {
          await assertPublicHost(llm.baseUrl);
        } catch (e) {
          return c.json({
            ok: false,
            error: apiErrorKey(
              new ApiException('E_MODEL_URL_UNREACHABLE', { detail: (e as Error)?.message ?? String(e) }),
            ),
          });
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
      if (!isRealDate(date)) throw new ApiException('E_DATE_INVALID');
      if (!db) return c.json({ date, digest: null });

      const digest = await readDigest(db, c.get('user').id, date);
      return c.json(assertResponse(aiSpec.get.response, { date, digest }, 'GET /api/digest'));
    })

    /* ---------------- POST /api/digest/generate ---------------- */
    .post(
      aiSpec.generate.path,
      requireAuth(auth, 'write'),
      zValidator('json', aiSpec.generate.body, (r) => {
        if (!r.success) throw new BadRequest('POST /api/digest/generate', r.error.issues);
      }),
      async (c) => {
        if (!db) return apiError(c, 'E_DB_NOT_READY');
        const uid = c.get('user').id;
        const body = c.req.valid('json');

        const [userRow] = await db.select({ prefs: users.prefs }).from(users).where(eq(users.id, uid)).limit(1);
        if (!userRow) return apiError(c, 'E_USER_NOT_FOUND', { status: 401 });

        // 账号自己关掉了日报：手动生成也一并挡掉，别留一条绕过开关烧额度的路
        if (userLayout(userRow.prefs).digestEnabled === false) {
          throw new ApiException('E_DIGEST_DISABLED');
        }

        const date = (body.date ?? '').trim() || shanghaiDate();
        if (!isRealDate(date)) throw new ApiException('E_DATE_INVALID');

        const cfg = userDigest(userRow.prefs);
        const secret = await getCryptoSecret(db);
        const llm = resolveUserLlm(await loadLlmRow(db, uid), secret);

        // 地址不可用就别往下跑：等 180 秒超时再把日报降级，体验比直接报错差得多
        if (llm.baseUrl) {
          try {
            await assertPublicHost(llm.baseUrl);
          } catch (e) {
            throw new ApiException('E_MODEL_URL_UNREACHABLE', { detail: (e as Error)?.message ?? String(e) });
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
    )

    /* ---------------- POST /api/entry/:id/ai ---------------- */
    .post(
      aiSpec.entryAi.path,
      requireAuth(auth, 'write'),
      zValidator('json', aiSpec.entryAi.body, (r) => {
        if (!r.success) throw new BadRequest('POST /api/entry/:id/ai', r.error.issues);
      }),
      async (c) => {
        if (!db) return apiError(c, 'E_DB_NOT_READY');
        const uid = c.get('user').id;

        // 路径上的 id 是字符串，LLM/客户端可能传数字字符串；非正整数一律当「找不到」
        const idNum = Number(c.req.param('id'));
        if (!Number.isInteger(idNum) || idNum <= 0) throw new ApiException('E_ENTRY_NOT_FOUND');

        // owner 隔离：经 feeds join，id 猜对了也读不到别人的条目
        const [entry] = await db
          .select({ content: entriesTable.content, title: entriesTable.title })
          .from(entriesTable)
          .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
          .where(and(eq(entriesTable.id, idNum), eq(feeds.ownerId, uid)))
          .limit(1);
        if (!entry) throw new ApiException('E_ENTRY_NOT_FOUND');

        const secret = await getCryptoSecret(db);
        const llm = resolveUserLlm(await loadLlmRow(db, uid), secret);
        // 地址不可用先拦下，别等 180 秒超时（与日报生成一致）
        if (llm.baseUrl) {
          try {
            await assertPublicHost(llm.baseUrl);
          } catch (e) {
            throw new ApiException('E_MODEL_URL_UNREACHABLE', { detail: (e as Error)?.message ?? String(e) });
          }
        }

        const body = c.req.valid('json');
        const cut = truncateForAi(entry.content ?? '');
        const messages: ChatMessage[] = [
          { role: 'system', content: entryAiSystemPrompt(body.action, body.targetLang ?? '简体中文') },
          { role: 'user', content: `文章标题：${entry.title ?? '(无标题)'}\n\n正文：\n${cut.content}` },
        ];

        try {
          const result = await chat(messages, llm, { fetchImpl: safeFetch });
          return c.json(
            assertResponse(aiSpec.entryAi.response, { ok: true, result }, 'POST /api/entry/:id/ai'),
          );
        } catch (e) {
          // 降级可读：模型失败返回 200，ok:false + 原因，前端直接呈现，不 500
          return c.json(
            assertResponse(
              aiSpec.entryAi.response,
              { ok: false, result: (e as Error)?.message ?? 'AI 调用失败' },
              'POST /api/entry/:id/ai',
            ),
          );
        }
      },
    )

    /* ---------------- GET /api/entry/:id/ai-tags ---------------- */
    .get(
      aiSpec.entryAiTags.path,
      requireAuth(auth, 'user'),
      async (c) => {
        if (!db) return apiError(c, 'E_DB_NOT_READY');
        const uid = c.get('user').id;

        const idNum = Number(c.req.param('id'));
        if (!Number.isInteger(idNum) || idNum <= 0) throw new ApiException('E_ENTRY_NOT_FOUND');

        // owner 隔离：entry_ai_tags 自带 userId，猜对 id 也读不到别人的标签
        const [row] = await db
          .select({ tags: entryAiTags.tags, status: entryAiTags.status, model: entryAiTags.model })
          .from(entryAiTags)
          .where(and(eq(entryAiTags.entryId, idNum), eq(entryAiTags.userId, uid)))
          .limit(1);

        const payload = assertResponse(
          aiSpec.entryAiTags.response,
          {
            id: String(idNum),
            tags: row?.tags ?? [],
            status: row?.status ?? 'pending',
            model: row?.model ?? null,
          },
          'GET /api/entry/:id/ai-tags',
        );
        return c.json(payload);
      },
    )

    /* ---------------- POST /api/entry/:id/ai-tags ---------------- */
    .post(
      aiSpec.entryAiTagsSet.path,
      requireAuth(auth, 'write'),
      async (c) => {
        if (!db) return apiError(c, 'E_DB_NOT_READY');
        const uid = c.get('user').id;

        const idNum = Number(c.req.param('id'));
        if (!Number.isInteger(idNum) || idNum <= 0) throw new ApiException('E_ENTRY_NOT_FOUND');

        // owner 隔离：经 feeds join，id 猜对了也读不到别人的正文
        const [entry] = await db
          .select({ content: entriesTable.content, title: entriesTable.title })
          .from(entriesTable)
          .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
          .where(and(eq(entriesTable.id, idNum), eq(feeds.ownerId, uid)))
          .limit(1);
        if (!entry) throw new ApiException('E_ENTRY_NOT_FOUND');

        const secret = await getCryptoSecret(db);
        const llm = resolveUserLlm(await loadLlmRow(db, uid), secret);
        if (llm.baseUrl) {
          try {
            await assertPublicHost(llm.baseUrl);
          } catch (e) {
            throw new ApiException('E_MODEL_URL_UNREACHABLE', { detail: (e as Error)?.message ?? String(e) });
          }
        }

        const id = crypto.randomUUID();
        const base = { id: String(idNum), model: llm.model };
        try {
          const { tags } = await suggestEntryTags(entry.title, entry.content ?? '', llm, safeFetch);
          await db
            .insert(entryAiTags)
            .values({ id, userId: uid, entryId: idNum, tags, model: llm.model, promptVersion: AI_TAG_PROMPT_VERSION, status: 'done' })
            .onConflictDoUpdate({
              target: [entryAiTags.userId, entryAiTags.entryId],
              set: { tags, model: llm.model, promptVersion: AI_TAG_PROMPT_VERSION, status: 'done', error: null, updatedAt: sql`now()` },
            });
          return c.json(
            assertResponse(aiSpec.entryAiTagsSet.response, { ok: true, ...base, tags, status: 'done' }, 'POST /api/entry/:id/ai-tags'),
          );
        } catch (e) {
          // 降级可读：模型失败返回 200，ok:false + 原因（标记 failed 便于重试），不 500
          const message = e instanceof Error ? e.message : String(e);
          await db
            .insert(entryAiTags)
            .values({ id, userId: uid, entryId: idNum, tags: [], model: llm.model, promptVersion: AI_TAG_PROMPT_VERSION, status: 'failed', error: message.slice(0, 500) })
            .onConflictDoUpdate({
              target: [entryAiTags.userId, entryAiTags.entryId],
              set: { status: 'failed', error: message.slice(0, 500), updatedAt: sql`now()` },
            });
          return c.json(
            assertResponse(aiSpec.entryAiTagsSet.response, { ok: false, ...base, tags: [], status: 'failed', error: message }, 'POST /api/entry/:id/ai-tags'),
          );
        }
      },
    );
}
