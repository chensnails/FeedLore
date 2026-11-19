import { z } from 'zod';
import * as C from './common';
import * as M from './models';

/**
 * @feedlore/contract — 端点目录（契约草稿，v2 P1）
 *
 * 这是前后端唯一真相源的第一份完整草稿，从 apps/legacy/server.js 的真实路由反推而来。
 * 每个端点声明：方法、路径、鉴权级别、请求查询/体、响应 schema。
 * 后续 Hono 层用 `app` 满足这些 schema，前端 `hc<typeof app>` 据此生成类型化客户端，
 * 从而彻底取代 `core` 字符串事件 + 全局可变 state。
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
    response: z.object({
      ok: z.boolean(),
      username: z.string(),
      role: C.RoleSchema,
      /** 登录后是否必须先改密（首次部署的初始账号为 true）。 */
      mustChangePassword: z.boolean(),
    }),
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
          .object({
            memoryUsed: z.number().nullable(),
            memoryLimit: z.number().nullable(),
            cpuPercent: z.number().nullable(),
          })
          .nullable(),
        loadavg: z.array(z.number()),
        cpuCount: z.number(),
      }),
      db: z.object({
        ready: z.boolean(),
        error: z.string().nullable(),
        latencyMs: z.number().nullable(),
        pool: z
          .object({ total: z.number(), idle: z.number(), waiting: z.number(), max: z.number() })
          .nullable(),
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
        /** 整轮刷新进度（刷新全部按钮旁的细粒度展示） */
        refreshProgress: z.object({
          running: z.boolean(),
          label: z.string(),
          total: z.number().int(),
          done: z.number().int(),
          startedAt: C.IsoDateTime.nullable(),
        }),
        /** 条件请求被忽略而降频的 host（进程内观测，重启重置） */
        condPenalties: z.array(
          z.object({
            host: z.string(),
            misses: z.number().int(),
            factor: z.number(),
            lastAt: C.IsoDateTime,
          }),
        ),
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
          }),
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
    // ⚠️ 这里必须同时写 `as const`：只写 `satisfies EndpointSpec` 时，satisfies 会先给
    // 属性套上 `path: string` 的上下文类型，字面量被拓宽成 string；外层对象的 `as const`
    // 收不回来。结果是 `authSpec.status.path` 类型是 string，Hono 取不到路径字面量，
    // **`/api/status` 静默不进 AppType**（服务端类型全绿，但前端 hc 里没有这个键）。
  } as const satisfies EndpointSpec,
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
  sessionsList: {
    method: 'get',
    path: '/api/sessions',
    auth: 'user',
    response: z.object({ sessions: z.array(M.SessionDeviceSchema) }),
  },
  sessionRevoke: {
    method: 'delete',
    path: '/api/sessions/:id',
    auth: 'user',
    response: C.OkSchema,
  },
  sessionsRevokeOthers: {
    method: 'post',
    path: '/api/sessions/revoke-others',
    auth: 'user',
    response: z.object({ ok: z.boolean(), revoked: z.number().int() }),
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
  refreshMinutes: z
    .union([z.number().int(), z.literal('global'), z.literal(''), z.null()])
    .optional(),
  /** 摘要型订阅：抓原文页提取全文 */
  fullText: z.boolean().optional(),
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
  /* GET /api/feeds/export —— 导出 OPML。
   * 为什么是「返回一段文本」而不是直接 `text/xml`：v2 的所有响应都要过
   * `assertResponse` 校验契约，把 OPML 塞在 JSON 字段里才能保持「一个响应一个形状」，
   * 下载动作交给前端（Blob + a[download]）去做，服务端不关心用户存到哪。 */
  exportOpml: {
    method: 'get',
    path: '/api/feeds/export',
    auth: 'user',
    response: z.object({
      ok: z.boolean(),
      count: z.number().int(),
      opml: z.string(),
    }),
  },
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
  /** 当前抓取进度（给「刷新全部」按钮旁展示；只读、无副作用） */
  refreshProgress: {
    method: 'get',
    path: '/api/feeds/refresh-progress',
    auth: 'user',
    response: z.object({
      running: z.boolean(),
      label: z.string(),
      total: z.number().int(),
      done: z.number().int(),
      startedAt: C.IsoDateTime.nullable(),
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
      /** 本轮因连续失败被自动停用的频道数（optional：老客户端不认也无所谓） */
      autoDisabled: z.number().int().optional(),
      /** 本轮按条目过滤规则丢弃的条数 */
      filtered: z.number().int().optional(),
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
      result: z
        .object({ error: z.string().nullable(), added: z.number().int().optional() })
        .passthrough(),
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
      probe: z
        .object({
          ok: z.boolean(),
          error: z.string().optional(),
          added: z.number().int().optional(),
        })
        .optional(),
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
  /** 手动标签（entries.tags） */
  tag: z.string().max(60).optional(),
  /** AI 标签（entry_ai_tags）：与手动标签物理隔离，点文章页「AI 标签」组传这个 */
  aiTag: z.string().max(60).optional(),
  unread: z.enum(['1']).optional(),
  fav: z.enum(['1']).optional(),
  watch: z.enum(['watch', 'block']).optional(),
  scope: z.enum(['all', 'cards']).optional(),
  /* feeds=1,2,3 频道 id 清单。加长度上限：这是唯一没设防的字符串参数，
   * 不设限时可塞进任意长的串直达 SQL 的 inArray，纯耗资源。4000 字符足够
   * 几百个频道（每个 id + 逗号约 10 字符），正常分组筛选远到不了。 */
  feeds: z.string().max(4000).optional(),
  /* name = 按标题排。契约里必须有这一档：LEGACY 的 layout.sort 就写着 new/old/name，
   * 只让服务端支持前两档的话，存了 name 的账号会静默退回「新→旧」——
   * 设置里显示「按名称」而列表按时间排，是最难查的那类不一致。 */
  sort: z.enum(['new', 'old', 'name']).optional(),
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
  aiTag: z.string().max(60).optional(),
  watch: z.enum(['watch', 'block']).optional(),
  /* 收藏视图下的一键已读也必须只命中「收藏且未读」。
   * 少这个字段，「在收藏视图点全部已读」会把范围内所有未读都标掉 ——
   * 用户只看到几十条收藏，实际标掉了几千条。 */
  fav: z.enum(['1']).optional(),
});
export type ReadAllBody = z.infer<typeof readAllBody>;

/* 批量已读的撤销：作用域必须和那次 read-all 完全一致，at 是服务端回执里的
 * 批次时间戳（同一批 UPDATE 写进去的 read_at）。服务端只回滚「仍是已读且
 * read_at 恰好等于这一批」的行，所以不会误伤之后单独标记的已读。 */
export const readAllUndoBody = readAllBody.extend({
  at: z.string().min(10).max(40),
});
export type ReadAllUndoBody = z.infer<typeof readAllUndoBody>;

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
    response: z.object({
      ok: z.boolean(),
      updated: z.number().int(),
      /* 撤销凭据：这一批 UPDATE 的 read_at（ISO）。updated = 0 时也给，
         客户端只在 updated > 0 时展示「撤销」。 */
      undo: z.object({ at: z.string() }),
    }),
  },
  readAllUndo: {
    method: 'post',
    path: '/api/entries/read-all/undo',
    auth: 'user',
    body: readAllUndoBody,
    response: z.object({ ok: z.boolean(), reverted: z.number().int() }),
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
  layout: M.LayoutSchema,
  filters: z.array(M.FilterRuleSchema),
  watchRules: z.array(M.WatchRuleSchema),
  watchExpireDays: z.number().int().min(0).max(3650),
  webhookUrl: z.string(),
  digest: M.DigestConfigSchema,
  rules: z.array(M.RuleSchema),
  llm: M.LlmViewSchema,
  /** 厂商 / 接入点（0017）：名称 + 地址 + 加密 Key。 */
  llmVendors: z.array(M.LlmVendorViewSchema),
  /** 模型列表；默认模型只有一个，路由 providerId 指向这里的 id。 */
  llmModels: z.array(M.LlmModelViewSchema),
  /** 任务级开关与模型分配；空对象 = 全开 + 全走默认模型。 */
  llmRoutes: M.LlmRoutesSchema,
});
export type PrefsResponse = z.infer<typeof prefsResponse>;

