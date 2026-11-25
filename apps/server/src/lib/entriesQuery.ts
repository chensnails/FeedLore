/**
 * 条目查询的共享构件（列表筛选语义的唯一真源）。
 *
 * 从 routes/entries.ts 抽出来的原因：MCP 工具（mcp/tools.ts）要按**同一套**
 * 筛选语义查条目——owner 子查询、关键词覆盖正文与标签、收藏/未读/关注过滤。
 * 抽到 lib 让 HTTP 路由与 MCP 工具共同 import，避免第二份真源悄悄走样。
 */

import { entries, entryAiTags, feeds } from '@feedlore/db';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';

/** 条目查询公共列（详情另加 content）。字段名与 CardRow 一一对应。 */
export const CARD_COLUMNS = {
  id: entries.id,
  feedId: entries.feedId,
  title: entries.title,
  link: entries.link,
  pwd: entries.pwd,
  description: entries.description,
  size: entries.size,
  tags: entries.tags,
  // AI 标签：与手动 tags 物理隔离；按 (entry_id, feeds.owner_id) 取本人那份。
  // 列表/详情都 innerJoin(feeds)，所以 feeds.ownerId 在此可见。
  aiTags: sql<
    string[]
  >`coalesce((select ${entryAiTags.tags} from ${entryAiTags} where ${entryAiTags.entryId} = ${entries.id} and ${entryAiTags.userId} = ${feeds.ownerId}), ARRAY[]::text[])`,
  image: entries.image,
  images: entries.images,
  links: entries.links,
  sourceUrl: entries.sourceUrl,
  publishedAt: entries.publishedAt,
  isRead: entries.isRead,
  isFavorite: entries.isFavorite,
  favoritedAt: entries.favoritedAt,
  bodyJson: entries.bodyJson,
  bodyVersion: entries.bodyVersion,
  feedName: feeds.title,
};

export interface EntryFilter {
  feedIds: number[] | null;
  q?: string | undefined;
  /** 手动标签（entries.tags） */
  tag?: string | undefined;
  /** AI 标签（entry_ai_tags，与手动标签物理隔离）：点文章页「AI 标签」组用它 */
  aiTag?: string | undefined;
  watch?: 'watch' | 'block' | undefined;
  unread?: boolean;
  fav?: boolean;
}

/** 解析 `feeds=1,2,3`；返回 null 表示「没传这个参数」。 */
export function parseFeedIds(raw: string | undefined): number[] | null {
  if (raw === undefined) return null;
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.trunc(n));
}

/** 筛选条件（列表与「全部已读」共用）。owner 走 ARRAY 子查询，因此 UPDATE 也能直接用。 */
export function entryConditions(uid: string, f: EntryFilter): SQL[] {
  const conds: SQL[] = [
    // ANY(ARRAY(...)) 让 owner 过滤成为一次 InitPlan；写成 IN (subquery) 时
    // 规划器会把 feeds 放到过滤之后做 join，逐行多付一次 join 成本。
    sql`${entries.feedId} = ANY(ARRAY(SELECT ${feeds.id} FROM ${feeds} WHERE ${feeds.ownerId} = ${uid}))`,
  ];
  if (f.feedIds !== null) conds.push(inArray(entries.feedId, f.feedIds));
  // @> 才能利用 entries_tags_idx；= ANY(tags) 会退化成全表筛选。
  if (f.tag) conds.push(sql`${entries.tags} @> ARRAY[${f.tag}]::text[]`);
  if (f.aiTag) {
    // AI 标签在独立表，且必须按 owner 取本人那份——和 CARD_COLUMNS.aiTags 的取值口径一致。
    // 用 exists 而不是 join：列表/UPDATE 共用这套条件，join 会放大行数、让 "all read" 误伤。
    conds.push(sql`exists (
      select 1 from ${entryAiTags}
      where ${entryAiTags.entryId} = ${entries.id}
        and ${entryAiTags.userId} = ${uid}
        and ${f.aiTag} = any(${entryAiTags.tags})
    )`);
  }
  if (f.q) {
    const kw = f.q.trim();
    if (kw) {
      // 转义 LIKE 通配符（% _）与转义符本身（\）：搜「100%」「a_b」要按字面命中，
      // 而不是把 % 当任意串、_ 当任意单字符。PG 的 (I)LIKE 默认转义符就是反斜杠。
      const esc = kw.replace(/[\\%_]/g, (c) => '\\' + c);
      const pat = `%${esc}%`;
      // 覆盖正文与标签：只搜标题/描述时，正文里的关键词搜不到（legacy v2.6.0 的同款修正）
      conds.push(
        sql`(${entries.title} ilike ${pat}
          or coalesce(${entries.description}, '') ilike ${pat}
          or coalesce(${entries.content}, '') ilike ${pat}
          or exists (select 1 from unnest(${entries.tags}) t where t ilike ${pat}))`,
      );
    }
  }
  if (f.unread) conds.push(eq(entries.isRead, false));
  if (f.fav) conds.push(eq(entries.isFavorite, true));
  if (f.watch) conds.push(eq(entries.watchState, f.watch));
  return conds;
}

/**
 * `sort=relevance` 的分层打分（只在 q 非空时调用；无 q 由路由退回新→旧）。
 *
 * 关键词口径必须与上面的 ilike 条件一致：这里用**原始词**做 strpos，不把
 * `%`/`_`/`\` 的 LIKE 转义串带进来，否则搜「100%」会把转义符一起比，永远 0 分。
 * 层级：标题（前缀命中再加成） > 标签 > 摘要 > 正文。正文只占 10 分：
 * 它很长、几乎什么都命中，权重给高了会把「标题就是这个词」的那条压下去。
 * 同分再用发布时间 / id 稳定兜底，保证分页不重不漏。
 */
export function relevanceScore(q: string | undefined): SQL | null {
  const kw = String(q ?? '')
    .trim()
    .toLowerCase();
  if (!kw) return null;
  return sql`(case when strpos(lower(coalesce(${entries.title}, '')), ${kw}) > 0
                then 100 + case when strpos(lower(${entries.title}), ${kw}) = 1 then 20 else 0 end
                else 0 end)
            + (case when exists (
                 select 1 from unnest(${entries.tags}) as tg where strpos(lower(tg), ${kw}) > 0
               ) then 60 else 0 end)
            + (case when strpos(lower(coalesce(${entries.description}, '')), ${kw}) > 0 then 30 else 0 end)
            + (case when strpos(lower(coalesce(${entries.content}, '')), ${kw}) > 0 then 10 else 0 end)`;
}

/** 防止调用方漏 and()：单发也很常见，这里给个便捷包装。 */
export function entryWhere(uid: string, f: EntryFilter) {
  return and(...entryConditions(uid, f));
}
