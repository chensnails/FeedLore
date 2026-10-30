import { z } from 'zod';
import * as C from './common';
import * as M from './models';

/**
 * @feedlore/contract — 端点目录（契约草稿，v2 P1）
 *
 * 这是前后端唯一真相源的第一份完整草稿，从 apps/legacy/server.js 的真实路由反推而来。
 * 每个端点声明：方法、路径、鉴权级别、请求查询/体、响应 schema。
 * 后续 Hono 层用 `app` 满足这些 schema，前端 `hc<typeof app>` 据此生成类型化客户端，
 * 从而彻底取代 v1.x 的 `core` 字符串事件 + 全局可变 state。
 */

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';
export type AuthLevel = 'public' | 'user' | 'admin';

export interface EndpointSpec<Q = unknown, B = unknown, R = unknown> {
  method: HttpMethod;
  path: string;
  auth: AuthLevel;
  /** 查询参数（GET）。注意：HTTP 查询值都是字符串，这里用 z.coerce 表达「解析后形态」。 */
  query?: z.ZodType<Q>;
  /** 请求体（POST/PATCH）。 */
  body?: z.ZodType<B>;
  /** 响应体 schema（不含二进制透传类）。 */
  response: z.ZodType<R>;
  /** 二进制透传（如图片代理）标记，前端不应按 JSON 解析。 */
  binary?: boolean;
}

/* ============================ 鉴权 / 会话 ============================ */

export const loginBody = z.object({
  username: z.string(),
  password: z.string(),
});
export type LoginBody = z.infer<typeof loginBody>;

export const auth = {
  health: {
    method: 'get',
    path: '/api/health',
    auth: 'public',
    response: C.HealthSchema,
  },
  session: {
    method: 'get',
    path: '/api/session',
    auth: 'public',
    response: C.SessionSchema,
  },
  login: {
    method: 'post',
    path: '/api/login',
    auth: 'public',
    body: loginBody,
    response: z.object({ ok: z.boolean(), username: z.string(), role: C.RoleSchema }),
  },
  logout: {
    method: 'post',
    path: '/api/logout',
    auth: 'user',
    response: C.OkSchema,
  },
  status: {
    method: 'get',
    path: '/api/status',
    auth: 'admin',
    response: z.object({
      app: z.object({
        version: z.string(),
        node: z.string(),
        pid: z.number(),
        uptimeSec: z.number(),
        startedAt: C.IsoDateTime,
        timezone: z.string(),
        now: C.IsoDateTime,
        today: z.string(),
        memory: z.object({
          rss: z.number(),
          heapUsed: z.number(),
          heapTotal: z.number(),
          external: z.number(),
        }),
        container: z
          .object({ memoryUsed: z.number().nullable(), memoryLimit: z.number().nullable(), cpuPercent: z.number().nullable() })
          .nullable(),
        loadavg: z.array(z.number()),
        cpuCount: z.number(),
      }),
      db: z.object({
        ready: z.boolean(),
        error: z.string().nullable(),
        latencyMs: z.number().nullable(),
        pool: z.object({ total: z.number(), idle: z.number(), waiting: z.number(), max: z.number() }).nullable(),
        tables: z.unknown().nullable(),
        sizeBytes: z.number().nullable(),
      }),
      rss: z.object({
        refreshMinutes: z.number(),
        keepPerFeed: z.number(),
        keepDays: z.number(),
        autoRefreshMinutes: z.number(),
        concurrency: z.number(),
        timeoutSeconds: z.number(),
        feedFailLimit: z.number(),
        proxyUrl: z.string(),
        lastRefreshAt: C.IsoDateTime.nullable(),
        nextRefreshAt: C.IsoDateTime.nullable(),
        dueCount: z.number(),
        inFlight: z.number(),
        lastResult: z
          .object({
            added: z.number(),
            pruned: z.number(),
            skipped: z.number(),
            failed: z.number(),
            autoDisabled: z.number(),
            filtered: z.number(),
            durationMs: z.number(),
          })
          .nullable(),
        feeds: z.object({
          total: z.number(),
          enabled: z.number(),
          cardEnabled: z.number(),
          error: z.number(),
          neverFetched: z.number(),
          perFeedInterval: z.number(),
          autoDisabled: z.number(),
        }),
        entries: z.object({
          total: z.number(),
          unread: z.number(),
          favorite: z.number(),
          added24h: z.number(),
          oldest: C.IsoDateTime.nullable(),
          newest: C.IsoDateTime.nullable(),
        }),
        problems: z.array(
          z.object({
            feedId: z.string(),
            title: z.string(),
            error: z.string(),
            lastFetchedAt: C.IsoDateTime.nullable(),
            groupName: z.string(),
            enabled: z.boolean(),
            failStreak: z.number(),
          })
        ),
      }),
      digest: z.object({
        autoUsers: z.number(),
        totalUsers: z.number(),
        nextRunAt: C.IsoDateTime.nullable(),
        count: z.number(),
        oldestDate: z.string().nullable(),
        latest: z
          .object({
            date: z.string(),
            generatedAt: z.number().nullable(),
            model: z.string(),
            fallback: z.boolean(),
            error: z.string().nullable(),
            usedMapReduce: z.boolean(),
            stats: z.unknown().nullable(),
          })
          .nullable(),
      }),
    }),
  } satisfies EndpointSpec,
  version: {
    method: 'get',
    path: '/api/version',
    auth: 'user',
    response: C.VersionSchema,
  },
  versionCheck: {
    method: 'post',
    path: '/api/version/check',
    auth: 'user',
    response: C.VersionCheckSchema,
  },
  update: {
    method: 'post',
    path: '/api/update',
    auth: 'admin',
    response: C.OkSchema,
  },
} as const satisfies Record<string, EndpointSpec>;