export const prefsPatchBody = z.object({
  groupOrder: z.array(z.string()).optional(),
  // 各组都是「部分更新」：前端只提交改动的键，服务端按 legacy 的 sanitize 逐键回落默认
  layout: M.LayoutSchema.partial().optional(),
  filters: z.array(M.FilterRuleSchema).optional(),
  watchRules: z.array(M.WatchRuleInputSchema).optional(),
  watchExpireDays: z.number().int().min(0).max(3650).optional(),
  webhookUrl: z.string().optional(),
  digest: M.DigestConfigSchema.partial().optional(),
  // AI 标签开关已收口到 llmRoutes.ai_tags（0016）：prefs.aiTags 废弃，见 routes.ai_tags
  rules: z.array(M.RuleSchema).optional(),
  llm: M.LlmConfigSchema.partial().optional(),
  /** 单条厂商 upsert（id 省略=新增）。Key 属于厂商，换模型不用重填。 */
  llmVendor: M.LlmVendorInputSchema.optional(),
  /** 删除厂商（id）。该厂商下的模型一并删除，引用它们的路由自动回落到默认模型。 */
  llmVendorDelete: z.string().max(64).optional(),
  /** 单条模型 upsert（id 省略=新增）。 */
  llmModel: M.LlmModelInputSchema.optional(),
  /** 删除模型（id）。引用它的路由自动回落到默认模型。 */
  llmModelDelete: z.string().max(64).optional(),
  /** 任务路由表：按能力键部分更新（只提交改动的键，服务端逐键合并；record 天然可缺键）。 */
  llmRoutes: M.LlmRoutesSchema.optional(),
});
export type PrefsPatchBody = z.infer<typeof prefsPatchBody>;

