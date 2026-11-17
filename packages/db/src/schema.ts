/**
 * FeedLore v2 — Drizzle 数据库 schema（单一真相源的物理层）
 *
 * 设计要点：
 * 1. v2 是新应用（apps/server + apps/web + packages/*），本文件定义的是**全新 schema**，
 *    不是原地改 legacy 表。legacy（apps/legacy/db.js）仅作参考。
 * 2. 用户 id 采用 better-auth 标准 **text（cuid）**；legacy 的 bigserial id 在 P7 切换时
 *    一次性迁移（同时转换 feeds.owner_id / digests.owner_id 引用）。避免 bigint 与
 *    better-auth 类型推断冲突，守住「类型即契约」。
 * 3. auth 四表（users/sessions/accounts/verifications）列名用 snake_case，与 better-auth
 *    drizzleAdapter({ usePlural: true }) 期望一致。P3 在 createAuth 里直接复用本 schema。
 * 4. 业务表（feeds/entries/digests/image_cache/settings）严格对齐 legacy 列，
 *    feeds.id / entries.id 用 bigserial（mode:number），与 legacy 自增一致。
 * 5. 索引镜像 legacy 的高频路径（未读徽标、收藏、关注/屏蔽、发布时间倒序、模糊搜索）。
 */

import { relations } from 'drizzle-orm';
import {
  pgTable,
  text,
  boolean,
  timestamp,
  jsonb,
  bigserial,
  bigint,
  integer,
  smallint,
  real,
  date,
  customType,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

/**
 * bytea 列（二进制，存图片 WebP/原图像素字节）。
 * drizzle-orm 0.44 的 pg-core 未从顶层导出 bytea 构造器，这里用 customType 等价定义。
 * node-postgres 对 bytea 返回 Buffer，data/driverData 均按 Buffer 处理。
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/* ============================================================================
 * Auth schema（better-auth 兼容，usePlural → 表名 users/sessions/accounts/verifications）
 * 字段名 camelCase 模型 ↔ snake_case 列名，由 Drizzle 映射。
 * ==========================================================================*/

export const users = pgTable('users', {
  id: text('id').primaryKey(), // better-auth 生成 cuid
  name: text('name'),
  username: text('username').unique(), // username 插件
  // username 插件要求：展示用用户名（与登录用的规范化 username 分离，可为空）
  displayUsername: text('display_username'),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // admin 插件
  role: text('role').notNull().default('user'),
  banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { mode: 'date' }),
  // 业务扩展：布局/过滤/关注屏蔽/日报配置（每用户加密 LLM key 不在此，见 user_llm；外观存浏览器本机）
  prefs: jsonb('prefs').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  impersonatedBy: text('impersonated_by'),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { mode: 'date' }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { mode: 'date' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
});

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
});

/* ============================================================================
 * 业务 schema（对齐 legacy，外键指向 users.id 的 text 类型）
 * ==========================================================================*/

export const feeds = pgTable(
  'feeds',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title'),
    siteUrl: text('site_url'),
    description: text('description'),
    iconUrl: text('icon_url'),
    enabled: boolean('enabled').notNull().default(true), // 采集开关
    cardEnabled: boolean('card_enabled').notNull().default(true), // 卡片页展示开关
    groupName: text('group_name'), // NULL/'' = 未分组
    customTitle: text('custom_title'), // 优先于抓取来的 title
    sortOrder: integer('sort_order').notNull().default(0),
    refreshMinutes: integer('refresh_minutes'), // NULL = 跟随全局
    // 摘要型订阅：抓原文页面并提取全文（默认关，按频道自愿开启）
    fullText: boolean('full_text').notNull().default(false),
    etag: text('etag'),
    lastModified: text('last_modified'),
    lastStatus: text('last_status'),
    lastError: text('last_error'),
    failStreak: smallint('fail_streak').notNull().default(0),
    lastFetchedAt: timestamp('last_fetched_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('feeds_owner_id_url_key').on(t.ownerId, t.url), // 每用户内 URL 唯一
  ],
);