/* ============================ 频道（Feeds） ============================ */

export const feedCreateBody = z.object({
  url: z.string().url().max(2000),
  enabled: z.boolean().optional(),
  cardEnabled: z.boolean().optional(),
  groupName: z.string().max(40).optional(),
});
export type FeedCreateBody = z.infer<typeof feedCreateBody>;

export const feedPatchBody = z.object({
  enabled: z.boolean().optional(),
  cardEnabled: z.boolean().optional(),
  groupName: z.string().max(40).optional(),
  title: z.string().max(200).optional(),
  sortOrder: z.number().int().optional(),
  /** 空 / 'global' / null 表示「跟随全局」；否则为 5~1440 的整数（服务端夹取） */
  refreshMinutes: z.union([z.number().int(), z.literal('global'), z.literal(''), z.null()]).optional(),
  url: z.string().url().max(2000).optional(),
});
export type FeedPatchBody = z.infer<typeof feedPatchBody>;

export const feedReorderBody = z.object({
  feeds: z.array(z.object({ id: z.number().int().positive() }).passthrough()),
});
export type FeedReorderBody = z.infer<typeof feedReorderBody>;

export const importBody = z.object({ opml: z.string().min(1) });
export type ImportBody = z.infer<typeof importBody>;

export const feedsListResponse = z.object({
  feeds: z.array(M.FeedSchema),
  total: z.number().int(),
  enabled: z.number().int(),
  cardEnabled: z.number().int(),
  groups: z.array(z.string()),
  groupOrder: z.array(z.string()),
  flags: M.EntryFlagsSchema,
  lastRefreshAt: C.IsoDateTime.nullable(),
  nextRefreshAt: C.IsoDateTime.nullable(),
  refreshMinutes: z.number().int(),
  keepDays: z.number().int(),
  autoRefreshMinutes: z.number().int(),
});
export type FeedsListResponse = z.infer<typeof feedsListResponse>;