export const prefsUpdateResponse = z.object({
  ok: z.boolean(),
  groupOrder: z.array(z.string()),
  layout: M.LayoutSchema,
  filters: z.array(M.FilterRuleSchema),
  watchRules: z.array(M.WatchRuleSchema),
  watchExpireDays: z.number().int().min(0).max(3650),
  webhookUrl: z.string(),
  digest: M.DigestConfigSchema,
  rules: z.array(M.RuleSchema),
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
  username: z
    .string()
    .regex(/^[\w.@-]{1,40}$/)
    .optional(),
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
    response: z.object({
      ok: z.boolean(),
      user: z.object({ id: z.string(), username: z.string(), role: C.RoleSchema }),
    }),
  },
  userPatch: {
    method: 'patch',
    path: '/api/users/:id',
    auth: 'admin',
    body: userPatchBody,
    response: z.object({
      ok: z.boolean(),
      user: z.object({ id: z.string(), username: z.string(), role: C.RoleSchema }),
    }),
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

export const testLlmBody = z.object({
  llm: M.LlmConfigSchema.partial().optional(),
  /** 指定测哪个已保存的模型（0017）；不传 = 默认模型。测试不受能力开关限制。 */
  modelId: z.string().max(64).optional(),
});
export type TestLlmBody = z.infer<typeof testLlmBody>;

export const digestGenerateBody = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  feeds: z.array(z.number().int().positive()).optional(),
  force: z.boolean().optional(),
});
export type DigestGenerateBody = z.infer<typeof digestGenerateBody>;

