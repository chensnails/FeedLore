/**
 * 偏好读接口（契约：contract.prefs.get）。
 *
 * 数据来源两处：
 * - `users.prefs`（jsonb）：外观 / 布局 / 过滤规则 / 关注屏蔽 / webhook / 日报配置；
 * - `user_llm`（侧表）：模型 baseUrl / model / thinking，以及**只看「有没有 key」**。
 *
 * 读的一律是「清洗后的视图」：库里可能躺着老版本写的脏值（比如 theme='github' 之后
 * 被删掉的枚举），直接透出会让前端渲染出白屏或让 assertResponse 500。
 * 清洗器在 `lib/prefs.ts`，与 legacy `lib/prefs.js` 行为一致。
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { users, userLlm, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import { prefs as prefsSpec, prefsResponse, type LlmView } from '@feedlore/contract';
import { assertResponse } from '../lib/validate';
import {
  userAppearance,
  userDigest,
  userFilters,
  userGroupOrder,
  userLayout,
  userWatchRules,
  userWebhook,
} from '../lib/prefs';
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

export function prefsRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>().get(prefsSpec.get.path, requireAuth(auth, 'user'), async (c) => {
    if (!db) return c.json({ error: '数据库未就绪' }, 503);

    const uid = c.get('user').id;

    const [userRow] = await db.select({ prefs: users.prefs }).from(users).where(eq(users.id, uid)).limit(1);
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
  });
}
