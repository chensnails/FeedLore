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
  date,
  customType,
  uniqueIndex,
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
  // 业务扩展：外观/布局/过滤/关注屏蔽/日报配置（每用户加密 LLM key 不在此，见 user_llm）
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
    links: text('links').array(), // 可复制链接（v17）
    watchState: text('watch_state'), // null|'watch'|'block'（v21）
    watchRule: text('watch_rule'),
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
  thinking: boolean('thinking').notNull().default(false),
  thinkingDepth: integer('thinking_depth').notNull().default(0),
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
