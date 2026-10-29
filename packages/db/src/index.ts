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

import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

// 对齐 legacy db.js：大整数/数值统一解析为 number，避免 Drizzle 返回 bigint 带来的序列化问题
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8
pg.types.setTypeParser(23, (v) => (v === null ? null : Number(v))); // int4
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

export { schema };
export * from './schema';

export type Db = NodePgDatabase<typeof schema>;

let _pool: pg.Pool | null = null;

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
  });
  pool.on('error', (e) => console.error('[db] 空闲连接异常：', e?.message ?? e));
  return pool;
}

export function createDb(connectionString?: string): Db {
  const cs = connectionString ?? process.env.DATABASE_URL;
  if (!cs) throw new Error('DATABASE_URL 未设置：请提供连接串或环境变量');
  // 简单复用：同一进程内同一连接串复用 pool（Hono 服务常驻单例）
  if (!_pool || _pool.options.connectionString !== cs) {
    _pool = createPool(cs);
  }
  return drizzle(_pool, { schema });
}
