/**
 * AI 日报路由（契约：contract.ai.*）
 *
 * 端点边界刻意划得很窄：
 * - `test-llm`：**失败也返回 200**（`{ok:false,error}`）。这是给用户看的诊断，
 *   用 4xx/5xx 表达会让前端只能弹一个「请求失败」，把人引去查网络而不是改 Key。
 * - `digests` / `digest`：只读自己那份（`owner_id` 进 WHERE），没有跨账号路径。
 * - `generate` / `entry/:id/ai` / `entry/:id/ai-tags`：**同步兼容入口**，
 *   网页已改走 `POST /api/ai/jobs`（异步 + 轮询，见 lib/aiJobs.ts）。
 *   这三个保留给 CLI / 脚本 / 旧客户端，执行体与任务共用 lib/aiTasks.ts，
 *   不存在第二份提示词或截断逻辑。
 * - `ai/jobs`：提交即返回 + 轮询。真正昂贵的模型调用在进程内异步跑。
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { entryAiTags, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import { ai as aiSpec, type LlmConfig } from '@feedlore/contract';
import {
  listDigestDates,
  listModels,
  readDigest,
  shanghaiDate,
  testLlm,
  type ResolvedLlm,
} from '@feedlore/ai';
import { resolveProviderForTest } from '../lib/llmProviders';
import { assertResponse, BadRequest } from '../lib/validate';
import { apiError, ApiException, apiErrorBody, apiErrorKey } from '../lib/apiError';
import { assertPublicHost, safeFetch } from '../lib/net';
import {
  AI_REQUEST_KEEP,
  AI_REQUEST_KEEP_DAYS,
  readAiRequests,
  readAiUsageSummary,
  recordAiUsage,
} from '../lib/aiUsage';
import { execDigest, execEntryAi, execEntryTags, isRealDate } from '../lib/aiTasks';
import { createJob, readJob, toJobView } from '../lib/aiJobs';
import { requireAuth, type AppEnv } from '../middleware/auth';

export function aiRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- GET /api/ai-usage ---------------- */
    /* AI 消耗量：只读本人，按「今日 / 近 7 天 / 近 30 天」+ 按功能 + 按天序列。
     * 读接口不记账——看统计本身不该消耗额度。 */
    .get(
      aiSpec.apiUsage.path,
      requireAuth(auth, 'user'),
      zValidator('query', aiSpec.apiUsage.query, (r) => {
        if (!r.success) throw new BadRequest('GET /api/ai-usage', r.error.issues);
      }),
      async (c) => {
        if (!db) return apiError(c, 'E_DB_NOT_READY');
        const uid = c.get('user').id;
        const q = c.req.valid('query') as { days?: number };
        const summary = await readAiUsageSummary(db, uid, q.days ?? 30);
        return c.json(assertResponse(aiSpec.apiUsage.response, summary, 'GET /api/ai-usage'));
      },
    )
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
        const body = c.req.valid('json') as { llm?: Partial<LlmConfig>; providerId?: string };

        const base = await resolveProviderForTest(db, uid, body.providerId);
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

        // 测试模型也算消耗：成功失败都记一次，用量由 onUsage 带出来
        let testUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
        const testStarted = Date.now();
        const payload = assertResponse(
          aiSpec.testLlm.response,
          await testLlm(llm, safeFetch, (u) => { testUsage = u; }),
          'POST /api/digest/test-llm',
        );
        await recordAiUsage(db, uid, 'test', testUsage, payload.ok === true, 1, {
          model: llm.model,
          label: '测试连接',
          durationMs: Date.now() - testStarted,
          error: payload.ok ? '' : payload.error,
        });
        return c.json(payload);
      },
    )

    /* ---------------- POST /api/llm/models ---------------- */
    /**
     * 拉上游模型列表，给「模型名称」下拉用。
     * 与 test-llm 同口径：可临时带未保存的 baseUrl / apiKey；失败返回 ok:false + error，
     * 前端退回手填并说明原因（不兼容的上游很常见，不该做成 4xx 让人以为填错了）。
     */
    .post(
      aiSpec.llmModels.path,
      requireAuth(auth, 'write'),
      zValidator('json', aiSpec.llmModels.body, (r) => {
        if (!r.success) throw new BadRequest('POST /api/llm/models', r.error.issues);
      }),
      async (c) => {
        if (!db) return c.json({ ok: false, models: [], error: apiErrorBody('E_DB_NOT_READY').error });
        const uid = c.get('user').id;
        const body = c.req.valid('json') as { llm?: Partial<LlmConfig>; providerId?: string };

        const base = await resolveProviderForTest(db, uid, body.providerId);
        const llm = { baseUrl: base.baseUrl, apiKey: base.apiKey };
        if (body.llm?.baseUrl?.trim()) llm.baseUrl = body.llm.baseUrl.trim().replace(/\/+$/, '');
        if (body.llm?.apiKey?.trim()) llm.apiKey = body.llm.apiKey.trim();

        if (!llm.baseUrl || !llm.apiKey) {
          return c.json({ ok: false, models: [], error: apiErrorBody('E_MODEL_INCOMPLETE').error });
        }
        // 同一个 SSRF 闸门：模型地址是用户可控的出网目标，不能跳过
        try {
          await assertPublicHost(llm.baseUrl);
        } catch (e) {
          return c.json({
            ok: false,
            models: [],
            error: apiErrorKey(new ApiException('E_MODEL_URL_UNREACHABLE', { detail: (e as Error)?.message ?? String(e) })),
          });
        }

        try {
          const models = await listModels(llm, safeFetch);
          return c.json({ ok: true, models });
        } catch (e) {
          return c.json({ ok: false, models: [], error: (e as Error)?.message ?? String(e) });
        }
      },
    )

    /* ---------------- GET /api/ai-requests ---------------- */
    /** 最近调用明细（只读本人）。读失败就返回空数组 —— 这块是参考信息，不该让面板报错。 */
    .get(aiSpec.requests.path, requireAuth(auth, 'user'), async (c) => {
      if (!db) return c.json({ requests: [], keep: AI_REQUEST_KEEP, keepDays: AI_REQUEST_KEEP_DAYS });
      const uid = c.get('user').id;
      let limit = 50;
      try {
        const raw = Number(c.req.query('limit'));
        if (Number.isFinite(raw) && raw > 0) limit = raw;
      } catch { /* 用默认值 */ }
      const requests = await readAiRequests(db, uid, limit);
      return c.json(
        assertResponse(
          aiSpec.requests.response,
          { requests, keep: AI_REQUEST_KEEP, keepDays: AI_REQUEST_KEEP_DAYS },
          'GET /api/ai-requests',
        ),
      );
    })

    /* ---------------- POST /api/ai/jobs ---------------- */
    /**
     * 提交 AI 任务。**立即返回 job**（毫秒级），模型调用在进程内异步执行。
     * 提交阶段就把能快速判定的错误判掉：条目不存在 / 越权 / 日期非法 / 任务过多。
     */
    .post(
      aiSpec.aiJobCreate.path,
      requireAuth(auth, 'write'),
      zValidator('json', aiSpec.aiJobCreate.body, (r) => {
        if (!r.success) throw new BadRequest('POST /api/ai/jobs', r.error.issues);
      }),
      async (c) => {
        if (!db) return apiError(c, 'E_DB_NOT_READY');
        const uid = c.get('user').id;
        const job = await createJob(db, uid, c.req.valid('json'));
        return c.json(
          assertResponse(aiSpec.aiJobCreate.response, { ok: true, job: toJobView(job) }, 'POST /api/ai/jobs'),
        );
      },
    )

    /* ---------------- GET /api/ai/jobs/:id ---------------- */
    /**
     * 轮询任务状态。前端约定间隔 1.5 秒（见 lib/aiJobs.ts 的 AI_JOB_POLL_MS）。
     * owner 隔离：拿别人的 id 一律 404，不暴露「这个 id 存在」。
     */
    .get(aiSpec.aiJobGet.path, requireAuth(auth, 'user'), async (c) => {
      if (!db) return apiError(c, 'E_DB_NOT_READY');
      const uid = c.get('user').id;
      const job = await readJob(db, uid, c.req.param('id'));
      if (!job) throw new ApiException('E_AI_JOB_NOT_FOUND');
      return c.json(assertResponse(aiSpec.aiJobGet.response, { ok: true, job }, 'GET /api/ai/jobs/:id'));
    })

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

    /* ---------------- POST /api/digest/generate（同步兼容入口） ---------------- */
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
        const result = await execDigest(db, uid, { date: body.date, force: body.force === true, feeds: body.feeds ?? null });
        return c.json(
          assertResponse(
            aiSpec.generate.response,
            { ok: true, cached: result.cached, digest: result.digest },
            'POST /api/digest/generate',
          ),
        );
      },
    )

    /* ---------------- POST /api/entry/:id/ai（同步兼容入口） ---------------- */
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

        const body = c.req.valid('json');
        try {
          const { result } = await execEntryAi(db, uid, {
            entryId: idNum,
            action: body.action,
            targetLang: body.targetLang,
          });
          return c.json(
            assertResponse(aiSpec.entryAi.response, { ok: true, result }, 'POST /api/entry/:id/ai'),
          );
        } catch (e) {
          // 条目不存在 / 越权是请求错误，照常抛出；模型失败降级成 {ok:false}（前端直接呈现原因）
          if (e instanceof ApiException && !isModelFailure(e)) throw e;
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

    /* ---------------- POST /api/entry/:id/ai-tags（同步兼容入口） ---------------- */
    .post(
      aiSpec.entryAiTagsSet.path,
      requireAuth(auth, 'write'),
      async (c) => {
        if (!db) return apiError(c, 'E_DB_NOT_READY');
        const uid = c.get('user').id;

        const idNum = Number(c.req.param('id'));
        if (!Number.isInteger(idNum) || idNum <= 0) throw new ApiException('E_ENTRY_NOT_FOUND');

        const base = { id: String(idNum) };
        try {
          const { tags, model } = await execEntryTags(db, uid, idNum);
          return c.json(
            assertResponse(
              aiSpec.entryAiTagsSet.response,
              { ok: true, ...base, tags, status: 'done', model },
              'POST /api/entry/:id/ai-tags',
            ),
          );
        } catch (e) {
          if (e instanceof ApiException && !isModelFailure(e)) throw e;
          // 降级可读：模型失败返回 200，ok:false + 原因（execEntryTags 已把记录标 failed）
          const message = e instanceof Error ? e.message : String(e);
          return c.json(
            assertResponse(
              aiSpec.entryAiTagsSet.response,
              { ok: false, ...base, tags: [], status: 'failed', model: null, error: message },
              'POST /api/entry/:id/ai-tags',
            ),
          );
        }
      },
    );
}

/**
 * 「模型侧的失败」与「请求侧的失败」要分开：
 * 前者降级成 `{ok:false, reason}` 给用户看，后者（条目不存在、越权、模型未配置）
 * 必须保持 4xx —— 否则前端会把「这篇文章不是你的」显示成一句模型报错。
 */
function isModelFailure(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /^E_AI_[A-Z_]+/.test(msg);
}
