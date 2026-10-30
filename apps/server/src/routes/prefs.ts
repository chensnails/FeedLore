/**
 * 偏好接口（契约：contract.prefs.get / update）
 *
 * 数据来源两处：
 * - `users.prefs`（jsonb）：外观 / 布局 / 过滤规则 / 关注屏蔽 / webhook / 日报配置；
 * - `user_llm`（侧表）：模型 baseUrl / model / thinking，以及**只看「有没有 key」**。
 *
 * 读的一律是「清洗后的视图」：库里可能躺着老版本写的脏值（比如 theme='github' 之后
 * 被删掉的枚举），直接透出会让前端渲染出白屏或让 assertResponse 500。
 * 清洗器在 `lib/prefs.ts`，与 legacy `lib/prefs.js` 行为一致。
 *
 * 写的三条语义（与 legacy 一致，别改成「整份替换」）：
 * 1. appearance / layout 是**按现有值合并后再清洗**：前端只提交改动的键时，
 *    未提交的键必须保持用户原值，不能被 sanitize 的默认值冲掉。
 * 2. filters / watchRules 是**整组替换**：规则是列表，部分合并没有意义。
 * 3. digest 的 `lastAuto` 是服务端调度器独占写入的字段，客户端提交的同名字段一律忽略 ——
 *    否则用户每改一次别的选项就会把「今天已跑过」抹掉，调度器会在同一时间点反复重跑。
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { users, userLlm, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import {
  prefs as prefsSpec,
  prefsResponse,
  prefsPatchBody,
  type LlmView,
  type PrefsPatchBody,
} from '@feedlore/contract';
import { assertResponse, BadRequest } from '../lib/validate';
import {
  sanitizeAppearance,
  sanitizeDigest,
  sanitizeFilters,
  sanitizeLayout,
  sanitizeWatchRules,
  sanitizeWebhook,
  userAppearance,
  userDigest,
  userFilters,
  userGroupOrder,
  userLayout,
  userWatchRules,
  userWebhook,
} from '../lib/prefs';
import { assertPublicHost } from '../lib/net';
import { requireAuth, type AppEnv } from '../middleware/auth';

/** legacy 的思维深度是 'low'|'medium'|'high'；v2 侧表用 0~3 的整数（P7 迁移时映射）。 */
const THINKING_DEPTH_DEFAULT = 2;

interface LlmRow {
  encryptedKey: string | null;
  baseUrl: string | null;
  model: string | null;
  thinking: boolean;
  thinkingDepth: number;
}

function llmView(row: LlmRow | undefined): LlmView {
  return {
    baseUrl: row?.baseUrl ?? '',
    model: row?.model ?? '',
    temperature: 0.3,
    thinking: row?.thinking === true,
    thinkingDepth: Number.isInteger(row?.thinkingDepth) ? (row?.thinkingDepth as number) : THINKING_DEPTH_DEFAULT,
    apiKeySet: Boolean(row?.encryptedKey),
    // 掩码提示需要解密（packages/ai 的 cryptoSecret），P5 落地后补上；现在只回是否已设置
    apiKeyHint: '',
  };
}

type PrefsBag = Record<string, unknown>;

