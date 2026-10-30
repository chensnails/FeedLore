/**
 * 应用装配层：把路由、中间件、错误处理组装成一个 Hono 实例。
 *
 * 为什么单独拆出 app.ts（与 index.ts 分离）：
 * - `AppType` 必须是**路由链式返回值**的类型，只有这样 hc<AppType> 才能把
 *   路径、方法、请求体、响应体全部推导到前端。若在 index.ts 里就地 `new Hono()`
 *   再 `app.route(...)`（不接收返回值），类型上这些路由等同于不存在。
 * - 副作用（连库、起调度、listen）留在 index.ts，本文件保持「纯装配」，
 *   这样测试可以直接 import 而不监听端口。
 */

import { Hono } from 'hono';
import type { Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import type { AppEnv } from './middleware/auth';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { feedsRoutes } from './routes/feeds';

export interface AppDeps {
  db: Db | null;
  auth: AuthInstance | null;
}

export function createApp({ db, auth }: AppDeps) {
  const app = new Hono<AppEnv>();

  return (
    app
      // better-auth 自带路由（sign-in/username、sign-out、get-session …）
      .on(['GET', 'POST'], '/api/auth/**', (c) => {
        if (!auth) return c.json({ error: '鉴权服务未就绪' }, 503);
        return auth.handler(c.req.raw);
      })
      .onError((err, c) => {
        // 自定义错误（ContractViolation/BadRequest）带 status；Hono 的 HTTPResponseError 不带。
        const raw = err as unknown as { status?: unknown };
        const s = typeof raw.status === 'number' ? raw.status : 500;
        if (s >= 500) console.error('[error]', err);
        const body = { error: s >= 500 ? '服务器内部错误' : err.message };
        if (s === 400) return c.json(body, 400);
        if (s === 401) return c.json(body, 401);
        if (s === 403) return c.json(body, 403);
        if (s === 501) return c.json(body, 501);
        if (s === 503) return c.json(body, 503);
        return c.json(body, 500);
      })
      .notFound((c) => c.json({ error: '接口不存在' }, 404))
      .route('/', healthRoutes(db))
      .route('/', authRoutes(db, auth))
      .route('/', feedsRoutes(db, auth))
  );
}

/**
 * 前端类型化客户端的唯一入口：`hc<AppType>(baseUrl)`。
 * 改路由/改响应字段时，前端会在 `tsc` 阶段直接报错，而不是等到线上白屏。
 */
export type AppType = ReturnType<typeof createApp>;
