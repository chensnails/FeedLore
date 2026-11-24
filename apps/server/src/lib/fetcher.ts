import { type Db, feeds, users } from '@feedlore/db';
import { eq, inArray } from 'drizzle-orm';
import { apiErrorKey } from './apiError';
import { tryFetchLock } from './fetchCoordinator';
import { loadFeed } from './fetchNetwork';
import {
  advanceRefreshRun,
  beginRefreshRun,
  endRefreshRun,
  flightFinished,
  flightStarted,
  recordRefreshRun,
} from './fetchRuntime';
import { bumpFailStreak, markWatch, pruneEntries, saveFeedMeta, upsertEntries } from './fetchStore';
import type { FeedRow, GroupResult, RefreshSummary } from './fetchTypes';
import { applyFilters } from './filter';
import { enhanceWithFullText, pruneArticleCache } from './fulltext';
import { log } from './logger';
import { safeFetch } from './net';
import { userFilters, userRules, userWatchRules, userWebhook } from './prefs';
import { applyRulesToFresh } from './rules';
import { scopeAllows } from './scope';
import { getSource, type SourceConfig } from './settings';
import { classify, notifyRuleNames } from './watch';
import { expireWatchTags } from './watch-expire';

const inFlight = new WeakMap<Db, Map<string, Promise<GroupResult>>>();
const REFRESH_MIN_INTERVAL_MS = 5000;

function flightsFor(db: Db): Map<string, Promise<GroupResult>> {
  let flights = inFlight.get(db);
  if (!flights) {
    flights = new Map();
    inFlight.set(db, flights);
  }
  return flights;
}

function groupKey(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

async function loadPrefs(
  db: Db,
  ownerIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
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

interface WatchHit {
  ownerId: string;
  ruleName: string;
  title: string;
  link: string | null;
  feed: string;
  publishedAt: Date | null;
}
let pendingHits: WatchHit[] = [];

async function flushWatchNotify(
  _db: Db,
  prefs: Map<string, Record<string, unknown>>,
): Promise<void> {
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
    if (!url) continue;
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
      const res = await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) log.error('[watch] webhook returned', res.status);
    } catch (e) {
      log.error('[watch] webhook delivery failed:', (e as Error)?.message ?? e);
    }
  }
}

async function refreshGroup(
  db: Db,
  key: string,
  members: FeedRow[],
  src: SourceConfig,
): Promise<GroupResult> {
  const flights = flightsFor(db);
  const running = flights.get(key);
  if (running) return { ...(await running), skipped: 'in-flight' };

  const p = (async () => {
    const claim = await tryFetchLock(db, key, async () => {
      const fresh = await db
        .select()
        .from(feeds)
        .where(
          inArray(
            feeds.id,
            members.map((m) => m.id),
          ),
        );
      const matching = fresh.filter((m) => groupKey(m.url) === key);
      if (!matching.length) return { url: key, skipped: 'too-recent' as const, added: 0, feeds: 0 };

      const last = Math.max(...matching.map((m) => m.lastFetchedAt?.getTime() ?? 0));
      if (last && Date.now() - last < REFRESH_MIN_INTERVAL_MS) {
        return { url: key, skipped: 'too-recent' as const, added: 0, feeds: matching.length };
      }
      return doRefreshGroup(db, key, matching, src);
    });
    return claim.acquired
      ? claim.value
      : { url: key, skipped: 'in-flight' as const, added: 0, feeds: members.length };
  })().finally(() => {
    flights.delete(key);
    flightFinished();
  });
  flights.set(key, p);
  flightStarted();
  return p;
}

