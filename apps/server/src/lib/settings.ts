/**
 * 站点级采集参数（`settings` 表，key = 'source'）。
 *
 * 移植 `apps/legacy/server.js` 的 `defaults()` / `normalizeSettings()` / `loadSettings()`
 * / `saveSettings()`，结构与语义对齐。
 *
 * 三条必须守住的规则：
 * 1. **读库也要 clamp**：手改库、老库缺键、表单脏值三种情况都会遇到。
 *    只在写入时夹区间是不够的 —— 数据库不是唯一的写入方。
 * 2. **env 只是首次落库的默认值**：一旦库里有了值，界面/接口保存的值优先。
 *    否则改 `.env` 重启会静默覆盖管理员在界面上的设置。
 * 3. **进程内快照 + 失效**：抓取器每个 tick 都要用这些参数（concurrency / timeout /
 *    keepPerFeed…），逐次查库没必要；保存后必须立刻失效，否则「改完没生效」。
 *
 * 与 legacy 的差异：这里只存 `source`。`auth`（单管理员账号 + 密码哈希）与
 * `sessionSecret` 在 v2 已交给 better-auth（users 表 + AUTH_SECRET），不再进 settings。
 */

import { eq } from 'drizzle-orm';
import { settings as settingsTable, type Db } from '@feedlore/db';
import type { SourceConfig } from '@feedlore/contract';
import { setOutboundProxy } from './net';
import {
  DEFAULT_KEEP_DAYS,
  DEFAULT_REFRESH_MINUTES,
  FEED_FAIL_LIMIT,
  REFRESH_CONCURRENCY,
  RSS_TIMEOUT_SECONDS,
  KEEP_PER_FEED,
} from '../env';

/** 重新导出，`fetcher` 等模块直接从这里取类型，避免同时依赖 contract 与 env。 */
export type { SourceConfig };

const KEY = 'source';

/** 快照有效期：即使不经过本进程的写入（另一容器/手工 SQL 改库）也能在 1 分钟内跟上。 */
const SNAPSHOT_TTL_MS = 60_000;

const int = (v: unknown, d: number): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : d;
};

/** 夹到闭区间；非法值（NaN/空串）取默认值再夹。语义对齐 legacy `clampInt(v, def, min, max)`。 */
function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = int(v, def);
  return Math.min(max, Math.max(min, n));
}

/** 首次落库的默认值：全部来自环境变量（与 legacy `defaults().source` 同区间）。 */
export function sourceDefaults(): SourceConfig {
  return {
    refreshMinutes: clampInt(DEFAULT_REFRESH_MINUTES, 20, 5, 1440),
    keepPerFeed: clampInt(KEEP_PER_FEED, 300, 0, 5000),
    // 0 = 不限（只按 keepPerFeed 的条数上限裁剪）
    keepDays: clampInt(DEFAULT_KEEP_DAYS, 0, 0, 3650),
    timeoutSeconds: clampInt(RSS_TIMEOUT_SECONDS, 25, 5, 120),
    concurrency: clampInt(REFRESH_CONCURRENCY, 3, 1, 10),
    feedFailLimit: clampInt(FEED_FAIL_LIMIT, 5, 2, 20),
    // 前端自动刷新列表的间隔：0 = 关闭（纯前端行为，服务端只负责存）
    autoRefreshMinutes: clampInt(process.env.AUTO_REFRESH_MINUTES, 0, 0, 1440),
    // 出网代理：真正接上了（`lib/net.ts` 的 setOutboundProxy / ProxyAgent）。
    // 走代理时这一跳没有 IP 钉定（DNS 由代理解析），内网地址仍然被拒 —— 取舍写在 net.ts 顶部。
    proxyUrl: String(process.env.PROXY_URL ?? '').trim().slice(0, 500),
    imgTtlDays: clampInt(process.env.IMG_TTL_DAYS, 7, 1, 365),
    imgKeepDays: clampInt(process.env.IMG_KEEP_DAYS, 90, 1, 3650),
    imgMaxDim: clampInt(process.env.IMG_MAX_DIM, 1280, 320, 4096),
    imgQuality: clampInt(process.env.IMG_WEBP_QUALITY, 78, 30, 100),
  };
}

