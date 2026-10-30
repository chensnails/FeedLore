/**
 * 状态页聚合（GET /api/status 的数据来源）。
 *
 * 单独成文件（而不是塞在 admin.ts 里）有两个原因：
 * 1) 这里的类型很重（契约 status.response 是三层嵌套的大对象）。与 13 个路由放在同一个
 *    模块里时，TypeScript 会把这个模块的返回类型算成一团糊，**Hono 的路由 schema 直接推成空**
 *    ——表现为「服务端类型检查全绿，但前端 hc 里根本没有 /api/status 这个键」。
 *    拆开后每个模块的类型预算都可控。
 * 2) 状态页自身的排障价值高，独立文件便于对照 legacy 的 buildStatus 逐项核对。
 */

import fs from 'node:fs';
import os from 'node:os';
import { sql } from 'drizzle-orm';
import { digests, feeds, getPool, users, type Db } from '@feedlore/db';
import { auth as authSpec } from '@feedlore/contract';
import type { z } from 'zod';
import { assertResponse } from './validate';
import { getSource } from './settings';
import {
  feedIntervalMs,
  getLastRefreshAt,
  getLastRun,
  inFlightCount,
  type FeedRow,
} from './fetcher';
import { userDigest, userLayout } from './prefs';
import { APP_VERSION } from '../env';

/* ============================================================================
 * 小工具
 * ==========================================================================*/

/**
 * 「下一个 HH:MM 时刻」的绝对毫秒值（按上海时区）。
 *
 * 上海自 1991 年后无夏令时，UTC 偏移恒为 +8，所以这里直接按偏移换算，
 * 不用 Intl 去解析「明天几点」——那条路在跨日边界上很容易算错一天。
 */
function nextRunAt(hhmm: string, now: Date): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const H = Number.isFinite(h) ? h : 8;
  const M = Number.isFinite(m) ? m : 0;
  const offset = 8 * 3600_000;
  const sh = new Date(now.getTime() + offset);
  const target = Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate(), H, M) - offset;
  // 今天的这个点已过 → 顺延到明天（<= 意味着「正好现在」，调度器这一分钟内会跑，算明天更准）
  return target > now.getTime() ? target : target + 86_400_000;
}

export const GITHUB_REPO = process.env.GITHUB_REPO ?? 'chensnails/FeedLore';
export const VERSION_TTL_MS = 10 * 60_000;

/** 上海时区的 YYYY-MM-DD（日报/状态页的「今天」口径与 legacy 一致）。 */
function shanghaiToday(d = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

const readCgroup = (file: string): string | null => {
  try {
    return String(fs.readFileSync(file, 'utf8')).trim();
  } catch {
    return null;
  }
};

/** 正整数字节；cgroup v2 未设限额时内容是 "max"（NaN）→ null；v1 的「无限制」是接近 2^63 的巨数 */
function cgroupBytes(raw: string | null, cap = 2 ** 40): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < cap ? n : null;
}