async function doRefreshGroup(
  db: Db,
  key: string,
  members: FeedRow[],
  cfg: SourceConfig,
): Promise<GroupResult> {
  const src =
    members
      .filter((m) => m.etag || m.lastModified)
      .sort((a, b) => (b.lastFetchedAt?.getTime() ?? 0) - (a.lastFetchedAt?.getTime() ?? 0))[0] ??
    members[0]!;

  const first = members[0]!;
  const prefs = await loadPrefs(
    db,
    members.map((m) => m.ownerId),
  );

  try {
    const r = await loadFeed(first.url, {
      etag: src.etag,
      lastModified: src.lastModified,
      timeoutMs: cfg.timeoutSeconds * 1000,
    });

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
      const items = applyFilters(
        r.items,
        userFilters(memberPrefs).filter((rule) => scopeAllows(rule.scope, m)),
      );
      filtered += r.items.length - items.length;

      const enriched =
        m.fullText && items.length
          ? await enhanceWithFullText(db, items, {
              siteUrl: r.siteUrl,
              timeoutMs: Math.min(cfg.timeoutSeconds * 1000, 12_000),
            }).catch((e: unknown) => {
              log.error('[rss] full-text fetch failed:', (e as Error)?.message ?? e);
              return items;
            })
          : items;

      const up = await upsertEntries(db, m.id, enriched);
      added += up.inserted;

      const wRules = userWatchRules(memberPrefs).filter((rule) => scopeAllows(rule.scope, m));
      if (wRules.length && up.fresh.length) {
        const verdicts = classify(wRules, up.fresh);
        if (verdicts.length) {
          await markWatch(db, m.id, verdicts).catch((e: unknown) =>
            log.error('[watch] failed to tag entries:', (e as Error)?.message ?? e),
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

      const rules = userRules(memberPrefs).filter((r) => r.on !== false);
      if (rules.length && up.fresh.length) {
        try {
          const hits = await applyRulesToFresh(db, m.id, m, up.fresh, rules);
          for (const h of hits) {
            pendingHits.push({
              ownerId: m.ownerId,
              ruleName: h.ruleName,
              title: h.title,
              link: h.link,
              feed: r.title ?? first.customTitle ?? first.url,
              publishedAt: h.publishedAt,
            });
          }
        } catch (e) {
          log.error('[rules] apply failed:', (e as Error)?.message ?? e);
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

    return {
      url: key,
      notModified: false,
      added,
      total: r.items.length,
      filtered,
      feeds: members.length,
    };
  } catch (e) {
    const msg = apiErrorKey(e);
    const autoOff: Array<{ id: number; title: string }> = [];

    for (const m of members) {
      await saveFeedMeta(db, m.id, { status: 'error', error: msg }).catch(() => {});
      const streak = await bumpFailStreak(db, m.id).catch(() => 0);
      if (streak >= cfg.feedFailLimit && m.enabled)
        autoOff.push({ id: m.id, title: m.customTitle || m.title || m.url });
    }
    for (const f of autoOff) {
      await db
        .update(feeds)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(feeds.id, f.id))
        .catch(() => {});
      log.info(
        `[rss] feed failed ${cfg.feedFailLimit} times in a row, collection auto-disabled: ${f.title}`,
      );
    }

    return { url: key, error: msg, added: 0, feeds: members.length, autoDisabled: autoOff.length };
  }
}

export async function refreshFeeds(
  db: Db,
  rows: FeedRow[],
  label = 'manual',
): Promise<RefreshSummary> {
  const startedAt = Date.now();
  const cfg = await getSource(db);
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
  beginRefreshRun(label, items.length, startedAt);

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++;
      const entry = items[idx];
      if (!entry) return;
      results.push(await refreshGroup(db, entry[0], entry[1], cfg));
      advanceRefreshRun();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(cfg.concurrency, items.length || 1) }, worker));
  } finally {
    endRefreshRun();
  }

  const prefs = await loadPrefs(
    db,
    rows.map((r) => r.ownerId),
  );
  await flushWatchNotify(db, prefs);

  const pruned = await pruneEntries(db, cfg).catch(() => 0);
  const watchExpired = await expireWatchTags(db).catch(() => 0);
  await pruneArticleCache(db).catch(() => 0);

  const added = results.reduce((n, r) => n + r.added, 0);
  const autoDisabled = results.reduce((n, r) => n + (r.autoDisabled ?? 0), 0);
  const filtered = results.reduce((n, r) => n + (r.filtered ?? 0), 0);
  const failed = results.filter((r) => r.error).map((r) => ({ url: r.url, error: r.error ?? '' }));
  const skipped = results.filter((r) => r.skipped).length;
  const at = recordRefreshRun({
    at: new Date(),
    added,
    pruned,
    skipped,
    failed: failed.length,
    autoDisabled,
    filtered,
    durationMs: Date.now() - startedAt,
  });

  log.info(
    `[rss] refresh (${label}) done: ${groups.size} URL groups / ${rows.length} feeds, ${added} new entries` +
      (skipped ? `, ${skipped} skipped` : '') +
      (failed.length ? `, ${failed.length} failed` : '') +
      (autoDisabled ? `, ${autoDisabled} auto-disabled after repeated failures` : '') +
      (filtered ? `, ${filtered} dropped by filter rules` : '') +
      (watchExpired ? `, ${watchExpired} watch tags expired` : '') +
      (pruned ? `, ${pruned} pruned` : '') +
      `, took ${Date.now() - startedAt}ms`,
  );

  return { at, added, failed, skipped, autoDisabled, filtered, pruned, results };
}

export async function refreshOneFeed(db: Db, feed: FeedRow): Promise<GroupResult> {
  return refreshGroup(db, groupKey(feed.url), [feed], await getSource(db));
}
