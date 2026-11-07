/**
 * `/mcp` 的 Bearer Token 鉴权。
 *
 * 与浏览器会话**物理隔离**（这是整套设计的关键约束）：
 * - 只认 `Authorization: Bearer flm_...`，**永不读 Cookie** —— 所以 `/mcp`
 *   不进 `/api/*` 的 CSRF/同源模型，两套通道互不开口子；
 * - token → SHA-256 → `mcp_tokens.token_hash` 点查（UNIQUE 索引），连 users
 *   一起取角色，映射成与 `requireAuth` 同形的身份注入 context；
 * - 只读账户不能创建 token（管理接口被 `write` 档拦下），因此这里不需要
 *   再为角色开口子 —— P1 的工具全是只读，所有角色行为一致。
 *
 * 401 故意**不带** `WWW-Authenticate: Bearer resource_metadata`：部分 MCP
 * 客户端看到它就会进入 OAuth 发现流程（找 /.well-known/...），发现不了反而
 * 报出更迷惑的错误。P1 依赖客户端「自定义 Header / 静态 Bearer」配置能力；
 * 要走标准 OAuth 发现见评估文档 P3。
 */

import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { mcpTokens, users, type Db } from '@feedlore/db';
import type { Role } from '@feedlore/contract';
import { normalizeRole } from '../lib/roles';
import { apiErrorBody } from '../lib/apiError';
import { bearerFromHeader, hashMcpToken, mcpRateLimit } from '../lib/mcpToken';
import type { SessionUser } from './auth';

export interface McpUser {
  id: string;
  username: string;
  role: Role;
  /** 'read' | 'write'；P1 工具全是只读，write 预留给后续写工具。 */
  scope: 'read' | 'write';
  tokenId: string;
  tokenPrefix: string;
}

/** 与 AppEnv 同形（挂进主 app），多出 mcpUser 一项。 */
export type McpEnv = {
  Variables: {
    user: SessionUser;
    /** 每次请求生成的 CSP nonce，HTML 内的内联脚本必须带同一个值。 */
    cspNonce: string;
    mcpUser: McpUser;
  };
};

export function mcpAuth(db: Db | null): MiddlewareHandler<McpEnv> {
  return async (c, next) => {
    if (!db) {
      const body = apiErrorBody('E_DB_NOT_READY');
      return c.json(body, body.status as 503);
    }

    const secret = bearerFromHeader(c.req.header('authorization'));
    // 恒定时间对比在这里意义不大：lookup 走哈希索引，时序差异来自哈希碰撞查找，
    // 而不是密钥本身 —— 与会话 token 的查表校验同一档威胁模型。
    if (!secret || !secret.startsWith('flm_')) {
      return c.json(apiErrorBody('E_MCP_TOKEN_INVALID'), 401);
    }

    const rows = await db
      .select({
        tokenId: mcpTokens.id,
        scope: mcpTokens.scope,
        prefix: mcpTokens.prefix,
        userId: users.id,
        username: users.username,
        role: users.role,
      })
      .from(mcpTokens)
      .innerJoin(users, eq(users.id, mcpTokens.userId))
      .where(eq(mcpTokens.tokenHash, hashMcpToken(secret)))
      .limit(1);

    const row = rows[0];
    if (!row || row.scope !== 'read' && row.scope !== 'write') {
      return c.json(apiErrorBody('E_MCP_TOKEN_INVALID'), 401);
    }

    const wait = mcpRateLimit(row.tokenId);
    if (wait > 0) {
      return c.json(apiErrorBody('E_MCP_RATE_LIMITED', { params: { retryAfter: wait } }), 429);
    }

    // lastUsedAt：发后不管，失败不影响本次调用；写多读少的场景也只是一行 UPDATE
    void db
      .update(mcpTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(mcpTokens.id, row.tokenId))
      .catch(() => { /* 设置页少一次「最近使用」更新，可接受 */ });

    c.set('mcpUser', {
      id: row.userId,
      username: row.username ?? '',
      role: normalizeRole(row.role),
      scope: row.scope,
      tokenId: row.tokenId,
      tokenPrefix: row.prefix,
    });
    await next();
  };
}