export const entries = pgTable(
  'entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    feedId: bigint('feed_id', { mode: 'number' })
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    guid: text('guid').notNull(),
    title: text('title').notNull(),
    link: text('link'),
    pwd: text('pwd'),
    description: text('description'),
    content: text('content'), // 展开全文（v10 起单独存）
    size: text('size'),
    tags: text('tags').array().notNull().default([]),
    image: text('image'), // 单图（卡片/缩略图）
    images: text('images').array(), // 多图（v15）
    sourceUrl: text('source_url'),
    publishedAt: timestamp('published_at', { mode: 'date' }),
    fetchedAt: timestamp('fetched_at', { mode: 'date' }).notNull().defaultNow(),
    isRead: boolean('is_read').notNull().default(false),
    readAt: timestamp('read_at', { mode: 'date' }),
    isFavorite: boolean('is_favorite').notNull().default(false),
    favoritedAt: timestamp('favorited_at', { mode: 'date' }),
    bodyJson: text('body_json'), // 图文块 JSON（v16）
    // 正文块格式：1 = v1 纯文本段落（老数据），2 = 结构化块（标题/列表/引用/代码/链接）
    bodyVersion: smallint('body_version').notNull().default(1),
    links: text('links').array(), // 可复制链接（v17）
    watchState: text('watch_state'), // null|'watch'|'block'（v21）
    watchRule: text('watch_rule'),
    // 进入「关注」的时刻：规则可设置保留天数，到期自动移除关注标记（屏蔽不受影响）
    watchTaggedAt: timestamp('watch_tagged_at', { mode: 'date' }),
  },
  (t) => [
    uniqueIndex('entries_feed_id_guid_key').on(t.feedId, t.guid),
  ],
);

export const digests = pgTable(
  'digests',
  {
    date: date('date', { mode: 'string' }).notNull(), // YYYY-MM-DD
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull(), // 日报 HTML/结构化内容
    model: text('model'),
    fallback: boolean('fallback').notNull().default(false),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('digests_owner_date_key').on(t.ownerId, t.date), // 每用户每天一份
  ],
);

export const imageCache = pgTable('image_cache', {
  key: text('key').primaryKey(), // sha256(归一化 URL)
  contentType: text('content_type').notNull(),
  data: bytea('data').notNull(), // 压缩后的 WebP 字节 / 原图字节
  width: integer('width'),
  height: integer('height'),
  origSize: integer('orig_size'),
  size: integer('size').notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
});

/** 摘要型订阅的全文抓取缓存：同一篇原文只解析一次，失败不落库（下次重试） */
export const articleCache = pgTable('article_cache', {
  url: text('url').primaryKey(),
  content: text('content'),
  bodyJson: text('body_json'),
  images: text('images').array().notNull().default([]),
  fetchedAt: timestamp('fetched_at', { mode: 'date' }).notNull().defaultNow(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
});

/** 每用户加密 LLM key（业务域，better-auth 不碰）。
 *  residualUserLlm 与 resolveUserLlm 回退逻辑在 packages/ai。 */
export const userLlm = pgTable('user_llm', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  encryptedKey: text('encrypted_key'), // 加密后的 apiKey（AEAD）
  baseUrl: text('base_url'),
  model: text('model'),
  /** NULL = 用默认温度（0.3）。契约里 temperature 是可写字段，没有列会变成「改了存不上」。 */
  temperature: real('temperature'),
  thinking: boolean('thinking').notNull().default(false),
  thinkingDepth: integer('thinking_depth').notNull().default(0),
  /**
   * 任务级能力开关与模型路由（0015）。空对象 = 全部能力开启、全走默认槽。
   * 形态见 0015 迁移注释；服务端解析时逐键容错，不信任前端结构。
   */
  routes: jsonb('routes').$type<LlmRoutes>().notNull().default({}),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
});

/**
 * 多路 AI 提供商（0015）：一个账号可配多套 baseUrl/key/model，按任务分配。
 * 每行独立加密 Key；user_llm 原有三件套保留为「默认槽」向后兼容。
 */
export const llmProviders = pgTable('llm_providers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull().default(''),
  encryptedKey: text('encrypted_key'),
  baseUrl: text('base_url'),
  model: text('model'),
  temperature: real('temperature'),
  thinking: boolean('thinking').notNull().default(false),
  thinkingDepth: integer('thinking_depth').notNull().default(0),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
});

/** 单个能力的路由项；providerId='default' 或省略表示回落 user_llm 默认槽。 */
export interface LlmRoute {
  enabled?: boolean;
  providerId?: string;
  /** 单篇 AI 四动作各自的模型分配（不单独开关，开关按 entry_ai 整体）。 */
  actions?: Record<string, string>;
}
/** 能力键见契约 AiCapability；这里用宽松 Record，服务端按白名单取键。 */
export type LlmRoutes = Record<string, LlmRoute>;

/**
 * MCP（Model Context Protocol）接口令牌。
 *
 * 与浏览器会话完全隔离：`/mcp` 只认 `Authorization: Bearer flm_...`，不读 Cookie，
 * 因此不进 CSRF/同源模型。token 只存 SHA-256（明文只在创建响应出现一次）；
 * prefix 是明文前 12 字符，供设置页与日志辨认归属。
 */
