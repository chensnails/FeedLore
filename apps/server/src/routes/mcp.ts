/**
 * MCP（Model Context Protocol）端点：`/mcp`（契约外端点，协议由 MCP 规范定义）。
 *
 * 关键决策（详见 .workbuddy/reports/mcp-feasibility-2026-11-07.md）：
 * - **无状态 Streamable HTTP**：每请求新建 McpServer + transport，进程内不存会话，
 *   容器随时可重启、反代无需粘性会话；`enableJsonResponse` 走纯 JSON 应答，
 *   过 nginx 不用配 SSE 缓冲。
 * - **鉴权完全走 Bearer token**（middleware/mcpAuth.ts），不读 Cookie —— 与浏览器
 *   CSRF 模型物理隔离，`/mcp` 也不在 `/api/*` 的 Origin 中间件覆盖范围内。
 * - **默认开启**：没有任何 token 时端点只会一直 401（惰性无害），存量用户零感知；
 *   `MCP_ENABLED=0` 可整体关闭。
 */

import { Hono } from 'hono';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { Db } from '@feedlore/db';
import { apiError } from '../lib/apiError';
import { mcpAuth, type McpEnv } from '../middleware/mcpAuth';
import { buildMcpServer } from '../mcp/tools';

export function isMcpEnabled(): boolean {
  return process.env.MCP_ENABLED !== '0';
}

/** 不改响应体，只补 no-store：鉴权过的 JSON 也不该被任何一层缓存。 */
function withNoStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function mcpRoutes(db: Db | null) {
  return new Hono<McpEnv>()
    .use('/mcp', async (c, next) => {
      if (!isMcpEnabled()) return apiError(c, 'E_MCP_DISABLED');
      await next();
    })
    .use('/mcp', mcpAuth(db))
    .all('/mcp', async (c) => {
      if (!db) return apiError(c, 'E_DB_NOT_READY'); // mcpAuth 已兜一次，这里保类型
      const user = c.get('mcpUser');

      const server = buildMcpServer(db, user);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // 无状态：没有会话表
        enableJsonResponse: true,      // 纯 JSON：反代零配置
      });
      await server.connect(transport);
      try {
        const res = await transport.handleRequest(c.req.raw);
        return withNoStore(res);
      } finally {
        // JSON 应答在 handleRequest 返回时已完整落成，可以立刻释放本请求的协议栈
        void server.close();
        void transport.close();
      }
    });
}