/** 单条目 AI 动作。不落库缓存（Phase 1：按需调用，见 ai-feature-plan.md）。 */
export const entryAiBody = z.object({
  action: z
    .enum(['summary', 'keypoints', 'translate', 'explain'])
    .describe('summary=摘要 / keypoints=关键要点 / translate=翻译 / explain=通俗解释'),
  /** translate 时的目标语言，默认简体中文；其余动作忽略。 */
  targetLang: z.string().max(20).optional(),
});
export type EntryAiBody = z.infer<typeof entryAiBody>;

/** 用量口径：一次「总览」= 今日 / 近 7 天 / 近 30 天 + 按功能拆分 + 按天序列。 */
export const aiUsageTotal = z.object({
  calls: z.number().int(),
  fails: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
});

export const aiUsageResponse = z.object({
  today: aiUsageTotal,
  days7: aiUsageTotal,
  days30: aiUsageTotal,
  byKind: z.array(
    z.object({
      kind: z.string(),
      calls: z.number().int(),
      fails: z.number().int(),
      totalTokens: z.number().int(),
    }),
  ),
  series: z.array(
    z.object({
      date: z.string(),
      calls: z.number().int(),
      totalTokens: z.number().int(),
    }),
  ),
});
export type AiUsageResponse = z.infer<typeof aiUsageResponse>;

/** 拉取上游模型列表（OpenAI 兼容 `GET {base}/models`）。
 *  可临时带未保存的 baseUrl / apiKey —— 与「测试连接」同口径，刚填完就能试。 */
export const llmModelsBody = z.object({
  llm: M.LlmConfigSchema.partial().optional(),
  /** 指定拉哪个已保存厂商的模型列表（0017）；不传 = 默认模型的厂商。 */
  vendorId: z.string().max(64).optional(),
});
export type LlmModelsBody = z.infer<typeof llmModelsBody>;

/** 一条请求明细。`kind` 原样回，中文名由前端词典映射（与 AI 用量同一套）。 */
export const aiRequestItem = z.object({
  id: z.number().int(),
  kind: z.string(),
  model: z.string(),
  label: z.string(),
  ok: z.boolean(),
  calls: z.number().int(),
  durationMs: z.number().int(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  error: z.string(),
  createdAt: z.string(),
});
export type AiRequestItem = z.infer<typeof aiRequestItem>;

export const aiRequestsResponse = z.object({
  requests: z.array(aiRequestItem),
  /** 明细保留口径（条数 / 天数），界面上如实写出来 */
  keep: z.number().int(),
  keepDays: z.number().int(),
});
export type AiRequestsResponse = z.infer<typeof aiRequestsResponse>;

/* ============================ AI 异步任务 ============================
 * 长任务（单篇生成 / AI 标签 / 日报）改成「提交 → 轮询」：提交立即返回 jobId，
 * 前端按约定间隔取状态。这样请求都变成短连接，网关的 100 秒读超时不再生效。
 */

/** 任务种类。MCP 不在此列：MCP 协议本身是请求-响应，改异步会破坏客户端兼容。 */
export const aiJobKind = z.enum(['entry_ai', 'ai_tags', 'digest', 'explore']);
export type AiJobKind = z.infer<typeof aiJobKind>;

/** 状态单向流转：queued → running → succeeded | failed。 */
export const aiJobStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type AiJobStatus = z.infer<typeof aiJobStatus>;

export const aiJobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  /** 在做什么：文章标题 / 「日报 2026-11-16」 */
  label: z.string(),
  /** 出参：entry_ai → {result} / ai_tags → {tags,model} / digest → {cached,digest} */
  result: z.unknown().nullable(),
  /** 失败原因（稳定错误码，前端过词典）；成功为空串 */
  error: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** 已耗时：运行中 = 至今，结束 = 总时长 */
  durationMs: z.number().int(),
});
export type AiJob = z.infer<typeof aiJobSchema>;

