import { z } from 'zod';

/**
 * @feedlore/contract — 公共原语
 * 所有跨资源复用的基础类型集中在此。
 */

/** ISO 时间字符串（服务端统一用 `.toISOString()` 输出）。比 `z.string().datetime()` 略宽松，避免毫秒/时区细节误伤。 */
export const IsoDateTime = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: '必须是合法 ISO 时间字符串' });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** 资源 ID：响应里一律以字符串形态下发的数字 ID。 */
export const IdSchema = z.string().regex(/^\d+$/, 'ID 必须为纯数字字符串');
export type Id = z.infer<typeof IdSchema>;

/** 统一错误响应（服务端 `classifyError` 输出）。 */
export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  status: z.number().int(),
  code: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const RoleSchema = z.enum(['admin', 'user']);
export type Role = z.infer<typeof RoleSchema>;

/** 探活响应。`db.ready=false` 时 HTTP 为 503，但结构不变。 */
export const HealthSchema = z.object({
  ok: z.boolean(),
  authed: z.boolean(),
  db: z.object({
    ready: z.boolean(),
    latencyMs: z.number().int().nullable(),
  }),
});
export type Health = z.infer<typeof HealthSchema>;

/** 当前会话快照（GET /api/session）。 */
export const SessionSchema = z.object({
  authenticated: z.boolean(),
  username: z.string().nullable(),
  role: RoleSchema.nullable(),
  id: z.string().nullable(),
  dbReady: z.boolean(),
});
export type Session = z.infer<typeof SessionSchema>;

/** 版本信息（GET /api/version）。 */
export const VersionSchema = z.object({
  version: z.string(),
  repo: z.string(),
  updateEnabled: z.boolean(),
});
export type VersionInfo = z.infer<typeof VersionSchema>;

/** 版本检查结果（POST /api/version/check，带 TTL 缓存）。 */
export const VersionCheckSchema = z.object({
  ok: z.boolean(),
  current: z.string().optional(),
  latest: z.string().optional(),
  hasUpdate: z.boolean().optional(),
  releaseUrl: z.string().optional(),
  name: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  source: z.string().optional(),
  error: z.string().optional(),
});
export type VersionCheck = z.infer<typeof VersionCheckSchema>;

/** 通用 `{ ok: true }` 操作结果。 */
export const OkSchema = z.object({ ok: z.boolean() });
export type OkResult = z.infer<typeof OkSchema>;

/** 整数闭区间夹取（与 legacy `clampInt` 语义一致）。 */
export const intRange = (min: number, max: number) =>
  z.number().int().min(min).max(max);
