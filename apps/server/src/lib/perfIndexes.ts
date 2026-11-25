/**
 * 重型性能索引的后台补建（2026-11-25）。
 *
 * 0020/0021 曾在启动迁移里同步建 trigram GIN 索引。条目量大时单条 CREATE INDEX
 * 要扫全表数分钟，app 在迁移结束前不会监听，健康检查失败、反代直接 502。
 * 索引只影响查询速度，不是启动正确性的前提，因此移到服务监听之后：
 * - 独立连接、autocommit，逐条 CREATE INDEX CONCURRENTLY（不阻塞读写、不拿长锁）；
 * - advisory lock 保证多实例只有一个在构建；
 * - 已存在但 indisvalid=false 的残留索引先 DROP 再重建（上次构建被中断的自愈）。
 * 失败只告警，下次启动重试；站点功能不依赖这些索引。
 */
import pg from 'pg';
import { log } from './logger';

const LOCK_KEY = 'feedlore:perf-indexes';

/** 首次构建延迟：避开冷启动的迁移、播种与第一轮抓取。 */
const START_DELAY_MS = 15_000;

export interface PerfIndexSpec {
  name: string;
  table: string;
  sql: string;
}

export const PERF_INDEXES: readonly PerfIndexSpec[] = [
  {
    name: 'entries_desc_trgm',
    table: 'entries',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "entries_desc_trgm" ON "entries" USING gin ("description" gin_trgm_ops)`,
  },
  {
    name: 'entries_desc_trgm_expr',
    table: 'entries',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "entries_desc_trgm_expr" ON "entries" USING gin (coalesce("description", '') gin_trgm_ops)`,
  },
  {
    name: 'entries_content_trgm_expr',
    table: 'entries',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "entries_content_trgm_expr" ON "entries" USING gin (coalesce("content", '') gin_trgm_ops)`,
  },
];

export interface PerfIndexDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PerfIndexResult {
  /** true = 另一个实例已持锁，本次未做任何事 */
  locked: boolean;
  created: string[];
  kept: string[];
}

export async function ensurePerfIndexes(db: PerfIndexDb): Promise<PerfIndexResult> {
  const lock = await db.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as ok', [
    LOCK_KEY,
  ]);
  if (!lock.rows[0]?.ok) return { locked: true, created: [], kept: [] };

  const created: string[] = [];
  const kept: string[] = [];
  try {
    for (const ix of PERF_INDEXES) {
      const found = await db.query(
        `select i.indisvalid
           from pg_index i
           join pg_class c on c.oid = i.indexrelid
          where c.relname = $1 and i.indrelid = to_regclass($2)`,
        [ix.name, ix.table],
      );
      const row = found.rows[0] as { indisvalid?: boolean } | undefined;
      if (row?.indisvalid) {
        kept.push(ix.name);
        continue;
      }
      if (row) {
        log.warn(`[index] dropping invalid index ${ix.name} left by an interrupted build`);
        await db.query(`drop index concurrently if exists "${ix.name}"`);
      }
      await db.query(ix.sql);
      created.push(ix.name);
    }
  } finally {
    await db
      .query('select pg_advisory_unlock(hashtextextended($1, 0))', [LOCK_KEY])
      .catch(() => {});
  }

  return { locked: false, created, kept };
}

/** 服务开始监听后调用；不 await、不阻塞请求。 */
export function startPerfIndexBuilder(url: string): void {
  setTimeout(() => {
    void buildPerfIndexes(url);
  }, START_DELAY_MS).unref();
}

export async function buildPerfIndexes(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    // 后台构建不受连接池 60s statement_timeout 约束；同时限制并行度，别把整机 CPU 吃满。
    await client.query('SET statement_timeout = 0');
    await client.query('SET lock_timeout = 0');
    await client.query('SET max_parallel_maintenance_workers = 1');
    await client.query("SET maintenance_work_mem = '256MB'");

    const r = await ensurePerfIndexes(client);
    if (r.locked) {
      log.info('[index] another instance is building performance indexes, skipping');
    } else if (r.created.length > 0) {
      log.info(
        `[index] performance indexes ready (created ${r.created.length}, existing ${r.kept.length})`,
      );
    } else {
      log.info(`[index] performance indexes already present (${r.kept.length})`);
    }
  } catch (e) {
    log.warn(
      `[index] background index build failed (will retry next start): ${(e as Error)?.message ?? e}`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}