/**
 * 提交任务的入参。`kind` 决定哪些字段有意义，其余忽略：
 * - entry_ai / ai_tags：`entryId`（必填）、entry_ai 另有 `action` / `targetLang`
 * - digest：`date` / `force`
 */
/** 探索会话里的一轮历史。refs 带条目名，供服务端把 [#n] 替换成书名号。 */
export const exploreHistoryTurnSchema = z.object({
  question: z.string().max(300),
  answer: z.string().max(4000),
  refs: z.array(z.object({ id: z.string().max(40), name: z.string().max(300) })).max(40),
});
export type ExploreHistoryTurn = z.infer<typeof exploreHistoryTurnSchema>;
export type ExploreHistory = ExploreHistoryTurn[];

export const aiJobBody = z.object({
  kind: aiJobKind,
  entryId: z.union([z.string(), z.number()]).optional(),
  action: z.enum(['summary', 'keypoints', 'translate', 'explain']).optional(),
  targetLang: z.string().max(20).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  force: z.boolean().optional(),
  /** digest 的自定义频道范围；不传按账号 prefs.digest 的口径 */
  feeds: z.array(z.number().int().positive()).max(500).optional(),
  /** explore：用户的自然语言问题（1~300 字） */
  question: z.string().min(1).max(300).optional(),
  /** explore：本次会话的全部历史轮次（前端内存态，刷新即清）。轮数上限只防滥用，不做业务截断。 */
  history: z.array(exploreHistoryTurnSchema).max(200).optional(),
});
export type AiJobBody = z.infer<typeof aiJobBody>;

/** 探索问答引用的一条订阅条目：带 id 才能跳到文章页并展开。 */
export const exploreRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  feedName: z.string(),
  date: z.string(),
  desc: z.string(),
  image: z.string().nullable(),
});
export type ExploreRef = z.infer<typeof exploreRefSchema>;

/** 探索问答结果：answer 是自然语言答案，refs 是它引用的本人条目。 */
export const exploreResultSchema = z.object({
  answer: z.string(),
  refs: z.array(exploreRefSchema),
  model: z.string(),
  matched: z.number().int(),
});
export type ExploreResult = z.infer<typeof exploreResultSchema>;

