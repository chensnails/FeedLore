/**
 * @feedlore/contract — 前后端唯一真相源（v2）。
 *
 * P0 种子：核心领域实体的 Zod schema。
 * P1 扩展：从 apps/legacy/server.js 反推的完整端点目录（endpoints.ts），
 *         覆盖 auth / feeds / entries / prefs / admin / ai / img 七大类。
 *
 * 后续 Hono 层用 `app` 满足这些 schema，前端 `hc<typeof app>` 据此生成类型化客户端。
 */

export * from './common';
export * from './models';
export * from './endpoints';
