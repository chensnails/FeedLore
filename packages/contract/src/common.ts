import { z } from 'zod';

/**
 * @feedlore/contract — 公共原语
 * 所有跨资源复用的基础类型集中在此。
 */

/** ISO 时间字符串（服务端统一用 `.toISOString()` 输出）。比 `z.string().datetime()` 略宽松，避免毫秒/时区细节误伤。 */
export const IsoDateTime = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Not a valid ISO time string' });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** 资源 ID：响应里一律以字符串形态下发的数字 ID。 */
export const IdSchema = z.string().regex(/^\d+$/, 'ID must be a numeric string');
export type Id = z.infer<typeof IdSchema>;

/**
 * 统一错误响应。
 *
 * - `error`：稳定错误码（见 `errors.ts`），前端按码查词典；透传上游异常时也允许直接放英文原文。
 * - `message`：英文说明，服务端日志与调试用，界面不直接依赖它。
 * - `params`：词典插值需要的结构化数据（如 `retryAfter`、冲突频道名）。
 */
export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  status: z.number().int(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * 账号角色。
 *
 * - `admin`：站点级设置 + 用户管理；
 * - `user`：自己的订阅源 / 偏好 / 模型 / 日报；
 * - `readonly`：只能阅读。保留文章 / 频道的查看、已读、收藏与布局偏好（外观存浏览器本机）；
 *   订阅源增删改、过滤与关注规则、Webhook、模型、日报生成、账号凭据修改全部由服务端拒绝，
 *   适合把账号借给别人阅读，登录凭据始终由管理员掌握。
 */
export const RoleSchema = z.enum(['admin', 'user', 'readonly']);
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

/**
 * 初始管理员密码（固定值，公开写在文档里）。
 *
 * 为什么不用随机口令：部署后拿密码要靠日志 / CLI 二次操作，对自托管场景太重。
 * 代价是「任何看过文档的人都知道它」—— 所以首次登录必须改密由服务端强制
 * （users.must_change_password + E_PASSWORD_CHANGE_REQUIRED），改完就不再有效。
 *
 * ⚠️ 空站点播种、`initial-password --reset`、登录页提示三处共用此值；
 *    老账号（升级前已存在）不会被重置成它。
 */
export const INITIAL_ADMIN_PASSWORD = 'Admin2026';

/** 当前会话快照（GET /api/session）。 */
export const SessionSchema = z.object({
  authenticated: z.boolean(),
  username: z.string().nullable(),
  role: RoleSchema.nullable(),
  id: z.string().nullable(),
  dbReady: z.boolean(),
  /* 首次登录必须改密（老账号升级后恒为 false）。前端据此把用户挡在改密页，
   * 服务端另有一道拦截（E_PASSWORD_CHANGE_REQUIRED），这里只是让界面提前引导。 */
  mustChangePassword: z.boolean(),
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
export const intRange = (min: number, max: number) => z.number().int().min(min).max(max);
