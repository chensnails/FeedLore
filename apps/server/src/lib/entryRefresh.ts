/**
 * 单篇手动重新抓取。
 *
 * 与整轮刷新严格分工：这里只重拉**当前这一条**，复用 normalizeItem + 全文增强的
 * 同一条解析链，但绝不 upsert 整个频道、不写频道状态、不触发规则 / 关注 / 清理。
 * 写回时只覆盖内容字段；标题、发布时间、已读 / 收藏 / 关注标记原样保留，
 * 这样列表顺序和用户的读取痕迹不会因为一次「修图」被悄悄改掉。
 */

import {
  type ApiErrorCode,
  type EntryDetail,
  type EntryRefreshResponse,
  entryRefreshResponse,
} from '@feedlore/contract';
import { type Db, entries as entriesTable, feeds } from '@feedlore/db';
import { and, eq, inArray } from 'drizzle-orm';
import { ApiException, apiErrorKey, isApiErrorCode } from './apiError';
import { toEntryDetail } from './dto';
import { CARD_COLUMNS } from './entriesQuery';
import { type LoadedFeed, loadFeed } from './fetchNetwork';
import { enhanceWithFullText } from './fulltext';
import { getSource } from './settings';
import { assertResponse } from './validate';

/** 同一 (用户, 条目) 的并发刷新合并成一次，防多标签页 / 双击把源站打穿。 */
const inFlight = new Map<string, Promise<EntryRefreshResponse>>();

export interface CurrentEntryRow {
  id: number;
  feedId: number;
  guid: string;
  feedUrl: string;
  feedSiteUrl: string | null;
  fullText: boolean;
  link: string | null;
  pwd: string | null;
  description: string | null;
  content: string | null;
  size: string | null;
  tags: string[];
  image: string | null;
  images: string[] | null;
  bodyJson: string | null;
  bodyVersion: number;
  links: string[] | null;
  sourceUrl: string | null;
}

function asApiException(err: unknown): ApiException {
  if (err instanceof ApiException) return err;
  const candidate = err as { code?: unknown; detail?: unknown; message?: unknown };
  if (isApiErrorCode(candidate?.code)) {
    return new ApiException(candidate.code as ApiErrorCode, {
      detail: candidate.detail === undefined ? undefined : String(candidate.detail),
    });
  }
  return new ApiException('E_FETCH_FAILED', {
    detail: String((candidate?.message ?? err) as unknown).slice(0, 300),
  });
}