export const mcpTokens = pgTable('mcp_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** 'read' | 'write'（P1 只有 read 工具；write 预留给后续写工具） */
  scope: text('scope').notNull().default('read'),
  tokenHash: text('token_hash').notNull().unique(), // sha256 hex
  prefix: text('prefix').notNull(),
  lastUsedAt: timestamp('last_used_at', { mode: 'date' }),
  revokedAt: timestamp('revoked_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
});

/**
 * AI 用量按天按功能聚合（AI 消耗量统计）。
 *
 * 为什么聚合而不是逐次明细：统计只需要「谁、哪天、哪项功能、调了几次、烧多少 token」，
 * 聚合后行数是 账号数 × 天数 × 功能数（可控），查询永远是索引命中；
 * 逐次明细会让表随调用量线性增长，却没有对应的分析需求。
 *
 * - `kind`：digest（日报）/ entry_ai（单篇 AI）/ ai_tags（自动打标）/ mcp（外部调用）/ test（测试模型）
 * - `calls` / `fails`：调用次数与失败次数（失败也计入 calls，同时单独记 fails）
 * - token 只有上游返回 usage 时才累加，所以可能与 calls 不成比例（上游没回 usage 就是 0）
 */
export const aiUsageDaily = pgTable(
  'ai_usage_daily',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(), // YYYY-MM-DD（Asia/Shanghai）
    kind: text('kind').notNull(),
    calls: integer('calls').notNull().default(0),
    fails: integer('fails').notNull().default(0),
    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull().default(0),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.date, t.kind] }),
  ],
);

/**
 * AI 自动生成的条目标签（Phase 2 · 智能标签）。
 *
 * 与手动 `entries.tags` **物理隔离**：AI 误标不会污染用户手动标签，且可整账号重算/关闭。
 * - `user_id`：按账号隔离（删除用户级联清）；
 * - `entry_id`：指向条目（删除条目级联清）；
 * - 每 (user_id, entry_id) 唯一，重复生成只更新 `tags` 与 `updated_at`；
 * - `status`：pending / done / failed（失败保留空 tags 与 error，便于前端提示与重试）。
 */
export const entryAiTags = pgTable(
  'entry_ai_tags',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entryId: bigint('entry_id', { mode: 'number' })
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    tags: text('tags').array().notNull().default([]),
    model: text('model'),
    promptVersion: integer('prompt_version').notNull().default(1),
    status: text('status').notNull().default('done'),
    error: text('error'),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('entry_ai_tags_user_entry_key').on(t.userId, t.entryId),
  ],
);

/**
 * AI 请求明细（设置 → 模型 →「模型状态」的数据源）。
 *
 * 与 `ai_usage_daily` 的分工：那张表回答「哪天、哪项功能烧了多少」，这张表回答
 * 「最近这次调用在做什么、成没成、多慢」。明细只保留每个账号最近
 * `AI_REQUEST_KEEP`(200) 条且不超过 `AI_REQUEST_KEEP_DAYS`(30) 天，写入时顺带裁剪
 * （见 apps/server/src/lib/aiUsage.ts），所以行数有上界，不会随调用量无限长。
 *
 * 不存提示词正文：`label` 只记「这次在做什么」（文章标题 / 日报日期 / MCP 工具名），
 * 够列表辨认即可，不把用户正文搬进日志表。
 */
export const aiRequestLog = pgTable('ai_request_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** digest / entry_ai / ai_tags / mcp / test，与 ai_usage_daily.kind 同一套取值 */
  kind: text('kind').notNull(),
  model: text('model').notNull().default(''),
  label: text('label').notNull().default(''),
  ok: boolean('ok').notNull().default(true),
  /** 一轮业务调用实际打了几次模型（日报 map-reduce 会分批），明细只落一行 */
  calls: integer('calls').notNull().default(1),
  durationMs: integer('duration_ms').notNull().default(0),
  promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull().default(0),
  completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull().default(0),
  /** 失败原因（已收敛成短句）；成功时为空串 */
  error: text('error').notNull().default(''),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
});

/**
 * AI 异步任务（`ai_jobs`）。
 *
 * 为什么要落库而不是纯内存：单篇生成实测 4~160 秒、日报可达数分钟，都长于网关的
 * 100 秒读超时。改成「提交即返回 jobId → 前端轮询」后，长连接消失；
 * 任务本身必须可查，否则前端只能靠猜。
 *
 * - `status`：queued → running → succeeded / failed（单向，不回退）
 * - `input` / `result` 用 jsonb：三种任务的出入参形状不同，建列会让表迅速长歪
 * - 进程重启时残留的 queued/running 由启动清扫标成 failed（见 lib/aiJobs.ts）
 */
