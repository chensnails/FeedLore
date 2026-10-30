/**
 * 每日 AI 摘要：采集 → 压缩 → 生成（超限走 map-reduce）→ 落地（幂等）。
 *
 * 流程与 legacy `apps/legacy/digest.js` 一致，差异只在数据访问方式（drizzle）与
 * 出网（统一走注入的 safeFetch）。三个设计点值得记住：
 *
 * 1. **多租户隔离靠 join feeds 而不是 entries.owner_id**：entries 表没有 owner 列，
 *    漏掉 `feeds.owner_id` 就等于把所有人订阅的内容混进同一个人的日报里。
 * 2. **降级不是失败**：模型不可用时仍生成一份规则摘要并标记 `fallback: true`，
 *    用户至少能看到「今天有什么更新」。而 fallback 结果**不写进缓存短路**——
 *    下一次请求会重试模型，否则一次网络抖动会锁死一整天。
 * 3. **`#编号` 是模型与代码之间的唯一契约**：所有 ref 都必须能解析回真实条目，
 *    解析不到的直接丢弃（模型偶尔会编出「#99」）。宁可少一条，也不给用户一个死链。
 */

import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { digests, entries, feeds, type Db } from '@feedlore/db';
import { DigestSchema, type Digest, type DigestItem } from '@feedlore/contract';
import { chat, extractJson, type ChatMessage, type FetchLike, type ResolvedLlm } from './llm';

const WINDOW_MS = 24 * 3600 * 1000;
const COLLECT_LIMIT = 3000;
/** 单轮直出上限，超过走 map-reduce（模型上下文有限，120 条以上质量会明显下滑）。 */
const SINGLE_LIMIT = 90;
const CHUNK = 40;

/* ============================ 小工具 ============================ */

/** 上海时区的 YYYY-MM-DD。日报的「今天」必须按用户所在的时区算，不能按 UTC。 */
export function shanghaiDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