function readCgroupMemory(): { used: number; limit: number | null } | null {
  const v2 = cgroupBytes(readCgroup('/sys/fs/cgroup/memory.current'));
  if (v2 !== null) return { used: v2, limit: cgroupBytes(readCgroup('/sys/fs/cgroup/memory.max')) };
  const v1 = cgroupBytes(readCgroup('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  if (v1 !== null) {
    return { used: v1, limit: cgroupBytes(readCgroup('/sys/fs/cgroup/memory/memory.limit_in_bytes')) };
  }
  return null;
}

/** 容器 CPU 是累计值，两次采样相减才有意义；首次调用只记基准返回 null。 */
let lastCpuSample: { usec: number; at: number } | null = null;
function readCgroupCpu(): number | null {
  let usec: number | null = null;
  const v2 = /^usage_usec\s+(\d+)/m.exec(readCgroup('/sys/fs/cgroup/cpu.stat') ?? '');
  if (v2) usec = Number(v2[1]) / 1000; // v2: 微秒
  else {
    const v1 = readCgroup('/sys/fs/cgroup/cpuacct/cpuacct.usage');
    if (v1) usec = Number(v1) / 1000; // v1: 纳秒
  }
  if (!Number.isFinite(usec)) return null;

  const at = Date.now();
  const prev = lastCpuSample;
  lastCpuSample = { usec: usec as number, at };
  if (!prev) return null;
  const dtMs = at - prev.at;
  if (dtMs < 1000) return null;
  const cpuMs = (usec as number) - prev.usec;
  if (!Number.isFinite(cpuMs) || cpuMs < 0) return null; // 容器重启过
  return Math.round((cpuMs / dtMs) * 10000) / 100;
}

/** 语义化版本比较：返回 1/0/-1。够用即可（只比较 x.y.z 数字段）。 */
export function compareVersion(a: string, b: string): number {
  const pa = String(a).split(/[.-]/).map((x) => Number(x) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/* ============================================================================
 * 状态聚合
 * ==========================================================================*/

/** eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

async function tableCounts(db: Db): Promise<Record<string, number>> {
  const res = await db.execute(sql`
    select (select count(*) from users)      as users,
           (select count(*) from feeds)      as feeds,
           (select count(*) from entries)    as entries,
           (select count(*) from digests)    as digests,
           (select count(*) from settings)   as settings,
           (select count(*) from image_cache) as image_cache
  `);
  const r = ((res.rows as unknown as Row[])[0] ?? {}) as Row;
  return {
    users: Number(r.users ?? 0),
    feeds: Number(r.feeds ?? 0),
    entries: Number(r.entries ?? 0),
    digests: Number(r.digests ?? 0),
    settings: Number(r.settings ?? 0),
    image_cache: Number(r.image_cache ?? 0),
  };
}

export async function buildStatus(
  db: Db | null,
): Promise<z.infer<typeof authSpec.status.response>> {
  const now = Date.now();
  const mem = process.memoryUsage();

  /* ---------------- 数据库 ---------------- */
  const dbInfo: {
    ready: boolean;
    error: string | null;
    latencyMs: number | null;
    pool: { total: number; idle: number; waiting: number; max: number } | null;
    tables: Record<string, number> | null;
    sizeBytes: number | null;
  } = { ready: false, error: null, latencyMs: null, pool: null, tables: null, sizeBytes: null };

  if (db) {
    const t0 = Date.now();
    try {
      await db.execute(sql`select 1`);
      dbInfo.ready = true;
      dbInfo.latencyMs = Date.now() - t0;
    } catch (e) {
      dbInfo.error = String((e as Error)?.message ?? e);
    }
    if (dbInfo.ready) {
      // 三项统计互不依赖，任一失败不该拖垮整页（表被删/权限不足时也要能看别的）
      try {
        dbInfo.tables = await tableCounts(db);
      } catch { /* 留 null */ }
      try {
        const r = await db.execute(sql`select pg_database_size(current_database()) as bytes`);
        const v = ((r.rows as unknown as Row[])[0] ?? {}).bytes;
        dbInfo.sizeBytes = v === undefined ? null : Number(v);
      } catch { /* 留 null */ }
      const p = getPool();
      if (p) {
        dbInfo.pool = {
          total: p.totalCount,
          idle: p.idleCount,
          waiting: p.waitingCount,
          max: p.options.max ?? Number(process.env.PG_POOL_MAX || 10),
        };
      }
    }
  } else {
    dbInfo.error = 'DATABASE_URL 未配置';
  }

  /* ---------------- 采集 ---------------- */
  const cfg = await getSource(db);
  const feedStats = { total: 0, enabled: 0, cardEnabled: 0, error: 0, neverFetched: 0, perFeedInterval: 0, autoDisabled: 0 };
  let problems: Array<{
    feedId: string;
    title: string;
    error: string;
    lastFetchedAt: string | null;
    groupName: string;
    enabled: boolean;
    failStreak: number;
  }> = [];
  let dueCount = 0;
  let nextRefreshAt: string | null = null;
  const entryInfo = { total: 0, unread: 0, favorite: 0, added24h: 0, oldest: null as string | null, newest: null as string | null };

  if (db && dbInfo.ready) {
    try {
      // 状态页是管理员视角，跨全部用户统计（legacy allFeeds 同口径）
      const rows = await db.select().from(feeds);
      const list = rows as FeedRow[];
      feedStats.total = list.length;
      feedStats.enabled = list.filter((f) => f.enabled).length;
      feedStats.cardEnabled = list.filter((f) => f.cardEnabled).length;
      feedStats.error = list.filter((f) => f.lastStatus === 'error').length;
      feedStats.neverFetched = list.filter((f) => !f.lastFetchedAt).length;
      feedStats.perFeedInterval = list.filter((f) => f.refreshMinutes != null).length;
      feedStats.autoDisabled = list.filter((f) => !f.enabled && f.failStreak >= cfg.feedFailLimit).length;

      problems = list
        .filter((f) => f.lastStatus === 'error')
        .map((f) => ({
          feedId: String(f.id),
          title: f.customTitle || f.title || f.url,
          error: f.lastError || '抓取失败',
          lastFetchedAt: f.lastFetchedAt ? f.lastFetchedAt.toISOString() : null,
          groupName: f.groupName ?? '',
          enabled: f.enabled,
          failStreak: f.failStreak,
        }));

      // 「下次抓取」= 已开启的频道里最早到期的那个；已过期的算「现在就该抓」
      let earliest: number | null = null;
      for (const f of list) {
        if (!f.enabled) continue;
        const at = f.lastFetchedAt ? f.lastFetchedAt.getTime() + feedIntervalMs(f, cfg.refreshMinutes) : now;
        if (at <= now) dueCount += 1;
        if (earliest === null || at < earliest) earliest = at;
      }
      nextRefreshAt = earliest === null ? null : new Date(Math.max(earliest, now)).toISOString();

      const eRes = await db.execute(sql`
        select count(*)::int as total,
               count(*) filter (where is_read = false)::int as unread,
               count(*) filter (where is_favorite = true)::int as favorite,
               count(*) filter (where fetched_at >= now() - interval '24 hours')::int as added24h,
               min(published_at) as oldest,
               max(published_at) as newest
        from entries
      `);
      const e = ((eRes.rows as unknown as Row[])[0] ?? {}) as Row;
      entryInfo.total = Number(e.total ?? 0);
      entryInfo.unread = Number(e.unread ?? 0);
      entryInfo.favorite = Number(e.favorite ?? 0);
      entryInfo.added24h = Number(e.added24h ?? 0);
      entryInfo.oldest = e.oldest ? new Date(e.oldest as string).toISOString() : null;
      entryInfo.newest = e.newest ? new Date(e.newest as string).toISOString() : null;
    } catch (e) {
      console.warn('[status] 采集统计失败：', (e as Error)?.message ?? e);
    }
  }

  /* ---------------- 日报 ---------------- */
  // 只报**事实**：多少账号开了自动、库里现存几份、以及「下一个会跑的时刻」。
  // nextRunAt 按账号各自的时间算（每人一份配置），取最早的那个；
  // 没有任何账号开自动时保持 null —— 没有调度目标却报一个时间是在骗人。
  const digestInfo = {
    autoUsers: 0,
    totalUsers: 0,
    nextRunAt: null as string | null,
    count: 0,
    oldestDate: null as string | null,
    latest: null as {
      date: string;
      generatedAt: number | null;
      model: string;
      fallback: boolean;
      error: string | null;
      usedMapReduce: boolean;
      stats: unknown;
    } | null,
  };

  if (db && dbInfo.ready) {
    try {
      const list = await db.select({ id: users.id, prefs: users.prefs }).from(users);
      digestInfo.totalUsers = list.length;
      let earliest: number | null = null;
      for (const u of list) {
        const d = userDigest(u.prefs as Record<string, unknown>);
        if (!d.auto) continue;
        // 关掉日报入口的账号不参与调度，也不该出现在「下次何时跑」里
        if (userLayout(u.prefs as Record<string, unknown>).digestEnabled === false) continue;
        digestInfo.autoUsers += 1;
        const t = nextRunAt(d.time, new Date(now));
        if (earliest === null || t < earliest) earliest = t;
      }
      if (earliest !== null) digestInfo.nextRunAt = new Date(earliest).toISOString();
    } catch { /* 静默：日报不是关键路径 */ }

    try {
      const dRes = await db.execute(sql`
        select count(*)::int as n,
               min(date)::text as oldest
        from digests
      `);
      const d = ((dRes.rows as unknown as Row[])[0] ?? {}) as Row;
      digestInfo.count = Number(d.n ?? 0);
      digestInfo.oldestDate = (d.oldest as string | null) ?? null;

      const latest = await db
        .select({
          date: digests.date,
          payload: digests.payload,
          model: digests.model,
          fallback: digests.fallback,
        })
        .from(digests)
        .orderBy(sql`${digests.date} desc`)
        .limit(1);
      const row = latest[0];
      if (row) {
        const p = (row.payload ?? {}) as Record<string, unknown>;
        digestInfo.latest = {
          date: String(row.date),
          generatedAt: typeof p.generatedAt === 'number' ? p.generatedAt : null,
          model: row.model ?? '',
          fallback: Boolean(row.fallback),
          error: typeof p.error === 'string' ? p.error : null,
          usedMapReduce: Boolean(p.usedMapReduce),
          stats: (p.stats as unknown) ?? null,
        };
      }
    } catch { /* 静默 */ }
  }

  /* ---------------- 组装 ---------------- */
  const containerMem = readCgroupMemory();
  const cpuPercent = readCgroupCpu();
  const container =
    containerMem || cpuPercent !== null
      ? {
          memoryUsed: containerMem ? containerMem.used : null,
          memoryLimit: containerMem ? containerMem.limit : null,
          cpuPercent,
        }
      : null;

  const run = getLastRun();

  return assertResponse(
    authSpec.status.response,
    {
      app: {
        version: APP_VERSION,
        node: process.version,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        startedAt: new Date(now - process.uptime() * 1000).toISOString(),
        timezone: 'Asia/Shanghai',
        now: new Date(now).toISOString(),
        today: shanghaiToday(new Date(now)),
        memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
        container,
        loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
        cpuCount: os.cpus().length,
      },
      db: dbInfo,
      rss: {
        refreshMinutes: cfg.refreshMinutes,
        keepPerFeed: cfg.keepPerFeed,
        keepDays: cfg.keepDays,
        autoRefreshMinutes: cfg.autoRefreshMinutes,
        concurrency: cfg.concurrency,
        timeoutSeconds: cfg.timeoutSeconds,
        feedFailLimit: cfg.feedFailLimit,
        proxyUrl: cfg.proxyUrl,
        lastRefreshAt: getLastRefreshAt()?.toISOString() ?? null,
        nextRefreshAt,
        dueCount,
        inFlight: inFlightCount(),
        lastResult: run
          ? {
              added: run.added,
              pruned: run.pruned,
              skipped: run.skipped,
              failed: run.failed,
              autoDisabled: run.autoDisabled,
              filtered: run.filtered,
              durationMs: run.durationMs,
            }
          : null,
        feeds: feedStats,
        entries: entryInfo,
        problems,
      },
      digest: digestInfo,
    },
    'GET /api/status',
  );
}
