/**
 * 智能去重（Phase 2 · T-B）——纯启发式，精度优先。
 *
 * 判定分两层，缺一不可：
 *  1) **组**：同一用户内「归一化标题」完全相同（标题为空时退回归一化链接）。
 *  2) **并**：与组内首条（最小 id）相比，满足下面任一才算重复——
 *     · 链接完全相同（两侧都 ≥12 字符，且都带值）；
 *     · 摘要完全相同（两侧都 ≥40 字符，且都带值）。
 *
 * 为什么要第二层：只比标题会把「同名不同篇」并掉（实测 196k 条里标出 7 万条重复，
 * 其中混着《谷雨》第 1-5 集 / 第 1-9 集、2160p / 1080p、每周都发的「Epic 本周限免」、
 * 每次开机的「开机提醒」）。加上「链接或摘要也要相同」后，留下的都是同一篇内容。
 *
 * 为什么链接用「完全相同」而不是去掉 query：`u.jd.com/xxx` 这类推广短链、tmdb 剧集页
 * 一个链接挂了上百条不同内容，去 query 会把它们并成一条（实测会并掉 11.8 万行）。
 *
 * 归一化口径必须与迁移 0010 的 SQL 逐字一致（两边都改才生效）：
 *   标题 → `regexp_replace(lower(title), '[^[:alnum:]]', '', 'g')`（白名单：只留字母数字与中文）
 *   链接 → `lower(btrim(link))`（不动 query，只去首尾空白）
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { entries, feeds, type Db } from '@feedlore/db';

/** 链接参与比较的最小长度（挡住 `https://a.b` 这类无意义短链）。 */
export const MIN_LINK_LEN = 12;
/** 摘要参与比较的最小长度（挡住空摘要 / 只有一句话的摘要）。 */
export const MIN_DESC_LEN = 40;

/**
 * 归一化标题：小写后**只保留字母、数字与中文**（标点、空白、符号、emoji 全部丢弃）。
 * 白名单写法，避免「JS 黑名单漏了全角标点、SQL 的 [[:punct:]] 却剔掉了」这种两套口径打架。
 */
export function normalizeTitle(title: string): string {
  return (title || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** 归一化链接：去首尾空白 + 小写；不足 MIN_LINK_LEN 视为「没有可用链接」。 */
export function normalizeLink(link: string | null | undefined): string {
  const l = (link || '').trim().toLowerCase();
  return l.length >= MIN_LINK_LEN ? l : '';
}

/**
 * 分组签名：优先归一化标题（`t:` 前缀）；标题归一化后为空才退回链接（`l:` 前缀）。
 * 前缀让两类签名不会互相撞车。空串表示「不参与去重」。
 */
export function dedupKeyFor(title: string, link: string | null | undefined): string {
  const t = normalizeTitle(title);
  if (t) return 't:' + t;
  const l = normalizeLink(link);
  return l ? 'l:' + l : '';
}

/** 双向内容判定：链接相同，或摘要完全相同。 */
export function sameContent(
  a: { link?: string | null; description?: string | null },
  b: { link?: string | null; description?: string | null },
): boolean {
  const la = normalizeLink(a.link);
  const lb = normalizeLink(b.link);
  if (la && lb && la === lb) return true;
  const da = a.description || '';
  const db = b.description || '';
  return da.length >= MIN_DESC_LEN && db.length >= MIN_DESC_LEN && da === db;
}

/**
 * 给一批「刚算出 dedup_key」的条目分配主/从关系（同一 owner 内）。
 *
 * 语义与迁移 0010 的回填完全一致：组内**首条（最小 id）为主**，其余条目只有
 * 在 `sameContent(条目, 首条)` 成立时才指向它；不成立就自己当锚点留在列表里。
 * 只处理传入 keys 命中的条目，返回被标记为重复的条数。
 */
export async function assignDuplicatesForKeys(db: Db, ownerId: string, keys: string[]): Promise<number> {
  const clean = [...new Set(keys.filter((k) => !!k && k.length > 0))];
  if (!clean.length) return 0;

  const rows = await db
    .select({
      id: entries.id,
      key: entries.dedupKey,
      link: entries.link,
      description: entries.description,
    })
    .from(entries)
    .innerJoin(feeds, eq(feeds.id, entries.feedId))
    .where(and(eq(feeds.ownerId, ownerId), inArray(entries.dedupKey, clean)))
    .orderBy(asc(entries.id));

  const anchor = new Map<string, { id: number; link: string | null; description: string | null }>();
  let updated = 0;
  for (const r of rows) {
    if (!r.key) continue;
    const head = anchor.get(r.key);
    if (!head) {
      anchor.set(r.key, r);
      continue;
    }
    if (!sameContent(r, head)) continue;
    const res = await db
      .update(entries)
      .set({ duplicateOf: head.id })
      .where(and(eq(entries.id, r.id), isNull(entries.duplicateOf)));
    updated += Number((res as unknown as { rowCount?: number | null }).rowCount ?? 0);
  }
  return updated;
}