const clamp = (s: unknown, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/** 去掉模型回显的「#12」编号前缀。 */
const stripRef = (s: unknown): string =>
  String(s ?? '')
    .replace(/^\s*#*\s*\d+\s*[.、:：)]?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

const shortFeed = (n: string): string =>
  String(n || '')
    .replace(/\s*-\s*Telegram Channel\s*$/i, '')
    .trim();

/* ============================ 内部数据结构 ============================ */

interface PoolEntry {
  id: string;
  feedId: string;
  feedName: string;
  name: string;
  desc: string;
  size: string;
  tags: string[];
  link: string | null;
}

function toLine(e: PoolEntry, idx: number | ''): string {
  const parts: string[] = [`#${idx}`];
  if (e.feedName) parts.push(`[${shortFeed(e.feedName)}]`);
  parts.push(e.name);
  if (e.desc) parts.push(`— ${clamp(e.desc, 80)}`);
  if (e.tags.length) parts.push(e.tags.slice(0, 4).map((t) => '#' + t).join(' '));
  if (e.size) parts.push(`(${e.size})`);
  return parts.join(' ');
}

const itemOf = (e: PoolEntry): DigestItem => ({
  name: e.name,
  feedName: shortFeed(e.feedName),
  tags: e.tags,
  size: e.size,
  link: e.link,
});

/* ============================ 提示词 ============================ */

/* `/no_think` 与 `/think` 是 Qwen3 混合思考模型的模板指令（实测关思考快 10 倍以上），
 * 对其它模型无副作用。系统提示里那句「只输出 JSON」是后端解析的地基，不对用户开放。 */
const SYSTEM_BODY =
  '你是一名资源情报编辑。用户订阅了若干 RSS / Telegram 频道，你负责把每天的新条目整理成一份中文简报。' +
  '你只输出 JSON，不输出任何解释性文字、不使用 Markdown 代码块。' +
  '注意：条目前的 #编号 仅用于标记引用，你在 comment 和 text 中不要重复输出该编号。';

const systemPrompt = (llm: ResolvedLlm): string => SYSTEM_BODY + (llm.thinking ? ' /think' : ' /no_think');

/* 用户自定义的「风格要求」只能追加在这句之后：JSON 骨架、键名和 ref 编号是解析契约，
 * 用户写飞了最多是日报难读，不该把结构改坏（改坏会静默降级成规则摘要）。 */
const STYLE_GUARD = '额外要求（只影响选材、语气与篇幅；上面的 JSON 结构、键名和 #编号 约定不得改变）：';

interface DigestMeta {
  range: string;
  feedCount: number;
}

function buildFinalPrompt(lines: string[], meta: DigestMeta, style: string): string {
  const tail = style ? ['', STYLE_GUARD, style] : [];
  return [
    `以下是过去 24 小时（${meta.range}）来自 ${meta.feedCount} 个频道的 ${lines.length} 条新条目：`,
    '',
    lines.join('\n'),
    '',
    '请整理成一份中文简报，严格按以下 JSON 结构输出：',
    '{',
    '  "overview": "2-3 句话的今日概览，说明更新量、主要内容和值得注意的趋势",',
    '  "highlights": [ { "ref": 条目编号, "text": "为什么值得关注的简短理由" } ],',
    '  "sections": [',
    '    { "title": "分类名", "items": [ { "ref": 条目编号, "comment": "一句话点评，20 字以内" } ] }',
    '  ]',
    '}',
    '要求：',
    '1. sections 按内容主题分类（例如 影视剧集 / 音乐音频 / 软件工具 / 学习资料 / 资讯讨论 / 其他），不要按频道分类；',
    '2. highlights 挑 3-5 条最有价值的，ref 必须是上面出现过的编号；',
    '3. 每个 section 的 items 最多 6 条，只挑真正有价值的，ref 必须是上面出现过的编号；',
    '4. comment 要具体，说明这是什么、适合谁，不要写"值得一看"这类空话；',
    '5. 只输出 JSON。',
    ...tail,
  ].join('\n');
}

/* ============================ 生成器 ============================ */

export interface GenerateInput {
  db: Db;
  ownerId: string;
  /** 只统计这些频道（digest.mode='custom' 时用）；undefined = 全部启用的频道。 */
  feedIds?: number[] | null;
  date?: string;
  force?: boolean;
  llm: ResolvedLlm;
  style?: string;
  limits?: { maxPerFeed?: number; maxTotal?: number; keepDays?: number };
  fetchImpl: FetchLike;
}

export interface GenerateResult {
  digest: Digest;
  cached: boolean;
}

/** 采集：过去 24 小时、该账号自己频道里的条目。 */
async function collect(db: Db, ownerId: string, feedIds: number[] | null | undefined, sinceMs: number): Promise<PoolEntry[]> {
  const since = new Date(sinceMs);
  const where = [
    // ⚠️ 这一条是多租户隔离的全部：entries 没有 owner 列，漏了就串数据
    eq(feeds.ownerId, ownerId),
    gt(entries.publishedAt, since),
  ];
  if (feedIds && feedIds.length) where.push(inArray(entries.feedId, feedIds));

  const rows = await db
    .select({
      id: entries.id,
      feedId: entries.feedId,
      customTitle: feeds.customTitle,
      feedTitle: feeds.title,
      title: entries.title,
      description: entries.description,
      size: entries.size,
      tags: entries.tags,
      link: entries.link,
    })
    .from(entries)
    .innerJoin(feeds, eq(feeds.id, entries.feedId))
    .where(and(...where))
    .orderBy(desc(entries.publishedAt), desc(entries.id))
    .limit(COLLECT_LIMIT);

  return rows.map((r) => ({
    id: String(r.id),
    feedId: String(r.feedId),
    feedName: r.customTitle || r.feedTitle || '',
    name: r.title,
    desc: r.description ?? '',
    size: r.size ?? '',
    tags: Array.isArray(r.tags) ? r.tags : [],
    link: r.link ?? null,
  }));
}

/**
 * 压缩：先按「链接（忽略提取码参数）或 频道+标题」去重，再按频道与总量限额截断。
 *
 * 去重放在限额之前很重要：同一个网盘链接被多个频道转发是常态，
 * 先去重才能保证 150 条名额不被同一条内容重复占满。
 */
function compress(list: PoolEntry[], maxPerFeed: number, maxTotal: number): PoolEntry[] {
  const seen = new Set<string>();
  const deduped: PoolEntry[] = [];
  for (const e of list) {
    const key = (e.link && e.link.replace(/[?&]pwd=[^&]*/i, '')) || e.feedId + '|' + e.name;
    const norm = key.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    deduped.push(e);
  }

  const perFeed = new Map<string, number>();
  const kept: PoolEntry[] = [];
  for (const e of deduped) {
    const n = perFeed.get(e.feedId) ?? 0;
    if (n >= maxPerFeed) continue;
    perFeed.set(e.feedId, n + 1);
    kept.push(e);
    if (kept.length >= maxTotal) break;
  }
  return kept;
}

async function singlePass(
  compact: PoolEntry[],
  meta: DigestMeta,
  llm: ResolvedLlm,
  style: string,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  const lines = compact.map((e, i) => toLine(e, i + 1));
  const content = await chat(
    [
      { role: 'system', content: systemPrompt(llm) },
      { role: 'user', content: buildFinalPrompt(lines, meta, style) },
    ] as ChatMessage[],
    llm,
    { fetchImpl },
  );
  return extractJson(content);
}

/**
 * 超量时的 map-reduce：先每 40 条压缩出一份「要点」，再用要点做终稿。
 *
 * 关键在终稿的候选池是 **map 阶段挑出来的子集**（`flat`），不是原始 150 条：
 * 这样 ref 编号在终稿里是连续的一小段，模型不容易指错人。
 */
async function mapReduce(
  compact: PoolEntry[],
  meta: DigestMeta,
  llm: ResolvedLlm,
  style: string,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  const chunks: PoolEntry[][] = [];
  for (let i = 0; i < compact.length; i += CHUNK) chunks.push(compact.slice(i, i + CHUNK));

  const mini: Array<{ base: PoolEntry[]; data: { summary?: unknown; notable?: Array<{ ref?: unknown; why?: unknown }> } }> = [];
  for (const ch of chunks) {
    const lines = ch.map((e, i) => toLine(e, i + 1));
    const content = await chat(
      [
        { role: 'system', content: systemPrompt(llm) },
        {
          role: 'user',
          content: [
            `下面是 ${ch.length} 条新条目（编号为批内编号）：`,
            '',
            lines.join('\n'),
            '',
            '请输出 JSON：{ "summary": "这一批的 2 句话概括", "notable": [ { "ref": 批内编号, "why": "值得关注的原因，15 字内" } ] }',
            'notable 最多 6 条，只挑真正有价值的。只输出 JSON。',
            // 选材侧重要在这一轮就起作用：终稿只能从这批挑出的 notable 里选
            ...(style ? ['', STYLE_GUARD, style] : []),
          ].join('\n'),
        },
      ] as ChatMessage[],
      llm,
      { fetchImpl },
    );
    try {
      mini.push({ base: ch, data: extractJson(content) as (typeof mini)[number]['data'] });
    } catch {
      // 单批解析失败不该毁掉整份日报：当作「这批没挑出东西」，其余批次继续
      mini.push({ base: ch, data: { summary: '', notable: [] } });
    }
  }

  const flat: PoolEntry[] = [];
  const digestLines: string[] = [];
  mini.forEach((m, ci) => {
    digestLines.push(`【第 ${ci + 1} 批】${String(m.data.summary ?? '') || '(无概括)'}`);
    for (const n of m.data.notable ?? []) {
      const e = m.base[Number(n.ref) - 1];
      if (!e) continue;
      flat.push(e);
      digestLines.push(`#${flat.length} ${toLine(e, '').replace(/^#\s*/, '')} — 关注点：${clamp(n.why, 20)}`);
    }
  });

  // 全部批次都没挑出东西（模型全在胡说）→ 退回单轮，拿前 90 条直出
  if (!flat.length) return singlePass(compact.slice(0, SINGLE_LIMIT), meta, llm, style, fetchImpl);

  const content = await chat(
    [
      { role: 'system', content: systemPrompt(llm) },
      { role: 'user', content: buildFinalPrompt(digestLines, meta, style) },
    ] as ChatMessage[],
    llm,
    { fetchImpl },
  );
  const out = extractJson(content);
  // 终稿的 ref 指向 flat，而 ref 解析用的是 compact … 这里把 flat 一并带出去
  return { ...out, __pool: flat };
}

/** 降级：不调模型，按频道分布 + 最新条目拼一份摘要。 */
function ruleDigest(compact: PoolEntry[], reason: string): {
  overview: string;
  highlights: Array<{ text: string }>;
  sections: Array<{ title: string; items: Array<{ comment: string; item?: DigestItem | null; ref?: number }> }>;
  fallback: true;
} {
  const byFeed = new Map<string, number>();
  const tagCount = new Map<string, number>();
  for (const e of compact) {
    const f = shortFeed(e.feedName) || '未知频道';
    byFeed.set(f, (byFeed.get(f) ?? 0) + 1);
    for (const t of e.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  }
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topFeeds = [...byFeed.entries()].sort((a, b) => b[1] - a[1]);

  return {
    overview:
      `过去 24 小时共采集 ${compact.length} 条更新，覆盖 ${byFeed.size} 个频道。` +
      (topTags.length ? `高频标签：${topTags.slice(0, 6).map(([t]) => t).join('、')}。` : '') +
      `（模型摘要不可用：${reason}）`,
    highlights: topFeeds.slice(0, 3).map(([f, n]) => ({ text: `${f} 更新 ${n} 条` })),
    sections: [
      {
        title: '频道更新分布',
        // feedName 留空：这里的「条目」就是频道本身，两处都填会渲染成「IT之家 IT之家」
        items: topFeeds.slice(0, 6).map(([f, n]) => ({
          comment: `${n} 条更新`,
          item: { name: f, feedName: '', tags: [], size: '', link: null },
        })),
      },
      {
        // 每条都写「（规则摘要）」会在 24 行里重复 24 次，信息量为零；写在标题上一次就够
        title: '最新条目（规则摘要）',
        items: compact.slice(0, 24).map((_e, i) => ({ comment: '', ref: i + 1 })),
      },
    ],
    fallback: true,
  };
}

/* ============================ 读 / 剪裁 ============================ */

/**
 * 读某天的日报。
 *
 * 存进 jsonb 的是契约形状，但库里的老行可能来自 legacy（字段有出入）。
 * 这里用 `safeParse` 兜住：解析失败当作「没有这份日报」，而不是让接口 500 ——
 * 一份格式坏掉的旧日报不该把整个日报页面打死。
 */
export async function readDigest(db: Db, ownerId: string, date: string): Promise<Digest | null> {
  const [row] = await db
    .select({ payload: digests.payload })
    .from(digests)
    .where(and(eq(digests.ownerId, ownerId), eq(digests.date, date)))
    .limit(1);
  if (!row) return null;
  const parsed = DigestSchema.safeParse(row.payload);
  if (!parsed.success) {
    console.error('[digest] 库里的日报格式不合法，按缺失处理：', parsed.error.issues[0]?.message);
    return null;
  }
  return parsed.data;
}

export async function listDigestDates(db: Db, ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ date: digests.date })
    .from(digests)
    .where(eq(digests.ownerId, ownerId))
    .orderBy(desc(digests.date))
    .limit(120);
  return rows.map((r) => r.date);
}

/** 按 keepDays 剪裁；只删这个账号自己的。 */
export async function pruneDigests(db: Db, ownerId: string, keepDays: number): Promise<number> {
  if (!(keepDays > 0)) return 0;
  const res = await db.execute(sql`
    delete from digests
     where owner_id = ${ownerId}
       and date < current_date - make_interval(days => ${Math.floor(keepDays)})
  `);
  return res.rowCount ?? 0;
}

/* ============================ 主流程 ============================ */

export async function generateDigest(input: GenerateInput): Promise<GenerateResult> {
  const { db, ownerId, llm, fetchImpl } = input;
  const date = input.date || shanghaiDate();
  const { maxPerFeed = 20, maxTotal = 150, keepDays = 30 } = input.limits ?? {};

  // 已有非降级结果 → 直接给（force 时才重跑）。降级结果刻意不短路，见文件头注释。
  if (!input.force) {
    const [row] = await db
      .select({ payload: digests.payload, fallback: digests.fallback })
      .from(digests)
      .where(and(eq(digests.ownerId, ownerId), eq(digests.date, date)))
      .limit(1);
    if (row && !row.fallback) {
      const cached = await readDigest(db, ownerId, date);
      if (cached) return { digest: cached, cached: true };
    }
  }

  const now = Date.now();
  const sinceMs = now - WINDOW_MS;
  const collected = await collect(db, ownerId, input.feedIds, sinceMs);
  const compact = compress(collected, Math.max(1, maxPerFeed), Math.max(1, maxTotal));
  const feedCount = new Set(compact.map((e) => e.feedId)).size;
  const meta: DigestMeta = {
    range: `${new Date(sinceMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} ~ ${new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    feedCount,
  };

  let raw: Record<string, unknown>;
  let llmError: string | null = null;
  let pool: PoolEntry[] = compact;
  const style = typeof input.style === 'string' ? input.style.trim() : '';

  if (!compact.length) {
    raw = { overview: '过去 24 小时没有采集到新条目。', highlights: [], sections: [], fallback: true };
  } else {
    try {
      const used = compact.length > SINGLE_LIMIT
        ? await mapReduce(compact, meta, llm, style, fetchImpl)
        : await singlePass(compact, meta, llm, style, fetchImpl);
      // map-reduce 会把「终稿候选池」塞在 __pool 里带出来，ref 要按它解析
      const carried = used.__pool;
      if (Array.isArray(carried)) pool = carried as PoolEntry[];
      raw = used;
      delete raw.__pool;
    } catch (e) {
      llmError = (e as Error)?.message ?? String(e);
      raw = ruleDigest(compact, llmError) as unknown as Record<string, unknown>;
    }
  }

  const resolve = (ref: unknown): DigestItem | null => {
    const e = pool[Number(ref) - 1];
    return e ? itemOf(e) : null;
  };

  const highlightsRaw = Array.isArray(raw.highlights) ? (raw.highlights as Array<Record<string, unknown>>) : [];
  const sectionsRaw = Array.isArray(raw.sections) ? (raw.sections as Array<Record<string, unknown>>) : [];

  const digest: Digest = {
    date,
    generatedAt: now,
    windowFrom: sinceMs,
    windowTo: now,
    model: llm.model || '',
    usedMapReduce: compact.length > SINGLE_LIMIT,
    fallback: raw.fallback === true,
    error: llmError,
    stats: { collected: collected.length, kept: compact.length, feeds: feedCount },
    // 概览是「2-3 句话」，600 字已经很宽；不封顶的话模型偶尔会写一大段，
    // 直接把下面的分类挤到屏幕外（也顺带挡住「错误信息被模型复述」的极端情况）
    overview: clamp(raw.overview, 600),
    highlights: highlightsRaw
      .map((h) => ({
        text: clamp(stripRef(h.text ?? h.why ?? ''), 60),
        item: h.item && typeof h.item === 'object' ? (h.item as DigestItem) : resolve(h.ref),
      }))
      .filter((h) => h.item)
      .slice(0, 6),
    sections: sectionsRaw
      .map((s) => ({
        title: clamp(stripRef(s.title ?? '未分类'), 20),
        items: (Array.isArray(s.items) ? (s.items as Array<Record<string, unknown>>) : [])
          .map((it) => ({
            comment: clamp(stripRef(it.comment ?? ''), 60),
            item: it.item && typeof it.item === 'object' ? (it.item as DigestItem) : resolve(it.ref),
          }))
          .filter((it): it is { comment: string; item: DigestItem } => Boolean(it.item))
          .slice(0, 8),
      }))
      .filter((s) => s.items.length),
  };

  await db
    .insert(digests)
    .values({
      date,
      ownerId,
      payload: digest as unknown as Record<string, unknown>,
      model: digest.model,
      fallback: digest.fallback,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [digests.ownerId, digests.date],
      set: {
        payload: digest as unknown as Record<string, unknown>,
        model: digest.model,
        fallback: digest.fallback,
        createdAt: new Date(),
      },
    });

  await pruneDigests(db, ownerId, keepDays).catch(() => 0);
  return { digest, cached: false };
}