/** 把任意对象安全地当成 prefs 分组读（库里可能是 null / 字符串 / 数组）。 */
function groupOf(prefs: PrefsBag, key: string): Record<string, unknown> {
  const v = prefs[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function prefsRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- GET /api/prefs ---------------- */
    .get(prefsSpec.get.path, requireAuth(auth, 'user'), async (c) => {
      if (!db) return c.json({ error: '数据库未就绪' }, 503);

      const uid = c.get('user').id;

      const [userRow] = await db
        .select({ prefs: users.prefs })
        .from(users)
        .where(eq(users.id, uid))
        .limit(1);
      if (!userRow) return c.json({ error: '用户不存在' }, 401);

      const [llmRow] = await db
        .select({
          encryptedKey: userLlm.encryptedKey,
          baseUrl: userLlm.baseUrl,
          model: userLlm.model,
          thinking: userLlm.thinking,
          thinkingDepth: userLlm.thinkingDepth,
        })
        .from(userLlm)
        .where(eq(userLlm.userId, uid))
        .limit(1);

      const prefs = userRow.prefs;

      const payload = assertResponse(
        prefsResponse,
        {
          groupOrder: userGroupOrder(prefs),
          appearance: userAppearance(prefs),
          layout: userLayout(prefs),
          filters: userFilters(prefs),
          watchRules: userWatchRules(prefs),
          webhookUrl: userWebhook(prefs),
          digest: userDigest(prefs),
          llm: llmView(llmRow),
        },
        'GET /api/prefs',
      );
      return c.json(payload);
    })

    /* ---------------- POST /api/prefs ---------------- */
    .post(
      prefsSpec.update.path,
      requireAuth(auth, 'user'),
      zValidator('json', prefsPatchBody, (result) => {
        if (!result.success) throw new BadRequest('POST /api/prefs', result.error.issues);
      }),
      async (c) => {
        if (!db) return c.json({ error: '数据库未就绪' }, 503);

        const uid = c.get('user').id;
        const body: PrefsPatchBody = c.req.valid('json');

        const [userRow] = await db
          .select({ prefs: users.prefs })
          .from(users)
          .where(eq(users.id, uid))
          .limit(1);
        if (!userRow) return c.json({ error: '用户不存在' }, 401);

        const prev = (userRow.prefs ?? {}) as PrefsBag;
        const next: PrefsBag = { ...prev };

        if (Array.isArray(body.groupOrder)) {
          next.groupOrder = body.groupOrder
            .filter((g): g is string => typeof g === 'string')
            .map((g) => g.trim().slice(0, 40))
            .filter(Boolean);
        }

        // 合并后再清洗：只改主题不该把主色重置成默认值
        if (body.appearance) {
          next.appearance = sanitizeAppearance({ ...groupOf(prev, 'appearance'), ...body.appearance });
        }
        if (body.layout) {
          next.layout = sanitizeLayout({ ...groupOf(prev, 'layout'), ...body.layout });
        }
        // 规则整组替换（非法规则被清洗器丢弃，而不是整体报错）
        if (Array.isArray(body.filters)) {
          next.filters = sanitizeFilters(body.filters);
        }
        if (Array.isArray(body.watchRules)) {
          next.watchRules = sanitizeWatchRules(body.watchRules);
        }

        if (typeof body.webhookUrl === 'string') {
          const hook = sanitizeWebhook(body.webhookUrl);
          /* 保存即校验（S-06）：地址一旦落库，之后每次命中关注规则都会向它 POST。
           * 空串表示「清空」，放行。 */
          if (hook) {
            try {
              await assertPublicHost(hook);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              throw new HTTPException(400, { message: `Webhook 地址不可用：${msg}` });
            }
          }
          next.webhookUrl = hook;
        }

        if (body.digest) {
          const prevDigest = groupOf(prev, 'digest');
          const merged = sanitizeDigest({ ...prevDigest, ...body.digest });
          // lastAuto 只归服务端调度器写
          merged.lastAuto = typeof prevDigest.lastAuto === 'string' ? prevDigest.lastAuto : '';
          next.digest = merged;
        }

        await db
          .update(users)
          .set({ prefs: next, updatedAt: sql`now()` })
          .where(eq(users.id, uid));

        /* ---- 模型配置：写 user_llm 侧表 ----
         * apiKey 需要 AEAD 加密（legacy lib/crypto.js），随 packages/ai 一起在 P5 落地。
         * 在那之前**明确拒绝**非空 apiKey，而不是存明文或假装存了。 */
        if (body.llm) {
          if (typeof body.llm.apiKey === 'string' && body.llm.apiKey.trim()) {
            throw new HTTPException(400, {
              message: '密钥保存尚未开放：加密模块随 AI 能力（P5）一起接入，当前仅支持填写模型地址与名称',
            });
          }

          const llmSet: {
            baseUrl?: string | null;
            model?: string | null;
            thinking?: boolean;
            thinkingDepth?: number;
          } = {};

          if (body.llm.baseUrl !== undefined) {
            const v = body.llm.baseUrl.trim();
            // 模型地址也是出网口（服务端会带着 Key 向它 POST）——只在真的改了时才校验
            if (v) {
              try {
                await assertPublicHost(v);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                throw new HTTPException(400, { message: `模型地址不可用：${msg}` });
              }
            }
            llmSet.baseUrl = v || null;
          }
          if (body.llm.model !== undefined) llmSet.model = body.llm.model.trim() || null;
          if (body.llm.thinking !== undefined) llmSet.thinking = body.llm.thinking === true;
          if (body.llm.thinkingDepth !== undefined) {
            llmSet.thinkingDepth = Math.min(3, Math.max(0, Math.trunc(body.llm.thinkingDepth)));
          }

          if (Object.keys(llmSet).length) {
            await db
              .insert(userLlm)
              .values({ userId: uid, ...llmSet })
              .onConflictDoUpdate({
                target: userLlm.userId,
                set: { ...llmSet, updatedAt: sql`now()` },
              });
          }
        }

        const payload = assertResponse(
          prefsSpec.update.response,
          {
            ok: true,
            groupOrder: userGroupOrder(next),
            appearance: userAppearance(next),
            layout: userLayout(next),
            filters: userFilters(next),
            watchRules: userWatchRules(next),
            webhookUrl: userWebhook(next),
            digest: userDigest(next),
          },
          'POST /api/prefs',
        );
        return c.json(payload);
      },
    );
}
