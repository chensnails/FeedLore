/**
 * 抓取器：出网 → 解析 → 过滤 → 入库 → 打标 → 记录状态（移植 apps/legacy/server.js 的
 * `refreshGroup` / `refreshFeeds` / `scheduleRefresh`，逻辑对齐、结构重排）。
 *
 * 三条与 legacy 一致的关键行为，少一条就会出问题：
 * 1. **按 URL 分组**：同一 URL 被多个用户订阅时只回源一次，解析结果写回组内每个 feed 行
 *    （entries 仍按 feed 各存一份，用户隔离不变）。
 * 2. **两层去重**：inFlight（同一 URL 正在抓 → 复用同一个 Promise）+ 5s 最小间隔
 *    （防连点「刷新全部」把源站打爆）。
 * 3. **失败计数与自动停用**：连续失败达阈值把 enabled 置 false，订阅与已抓条目保留；
 *    手动重新打开采集会清零，给足一整轮观察期。
 *
 * 与 legacy 的差异（刻意的）：
 * - 过滤规则 / 关注规则按成员 owner 逐人取 `users.prefs`（一次批量查，不 N+1）。
 * - 所有出网走 `lib/net.safeFetch`（逐跳校验 + IP 钉定），不接受直连 fetch。
 * - 入库用「先查已存在 guid + 一次多行 upsert」，比 legacy 的逐条 INSERT 少 N 次往返。
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { entries, feeds, users, type Db } from '@feedlore/db';
import { safeFetch } from './net';
import { normalizeItem, parseFeed, type NormalizedItem } from './rss';
import { applyFilters } from './filter';
import { classify, notifyRuleNames, type WatchVerdict } from './watch';
import { userFilters, userWatchRules, userWebhook } from './prefs';
import {
  DEFAULT_KEEP_DAYS,
  DEFAULT_REFRESH_MINUTES,
  FEED_FAIL_LIMIT,
  FETCH_TIMEOUT_MS,
  KEEP_PER_FEED,
  REFRESH_CONCURRENCY,
  SCHEDULER_ENABLED,
} from '../env';

export type FeedRow = typeof feeds.$inferSelect;

/* ============================================================================
 * 1. 出网
 * ==========================================================================*/

const UA = 'Mozilla/5.0 (compatible; FeedLore/2.8; +RSS reader)';
const MAX_BYTES = 12 * 1024 * 1024;
const RETRY_MAX = 3;
const RETRY_BASE_MS = 800;
const RETRY_FACTOR = 2.4;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 5xx / 408 / 425 / 429 值得重试；其余 4xx 是配置问题，重试也白搭。 */
function retryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

class FeedError extends Error {
  status?: number;
  permanent?: boolean;
  constructor(message: string, opts: { status?: number; permanent?: boolean } = {}) {
    super(message);
    this.status = opts.status;
    this.permanent = opts.permanent;
  }
}

export interface FetchOnce {
  notModified: boolean;
  body?: string;
  etag?: string | null;
  lastModified?: string | null;
  finalUrl?: string;
  status?: number;
}

/**
 * 抓一次（带 ETag / Last-Modified 条件请求）。
 * 失败分类：网络/超时/5xx/408/425/429 → 指数退避重试；其它 4xx → 永久错误不重试；304 → 成功。
 */
