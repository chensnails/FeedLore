/**
 * 条目查询的共享构件（列表筛选语义的唯一真源）。
 *
 * 从 routes/entries.ts 抽出来的原因：MCP 工具（mcp/tools.ts）要按**同一套**
 * 筛选语义查条目——owner 子查询、关键词覆盖正文与标签、收藏/未读/关注过滤。
 * 抽到 lib 让 HTTP 路由与 MCP 工具共同 import，避免第二份真源悄悄走样。
 */

import { and, eq, exists, inArray, isNull, not, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { entries, entryAiTags, feeds, type Db } from '@feedlore/db';

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
  aiTags: sql<string[]>`coalesce((select ${entryAiTags.tags} from ${entryAiTags} where ${entryAiTags.entryId} = ${entries.id} and ${entryAiTags.userId} = ${feeds.ownerId}), ARRAY[]::text[])`,
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
  duplicateOf: entries.duplicateOf,
  // 本条目作为「主条目」时挂了多少条重复（列表「N 重复」提示用）
  dupCount: sql<number>`(select count(*)::int from entries d where d.duplicate_of = ${entries.id})`,
};

export interface EntryFilter {
  feedIds: number[] | null;
  q?: string | undefined;
  tag?: string | undefined;
  watch?: 'watch' | 'block' | undefined;
  unread?: boolean;
  fav?: boolean;
  /** 'hide' = 列表排除重复项；'all'/未传 = 不按去重过滤（「全部已读」等默认不过滤） */
  dedup?: 'hide' | 'all';
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

/** 筛选条件（列表与「全部已读」共用）。owner 走子查询，因此 UPDATE 也能直接用。 */
export function entryConditions(db: Db, uid: string, f: EntryFilter): SQL[] {
  const conds: SQL[] = [
    inArray(
      entries.feedId,
      db.select({ id: feeds.id }).from(feeds).where(eq(feeds.ownerId, uid)),
    ),
  ];
  if (f.feedIds !== null) conds.push(inArray(entries.feedId, f.feedIds));
  if (f.tag) conds.push(sql`${f.tag} = any(${entries.tags})`);
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
  // 智能去重（软链接）：仅在列表显式要求时排除重复项；「全部已读」等不传 dedup → 不过滤
  if (f.dedup === 'hide') {
    if (f.feedIds && f.feedIds.length) {
      /* 折叠以「当前视图」为准：主条目也在这些频道里才折叠它。
       * 主条目在视图外就保留这一条 —— 否则「同一新闻被别的频道转载」会让你在
       * 本频道里完全看不到它，看上去像条目丢了。 */
      const primary = alias(entries, 'dup_primary');
      conds.push(
        or(
          isNull(entries.duplicateOf),
          not(
            exists(
              db
                .select({ one: sql`1` })
                .from(primary)
                .where(and(eq(primary.id, entries.duplicateOf), inArray(primary.feedId, f.feedIds))),
            ),
          ),
        ) as SQL,
      );
    } else {
      conds.push(isNull(entries.duplicateOf));
    }
  }
  return conds;
}

/** 防止调用方漏 and()：单发也很常见，这里给个便捷包装。 */
export function entryWhere(db: Db, uid: string, f: EntryFilter) {
  return and(...entryConditions(db, uid, f));
}
