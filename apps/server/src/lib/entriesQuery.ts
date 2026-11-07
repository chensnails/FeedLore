/**
 * 条目查询的共享构件（列表筛选语义的唯一真源）。
 *
 * 从 routes/entries.ts 抽出来的原因：MCP 工具（mcp/tools.ts）要按**同一套**
 * 筛选语义查条目——owner 子查询、关键词覆盖正文与标签、收藏/未读/关注过滤。
 * 抽到 lib 让 HTTP 路由与 MCP 工具共同 import，避免第二份真源悄悄走样。
 */

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { entries, feeds, type Db } from '@feedlore/db';

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
  tag?: string | undefined;
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
      const pat = `%${kw}%`;
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

/** 防止调用方漏 and()：单发也很常见，这里给个便捷包装。 */
export function entryWhere(db: Db, uid: string, f: EntryFilter) {
  return and(...entryConditions(db, uid, f));
}