export const ai = {
  /** AI 消耗量统计（只读本人）。days 控制按天序列与合计的窗口，默认 30。 */
  apiUsage: {
    method: 'get',
    path: '/api/ai-usage',
    auth: 'user',
    query: z.object({ days: z.coerce.number().int().min(1).max(365).optional() }),
    response: aiUsageResponse,
  },
  testLlm: {
    method: 'post',
    path: '/api/digest/test-llm',
    auth: 'user',
    body: testLlmBody,
    // 注意：测试失败仍返回 200，ok:false + error；成功返回 ok:true + reply
    response: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      reply: z.string().optional(),
    }),
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
    query: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    response: z.object({ date: z.string(), digest: M.DigestSchema.nullable() }),
  },
  generate: {
    method: 'post',
    path: '/api/digest/generate',
    auth: 'user',
    body: digestGenerateBody,
    response: z.object({ ok: z.boolean(), cached: z.boolean(), digest: M.DigestSchema }),
  },
  /**
   * 单条目 AI（按需调用，不落库）。
   * 权限 write：调用模型消耗用户额度，与日报生成同档；读接口只给 user。
   * 失败不 500：ok:false 并把原因写进 result，前端直接呈现（降级可读）。
   */
  entryAi: {
    method: 'post',
    path: '/api/entry/:id/ai',
    auth: 'user',
    body: entryAiBody,
    response: z.object({ ok: z.boolean(), result: z.string() }),
  },
  /**
   * 单条目 AI 标签（Phase 2 · 智能标签）。
   * GET：读本人该条的 AI 标签（owner 隔离；无记录则返回空数组 + status 'pending'），
   *   主要由列表/详情里的 toCard 顺带带出，这里供「手动重算后即时回读」用。
   * POST：按需重算（auth 标 user，但路由用 requireAuth 'write' 拦截，消耗模型额度；
   *   降级可读——模型失败返回 ok:false + error，不 500）。
   */
  entryAiTags: {
    method: 'get',
    path: '/api/entry/:id/ai-tags',
    auth: 'user',
    response: z.object({
      id: z.string(),
      tags: z.array(z.string()),
      status: z.string(),
      model: z.string().nullable(),
    }),
  },
  entryAiTagsSet: {
    method: 'post',
    path: '/api/entry/:id/ai-tags',
    auth: 'user',
    response: z.object({
      ok: z.boolean(),
      id: z.string(),
      tags: z.array(z.string()),
      status: z.string(),
      model: z.string().nullable(),
      error: z.string().optional(),
    }),
  },
  /**
   * 拉上游模型列表，供设置页「模型名称」下拉。
   * 失败不 500：ok:false + error（上游不兼容 / Key 无效 / 网络不通都可能），
   * 前端退回手填并说明原因。
   */
  llmModels: {
    method: 'post',
    path: '/api/llm/models',
    auth: 'user',
    body: llmModelsBody,
    response: z.object({
      ok: z.boolean(),
      models: z.array(z.string()),
      error: z.string().optional(),
    }),
  },
  /** 最近调用明细（只读本人）。limit 默认 50，上限 200（= 表的保留上限）。 */
  requests: {
    method: 'get',
    path: '/api/ai-requests',
    auth: 'user',
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
    response: aiRequestsResponse,
  },
  /**
   * 提交一个 AI 任务。**立即返回**（<100ms），真正的模型调用在服务端进程内异步执行。
   * 权限 write：会消耗账号额度。同一账号同时排队/运行的任务数有上限（超了 429 E_AI_BUSY）。
   */
  aiJobCreate: {
    method: 'post',
    path: '/api/ai/jobs',
    auth: 'user',
    body: aiJobBody,
    response: z.object({ ok: z.boolean(), job: aiJobSchema }),
  },
  /** 轮询任务状态。只读本人：拿别人的 jobId 一律 404。 */
  aiJobGet: {
    method: 'get',
    path: '/api/ai/jobs/:id',
    auth: 'user',
    response: z.object({ ok: z.boolean(), job: aiJobSchema }),
  },
} as const satisfies Record<string, EndpointSpec>;

/* ============================ 数据导出 / 备份 ============================ */

/** 都是 tar.gz 二进制下载：响应体不做 JSON 校验，前端直接用链接触发下载。 */
export const exportApi = {
  userExport: {
    method: 'get',
    path: '/api/export',
    auth: 'user',
    /** llm=1 时附 llm.json（含解密后的 API Key），默认不含 */
    query: z.object({ llm: z.enum(['0', '1']).optional() }),
    response: z.unknown(),
    binary: true,
  },
  siteBackup: {
    method: 'get',
    path: '/api/backup',
    auth: 'admin',
    response: z.unknown(),
    binary: true,
  },
} as const satisfies Record<string, EndpointSpec>;

/* ============================ 数据导入 / 整站还原 ============================ */

