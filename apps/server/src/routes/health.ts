/**
 * GET /api/health —— 契约：contract.auth.health（public）
 */

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { Db } from '@feedlore/db';
import { HealthSchema } from '@feedlore/contract';
import { assertResponse } from '../lib/validate';
import type { AppEnv } from '../middleware/auth';

export function healthRoutes(db: Db | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/health', async (c) => {
    const t0 = Date.now();
    let ready = false;
    let latencyMs: number | null = null;

    if (db) {
      try {
        await db.execute(sql`select 1`);
        ready = true;
        latencyMs = Date.now() - t0;
      } catch (e) {
        // 健康检查本身不抛给客户端，只落日志；db.ready=false 已足够表达
        console.error('[health] 数据库探测失败：', (e as Error)?.message ?? e);
      }
    }

    const payload = assertResponse(
      HealthSchema,
      { ok: ready, authed: false, db: { ready, latencyMs } },
      'GET /api/health',
    );
    return c.json(payload, ready ? 200 : 503);
  });

  return app;
}
