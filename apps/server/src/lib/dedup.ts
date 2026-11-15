/**
 * 智能去重（Phase 2 · T-B）——纯启发式。
 *
 * 判定：同一用户内，**归一化标题完全一致**（或标题为空时归一化链接一致）即视为重复。
 * 归一化 = 小写 + 去掉空白与 ASCII 标点（保留中文与字母数字）；与迁移 0009 里的
 * SQL 归一化保持同一口径，避免「入库用 JS、回填用 SQL」两套 key 对不上。
 *
 * 为什么不用 LLM / 向量：126k 量级下逐篇调模型不现实；标题归一化已能吃掉
 * 跨源转载里绝大多数「同一标题、标点/空格不同」的重复。
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { entries, feeds, type Db } from '@feedlore/db';

/** 归一化标题：小写 + 去空白/ASCII 标点/常见中文标点（保留中文与字母数字）。
 *  中文标点集合与迁移 0009 的 SQL 保持同一口径。 */
export function normalizeTitle(title: string): string {
  return (title || '').toLowerCase().replace(/[\s!-\/:-@\[-`{-~，。！？；：、“”‘’【】《》〈〉（）—…·]/g, '');
}

/** 归一化链接：小写、去 query/hash、去末尾斜杠。 */
export function normalizeLink(link: string | null | undefined): string {
  if (!link) return '';
  return link.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/** 去重签名：优先归一化标题；标题为空时退回归一化链接。 */
export function dedupKeyFor(title: string, link: string | null | undefined): string {
  const t = normalizeTitle(title);
  return t || normalizeLink(link);
}

/**
 * 给一批「刚算出 dedup_key」的条目分配主/从关系（同一 owner 内）。
 * 只处理传入 keys 命中的条目；组内最小 id 为主，其余（尚无 duplicate_of 的）指向它。
 * 返回被标记为重复的条数。
 */
export async function assignDuplicatesForKeys(db: Db, ownerId: string, keys: string[]): Promise<number> {
  const clean = [...new Set(keys.filter((k) => !!k && k.length > 0))];
  if (!clean.length) return 0;

  const rows = await db
    .select({ id: entries.id, key: entries.dedupKey })
    .from(entries)
    .innerJoin(feeds, eq(feeds.id, entries.feedId))
    .where(and(eq(feeds.ownerId, ownerId), inArray(entries.dedupKey, clean)))
    .orderBy(asc(entries.id));

  const primary = new Map<string, number>();
  let updated = 0;
  for (const r of rows) {
    if (!r.key) continue;
    const p = primary.get(r.key);
    if (p == null) {
      primary.set(r.key, r.id);
      continue;
    }
    const res = await db
      .update(entries)
      .set({ duplicateOf: p })
      .where(and(eq(entries.id, r.id), isNull(entries.duplicateOf)));
    updated += Number((res as unknown as { rowCount?: number | null }).rowCount ?? 0);
  }
  return updated;
}
