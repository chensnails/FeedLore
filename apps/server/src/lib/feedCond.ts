/**
 * 条件请求健康度（进程内，重启即重置）。
 *
 * 背景：实测 12 个真实源只有 5 个回 304。RSSHub 系与部分网关会忽略
 * If-None-Match / If-Modified-Since，每次都回 200 全量 XML —— 既费带宽又拖慢整轮抓取。
 *
 * 判定口径（不能只看「带条件头却 200」就判它不认）：
 *   - 304                         → 认，清零连续未命中
 *   - 200 且响应校验头与请求相同   → 忽略条件头（源站其实没更新，但照发全量）
 *   - 200 且响应校验头变了         → 真的更新了，正常，清零
 *   - 没有条件头可带              → 不参与统计（akamai 这类不给 etag 的源无从判断）
 *
 * 连续 MISS_LIMIT 次「忽略」后，该 host 的到期间隔翻倍（最高 MAX_FACTOR 倍）；
 * 一旦重新看到 304 或内容头变化，立刻恢复。不落库、不改 feeds 表，纯运行期自适应。
 */

export const COND_MISS_LIMIT = 3;
export const COND_MAX_FACTOR = 4;

interface CondStat {
  /** 连续「带条件头却回相同校验头」的次数 */
  misses: number;
  /** 当前间隔倍数（1 / 2 / 4） */
  factor: number;
  /** 最近一次观测时间，用于给状态页展示 */
  lastAt: number;
}

const stats = new Map<string, CondStat>();

/** 取 host（小写、去端口），拿不到就返回空串（不参与统计）。 */
export function condHost(url: string): string {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 一次条件请求的结果。 */
export type CondOutcome =
  | { kind: 'hit' }                                   // 304
  | { kind: 'fresh'; etag?: string | null; lastModified?: string | null }  // 200，头变了
  | { kind: 'ignored'; etag?: string | null; lastModified?: string | null } // 200，头没变
  | { kind: 'skip' };                                 // 没有条件头可带

/** 判一次响应算哪种结果。纯函数，便于单测。 */
export function classifyCond(
  sent: { etag?: string | null; lastModified?: string | null },
  got: { status?: number; etag?: string | null; lastModified?: string | null },
): CondOutcome['kind'] {
  const hasCond = !!(sent.etag || sent.lastModified);
  if (!hasCond) return 'skip';
  if (got.status === 304) return 'hit';

  // 两侧都有同一类校验头且完全相同 → 源站没更新却仍回 200，等于忽略了条件头
  const sameEtag = !!sent.etag && !!got.etag && sent.etag === got.etag;
  const sameLast = !!sent.lastModified && !!got.lastModified && sent.lastModified === got.lastModified;
  if (sameEtag || sameLast) return 'ignored';

  // 只要有一侧缺头就无从比较；这种源不能判定为「忽略」，按正常更新处理，避免误伤
  return 'fresh';
}

/** 记录一次观测。host 为空时静默跳过。 */
export function noteCond(host: string, kind: CondOutcome['kind']): void {
  if (!host || kind === 'skip') return;
  const now = Date.now();
  const cur = stats.get(host) ?? { misses: 0, factor: 1, lastAt: now };
  if (kind === 'hit' || kind === 'fresh') {
    cur.misses = 0;
    cur.factor = 1;
  } else {
    cur.misses += 1;
    if (cur.misses >= COND_MISS_LIMIT) cur.factor = Math.min(COND_MAX_FACTOR, cur.factor * 2);
  }
  cur.lastAt = now;
  stats.set(host, cur);
}

/** 该 host 当前的间隔倍数（1 表示不降频）。 */
export function condFactor(host: string): number {
  return host ? (stats.get(host)?.factor ?? 1) : 1;
}

/** 状态页用：当前被降频的 host 列表。 */
export function condPenalties(): Array<{ host: string; misses: number; factor: number; lastAt: string }> {
  return [...stats.entries()]
    .filter(([, v]) => v.factor > 1)
    .map(([host, v]) => ({ host, misses: v.misses, factor: v.factor, lastAt: new Date(v.lastAt).toISOString() }))
    .sort((a, b) => b.factor - a.factor || a.host.localeCompare(b.host));
}

/** 仅供测试：清空观测状态。 */
export function resetCondForTest(): void {
  stats.clear();
}
