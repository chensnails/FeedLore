import { z } from 'zod';
import { IdSchema, IsoDateTime, RoleSchema } from './common';

/**
 * @feedlore/contract — 领域模型
 * 对应 legacy `lib/dto.js` 的 `toFeedDto` / `toCard` 输出，以及各偏好 sanitize 后的结构。
 * 字段命名与 v1.x 响应保持一致（下个落地的 Hono 层需满足这些 schema），便于平滑切换。
 */

/* ============================ 频道（Feed） ============================ */

export const FeedSchema = z.object({
  id: IdSchema,
  url: z.string().url(),
  title: z.string(),
  customTitle: z.string().nullable(),
  siteUrl: z.string().url().nullable(),
  description: z.string(),
  icon: z.string().nullable(),
  /** 采集开关 */
  enabled: z.boolean(),
  /** 卡片页展示开关（与 enabled 独立） */
  cardEnabled: z.boolean(),
  groupName: z.string(),
  sortOrder: z.number().int(),
  entryCount: z.number().int(),
  unreadCount: z.number().int(),
  /** 该频道单独设置的频率；null = 跟随全局 */
  refreshMinutes: z.number().int().nullable(),
  /** 实际生效频率（own 优先，否则全局） */
  effectiveRefreshMinutes: z.number().int(),
  nextRefreshAt: IsoDateTime.nullable(),
  status: z.string().nullable(),
  error: z.string().nullable(),
  lastFetchedAt: IsoDateTime.nullable(),
  /** 连续抓取失败计数，达到站点 feedFailLimit 会被自动停用 */
  failStreak: z.number().int().nonnegative(),
});
export type Feed = z.infer<typeof FeedSchema>;

/* ============================ 条目（Entry / Card） ============================ */

export const CardSchema = z.object({
  id: IdSchema,
  name: z.string(),
  desc: z.string(),
  size: z.string(),
  tags: z.array(z.string()),
  link: z.string().nullable(),
  pwd: z.string().nullable(),
  /** 所有可复制链接（主链接优先），不做图片代理 */
  links: z.array(z.string()),
  /** 单图（已改写 /api/img 代理），无则 null */
  image: z.string().nullable(),
  /** 多图（已改写代理） */
  images: z.array(z.string()),
  /** 图文顺序块 JSON，图片块已走代理；无则 null */
  bodyJson: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  date: IsoDateTime.nullable(),
  feedId: IdSchema,
  feedName: z.string(),
  isRead: z.boolean(),
  isFavorite: z.boolean(),
  favoritedAt: IsoDateTime.nullable(),
});
export type Card = z.infer<typeof CardSchema>;

/** 条目详情 = Card + 正文（GET /api/entries/:id 才返回 content）。 */
export const EntryDetailSchema = CardSchema.extend({ content: z.string() });
export type EntryDetail = z.infer<typeof EntryDetailSchema>;

/** 侧栏徽标计数。 */
export const EntryFlagsSchema = z.object({
  total: z.number().int(),
  unread: z.number().int(),
  favorite: z.number().int(),
});
export type EntryFlags = z.infer<typeof EntryFlagsSchema>;

export const TagCountSchema = z.object({ tag: z.string(), n: z.number().int() });
export type TagCount = z.infer<typeof TagCountSchema>;

/* ============================ 用户 ============================ */

export const UserSchema = z.object({
  id: IdSchema,
  username: z.string(),
  role: RoleSchema,
  createdAt: IsoDateTime.nullable(),
});
export type User = z.infer<typeof UserSchema>;

