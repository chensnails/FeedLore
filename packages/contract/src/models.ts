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

/**
 * 外观配置。
 *
 * ⚠️ 取值表直接对齐 `apps/legacy/lib/prefs.js` 的 `APPEARANCE_DEFAULTS/APPEARANCE_KEYS`，
 * **不是随手设计的枚举**：这里写成 `theme: 'system' | 'light' | 'dark'` 之类的「更漂亮」版本，
 * 会让老用户真实数据（`theme='auto'`、`fontSize='m'`）在 `assertResponse` 处直接 500。
 * 契约必须描述**实际存在的数据**，而不是我们希望它长什么样。
 */
export const AppearanceSchema = z.object({
  theme: z.enum(['auto', 'light', 'dark', 'github']),
  accent: z.enum(['blue', 'violet', 'teal', 'green', 'amber', 'rose']),
  fontSize: z.enum(['s', 'm', 'l']),
  density: z.enum(['cozy', 'compact']),
  readerFont: z.enum(['sans', 'serif']),
  readerLh: z.enum(['s', 'm', 'l']),
  readerFs: z.enum(['s', 'm', 'l']),
  readerWidth: z.enum(['s', 'm', 'l', 'full']),
});
export type Appearance = z.infer<typeof AppearanceSchema>;

/**
 * 布局偏好（按账号保存）。同样对齐 legacy `LAYOUT_DEFAULTS / LAYOUT_VALUES`。
 * 含 `LAYOUT_MIRROR` 字段（sort / rdScope / rdCollapsedGroups）：1.7.2 的「折叠点不动」
 * 就是因为前端读了 state 上不存在的 `rdCollapsedGroups`，所以这些键必须显式登记。
 */
export const LayoutSchema = z
  .object({
    view: z.enum(['grid', 'list']),
    tab: z.enum(['reader', 'cards', 'ai']),
    collapsedGroups: z.array(z.string()),
    accordion: z.boolean(),
    /** 设置页各分组的展开状态：{ [key]: boolean } */
    sections: z.record(z.string(), z.boolean()),
    sort: z.enum(['new', 'old', 'name']),
    rdScope: z.enum(['all', 'unread', 'favorite']),
    rdCollapsedGroups: z.array(z.string()),
    /** 阅读页频道栏宽度（px，180~400，服务端夹取） */
    readerSideWidth: z.number().int(),
    digestEnabled: z.boolean(),
    // 未来加的键不该让老客户端 500，也不该被静默丢弃
  })
  .passthrough();
export type Layout = z.infer<typeof LayoutSchema>;

/** 条目过滤规则（入库前生效，命中 block 的条目不会入库）。字段名对齐 legacy。 */
export const FilterRuleSchema = z.object({
  id: z.string(),
  /** 规则开关（关掉只是停用，不删除） */
  on: z.boolean(),
  act: z.enum(['block', 'allow']),
  field: z.enum(['title', 'desc', 'content', 'all']),
  /** kw = 关键字包含，re = 正则 */
  kind: z.enum(['kw', 're']),
  pattern: z.string(),
});
export type FilterRule = z.infer<typeof FilterRuleSchema>;

/** 关注 / 屏蔽规则（对已入库条目打标记，不删除条目）。 */
export const WatchRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  keywords: z.array(z.string()),
  act: z.enum(['watch', 'block']),
  notify: z.boolean(),
  on: z.boolean(),
});
export type WatchRule = z.infer<typeof WatchRuleSchema>;

/** 日报配置（按账号）。 */
export const DigestConfigSchema = z.object({
  auto: z.boolean(),
  /** HH:MM（24 小时零填充） */
  time: z.string(),
  mode: z.enum(['enabled', 'all', 'custom']),
  feeds: z.array(z.number().int()),
  maxPerFeed: z.number().int(),
  maxTotal: z.number().int(),
  keepDays: z.number().int(),
  /** 用户自定义的风格要求（≤2000 字，纯文本） */
  style: z.string(),
  /** 只由服务端写：调度器用它判断「今天这轮跑过了」 */
  lastAuto: z.string(),
});
export type DigestConfig = z.infer<typeof DigestConfigSchema>;

/** 模型配置（按账号）。apiKey 仅在填写时入库加密；视图层不回明文。 */
export const LlmConfigSchema = z.object({
  baseUrl: z.string().max(500),
  model: z.string().max(200),
  apiKey: z.string().max(500).optional(),
  temperature: z.number().optional(),
  thinking: z.boolean().optional(),
  thinkingDepth: z.number().int().min(0).max(3).optional(),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/** 偏好 GET 视图里回显的模型形态（apiKey 不回明文，只给掩码提示）。 */
export const LlmViewSchema = z.object({
  baseUrl: z.string(),
  model: z.string(),
  temperature: z.number(),
  thinking: z.boolean(),
  thinkingDepth: z.number().int(),
  apiKeySet: z.boolean(),
  apiKeyHint: z.string(),
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