/** 把任意来源（库里的旧值 / 表单提交的增量）夹成合法配置。 */
export function normalizeSource(input: Partial<Record<keyof SourceConfig, unknown>> | null | undefined): SourceConfig {
  const def = sourceDefaults();
  const s = input ?? {};
  const cur = <K extends keyof SourceConfig>(k: K): unknown => (s[k] === undefined ? def[k] : s[k]);

  return {
    refreshMinutes: clampInt(cur('refreshMinutes'), def.refreshMinutes, 5, 1440),
    keepPerFeed: clampInt(cur('keepPerFeed'), def.keepPerFeed, 0, 5000),
    keepDays: clampInt(cur('keepDays'), def.keepDays, 0, 3650),
    timeoutSeconds: clampInt(cur('timeoutSeconds'), def.timeoutSeconds, 5, 120),
    concurrency: clampInt(cur('concurrency'), def.concurrency, 1, 10),
    feedFailLimit: clampInt(cur('feedFailLimit'), def.feedFailLimit, 2, 20),
    autoRefreshMinutes: clampInt(cur('autoRefreshMinutes'), def.autoRefreshMinutes, 0, 1440),
    proxyUrl: String(cur('proxyUrl') ?? '').trim().slice(0, 500),
    imgTtlDays: clampInt(cur('imgTtlDays'), def.imgTtlDays, 1, 365),
    imgKeepDays: clampInt(cur('imgKeepDays'), def.imgKeepDays, 1, 3650),
    imgMaxDim: clampInt(cur('imgMaxDim'), def.imgMaxDim, 320, 4096),
    imgQuality: clampInt(cur('imgQuality'), def.imgQuality, 30, 100),
  };
}

/* ============================================================================
 * 快照
 * ==========================================================================*/

let snapshot: SourceConfig | null = null;
let snapshotAt = 0;

/**
 * 同步读当前快照（可能为 null：进程刚起、还没读过库）。
 * 只在**不方便 await** 的地方用（如 `feedIntervalMs` 的默认参数）；能 await 就用 `getSource`。
 */
export function sourceSnapshot(): SourceConfig | null {
  return snapshot;
}

/** 取配置：快照新鲜就直接用，否则读库（DB 挂了回退上一次快照，再回退默认值）。 */
export async function getSource(db: Db | null): Promise<SourceConfig> {
  if (snapshot && Date.now() - snapshotAt < SNAPSHOT_TTL_MS) return snapshot;
  return (await reloadSource(db)) ?? snapshot ?? sourceDefaults();
}

/** 强制读库并刷新快照。 */
export async function reloadSource(db: Db | null): Promise<SourceConfig | null> {
  if (!db) return snapshot;
  try {
    const rows = await db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.key, KEY))
      .limit(1);
    const stored = (rows[0]?.value ?? null) as Partial<Record<keyof SourceConfig, unknown>> | null;
    snapshot = normalizeSource(stored);
    snapshotAt = Date.now();
    // 出网代理跟着快照走：改完保存后，下一次出网就用新的（不用重启）
    setOutboundProxy(snapshot.proxyUrl);
    return snapshot;
  } catch (e) {
    // 数据库不可用不能让抓取器一起死：用上一次快照（或默认值）继续
    console.warn('[settings] 读取采集参数失败，沿用上次值：', (e as Error)?.message ?? e);
    return snapshot;
  }
}

/**
 * 合并式保存：只覆盖 `patch` 里出现过的键，其余保持库里现值。
 * 返回保存后的完整配置（已 clamp）。
 */
export async function saveSource(db: Db, patch: Partial<Record<keyof SourceConfig, unknown>>): Promise<SourceConfig> {
  const current = (await reloadSource(db)) ?? sourceDefaults();
  const next = normalizeSource({ ...current, ...patch });

  await db
    .insert(settingsTable)
    .values({ key: KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value: next, updatedAt: new Date() },
    });

  snapshot = next;
  snapshotAt = Date.now();
  setOutboundProxy(next.proxyUrl);
  return next;
}

/** 仅用于测试/进程重启时清空快照。 */
export function resetSourceSnapshot(): void {
  snapshot = null;
  snapshotAt = 0;
}
