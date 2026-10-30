/**
 * 数据库行 → 契约 DTO（对齐 apps/legacy/lib/dto.js）。
 *
 * 这一层是「物理列名 ↔ 契约字段名」的唯一换算点：
 * 列名 snake_case / 缩写（`icon_url`、`is_favorite`），契约一律 camelCase 且 ID 为字符串。
 * 把换算散到各路由里，就会出现「同一个字段两个 DTO 两套写法」——1.7.x 的典型病。
 */

import type { Card, EntryDetail, Feed } from '@feedlore/contract';

/**
 * 外链图片 → 展示地址。
 *
 * v1.x 一律改写成 `/api/img?u=...`（防防盗链、防签名过期）。
 * v2 的图片代理尚未实现（需要走 `lib/net` 的 SSRF 校验 + 图片缓存，排在 P6），
 * 因此这里**暂时原样返回**：契约字段类型不变，接上代理时只改这一个函数。
 */
export function imgUrl(u: string | null | undefined): string | null {
  const v = typeof u === 'string' ? u.trim() : '';
  return v || null;
}

/**
 * 图文块 JSON 里图片块的改写点。当前与 imgUrl 同步为直通；
 * 接代理后这里要把 `{t:'img',src}` 逐块换掉（legacy `proxyBodyJson` 同款）。
 */
export function bodyJsonUrl(json: string | null | undefined): string | null {
  return typeof json === 'string' && json ? json : null;
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
  feedName: string | null;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function toCard(row: CardRow): Card {
  const images = Array.isArray(row.images) ? row.images : [];
  return {
    id: String(row.id),
    name: row.title,
    desc: row.description ?? '',
    size: row.size ?? '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    link: row.link ?? null,
    pwd: row.pwd ?? null,
    links: Array.isArray(row.links) ? row.links : [],
    image: imgUrl(row.image),
    images: images.map((u) => imgUrl(u)).filter((u): u is string => u !== null),
    bodyJson: bodyJsonUrl(row.bodyJson),
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
    icon: imgUrl(row.iconUrl),
    enabled: row.enabled,
    cardEnabled: row.cardEnabled,
    groupName: row.groupName ?? '',
    sortOrder: row.sortOrder,
    entryCount: counts.entryCount ?? 0,
    unreadCount: counts.unreadCount ?? 0,
    refreshMinutes: row.refreshMinutes ?? null,
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