export const feeds = {
  list: {
    method: 'get',
    path: '/api/feeds',
    auth: 'user',
    response: feedsListResponse,
  },
  reorder: {
    method: 'post',
    path: '/api/feeds/reorder',
    auth: 'user',
    body: feedReorderBody,
    response: z.object({ ok: z.boolean(), updated: z.number().int() }),
  },
  create: {
    method: 'post',
    path: '/api/feeds',
    auth: 'user',
    body: feedCreateBody,
    response: z.object({
      ok: z.boolean(),
      existed: z.boolean(),
      feed: M.FeedSchema,
      added: z.number().int(),
    }),
  },
  refresh: {
    method: 'post',
    path: '/api/feeds/refresh',
    auth: 'user',
    response: z.object({
      ok: z.boolean(),
      at: C.IsoDateTime,
      added: z.number().int(),
      skipped: z.number().int(),
      failed: z.array(z.object({ url: z.string(), error: z.string() })),
    }),
  },
  import: {
    method: 'post',
    path: '/api/feeds/import',
    auth: 'user',
    body: importBody,
    response: z.object({
      ok: z.boolean(),
      added: z.number().int(),
      duplicated: z.number().int(),
      skipped: z.number().int(),
      groups: z.array(z.string()),
      feeds: z.array(M.FeedSchema),
    }),
  },
  refreshOne: {
    method: 'post',
    path: '/api/feeds/:id/refresh',
    auth: 'user',
    response: z.object({
      ok: z.boolean(),
      result: z.object({ error: z.string().nullable(), added: z.number().int().optional() }).passthrough(),
      feed: M.FeedSchema,
    }),
  },
  patchOne: {
    method: 'patch',
    path: '/api/feeds/:id',
    auth: 'user',
    body: feedPatchBody,
    response: z.object({
      ok: z.boolean(),
      urlChanged: z.boolean().optional(),
      probe: z.object({ ok: z.boolean(), error: z.string().optional(), added: z.number().int().optional() }).optional(),
      feed: M.FeedSchema,
    }),
  },
  deleteOne: {
    method: 'delete',
    path: '/api/feeds/:id',
    auth: 'user',
    response: C.OkSchema,
  },
} as const satisfies Record<string, EndpointSpec>;

/* ============================ 条目（Entries） ============================ */

export const entriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(100).optional(),
  tag: z.string().max(60).optional(),
  unread: z.enum(['1']).optional(),
  fav: z.enum(['1']).optional(),
  watch: z.enum(['watch', 'block']).optional(),
  scope: z.enum(['all', 'cards']).optional(),
  feeds: z.string().optional(),
  sort: z.enum(['new', 'old']).optional(),
});
export type EntriesQuery = z.infer<typeof entriesQuery>;

export const entriesListResponse = z.object({
  entries: z.array(M.CardSchema),
  hasMore: z.boolean(),
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  tags: z.array(M.TagCountSchema),
});
export type EntriesListResponse = z.infer<typeof entriesListResponse>;

export const readAllBody = z.object({
  feeds: z.array(z.number().int().positive()).optional(),
  q: z.string().max(100).optional(),
  tag: z.string().max(60).optional(),
  watch: z.enum(['watch', 'block']).optional(),
});
export type ReadAllBody = z.infer<typeof readAllBody>;

export const entryFlagPatchBody = z.object({
  isRead: z.boolean().optional(),
  isFavorite: z.boolean().optional(),
});
export type EntryFlagPatchBody = z.infer<typeof entryFlagPatchBody>;