export const aiJobs = pgTable('ai_jobs', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** entry_ai / ai_tags / digest */
  kind: text('kind').notNull(),
  /** queued / running / succeeded / failed */
  status: text('status').notNull().default('queued'),
  /** 界面上「在做什么」：文章标题 / 日报日期 */
  label: text('label').notNull().default(''),
  /** 入参（entryId / action / date / force …），形状由 kind 决定 */
  input: jsonb('input').notNull().default({}),
  /** 出参（entry_ai: {result} / ai_tags: {tags,model} / digest: {cached,digest}） */
  result: jsonb('result'),
  error: text('error').notNull().default(''),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { mode: 'date' }),
  finishedAt: timestamp('finished_at', { mode: 'date' }),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
});

/* ============================================================================
 * 索引（镜像 legacy 高频路径）
 * ----------------------------------------------------------------------------
 * 注意：drizzle-orm 0.44.7 的 index().on(列) 存在回归（列对象不再携带
 * defaultConfig，indexes.cjs 仍引用它导致 JSON.parse(undefined) 抛错），且
 * drizzle-kit 无法为 DESC NULLS LAST / GIN+gin_trgm_ops 这类表达式索引生成 SQL。
 * 因此所有性能索引统一在迁移文件 0001_perf_indexes.sql 里用原始 SQL 创建，
 * 本文件只保留表结构与 unique 约束（uniqueIndex 列定义内联）。
 * 索引清单（见 0001）：
 *   feeds_owner_idx           (owner_id, sort_order, id)
 *   entries_pub_idx           (published_at DESC NULLS LAST, id DESC)
 *   entries_feed_pub_idx      (feed_id, published_at DESC NULLS LAST, id DESC)
 *   entries_tags_idx          USING gin (tags)
 *   entries_unread_idx        (feed_id) WHERE is_read = false
 *   entries_watch_idx         (watch_state, published_at DESC NULLS LAST, id DESC) WHERE watch_state IS NOT NULL
 *   entries_fav_idx           (favorited_at DESC NULLS LAST, id DESC) WHERE is_favorite = true
 *   image_cache_created_idx   (created_at)
 *   entries_title_trgm        USING gin (title gin_trgm_ops)  -- 需 pg_trgm 扩展
 * ==========================================================================*/

/* ============================================================================
 * 关系（供 Drizzle 关联查询）
 * ==========================================================================*/

export const usersRelations = relations(users, ({ many, one }) => ({
  feeds: many(feeds),
  digests: many(digests),
  sessions: many(sessions),
  accounts: many(accounts),
  llm: one(userLlm, { fields: [users.id], references: [userLlm.userId] }),
}));

export const feedsRelations = relations(feeds, ({ one, many }) => ({
  owner: one(users, { fields: [feeds.ownerId], references: [users.id] }),
  entries: many(entries),
}));

export const entriesRelations = relations(entries, ({ one }) => ({
  feed: one(feeds, { fields: [entries.feedId], references: [feeds.id] }),
}));

export const digestsRelations = relations(digests, ({ one }) => ({
  owner: one(users, { fields: [digests.ownerId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const userLlmRelations = relations(userLlm, ({ one }) => ({
  user: one(users, { fields: [userLlm.userId], references: [users.id] }),
}));

export const llmProvidersRelations = relations(llmProviders, ({ one }) => ({
  user: one(users, { fields: [llmProviders.userId], references: [users.id] }),
}));

export const entryAiTagsRelations = relations(entryAiTags, ({ one }) => ({
  user: one(users, { fields: [entryAiTags.userId], references: [users.id] }),
  entry: one(entries, { fields: [entryAiTags.entryId], references: [entries.id] }),
}));

/* ============================================================================
 * 类型导出（供 apps/server、packages/ai 等消费，避免重复定义）
 * ==========================================================================*/

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Verification = typeof verifications.$inferSelect;
export type Feed = typeof feeds.$inferSelect;
export type NewFeed = typeof feeds.$inferInsert;
export type Entry = typeof entries.$inferSelect;
export type NewEntry = typeof entries.$inferInsert;
export type Digest = typeof digests.$inferSelect;
export type ImageCacheRow = typeof imageCache.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type UserLlm = typeof userLlm.$inferSelect;
export type NewUserLlm = typeof userLlm.$inferInsert;
export type LlmProvider = typeof llmProviders.$inferSelect;
export type NewLlmProvider = typeof llmProviders.$inferInsert;
export type McpToken = typeof mcpTokens.$inferSelect;
export type AiUsageDailyRow = typeof aiUsageDaily.$inferSelect;
export type AiRequestLogRow = typeof aiRequestLog.$inferSelect;
export type AiJobRow = typeof aiJobs.$inferSelect;
export type EntryAiTags = typeof entryAiTags.$inferSelect;
