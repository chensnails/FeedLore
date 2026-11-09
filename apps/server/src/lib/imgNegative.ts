/* `/api/img` 的失败负缓存（进程内，短 TTL）。
 *
 * 图片地址一旦在上游 404，前端会立刻用 `?r=1` 再试一次；`r` 不参与缓存 key，
 * 所以不缓存失败就意味着**每张死图一次渲染要回源两次**，反复刷新还会成倍放大。
 * 这里把 404/410 记住 2 分钟，第二次起直接原样返回状态码，不再经过 L2 查询与回源。
 *
 * 只收 404/410：
 * - 403 已经过 Referer 重试，仍拒绝多半是持续性防盗链，但换 referer 策略后可能恢复；
 * - 429 是限流、5xx/504 是暂时故障，缓存它们会把「过几分钟就好」变成「固定挂几分钟」。
 *
 * 必须独立于 `img.ts` 的 500 条图片 LRU：图片条目动辄数百 KB，混在一起时
 * 几十个字符串 key 就可能把热门图挤出去。
 */

export const IMG_NEG_TTL_MS = 120_000;
export const IMG_NEG_MAX = 2000;

const neg = new Map<string, { status: number; expiresAt: number }>();

/** 命中返回上游状态码，未命中 / 已过期返回 null。 */
export function negativeCacheGet(key: string, now = Date.now()): number | null {
  const hit = neg.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    neg.delete(key);
    return null;
  }
  // 近似 LRU：命中的挪到队尾
  neg.delete(key);
  neg.set(key, hit);
  return hit.status;
}

/** 只缓存 404/410；其余状态码直接忽略（见文件头）。 */
export function negativeCacheSet(key: string, status: number, now = Date.now()): void {
  if (status !== 404 && status !== 410) return;
  neg.delete(key);
  neg.set(key, { status, expiresAt: now + IMG_NEG_TTL_MS });
  while (neg.size > IMG_NEG_MAX) {
    const oldest = neg.keys().next();
    if (oldest.done) break;
    neg.delete(oldest.value);
  }
}

/** 图片成功写缓存时调用：万一存在同名负条目，立即让位给真图。 */
export function negativeCacheDelete(key: string): void {
  neg.delete(key);
}

/** 管理端「清空图片缓存」与测试复用。 */
export function resetNegativeCache(): void {
  neg.clear();
}

export function negativeCacheSize(): number {
  return neg.size;
}
