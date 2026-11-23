/**
 * 侧栏标签云的短 TTL 进程内缓存。
 *
 * `tagCounts()` 要对当前账号**全部条目**做 `unnest(tags)` + group by，
 * 21 万条真库上一次就是一次全表聚合；而列表翻页、切筛选、切视图都会带上它，
 * 结果却几乎不变（只有抓到新文章或导入/还原时才会变）。
 *
 * 这里只缓存 10 秒：翻页/切频道完全命中，新抓取与整站导入/还原则显式失效。
 * 不改响应结构，前端拿到的仍是同一份标签计数。
 */

export interface TagCountRow {
  tag: string;
  n: number;
}

const TTL_MS = 10_000;
const cache = new Map<string, { at: number; rows: TagCountRow[] }>();

export function tagCountsCacheKey(uid: string, feedIds: number[] | null): string {
  return `${uid}|${feedIds ? feedIds.join(',') : '*'}`;
}

export function tagCountsCacheGet(key: string, now = Date.now()): TagCountRow[] | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.at >= TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.rows;
}

export function tagCountsCacheSet(key: string, rows: TagCountRow[], now = Date.now()): void {
  cache.set(key, { at: now, rows });
}

/** 抓取到新条目 / 导入 / 还原后调用；只清本进程缓存，多实例各自 10 秒内自然过期。 */
export function invalidateTagCounts(): void {
  cache.clear();
}
