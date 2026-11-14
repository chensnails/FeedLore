/**
 * 数据库行 → 契约 DTO（对齐 apps/legacy/lib/dto.js）。
 *
 * 这一层是「物理列名 ↔ 契约字段名」的唯一换算点：
 * 列名 snake_case / 缩写（`icon_url`、`is_favorite`），契约一律 camelCase 且 ID 为字符串。
 * 把换算散到各路由里，就会出现「同一个字段两个 DTO 两套写法」——1.7.x 的典型病。
 */

import { imgUrl } from '@feedlore/contract';
import type { Card, EntryDetail, Feed } from '@feedlore/contract';

/**
 * 外链图片 → 本站 `/api/img` 代理地址。
 *
 * 实现已收口到 `@feedlore/contract`（日报条目也要给出同一个地址，见 image.ts），
 * 这里保留同名导出，避免改动所有调用点。
 */
export { imgUrl };

const proxied = (u: string): string => '/api/img?u=' + encodeURIComponent(u);

/**
 * 图文块 JSON 里图片块的改写点（legacy `proxyBodyJson` 同款）。
 *
 * 只在**确实改到东西**时重新序列化：绝大多数条目的块里没有 http 图片，
 * 原样返回字符串可以省掉一次 JSON.parse→stringify 的开销（列表 50 条会放大成 50 次）。
 *
 * v2 的图片可能藏在引用 / 列表项里，因此递归遍历；v1 的 `{t:'img'}` 是顶层块，
 * 同一套递归也能处理。
 */
export function bodyJsonUrl(json: string | null | undefined): string | null {
  if (typeof json !== 'string' || !json) return null;
  try {
    const blocks: unknown = JSON.parse(json);
    if (!Array.isArray(blocks)) return json;

    const walk = (arr: unknown[]): boolean => {
      let changed = false;
      for (const raw of arr) {
        if (!raw || typeof raw !== 'object') continue;
        const b = raw as Record<string, unknown>;
        if (b.t === 'img' && typeof b.src === 'string' && /^https?:\/\//i.test(b.src)) {
          b.src = proxied(b.src);
          changed = true;
        }
        if (b.t === 'figure' && b.img && typeof b.img === 'object') {
          const img = b.img as Record<string, unknown>;
          if (typeof img.src === 'string' && /^https?:\/\//i.test(img.src)) {
            img.src = proxied(img.src);
            changed = true;
          }
        }
        if (b.t === 'list' && Array.isArray(b.items)) {
          for (const item of b.items) {
            if (Array.isArray(item) && walk(item)) changed = true;
          }
        }
        if (b.t === 'quote' && Array.isArray(b.blocks) && walk(b.blocks)) changed = true;
      }
      return changed;
    };

    return walk(blocks) ? JSON.stringify(blocks) : json;
  } catch {
    return json; // 解析不了就原样给，前端按自己的容错处理
  }
}

/** 条目查询的公共列（列表与详情共用，详情多一列 content）。 */
export interface CardRow {
  id: number;
  feedId: number;
  title: string;
  link: string | null;
  pwd: string | null;
  description: string | null;
  size: string | null;
  tags: string[] | null;
  image: string | null;
  images: string[] | null;
  links: string[] | null;
  sourceUrl: string | null;
  publishedAt: Date | null;
  isRead: boolean;
  isFavorite: boolean;
  favoritedAt: Date | null;
  bodyJson: string | null;
  bodyVersion: number | null;
  feedName: string | null;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function toCard(row: CardRow): Card {
  const images = Array.isArray(row.images) ? row.images : [];
  // 相对图片路径用条目自身的落地页补全（根相对 `/img/a.png` 与页相对 `a.png` 都成立）
  const base = row.link ?? row.sourceUrl ?? null;
  return {
    id: String(row.id),
    name: row.title,
    desc: row.description ?? '',
    size: row.size ?? '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    link: row.link ?? null,
    pwd: row.pwd ?? null,
    links: Array.isArray(row.links) ? row.links : [],
    image: imgUrl(row.image, base),
    images: images.map((u) => imgUrl(u, base)).filter((u): u is string => u !== null),
    bodyJson: bodyJsonUrl(row.bodyJson),
    bodyVersion: row.bodyVersion === 2 ? 2 : 1,
    sourceUrl: row.sourceUrl ?? null,
    date: iso(row.publishedAt),
    feedId: String(row.feedId),
    feedName: row.feedName ?? '',
    isRead: Boolean(row.isRead),
    isFavorite: Boolean(row.isFavorite),
    favoritedAt: iso(row.favoritedAt),
  };
}

export function toEntryDetail(row: CardRow & { content: string | null }): EntryDetail {
  return { ...toCard(row), content: row.content ?? '' };
}

/** feeds 表行的结构化视图（不 import drizzle 类型，保持本文件只依赖契约）。 */
export interface FeedRow {
  id: number;
  url: string;
  title: string | null;
  siteUrl: string | null;
  description: string | null;
  iconUrl: string | null;
  enabled: boolean;
  cardEnabled: boolean;
  groupName: string | null;
  customTitle: string | null;
  sortOrder: number;
  refreshMinutes: number | null;
  fullText: boolean;
  lastStatus: string | null;
  lastError: string | null;
  lastFetchedAt: Date | null;
  failStreak: number;
}

export interface FeedCounts {
  entryCount?: number;
  unreadCount?: number;
}

/**
 * 频道行 → 契约 Feed。
 * `effectiveRefreshMinutes` 是「本频道频率优先、否则全局」的换算结果，
 * 前端只读这一个值就够，不用自己判 null。
 */
export function toFeed(
  row: FeedRow,
  counts: FeedCounts,
  globalRefreshMinutes: number,
): Feed {
  return {
    id: String(row.id),
    url: row.url,
    title: row.customTitle || row.title || row.url,
    customTitle: row.customTitle ?? null,
    siteUrl: row.siteUrl ?? null,
    description: row.description ?? '',
    icon: imgUrl(row.iconUrl, row.siteUrl ?? row.url),
    enabled: row.enabled,
    cardEnabled: row.cardEnabled,
    groupName: row.groupName ?? '',
    sortOrder: row.sortOrder,
    entryCount: counts.entryCount ?? 0,
    unreadCount: counts.unreadCount ?? 0,
    refreshMinutes: row.refreshMinutes ?? null,
    fullText: row.fullText,
    effectiveRefreshMinutes: row.refreshMinutes ?? globalRefreshMinutes,
    // 下次抓取时间 = 上次抓取 + 本频道频率（从未抓过 → 立刻该抓）。停用采集的返回 null。
    nextRefreshAt: row.enabled
      ? new Date(
        (row.lastFetchedAt?.getTime() ?? Date.now())
        + (row.refreshMinutes ?? globalRefreshMinutes) * 60_000,
      ).toISOString()
      : null,
    status: row.lastStatus ?? null,
    error: row.lastError ?? null,
    lastFetchedAt: iso(row.lastFetchedAt),
    failStreak: row.failStreak,
  };
}