function sameList(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/** 只挑内容字段；空值不覆盖已有内容，避免一次失败抓取把正文 / 配图清空。 */
export function mergeEntryRefreshContent(
  row: CurrentEntryRow,
  fresh: Awaited<ReturnType<typeof enhanceWithFullText>>[number],
) {
  const merged = {
    link: fresh.link || row.link,
    pwd: fresh.pwd || row.pwd,
    description: fresh.description || row.description,
    content: String(fresh.content || '').trim() ? fresh.content : row.content,
    size: fresh.size || row.size,
    tags: fresh.tags.length ? fresh.tags : row.tags,
    image: fresh.image || row.image,
    images: fresh.images.length ? fresh.images : (row.images ?? []),
    links: fresh.links.length ? fresh.links : (row.links ?? []),
    sourceUrl: fresh.sourceUrl || row.sourceUrl,
    bodyJson: fresh.bodyJson || row.bodyJson,
    bodyVersion: fresh.bodyJson ? fresh.bodyVersion : row.bodyVersion,
  };
  const changed =
    merged.link !== row.link ||
    merged.pwd !== row.pwd ||
    merged.description !== row.description ||
    merged.content !== row.content ||
    merged.size !== row.size ||
    !sameList(merged.tags, row.tags) ||
    merged.image !== row.image ||
    !sameList(merged.images, row.images) ||
    !sameList(merged.links, row.links) ||
    merged.sourceUrl !== row.sourceUrl ||
    merged.bodyJson !== row.bodyJson ||
    merged.bodyVersion !== row.bodyVersion;
  return { merged, changed };
}

async function doRefresh(db: Db, uid: string, id: number): Promise<EntryRefreshResponse> {
  const rows = await db
    .select({
      id: entriesTable.id,
      feedId: entriesTable.feedId,
      guid: entriesTable.guid,
      feedUrl: feeds.url,
      feedSiteUrl: feeds.siteUrl,
      fullText: feeds.fullText,
      link: entriesTable.link,
      pwd: entriesTable.pwd,
      description: entriesTable.description,
      content: entriesTable.content,
      size: entriesTable.size,
      tags: entriesTable.tags,
      image: entriesTable.image,
      images: entriesTable.images,
      bodyJson: entriesTable.bodyJson,
      bodyVersion: entriesTable.bodyVersion,
      links: entriesTable.links,
      sourceUrl: entriesTable.sourceUrl,
    })
    .from(entriesTable)
    .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
    // owner 与 id 同时进 WHERE：猜中 id 也读不到别人订阅的内容。
    .where(and(eq(entriesTable.id, id), eq(feeds.ownerId, uid)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiException('E_ENTRY_NOT_FOUND');

  const cfg = await getSource(db);
  let loaded: LoadedFeed;
  try {
    // 不带 etag / last-modified：手动刷新就是要绕过 304，真拿一次源站内容。
    loaded = await loadFeed(row.feedUrl, { timeoutMs: cfg.timeoutSeconds * 1000 });
  } catch (e) {
    throw asApiException(e);
  }
  if (loaded.notModified) throw new ApiException('E_FETCH_FAILED', { detail: 'unexpected 304' });

  // guid 是入库时的主键口径；guid 变更的源再按链接兜底匹配一次，找不到就原地失败。
  const item =
    loaded.items.find((it) => it.guid === row.guid) ??
    loaded.items.find((it) => Boolean(row.link) && it.link === row.link);
  if (!item) throw new ApiException('E_ENTRY_NOT_IN_FEED');

  let fresh = item;
  if (row.fullText) {
    try {
      const enhanced = await enhanceWithFullText(db, [item], {
        siteUrl: loaded.siteUrl,
        timeoutMs: Math.min(cfg.timeoutSeconds * 1000, 20_000),
        maxFetches: 1,
        force: true, // 手动刷新不吃 7 天全文缓存
      });
      fresh = enhanced[0] ?? item;
    } catch (e) {
      // 全文增强是可选增益，失败就退回订阅自带正文（与整轮刷新同口径）。
      fresh = item;
      void e;
    }
  }

  const { merged, changed } = mergeEntryRefreshContent(row, fresh);
  const refreshedAt = new Date();
  if (changed) {
    await db
      .update(entriesTable)
      .set({ ...merged, fetchedAt: refreshedAt })
      .where(
        and(
          eq(entriesTable.id, id),
          inArray(
            entriesTable.feedId,
            db.select({ id: feeds.id }).from(feeds).where(eq(feeds.ownerId, uid)),
          ),
        ),
      );
  }

  // 重读详情：图片代理化 / aiTags 等 DTO 口径必须与 GET /api/entries/:id 逐字一致。
  const detailRows = await db
    .select({ ...CARD_COLUMNS, content: entriesTable.content })
    .from(entriesTable)
    .innerJoin(feeds, eq(feeds.id, entriesTable.feedId))
    .where(and(eq(entriesTable.id, id), eq(feeds.ownerId, uid)))
    .limit(1);
  const detailRow = detailRows[0];
  if (!detailRow) throw new ApiException('E_ENTRY_NOT_FOUND');
  const entry: EntryDetail = toEntryDetail(detailRow);

  return assertResponse(
    entryRefreshResponse,
    {
      ok: true as const,
      id: String(id),
      changed,
      images: entry.images.length,
      refreshedAt: refreshedAt.toISOString(),
      entry,
    },
    'POST /api/entries/:id/refresh',
  );
}

/** 手动刷新单篇。并发去重只作用于这一条，不占用整轮抓取的运行期槽位。 */
export function refreshSingleEntry(db: Db, uid: string, id: number): Promise<EntryRefreshResponse> {
  const key = `${uid}:${id}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = doRefresh(db, uid, id).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

/** 路由层统一包装：保留已知错误码（含 FeedError），其余归到 E_FETCH_FAILED。 */
export { apiErrorKey, asApiException };
