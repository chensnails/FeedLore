/**
 * 数据库行 → 契约 DTO（对齐 apps/legacy/lib/dto.js）。
 *
 * 这一层是「物理列名 ↔ 契约字段名」的唯一换算点：
 * 列名 snake_case / 缩写（`icon_url`、`is_favorite`），契约一律 camelCase 且 ID 为字符串。
 * 把换算散到各路由里，就会出现「同一个字段两个 DTO 两套写法」——1.7.x 的典型病。
 */

import type { Card, EntryDetail, Feed } from '@feedlore/contract';

/**
 * 外链图片 → 展示地址（一律改写成本站 `/api/img` 代理）。
 *
 * 为什么必须改写：源站防盗链按 Referer 拦直连、混合内容被浏览器拦、
 * 部分 CDN 地址带短时效签名 —— 三者任一都会让卡片封面变白块。
 *
 * 两条边界（都来自 legacy 的线上踩坑）：
 *  1. **`data:` 直通**：RSSHub 之类会给内嵌 base64 图标，它本身就是完整资源。
 *     塞进代理只会被 `new URL()` 判成非法协议返回 400，表现为「整列图标全空」（v2.2.5）。
 *  2. **重复协议头归一**：个别源写成 `https:https://...`，不修的话解析出的主机名是 "https:"。
 *
 * v2 新增：支持 `base` 补全**相对地址**（`/logo.png`）。legacy 直接把相对地址塞进代理，
 * 代理端必然 400；这里用频道 siteUrl 补全，补不出来才丢弃。
 */
const proxied = (u: string): string => '/api/img?u=' + encodeURIComponent(u);

export function imgUrl(u: string | null | undefined, base?: string | null): string | null {
  const v = typeof u === 'string' ? u.trim() : '';
  if (!v) return null;
  if (/^data:/i.test(v)) return v;

  const fixed = v.replace(/^(https?):\1:\/\//i, '$1://');
  // 非 http(s) 绝对地址 → 尝试用 base 补全（相对路径走这条）
  let abs = fixed;
  if (!/^https?:\/\//i.test(fixed)) {
    try {
      abs = new URL(fixed, base ?? undefined).toString();
    } catch {
      return null; // 既不是绝对地址、也没有可用的 base → 丢掉（比给前端一个必 400 的链接好）
    }
  }
  if (!/^https?:\/\//i.test(abs)) return null;
  return proxied(abs);
}

/**
 * 图文块 JSON 里图片块的改写点（legacy `proxyBodyJson` 同款）。
 *
 * 只在**确实改到东西**时重新序列化：绝大多数条目的块里没有 http 图片，
 * 原样返回字符串可以省掉一次 JSON.parse→stringify 的开销（列表 50 条会放大成 50 次）。
 */
export function bodyJsonUrl(json: string | null | undefined): string | null {
  if (typeof json !== 'string' || !json) return null;
  try {
    const blocks: unknown = JSON.parse(json);
    if (!Array.isArray(blocks)) return json;

    let changed = false;
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (b && b.t === 'img' && typeof b.src === 'string' && /^https?:\/\//i.test(b.src)) {
        b.src = proxied(b.src);
        changed = true;
      }
    }
    return changed ? JSON.stringify(blocks) : json;
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
    icon: imgUrl(row.iconUrl, row.siteUrl ?? row.url),
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