export const entries = {
  list: {
    method: 'get',
    path: '/api/entries',
    auth: 'user',
    query: entriesQuery,
    response: entriesListResponse,
  },
  flags: {
    method: 'get',
    path: '/api/entries/flags',
    auth: 'user',
    response: M.EntryFlagsSchema,
  },
  readAll: {
    method: 'post',
    path: '/api/entries/read-all',
    auth: 'user',
    body: readAllBody,
    response: z.object({ ok: z.boolean(), updated: z.number().int() }),
  },
  watchApply: {
    method: 'post',
    path: '/api/watch/apply',
    auth: 'user',
    response: z.object({
      ok: z.boolean(),
      cleared: z.number().int(),
      tagged: z.number().int(),
      watching: z.number().int(),
      blocked: z.number().int(),
    }),
  },
  detail: {
    method: 'get',
    path: '/api/entries/:id',
    auth: 'user',
    response: M.EntryDetailSchema,
  },
  flagPatch: {
    method: 'patch',
    path: '/api/entries/:id',
    auth: 'user',
    body: entryFlagPatchBody,
    response: z.object({
      ok: z.boolean(),
      id: z.string(),
      isRead: z.boolean(),
      isFavorite: z.boolean(),
      favoritedAt: C.IsoDateTime.nullable(),
    }),
  },
} as const satisfies Record<string, EndpointSpec>;

/* ============================ 偏好（Prefs） ============================ */

export const prefsResponse = z.object({
  groupOrder: z.array(z.string()),
  appearance: M.AppearanceSchema,
  layout: M.LayoutSchema,
  filters: z.array(M.FilterRuleSchema),
  watchRules: z.array(M.WatchRuleSchema),
  webhookUrl: z.string(),
  digest: M.DigestConfigSchema,
  llm: M.LlmViewSchema,
});
export type PrefsResponse = z.infer<typeof prefsResponse>;

export const prefsPatchBody = z.object({
  groupOrder: z.array(z.string()).optional(),
  // 各组都是「部分更新」：前端只提交改动的键，服务端按 legacy 的 sanitize 逐键回落默认
  appearance: M.AppearanceSchema.partial().optional(),
  layout: M.LayoutSchema.partial().optional(),
  filters: z.array(M.FilterRuleSchema).optional(),
  watchRules: z.array(M.WatchRuleSchema).optional(),
  webhookUrl: z.string().optional(),
  digest: M.DigestConfigSchema.partial().optional(),
  llm: M.LlmConfigSchema.partial().optional(),
});
export type PrefsPatchBody = z.infer<typeof prefsPatchBody>;

export const prefsUpdateResponse = z.object({
  ok: z.boolean(),
  groupOrder: z.array(z.string()),
  appearance: M.AppearanceSchema,
  layout: M.LayoutSchema,
  filters: z.array(M.FilterRuleSchema),
  watchRules: z.array(M.WatchRuleSchema),
  webhookUrl: z.string(),
  digest: M.DigestConfigSchema,
});
export type PrefsUpdateResponse = z.infer<typeof prefsUpdateResponse>;

export const prefs = {
  get: {
    method: 'get',
    path: '/api/prefs',
    auth: 'user',
    response: prefsResponse,
  },
  update: {
    method: 'post',
    path: '/api/prefs',
    auth: 'user',
    body: prefsPatchBody,
    response: prefsUpdateResponse,
  },
} as const satisfies Record<string, EndpointSpec>;

/* ============================ 管理员 ============================ */

export const configGetResponse = z.object({
  username: z.string(),
  role: C.RoleSchema,
  source: M.SourceConfigSchema,
});
export type ConfigGetResponse = z.infer<typeof configGetResponse>;

export const configPatchBody = z.object({
  source: M.SourceConfigSchema.partial().optional(),
});
export type ConfigPatchBody = z.infer<typeof configPatchBody>;

export const userCreateBody = z.object({
  username: z.string().regex(/^[\w.@-]{1,40}$/),
  password: z.string().min(4),
  role: C.RoleSchema.optional(),
});
export type UserCreateBody = z.infer<typeof userCreateBody>;

export const userPatchBody = z.object({
  role: C.RoleSchema.optional(),
  password: z.string().min(4).optional(),
});
export type UserPatchBody = z.infer<typeof userPatchBody>;