const importCount = z.object({
  inserted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

/**
 * 模型配置的合并结果（与偏好一样「只补空、不覆盖」）：
 * - `applied`：账号原本没配模型，已按包内配置写入（Key 用本机主密钥重新加密）；
 * - `absent`：包里没带 `llm.json`（导出时没勾选）；
 * - `already-configured`：账号已有模型配置，包内的那份被保留现状地跳过；
 * - `url-blocked`：包里的模型地址没通过出网安全校验（SSRF 基线），整条跳过。
 */
const llmImportOutcome = z.enum(['applied', 'absent', 'already-configured', 'url-blocked']);

/** 上传的是原始 tar.gz 请求体，不按 JSON 校验；响应才是 JSON。 */
export const importApi = {
  userImport: {
    method: 'post',
    path: '/api/import',
    auth: 'user',
    body: z.unknown(),
    response: z.object({
      ok: z.boolean(),
      kind: z.literal('user'),
      feeds: importCount,
      entries: importCount,
      digests: importCount,
      prefs: z.boolean(),
      llm: llmImportOutcome,
    }),
  },
  siteRestore: {
    method: 'post',
    path: '/api/restore',
    auth: 'admin',
    body: z.unknown(),
    response: z.object({
      ok: z.boolean(),
      kind: z.literal('site'),
      counts: z.object({
        users: z.number().int().nonnegative(),
        accounts: z.number().int().nonnegative(),
        feeds: z.number().int().nonnegative(),
        entries: z.number().int().nonnegative(),
        digests: z.number().int().nonnegative(),
        images: z.number().int().nonnegative(),
        articles: z.number().int().nonnegative(),
        aiTags: z.number().int().nonnegative(),
        mcpTokens: z.number().int().nonnegative(),
        aiUsage: z.number().int().nonnegative(),
        aiRequestLog: z.number().int().nonnegative(),
      }),
    }),
  },
} as const satisfies Record<string, EndpointSpec>;

/* ============================ 图片代理 ============================ */

export const img = {
  proxy: {
    method: 'get',
    path: '/api/img',
    auth: 'user',
    /** `w` 是卡片 / 缩略图的宽度档位（320/640/960），服务端按档位裁切并独立缓存；
     *  省略时返回默认长边（1280）版本。 */
    query: z.object({
      u: z.string().url(),
      w: z.coerce.number().int().positive().optional(),
    }),
    response: z.unknown(),
    binary: true,
  },
} as const satisfies Record<string, EndpointSpec>;

/* ============================ MCP 接口令牌 ============================ */

/**
 * MCP（Model Context Protocol）接口的访问令牌，交给外部 AI 客户端当
 * `Authorization: Bearer flm_...` 用。与浏览器会话完全隔离：
 * - 哈希落库，明文只在创建响应里出现一次；
 * - scope 两档：`read`（P1 全部工具）/ `write`（预留，写工具上线后生效）；
 * - 吊销是软删（revokedAt），列表里不再出现。
 */
export const mcpTokenScope = z.enum(['read', 'write']);
export type McpTokenScope = z.infer<typeof mcpTokenScope>;

export const mcpTokenInfo = z.object({
  id: z.string(),
  name: z.string(),
  scope: mcpTokenScope,
  /** 明文前缀（如 `flm_ab12cd34`），用于在客户端侧辨认 token 归属。 */
  prefix: z.string(),
  createdAt: C.IsoDateTime,
  lastUsedAt: C.IsoDateTime.nullable(),
});
export type McpTokenInfo = z.infer<typeof mcpTokenInfo>;

export const mcpTokenCreateBody = z.object({
  name: z.string().min(1).max(40),
  scope: mcpTokenScope.default('read'),
});
export type McpTokenCreateBody = z.infer<typeof mcpTokenCreateBody>;

export const mcpTokens = {
  list: {
    method: 'get',
    path: '/api/mcp-tokens',
    auth: 'user',
    response: z.object({ tokens: z.array(mcpTokenInfo) }),
  },
  create: {
    method: 'post',
    path: '/api/mcp-tokens',
    auth: 'user',
    body: mcpTokenCreateBody,
    /** `secret` 是完整明文，只在这一次响应里出现。 */
    response: z.object({ token: mcpTokenInfo, secret: z.string() }),
  },
  revoke: {
    method: 'delete',
    path: '/api/mcp-tokens/:id',
    auth: 'user',
    response: C.OkSchema,
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
  export: exportApi,
  import: importApi,
  img,
  mcpTokens,
} as const;

export type Contract = typeof contract;
