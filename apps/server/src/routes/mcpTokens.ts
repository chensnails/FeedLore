/**
 * MCP 令牌管理（契约：contract.mcpTokens.*）。
 *
 * - 每用户独立：所有语句都带 `user_id = 当前用户`，别人的 id 一律 404；
 * - 走 `/api/*` 的会话鉴权与 CSRF/同源防线（与 `/mcp` 的 Bearer 通道互不相通）；
 * - 只读账户被 `requireAuth(auth,'write')` 拦下 —— 与其它配置写接口同一档语义；
 * - 明文 secret 只在创建响应出现一次，库里只有 SHA-256；
 * - 吊销是软删（revokedAt），`mcpAuth` 的点查会立即失效（同一次查表就看到 revoked）。
 */

import { Hono } from 'hono';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { mcpTokens, type Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import { mcpTokens as tokenSpec, type McpTokenInfo } from '@feedlore/contract';
import { apiError, ApiException } from '../lib/apiError';
import { assertResponse, BadRequest } from '../lib/validate';
import {
  generateMcpToken,
  MCP_TOKENS_MAX_PER_USER,
} from '../lib/mcpToken';
import { requireAuth, type AppEnv } from '../middleware/auth';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function mcpTokenRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- GET /api/mcp-tokens ---------------- */
    .get(tokenSpec.list.path, requireAuth(auth, 'user'), async (c) => {
      if (!db) return apiError(c, 'E_DB_NOT_READY');
      const uid = c.get('user').id;

      const rows = await db
        .select()
        .from(mcpTokens)
        .where(and(eq(mcpTokens.userId, uid), isNull(mcpTokens.revokedAt)))
        .orderBy(desc(mcpTokens.createdAt))
        .limit(100);

      const tokens: McpTokenInfo[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        scope: r.scope === 'write' ? 'write' : 'read',
        prefix: r.prefix,
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: iso(r.lastUsedAt),
      }));
      return c.json(assertResponse(tokenSpec.list.response, { tokens }, 'GET /api/mcp-tokens'));
    })

    /* ---------------- POST /api/mcp-tokens ---------------- */
    .post(
      tokenSpec.create.path,
      requireAuth(auth, 'write'),
      zValidator('json', tokenSpec.create.body, (result) => {
        if (!result.success) throw new BadRequest('POST /api/mcp-tokens', result.error.issues);
      }),
      async (c) => {
        if (!db) return apiError(c, 'E_DB_NOT_READY');
        const uid = c.get('user').id;
        const body = c.req.valid('json');

        const countRows = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(mcpTokens)
          .where(and(eq(mcpTokens.userId, uid), isNull(mcpTokens.revokedAt)));
        if ((countRows[0]?.n ?? 0) >= MCP_TOKENS_MAX_PER_USER) {
          throw new ApiException('E_MCP_TOKEN_LIMIT');
        }

        const { secret, hash, prefix } = generateMcpToken();
        const id = crypto.randomUUID();
        await db.insert(mcpTokens).values({
          id,
          userId: uid,
          name: body.name,
          scope: body.scope,
          tokenHash: hash,
          prefix,
        });

        return c.json(assertResponse(
          tokenSpec.create.response,
          {
            secret,
            token: {
              id,
              name: body.name,
              scope: body.scope,
              prefix,
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
            },
          },
          'POST /api/mcp-tokens',
        ));
      },
    )

    /* ---------------- DELETE /api/mcp-tokens/:id ---------------- */
    .delete(
      tokenSpec.revoke.path,
      requireAuth(auth, 'write'),
      zValidator('param', z.object({ id: z.string().min(1) }), (result) => {
        if (!result.success) throw new BadRequest('DELETE /api/mcp-tokens/:id', result.error.issues);
      }),
      async (c) => {
        if (!db) return apiError(c, 'E_DB_NOT_READY');
        const uid = c.get('user').id;
        const { id } = c.req.valid('param');

        // 软删：id + user 同进 WHERE，没命中就是别人的 token（404，不泄露存在性）
        const rows = await db
          .update(mcpTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(mcpTokens.id, id), eq(mcpTokens.userId, uid), isNull(mcpTokens.revokedAt)))
          .returning({ id: mcpTokens.id });
        if (!rows.length) throw new ApiException('E_MCP_TOKEN_NOT_FOUND');

        return c.json(assertResponse(tokenSpec.revoke.response, { ok: true }, 'DELETE /api/mcp-tokens/:id'));
      },
    );
}
