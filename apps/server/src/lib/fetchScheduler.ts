import type { Db } from '@feedlore/db';
import { feeds } from '@feedlore/db';
import { eq } from 'drizzle-orm';
import { DEFAULT_REFRESH_MINUTES, SCHEDULER_ENABLED } from '../env';
import { condFactor, condHost } from './feedCond';
import { RSS_SCHEDULER_LOCK_KEY, tryFetchLock } from './fetchCoordinator';
import { refreshFeeds } from './fetcher';
import { rssSchedulerMetrics } from './fetchRuntime';
import type { FeedRow, RefreshSummary } from './fetchTypes';
import { log } from './logger';
import { getSource, sourceSnapshot } from './settings';

export function feedIntervalMs(
  f: Pick<FeedRow, 'refreshMinutes'>,
  globalMinutes = sourceSnapshot()?.refreshMinutes ?? DEFAULT_REFRESH_MINUTES,
): number {
  const own = Number(f.refreshMinutes);
  const mins = Number.isFinite(own) && own > 0 ? own : globalMinutes;
  return mins * 60_000;
}

export function dueFeeds(rows: FeedRow[], now = Date.now()): FeedRow[] {
  return rows.filter((f) => {
    if (!f.enabled) return false;
    const lastAt = f.lastFetchedAt?.getTime() ?? 0;
    if (!lastAt) return true;
    const host = condHost(f.url);
    const interval = feedIntervalMs(f) * (host ? condFactor(host) : 1);
    return now - lastAt >= interval;
  });
}

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export async function tickRefresh(db: Db): Promise<RefreshSummary | null> {
  if (ticking) {
    rssSchedulerMetrics.skipped();
    return null;
  }
  ticking = true;
  let startedAt: number | null = null;
  let outcome: 'success' | 'failure' = 'success';
  let backlog: number | null = null;
  try {
    const claim = await tryFetchLock(db, RSS_SCHEDULER_LOCK_KEY, async () => {
      startedAt = rssSchedulerMetrics.start();
      await getSource(db);
      const all = await db.select().from(feeds).where(eq(feeds.enabled, true));
      const due = dueFeeds(all);
      backlog = due.length;
      if (!due.length) return null;
      return refreshFeeds(db, due, 'scheduled');
    });
    if (!claim.acquired) {
      rssSchedulerMetrics.skipped();
      return null;
    }
    return claim.value;
  } catch (e) {
    outcome = 'failure';
    throw e;
  } finally {
    if (startedAt !== null) rssSchedulerMetrics.finish(startedAt, outcome, backlog);
    ticking = false;
  }
}

export function startScheduler(db: Db): void {
  if (!SCHEDULER_ENABLED) {
    log.info('[rss] scheduled refresh disabled (REFRESH_DISABLED=1), manual refresh only');
    return;
  }
  if (timer) clearInterval(timer);
  void getSource(db)
    .then((cfg) =>
      log.info(
        `[rss] scheduler ready: global interval ${cfg.refreshMinutes} min, due feeds checked every minute`,
      ),
    )
    .catch((e: unknown) =>
      log.error('[rss] failed to read collection settings:', (e as Error)?.message ?? e),
    );
  timer = setInterval(() => {
    void tickRefresh(db).catch((e: unknown) =>
      log.error('[rss] scheduled refresh failed:', (e as Error)?.message ?? e),
    );
  }, TICK_MS);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