export const accountBody = z.object({
  currentPassword: z.string(),
  username: z.string().regex(/^[\w.@-]{1,40}$/).optional(),
  newPassword: z.string().min(4).optional(),
});
export type AccountBody = z.infer<typeof accountBody>;

export const admin = {
  configGet: {
    method: 'get',
    path: '/api/config',
    auth: 'admin',
    response: configGetResponse,
  },
  configPost: {
    method: 'post',
    path: '/api/config',
    auth: 'admin',
    body: configPatchBody,
    response: C.OkSchema,
  },
  imageCacheGet: {
    method: 'get',
    path: '/api/image-cache',
    auth: 'admin',
    response: z.object({ ok: z.boolean(), count: z.number().int(), bytes: z.number().int() }),
  },
  imageCacheClear: {
    method: 'post',
    path: '/api/image-cache/clear',
    auth: 'admin',
    response: z.object({ ok: z.boolean(), removed: z.number().int() }),
  },
  usersList: {
    method: 'get',
    path: '/api/users',
    auth: 'admin',
    response: z.object({ users: z.array(M.AdminUserSchema) }),
  },
  userCreate: {
    method: 'post',
    path: '/api/users',
    auth: 'admin',
    body: userCreateBody,
    response: z.object({ ok: z.boolean(), user: z.object({ id: z.string(), username: z.string(), role: C.RoleSchema }) }),
  },
  userPatch: {
    method: 'patch',
    path: '/api/users/:id',
    auth: 'admin',
    body: userPatchBody,
    response: z.object({ ok: z.boolean(), user: z.object({ id: z.string(), username: z.string(), role: C.RoleSchema }) }),
  },
  userDelete: {
    method: 'delete',
    path: '/api/users/:id',
    auth: 'admin',
    response: C.OkSchema,
  },
  account: {
    method: 'post',
    path: '/api/account',
    auth: 'user',
    body: accountBody,
    response: z.object({ ok: z.boolean(), username: z.string(), role: C.RoleSchema }),
  },
} as const satisfies Record<string, EndpointSpec>;

/* ============================ AI 日报 ============================ */

export const testLlmBody = z.object({ llm: M.LlmConfigSchema.partial().optional() });
export type TestLlmBody = z.infer<typeof testLlmBody>;

export const digestGenerateBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  feeds: z.array(z.number().int().positive()).optional(),
  force: z.boolean().optional(),
});
export type DigestGenerateBody = z.infer<typeof digestGenerateBody>;

export const ai = {
  testLlm: {
    method: 'post',
    path: '/api/digest/test-llm',
    auth: 'user',
    body: testLlmBody,
    // 注意：测试失败仍返回 200，ok:false + error；成功返回 ok:true + reply
    response: z.object({ ok: z.boolean(), error: z.string().optional(), reply: z.string().optional() }),
  },
  dates: {
    method: 'get',
    path: '/api/digests',
    auth: 'user',
    response: z.object({ dates: z.array(z.string()) }),
  },
  get: {
    method: 'get',
    path: '/api/digest',
    auth: 'user',
    query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    response: z.object({ date: z.string(), digest: M.DigestSchema.nullable() }),
  },
  generate: {
    method: 'post',
    path: '/api/digest/generate',
    auth: 'user',
    body: digestGenerateBody,
    response: z.object({ ok: z.boolean(), cached: z.boolean(), digest: M.DigestSchema }),
  },
} as const satisfies Record<string, EndpointSpec>;

/* ============================ 图片代理 ============================ */

export const img = {
  proxy: {
    method: 'get',
    path: '/api/img',
    auth: 'user',
    query: z.object({ u: z.string().url() }),
    response: z.unknown(),
    binary: true,
  },
} as const satisfies Record<string, EndpointSpec>;

/* ============================ 全集 ============================ */

export const contract = {
  auth,
  feeds,
  entries,
  prefs,
  admin,
  ai,
  img,
} as const;

export type Contract = typeof contract;