export async function fetchFeedRaw(
  url: string,
  { etag, lastModified, timeoutMs }: { etag?: string | null; lastModified?: string | null; timeoutMs?: number } = {},
): Promise<FetchOnce> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : FETCH_TIMEOUT_MS;
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), budget);
    try {
      const resp = await safeFetch(url, { headers, signal: ctl.signal });
      if (resp.status === 304) return { notModified: true, status: 304, finalUrl: url };

      if (!resp.ok) {
        const status = resp.status;
        throw new FeedError(`HTTP ${status}`, { status, permanent: !retryableStatus(status) });
      }

      const len = Number(resp.headers.get('content-length') ?? 0);
      if (len && len > MAX_BYTES) throw new FeedError('响应体过大', { permanent: false });

      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new FeedError('响应体过大', { permanent: false });

      // 统一按 UTF-8 解码；声明了 charset 的按声明来（不少中文源仍是 GBK）
      const ct = resp.headers.get('content-type') ?? '';
      const cs = /charset=([\w-]+)/i.exec(ct)?.[1];
      let body: string;
      if (cs && !/utf-?8/i.test(cs)) {
        try {
          body = new TextDecoder(cs).decode(buf);
        } catch {
          body = buf.toString('utf8');
        }
      } else {
        body = buf.toString('utf8');
      }

      return {
        notModified: false,
        status: resp.status,
        body,
        etag: resp.headers.get('etag'),
        lastModified: resp.headers.get('last-modified'),
        finalUrl: resp.url || url,
      };
    } catch (e) {
      lastErr = e;
      if ((e as Error)?.name === 'AbortError') {
        lastErr = new FeedError('抓取超时', { permanent: false });
      }
      const err = lastErr as FeedError;
      // 出网校验拒绝（内网地址 / 地址非法）属于配置错误，重试多少次都一样
      if (err?.status !== undefined && err.status >= 400 && err.status < 500) err.permanent = true;

      const permanent = err?.permanent === true;
      const msg = String(err?.message ?? err);
      const maybeTransient = err?.permanent === false
        || /ECONN|EAI_|fetch failed|socket hang up|network|抓取超时|响应体过大/i.test(msg);
      if (permanent || attempt >= RETRY_MAX || !maybeTransient) throw lastErr;
      await sleep(Math.round(RETRY_BASE_MS * RETRY_FACTOR ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new FeedError('抓取失败');
}

export interface LoadedFeed {
  notModified: boolean;
  title: string | null;
  siteUrl: string | null;
  description: string | null;
  iconUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  items: NormalizedItem[];
}

/** 一次抓取 + 解析 + 归一化 */
export async function loadFeed(
  url: string,
  cond: { etag?: string | null; lastModified?: string | null; timeoutMs?: number } = {},
): Promise<LoadedFeed> {
  const res = await fetchFeedRaw(url, cond);
  if (res.notModified) {
    return {
      notModified: true,
      title: null,
      siteUrl: null,
      description: null,
      iconUrl: null,
      etag: cond.etag ?? null,
      lastModified: cond.lastModified ?? null,
      items: [],
    };
  }
  const parsed = parseFeed(res.body ?? '');
  if (!parsed.items.length && !parsed.title) {
    throw new FeedError('不是可识别的 RSS / Atom 内容', { permanent: true });
  }
  return {
    notModified: false,
    title: parsed.title || null,
    siteUrl: parsed.siteUrl || null,
    description: parsed.description || null,
    iconUrl: parsed.iconUrl || null,
    etag: res.etag ?? null,
    lastModified: res.lastModified ?? null,
    items: parsed.items.map((it) => normalizeItem(it, parsed.title)),
  };
}

/* ============================================================================
 * 2. 写库
 * ==========================================================================*/

/** 记录一次抓取结果（成功时同时写入 feed 元信息与条件请求头）。 */
async function saveFeedMeta(
  db: Db,
  feedId: number,
  meta: {
    title?: string | null;
    siteUrl?: string | null;
    description?: string | null;
    iconUrl?: string | null;
    etag?: string | null;
    lastModified?: string | null;
    status: string;
    error?: string | null;
    /** 传数字（含 0）时直接覆写失败计数；不传则保持原值（失败路径另行 bump） */
    failStreak?: number;
  },
): Promise<void> {
  const set: Partial<typeof feeds.$inferInsert> = {
    lastStatus: meta.status,
    lastError: meta.error ?? null,
    lastFetchedAt: new Date(),
    updatedAt: new Date(),
  };
  // 抓不到 title 时不要把已有标题清空（不少源临时返回空 channel）
  if (meta.title) set.title = meta.title;
  if (meta.siteUrl) set.siteUrl = meta.siteUrl;
  if (meta.description) set.description = meta.description;
  if (meta.iconUrl) set.iconUrl = meta.iconUrl;
  if (meta.etag !== undefined) set.etag = meta.etag;
  if (meta.lastModified !== undefined) set.lastModified = meta.lastModified;
  if (Number.isFinite(meta.failStreak)) set.failStreak = Math.max(0, Number(meta.failStreak));

  await db.update(feeds).set(set).where(eq(feeds.id, feedId));
}

/** 失败计数 +1，返回新值 */
async function bumpFailStreak(db: Db, feedId: number): Promise<number> {
  const res = await db.execute(sql`
    update feeds set fail_streak = fail_streak + 1, updated_at = now()
     where id = ${feedId}
    returning fail_streak
  `);
  const row = (res.rows as unknown as Array<{ fail_streak: number }>)[0];
  return row ? Number(row.fail_streak) : 0;
}

export interface UpsertResult {
  inserted: number;
  /** 本轮新插入的条目（老条目上一轮已跑过关注/屏蔽规则，不必再判） */
  fresh: NormalizedItem[];
}

/**
 * 批量写入条目，返回新增条数与「本轮新增」列表。
 *
 * 做法：先按 guid 查已存在的（一条 SQL），再一次多行 upsert。
 * legacy 是逐条 INSERT ... ON CONFLICT 再用 `xmax = 0` 判新增 —— 50 条就是 50 次往返；
 * 这里两次往返搞定，新增集合由「查之前」的差集得出（并发双抓已由 inFlight 去重挡掉）。
 */
export async function upsertEntries(db: Db, feedId: number, items: NormalizedItem[]): Promise<UpsertResult> {
  if (!items.length) return { inserted: 0, fresh: [] };

  const guids = [...new Set(items.map((it) => it.guid))];
  const existing = await db
    .select({ guid: entries.guid })
    .from(entries)
    .where(and(eq(entries.feedId, feedId), inArray(entries.guid, guids)));
  const seen = new Set(existing.map((r) => r.guid));
  const fresh = items.filter((it) => !seen.has(it.guid));

  await db
    .insert(entries)
    .values(
      items.map((it) => ({
        feedId,
        guid: it.guid,
        title: it.title,
        link: it.link,
        pwd: it.pwd,
        description: it.description,
        content: it.content,
        size: it.size,
        tags: it.tags,
        image: it.image,
        images: it.images,
        links: it.links,
        sourceUrl: it.sourceUrl,
        bodyJson: it.bodyJson,
        publishedAt: it.publishedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [entries.feedId, entries.guid],
      set: {
        title: sql`excluded.title`,
        link: sql`excluded.link`,
        pwd: sql`excluded.pwd`,
        description: sql`excluded.description`,
        // 正文 COALESCE：某次抓取拿不到正文时不要把已存好的覆盖成 NULL
        content: sql`coalesce(excluded.content, ${entries.content})`,
        size: sql`excluded.size`,
        tags: sql`excluded.tags`,
        image: sql`excluded.image`,
        images: sql`excluded.images`,
        bodyJson: sql`coalesce(excluded.body_json, ${entries.bodyJson})`,
        links: sql`excluded.links`,
        sourceUrl: sql`excluded.source_url`,
        publishedAt: sql`excluded.published_at`,
      },
    });

  return { inserted: fresh.length, fresh };
}

/** 给新入库的条目打 watch / block 标记 */
async function markWatch(db: Db, feedId: number, verdicts: WatchVerdict[]): Promise<void> {
  if (!verdicts.length) return;

  // 按 (state, rule) 归组，一组一条 UPDATE
  const groups = new Map<string, { state: string; rule: string; guids: string[] }>();
  for (const v of verdicts) {
    const key = `${v.state}\u0000${v.rule}`;
    const g = groups.get(key) ?? { state: v.state, rule: v.rule, guids: [] };
    g.guids.push(v.guid);
    groups.set(key, g);
  }

  for (const g of groups.values()) {
    await db
      .update(entries)
      .set({ watchState: g.state, watchRule: g.rule })
      .where(and(eq(entries.feedId, feedId), inArray(entries.guid, g.guids)));
  }
}

/* ============================================================================
 * 3. 编排
 * ==========================================================================*/

export interface GroupResult {
  url: string;
  notModified?: boolean;
  added: number;
  total?: number;
  filtered?: number;
  error?: string | null;
  autoDisabled?: number;
  feeds: number;
  skipped?: 'too-recent' | 'in-flight';
}

export interface RefreshSummary {
  at: Date;
  added: number;
  failed: Array<{ url: string; error: string }>;
  skipped: number;
  autoDisabled: number;
  filtered: number;
  pruned: number;
  results: GroupResult[];
}

const recentFetchMs = new Map<string, number>();
const inFlight = new Map<string, Promise<GroupResult>>();
const REFRESH_MIN_INTERVAL_MS = 5000;

/** 同一 URL 的订阅归一组（用小写化后的完整 URL 做 key，与 feeds 唯一索引口径一致） */
function groupKey(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

/** 批量取用户偏好（一次查询，避免逐 feed N+1） */
async function loadPrefs(db: Db, ownerIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const ids = [...new Set(ownerIds)];
  if (!ids.length) return out;
  const rows = await db
    .select({ id: users.id, prefs: users.prefs })
    .from(users)
    .where(inArray(users.id, ids));
  for (const r of rows) out.set(r.id, (r.prefs ?? {}) as Record<string, unknown>);
  return out;
}

/** 关注规则命中的通知，攒到本轮结束再按账号合并推送（逐条推会刷出几十条消息） */
interface WatchHit {
  ownerId: string;
  ruleName: string;
  title: string;
  link: string | null;
  feed: string;
  publishedAt: Date | null;
}
let pendingHits: WatchHit[] = [];

async function flushWatchNotify(db: Db, prefs: Map<string, Record<string, unknown>>): Promise<void> {
  if (!pendingHits.length) return;
  const batch = pendingHits;
  pendingHits = [];

  const byOwner = new Map<string, WatchHit[]>();
  for (const h of batch) {
    const list = byOwner.get(h.ownerId) ?? [];
    list.push(h);
    byOwner.set(h.ownerId, list);
  }

  for (const [ownerId, list] of byOwner) {
    const url = userWebhook(prefs.get(ownerId) ?? null);
    if (!url) continue; // 没配地址就静默跳过（规则本身照常打标）
    const rules: string[] = [];
    for (const h of list) if (!rules.includes(h.ruleName)) rules.push(h.ruleName);

    const payload = {
      text: `【${rules.join(' / ')}】${list.length} 条新内容`,
      rule: rules.join(' / '),
      count: list.length,
      entries: list.slice(0, 20).map((h) => ({
        title: h.title,
        url: h.link,
        feed: h.feed,
        publishedAt: h.publishedAt,
      })),
    };

    try {
      // 发送前再校验一次：地址是保存后落库的，DNS 可能变化，也可能是升级前存下的内网地址
      const res = await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) console.error('[watch] webhook 返回', res.status);
    } catch (e) {
      console.error('[watch] webhook 失败：', (e as Error)?.message ?? e);
    }
  }
}

/** 抓一组「订阅了同一 URL」的频道：只回源一次，结果写回组内每个 feed 行 */
async function refreshGroup(db: Db, key: string, members: FeedRow[]): Promise<GroupResult> {
  const running = inFlight.get(key);
  if (running) return { ...(await running), skipped: 'in-flight' };

  const p = doRefreshGroup(db, key, members).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function doRefreshGroup(db: Db, key: string, members: FeedRow[]): Promise<GroupResult> {
  // 5s 内刚抓过这个 URL → 跳过（防连点刷新打爆源站）
  const last = recentFetchMs.get(key);
  if (last && Date.now() - last < REFRESH_MIN_INTERVAL_MS) {
    return { url: key, skipped: 'too-recent', added: 0, feeds: members.length };
  }

  // 用「最近抓过且带条件头」的那个成员的 etag/last_modified 打条件请求（命中 304 概率最高）
  const src = members
    .filter((m) => m.etag || m.lastModified)
    .sort((a, b) => (b.lastFetchedAt?.getTime() ?? 0) - (a.lastFetchedAt?.getTime() ?? 0))[0]
    ?? members[0]!;

  const first = members[0]!;
  const prefs = await loadPrefs(db, members.map((m) => m.ownerId));

  try {
    const r = await loadFeed(first.url, { etag: src.etag, lastModified: src.lastModified });

    if (r.notModified) {
      for (const m of members) {
        await saveFeedMeta(db, m.id, { status: 'ok', error: null, failStreak: 0 }).catch(() => {});
      }
      return { url: key, notModified: true, added: 0, total: 0, feeds: members.length };
    }

    let added = 0;
    let filtered = 0;

    for (const m of members) {
      const memberPrefs = prefs.get(m.ownerId) ?? null;

      // 条目过滤规则按成员 owner 逐人生效（同一 URL 多用户订阅时各过各的）
      const items = applyFilters(r.items, userFilters(memberPrefs));
      filtered += r.items.length - items.length;

      const up = await upsertEntries(db, m.id, items);
      added += up.inserted;

      // 新入库的条目立刻跑一遍关注 / 屏蔽规则
      const wRules = userWatchRules(memberPrefs);
      if (wRules.length && up.fresh.length) {
        const verdicts = classify(wRules, up.fresh);
        if (verdicts.length) {
          await markWatch(db, m.id, verdicts).catch((e: unknown) =>
            console.error('[watch] 打标失败：', (e as Error)?.message ?? e),
          );
          const names = notifyRuleNames(wRules);
          for (const v of verdicts) {
            const ruleName = names[v.rule];
            if (v.state !== 'watch' || !ruleName) continue;
            const row = up.fresh.find((f) => f.guid === v.guid);
            pendingHits.push({
              ownerId: m.ownerId,
              ruleName,
              title: row?.title ?? '',
              link: row?.link ?? null,
              feed: r.title ?? first.customTitle ?? first.url,
              publishedAt: row?.publishedAt ?? null,
            });
          }
        }
      }

      await saveFeedMeta(db, m.id, {
        title: r.title,
        siteUrl: r.siteUrl,
        description: r.description,
        iconUrl: r.iconUrl,
        etag: r.etag,
        lastModified: r.lastModified,
        status: 'ok',
        error: null,
        failStreak: 0,
      }).catch(() => {});
    }

    return { url: key, notModified: false, added, total: r.items.length, filtered, feeds: members.length };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 300);
    const autoOff: Array<{ id: number; title: string }> = [];

    for (const m of members) {
      await saveFeedMeta(db, m.id, { status: 'error', error: msg }).catch(() => {});
      const streak = await bumpFailStreak(db, m.id).catch(() => 0);
      if (streak >= FEED_FAIL_LIMIT && m.enabled) autoOff.push({ id: m.id, title: m.customTitle || m.title || m.url });
    }
    for (const f of autoOff) {
      await db.update(feeds).set({ enabled: false, updatedAt: new Date() }).where(eq(feeds.id, f.id)).catch(() => {});
      console.log(`[rss] 频道连续失败 ${FEED_FAIL_LIMIT} 次，已自动停用采集：${f.title}`);
    }

    return { url: key, error: msg, added: 0, feeds: members.length, autoDisabled: autoOff.length };
  } finally {
    recentFetchMs.set(key, Date.now()); // 无论成败都记时间，避免源站被连点打爆
  }
}

/** 清理：每个频道保留 N 条 + 按天数裁剪（收藏的条目一律豁免） */
export async function pruneEntries(db: Db): Promise<number> {
  let pruned = 0;

  if (KEEP_PER_FEED > 0) {
    const res = await db.execute(sql`
      delete from entries where id in (
        select id from (
          select id, row_number() over (
            partition by feed_id order by published_at desc nulls last, id desc
          ) as rn
          from entries where is_favorite = false
        ) x where x.rn > ${KEEP_PER_FEED}
      )
    `);
    pruned += res.rowCount ?? 0;
  }

  if (DEFAULT_KEEP_DAYS > 0) {
    const res = await db.execute(sql`
      delete from entries
       where is_favorite = false
         and published_at is not null
         and published_at < now() - make_interval(days => ${Math.floor(DEFAULT_KEEP_DAYS)})
    `);
    pruned += res.rowCount ?? 0;
  }

  return pruned;
}

/** 并发抓一批频道，抓完清理并汇总。手动「刷新全部」与定时 tick 都走这里。 */
export async function refreshFeeds(db: Db, rows: FeedRow[], label = '抓取'): Promise<RefreshSummary> {
  const startedAt = Date.now();
  const groups = new Map<string, FeedRow[]>();
  for (const f of rows) {
    const key = groupKey(f.url);
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }

  const items = [...groups.entries()];
  const results: GroupResult[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++;
      const entry = items[idx];
      if (!entry) return;
      results.push(await refreshGroup(db, entry[0], entry[1]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, items.length || 1) }, worker));

  // 关注命中先推送（需要 prefs，直接用本轮已经查过的）
  const prefs = await loadPrefs(db, rows.map((r) => r.ownerId));
  await flushWatchNotify(db, prefs);

  const pruned = await pruneEntries(db).catch(() => 0);

  const added = results.reduce((n, r) => n + r.added, 0);
  const autoDisabled = results.reduce((n, r) => n + (r.autoDisabled ?? 0), 0);
  const filtered = results.reduce((n, r) => n + (r.filtered ?? 0), 0);
  const failed = results.filter((r) => r.error).map((r) => ({ url: r.url, error: r.error ?? '' }));
  const skipped = results.filter((r) => r.skipped).length;

  lastRefreshAt = new Date();

  console.log(
    `[rss] ${label}完成：${groups.size} 个 URL 组 / ${rows.length} 个订阅，新增 ${added} 条`
    + (skipped ? `，跳过 ${skipped} 个` : '')
    + (failed.length ? `，失败 ${failed.length} 个` : '')
    + (autoDisabled ? `，连续失败自动停用 ${autoDisabled} 个` : '')
    + (filtered ? `，按过滤规则丢弃 ${filtered} 条` : '')
    + (pruned ? `，清理 ${pruned} 条` : '')
    + `，耗时 ${Date.now() - startedAt}ms`,
  );

  return { at: lastRefreshAt, added, failed, skipped, autoDisabled, filtered, pruned, results };
}

/** 抓单个频道（手动刷新单个用）；与批量刷新共享按 URL 的去重 */
export async function refreshOneFeed(db: Db, feed: FeedRow): Promise<GroupResult> {
  return refreshGroup(db, groupKey(feed.url), [feed]);
}

/** 该频道多久抓一次：自己设了就用它，否则跟随全局 */
export function feedIntervalMs(f: Pick<FeedRow, 'refreshMinutes'>, globalMinutes = DEFAULT_REFRESH_MINUTES): number {
  const own = Number(f.refreshMinutes);
  const mins = Number.isFinite(own) && own > 0 ? own : globalMinutes;
  return mins * 60_000;
}

/** 距上次抓取已超过自己间隔的频道（从没抓过的一律算到期） */
export function dueFeeds(rows: FeedRow[], now = Date.now()): FeedRow[] {
  return rows.filter((f) => {
    if (!f.enabled) return false;
    const lastAt = f.lastFetchedAt?.getTime() ?? 0;
    return !lastAt || now - lastAt >= feedIntervalMs(f);
  });
}

/* ============================================================================
 * 4. 调度
 * ==========================================================================*/

let lastRefreshAt: Date | null = null;
export const getLastRefreshAt = (): Date | null => lastRefreshAt;

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** 定时 tick：只抓「到期」的频道（跨用户）。每分钟检查一次，效果上每个频道各按自己的间隔。 */
export async function tickRefresh(db: Db): Promise<RefreshSummary | null> {
  if (ticking) return null; // 上一轮还没抓完（源站慢），本轮直接跳过
  ticking = true;
  try {
    const all = await db.select().from(feeds).where(eq(feeds.enabled, true));
    const due = dueFeeds(all);
    if (!due.length) return null;
    return await refreshFeeds(db, due, '定时抓取');
  } finally {
    ticking = false;
  }
}

export function startScheduler(db: Db): void {
  if (!SCHEDULER_ENABLED) {
    console.log('[rss] 定时抓取已禁用（REFRESH_DISABLED=1），只接受手动刷新');
    return;
  }
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void tickRefresh(db).catch((e: unknown) =>
      console.error('[rss] 定时抓取失败：', (e as Error)?.message ?? e),
    );
  }, TICK_MS);
  console.log(`[rss] 调度就绪：全局 ${DEFAULT_REFRESH_MINUTES} 分钟，每分钟检查一次到期频道`);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
