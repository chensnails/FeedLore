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
  /** 摘要型订阅：抓原文页提取全文（按频道自愿开启） */
  fullText: z.boolean(),
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

/* ============================ 正文块（Article v2） ============================ */

/**
 * 阅读页正文的结构化块（bodyVersion = 2）。
 *
 * 为什么不是 HTML：v1 把正文压成「纯文本段落 + 图片」，标题 / 列表 / 引用 / 代码 /
 * 正文链接全丢；直接存原文 HTML 又会把 XSS 面重新打开。这里只保留**语义**，
 * 前端用 React 组件渲染，样式仍由本站主题控制（暗色、字号、行宽都能统一）。
 *
 * 约束：内联节点只允许文本与语义标签，不携带 style / class / on* 属性；
 * 链接只接受服务端解析过的 http(s) / mailto 绝对地址。
 */
export type ArticleInline =
  | { t: 'text'; v: string }
  | { t: 'a'; href: string; v: ArticleInline[] }
  | { t: 'strong'; v: ArticleInline[] }
  | { t: 'em'; v: ArticleInline[] }
  | { t: 'code'; v: string }
  | { t: 'del'; v: ArticleInline[] }
  | { t: 'br' };

/** 正文图片：地址必须是服务端补全过的 http(s) 绝对地址 */
export type ArticleImage = { src: string; alt?: string; w?: number; h?: number };

export type ArticleBlock =
  | { t: 'p'; v: ArticleInline[] }
  | { t: 'h'; level: 2 | 3; v: ArticleInline[] }
  | { t: 'list'; ordered: boolean; items: ArticleBlock[][] }
  | { t: 'quote'; blocks: ArticleBlock[] }
  | { t: 'pre'; code: string; lang?: string }
  | { t: 'img'; src: string; alt?: string; w?: number; h?: number }
  /** head 最多一行表头；rows 里的单元格数量允许不齐（colspan/rowspan 已降级） */
  | { t: 'table'; head: ArticleInline[][]; rows: ArticleInline[][][] }
  | { t: 'figure'; img: ArticleImage; caption?: ArticleInline[] }
  | { t: 'hr' };

export const ArticleInlineSchema: z.ZodType<ArticleInline> = z.lazy(() =>
  z.discriminatedUnion('t', [
    z.object({ t: z.literal('text'), v: z.string() }),
    z.object({ t: z.literal('a'), href: z.string(), v: z.array(ArticleInlineSchema) }),
    z.object({ t: z.literal('strong'), v: z.array(ArticleInlineSchema) }),
    z.object({ t: z.literal('em'), v: z.array(ArticleInlineSchema) }),
    z.object({ t: z.literal('code'), v: z.string() }),
    z.object({ t: z.literal('del'), v: z.array(ArticleInlineSchema) }),
    z.object({ t: z.literal('br') }),
  ]),
);

export const ArticleImageSchema = z.object({
  src: z.string(),
  alt: z.string().optional(),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
});

export const ArticleBlockSchema: z.ZodType<ArticleBlock> = z.lazy(() =>
  z.discriminatedUnion('t', [
    z.object({ t: z.literal('p'), v: z.array(ArticleInlineSchema) }),
    z.object({
      t: z.literal('h'),
      level: z.union([z.literal(2), z.literal(3)]),
      v: z.array(ArticleInlineSchema),
    }),
    z.object({
      t: z.literal('list'),
      ordered: z.boolean(),
      items: z.array(z.array(ArticleBlockSchema)),
    }),
    z.object({ t: z.literal('quote'), blocks: z.array(ArticleBlockSchema) }),
    z.object({ t: z.literal('pre'), code: z.string(), lang: z.string().optional() }),
    ArticleImageSchema.extend({ t: z.literal('img') }),
    z.object({
      t: z.literal('table'),
      head: z.array(z.array(ArticleInlineSchema)),
      rows: z.array(z.array(z.array(ArticleInlineSchema))),
    }),
    z.object({
      t: z.literal('figure'),
      img: ArticleImageSchema,
      caption: z.array(ArticleInlineSchema).optional(),
    }),
    z.object({ t: z.literal('hr') }),
  ]),
);

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
  /** 正文块格式：1 = v1 纯文本块；2 = 结构化块（见 ArticleBlockSchema） */
  bodyVersion: z.union([z.literal(1), z.literal(2)]),
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
  /* 关注 / 屏蔽两档计数。legacy 的侧栏与卡片页筛选条都把这两档当一等公民显示，
   * 缺了它们，「关注」筛选只能盲点 —— 用户不知道点开是 3 条还是 3000 条。 */
  watching: z.number().int(),
  blocked: z.number().int(),
});
export type EntryFlags = z.infer<typeof EntryFlagsSchema>;

export const TagCountSchema = z.object({ tag: z.string(), n: z.number().int() });
export type TagCount = z.infer<typeof TagCountSchema>;

/* ============================ 用户 ============================ */

/**
 * 用户。
 *
 * ⚠️ `id` 不是数字：feeds/entries 的主键是 bigserial（所以用 IdSchema「纯数字」），
 * 而 users.id 由 better-auth 生成（cuid，字母数字混合）。照抄 IdSchema 会让
 * `GET /api/users` 在 `assertResponse` 处 500 —— 运行期才发现，编译期完全看不出来。
 */
export const UserSchema = z.object({
  id: z.string().min(1),
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

/**
 * 一台已登录设备（GET /api/sessions）。
 *
 * 只下发展示字段：`token` 是会话凭据本身，永远不出现在响应里（拿到它就能冒用登录）。
 * `current` 由服务端按当前 Cookie 对应的会话标记，前端据此区分「本机」与「其它设备」。
 */
export const SessionDeviceSchema = z.object({
  id: z.string().min(1),
  current: z.boolean(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: IsoDateTime,
  /** 最近一次请求时间（better-auth 每次校验会话都会刷新 updated_at） */
  lastSeenAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type SessionDevice = z.infer<typeof SessionDeviceSchema>;

/* ============================ 偏好（prefs） ============================ */

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
    /** 数据源面板显式展开的分组名（命名分组默认收起） */
    srcGroupsOpen: z.array(z.string()),
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

/** 规则适用范围：分组按名称动态跟随，频道按 id。all=true 时两个列表无意义。 */
export const RuleScopeSchema = z.object({
  all: z.boolean(),
  groups: z.array(z.string()),
  feeds: z.array(z.number().int()),
});
export type RuleScope = z.infer<typeof RuleScopeSchema>;

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
  /** 缺省 = 老规则（全部频道）；空选 = 不生效 */
  scope: RuleScopeSchema.optional(),
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
  /** 缺省 = 老规则（全部频道）；空选 = 不生效 */
  scope: RuleScopeSchema.optional(),
});
export type WatchRule = z.infer<typeof WatchRuleSchema>;

/**
 * 写入用的规则：keywords 允许直接提交多行文本。
 * 表单一直是「一行一个关键字」的 textarea，服务端 sanitizeWatchRules 也按字符串兼容，
 * 但响应侧仍统一返回数组，所以只在请求体里放宽。
 */
export const WatchRuleInputSchema = WatchRuleSchema.extend({
  keywords: z.union([z.string(), z.array(z.string())]),
});
export type WatchRuleInput = z.infer<typeof WatchRuleInputSchema>;

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