/** 管理员视角的用户列表项（GET /api/users）。 */
export const AdminUserSchema = UserSchema.extend({
  feedCount: z.number().int(),
  isSelf: z.boolean(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

/* ============================ 偏好（prefs） ============================ */

/** 外观配置（主题 / 主色 / 字号 / 阅读字体 / 行高 / 阅读宽度）。 */
export const AppearanceSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  accent: z.string().optional(),
  fontSize: z.number().optional(),
  readFont: z.string().optional(),
  lineHeight: z.number().optional(),
  readWidth: z.number().optional(),
});
export type Appearance = z.infer<typeof AppearanceSchema>;

/**
 * 布局偏好（按账号保存）。
 * 含 v1.x 的 `LAYOUT_MIRROR` 字段（sort / rdScope / rdCollapsedGroups），
 * 这些是核心状态，必须登记进契约，否则会重演 1.7.2「读不存在字段」的回归。
 */
export const LayoutSchema = z.object({
  viewMode: z.string().optional(),
  currentPage: z.string().optional(),
  collapsedGroups: z.array(z.string()).optional(),
  accordion: z.string().optional(),
  aiSubPage: z.string().optional(),
  settingsGroupOpen: z.array(z.string()).optional(),
  // —— LAYOUT_MIRROR 字段 ——
  sort: z.string().optional(),
  rdScope: z.string().optional(),
  rdCollapsedGroups: z.array(z.string()).optional(),
}).passthrough();
export type Layout = z.infer<typeof LayoutSchema>;

/**
 * 条目过滤规则（v2.7.0）。整组替换，仅在抓取写库前对新条目生效。
 * 范围四选：title / content / both / link。
 */
export const FilterRuleSchema = z.object({
  mode: z.enum(['keyword', 'regex']),
  pattern: z.string().min(1).max(200),
  field: z.enum(['title', 'content', 'both', 'link']),
  action: z.enum(['include', 'exclude']),
});
export type FilterRule = z.infer<typeof FilterRuleSchema>;

/** 关注 / 屏蔽规则（v21）。整组替换，保存后由 /api/watch/apply 回溯到已有条目。 */
export const WatchRuleSchema = z.object({
  type: z.enum(['watch', 'block']),
  field: z.enum(['title', 'content', 'author', 'feed']),
  match: z.enum(['contains', 'equals', 'regex']),
  value: z.string().min(1).max(200),
});
export type WatchRule = z.infer<typeof WatchRuleSchema>;

/** 日报配置（按账号）。 */
export const DigestConfigSchema = z.object({
  auto: z.boolean().optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  scope: z.enum(['all', 'cards', 'custom']).optional(),
  feeds: z.array(z.number().int().positive()).optional(),
  range: z.number().int().min(1).max(30).optional(),
  maxPerFeed: z.number().int().min(1).max(100).optional(),
  maxTotal: z.number().int().min(1).max(500).optional(),
  keepDays: z.number().int().min(1).max(365).optional(),
  style: z.string().max(2000).optional(),
});
export type DigestConfig = z.infer<typeof DigestConfigSchema>;

/** 模型配置（按账号）。apiKey 仅在填写时入库加密；视图层回显时不应返回明文。 */
export const LlmConfigSchema = z.object({
  baseUrl: z.string().max(500),
  model: z.string().max(200),
  apiKey: z.string().max(500).optional(),
  thinking: z.boolean().optional(),
  thinkingDepth: z.number().int().min(0).max(3).optional(),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/** 偏好 GET 视图里回显的模型形态（apiKey 不回明文）。 */
export const LlmViewSchema = LlmConfigSchema.omit({ apiKey: true }).extend({
  apiKeySet: z.boolean(),
});
export type LlmView = z.infer<typeof LlmViewSchema>;

/* ============================ AI 日报 ============================ */

/** 日报里的条目引用（精简 Card）。 */
export const DigestItemSchema = z.object({
  name: z.string(),
  feedName: z.string(),
  tags: z.array(z.string()),
  size: z.string(),
  link: z.string().nullable().optional(),
});
export type DigestItem = z.infer<typeof DigestItemSchema>;

export const DigestSectionSchema = z.object({
  title: z.string(),
  items: z.array(
    z.object({ comment: z.string(), item: DigestItemSchema.nullable() })
  ),
});
export type DigestSection = z.infer<typeof DigestSectionSchema>;

export const DigestSchema = z.object({
  date: z.string(),
  generatedAt: z.number().int(),
  windowFrom: z.number().int(),
  windowTo: z.number().int(),
  model: z.string(),
  usedMapReduce: z.boolean(),
  fallback: z.boolean(),
  error: z.string().nullable(),
  stats: z.object({
    collected: z.number().int(),
    kept: z.number().int(),
    feeds: z.number().int(),
  }),
  overview: z.string(),
  highlights: z.array(
    z.object({ text: z.string(), item: DigestItemSchema.nullable() })
  ),
  sections: z.array(DigestSectionSchema),
});
export type Digest = z.infer<typeof DigestSchema>;

/* ============================ 站点采集配置（admin） ============================ */

export const SourceConfigSchema = z.object({
  refreshMinutes: z.number().int(),
  keepPerFeed: z.number().int(),
  keepDays: z.number().int(),
  timeoutSeconds: z.number().int(),
  concurrency: z.number().int(),
  feedFailLimit: z.number().int(),
  autoRefreshMinutes: z.number().int(),
  proxyUrl: z.string(),
  imgTtlDays: z.number().int(),
  imgKeepDays: z.number().int(),
  imgMaxDim: z.number().int(),
  imgQuality: z.number().int(),
});
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
