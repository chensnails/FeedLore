/**
 * 每账号模型配置行的读取（供 HTTP 路由与 MCP 工具共用）。
 *
 * 抽到这里的原因：单条目 AI（routes/ai.ts）和 MCP 写工具（mcp/tools.ts）
 * 都要「拿到本人 user_llm 行 → resolveUserLlm 解密 → 调 chat()」。
 * 之前这行查询只躺在 routes/ai.ts 里，MCP 要复制一份就会漂移，所以收口到本文件。
 *
 * 注意：只取 user_llm 的字段，解密与「是否配置完整」交给 @feedlore/ai 的
 * `resolveUserLlm` / `llmComplete`，本文件不碰密钥。
 */

import { eq } from 'drizzle-orm';
import { userLlm, type Db } from '@feedlore/db';

/** 读该账号的模型配置行；没有则返回 undefined（resolveUserLlm 会按「未配置」处理）。 */
export async function loadLlmRow(
  db: Db,
  uid: string,
): Promise<{
  encryptedKey: string | null;
  baseUrl: string | null;
  model: string | null;
  temperature?: number | null;
  thinking: boolean;
  thinkingDepth: number;
} | undefined> {
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
