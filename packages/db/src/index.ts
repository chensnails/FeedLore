/**
 * @feedlore/db — 数据库客户端工厂
 *
 * 提供：
 * - createDb(connectionString?) → Drizzle NodePgDatabase（单例风格，按需调用）
 * - schema 全量导出（供 apps/server、packages/auth、packages/ai 引用）
 * - 类型导出（Db、各表 Select/Insert 类型）
 *
 * 注意：v2 使用 node-postgres（与 legacy 一致）。int8/int4/numeric 的类型解析
 * 对齐 legacy（统一按 number 取），与 schema.ts 里 bigserial mode:number 配合。
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

// 对齐 legacy db.js：大整数/数值统一解析为 number，避免 Drizzle 返回 bigint 带来的序列化问题
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8
pg.types.setTypeParser(23, (v) => (v === null ? null : Number(v))); // int4
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

export * from './schema';
export { schema };

export type Db = NodePgDatabase<typeof schema>;

let _pool: pg.Pool | null = null;

export interface PoolMetricSnapshot {
  connectionsCreated: number;
  idleConnectionErrors: number;
  acquisitions: number;
  releases: number;
  removed: number;
}

type PoolMetricState = PoolMetricSnapshot;

const poolMetricStates = new WeakMap<pg.Pool, PoolMetricState>();

function emptyPoolMetrics(): PoolMetricState {
  return {
    connectionsCreated: 0,
    idleConnectionErrors: 0,
    acquisitions: 0,
    releases: 0,
    removed: 0,
  };
}

function observePool(pool: pg.Pool): void {
  if (poolMetricStates.has(pool)) return;
  const state = emptyPoolMetrics();
  poolMetricStates.set(pool, state);
  pool.on('connect', () => {
    state.connectionsCreated += 1;
  });
  pool.on('acquire', () => {
    state.acquisitions += 1;
  });
  pool.on('release', () => {
    state.releases += 1;
  });
  pool.on('remove', () => {
    state.removed += 1;
  });
  pool.on('error', (e) => {
    state.idleConnectionErrors += 1;
    console.error('[db] idle connection error:', e?.message ?? e);
  });
}

export function getPoolMetrics(pool: pg.Pool | null = _pool): PoolMetricSnapshot | null {
  if (!pool) return null;
  return { ...(poolMetricStates.get(pool) ?? emptyPoolMetrics()) };
}

/** 单条 SQL 兜底超时（毫秒）。0 = 关闭（仅用于测试/特殊部署）；默认 60s。
 *  纯函数便于单测，避免把 pg 启动参数解析塞进 createPool 里难验证。 */
export function statementTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PG_STATEMENT_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
    /* 单条 SQL 的兜底超时：统计信息损坏时优化器可能给出 cost=Infinity 的笛卡尔计划，
     * 一条查询能挂几小时并占死连接池，进而拖垮所有 API（连 /api/entries 都 8s 超时）。
     * 让 PG 服务端在 60s 主动 cancel，连接即时归还。可用 PG_STATEMENT_TIMEOUT_MS 调；
     * 全库导入/还原这类长事务在事务内 SET LOCAL statement_timeout = '300s' 自行放宽。
     * 注意 0 在 pg 客户端是 falsy、不会下发，必须显式 0 时走 options 或 SET LOCAL。 */
    statement_timeout: statementTimeoutMs(),
  });
  observePool(pool);
  return pool;
}

export function createDb(connectionString?: string): Db {
  const cs = connectionString ?? process.env.DATABASE_URL;
  if (!cs)
    throw new Error(
      'DATABASE_URL is not set — provide a connection string or the environment variable',
    );
  // 简单复用：同一进程内同一连接串复用 pool（Hono 服务常驻单例）
  if (!_pool || _pool.options.connectionString !== cs) {
    _pool = createPool(cs);
  }
  return drizzle(_pool, { schema });
}

/**
 * 取当前连接池（状态页要报 total/idle/waiting/max）。
 * 未初始化时返回 null —— 调用方不该因为「还没连库」而崩。
 */
export function getPool(): pg.Pool | null {
  return _pool;
}
