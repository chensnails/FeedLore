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

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Db } from '@feedlore/db';
import type { AuthInstance } from '@feedlore/auth';
import type { AppEnv } from './middleware/auth';
import { WEB_ROOT } from './env';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { feedsRoutes } from './routes/feeds';
import { entriesRoutes } from './routes/entries';
import { prefsRoutes } from './routes/prefs';
import { imgRoutes } from './routes/img';

export interface AppDeps {
  db: Db | null;
  auth: AuthInstance | null;
}

/**
 * 托管前端产物（同一容器、同源部署，因此不需要 CORS，Cookie 也是同站的）。
 *
 * 缓存策略遵循 v1.x 的 CDN 铁律：
 * - `assets/*` 由 Vite 打上内容哈希 → immutable，可长缓存；
 * - `index.html` 无哈希 → no-cache，否则新 HTML 配旧 JS/CSS（1.4.0 搜索框事故）。
 */
function mountWeb(app: Hono<AppEnv>, root: string): void {
  // ⚠️ 必须改 `c.res.headers`，不能用 `c.header()`：后者写的是「待发送头」，
  //    在 `await next()` 之后响应已生成，再写不会生效（表现为静态资源永远 no-cache）。
  const cache = (value: string) => async (c: Context<AppEnv>, next: () => Promise<void>) => {
    await next();
    if (c.res && !c.res.headers.has('Cache-Control')) {
      c.res.headers.set('Cache-Control', value);
    }
  };

  app.use('/assets/*', cache('public, max-age=31536000, immutable'));
  app.use('/assets/*', serveStatic({ root }));

  app.use('/', cache('no-cache'));
  app.get('/', serveStatic({ root, path: 'index.html' }));
}

export function createApp({ db, auth }: AppDeps) {
  const app = new Hono<AppEnv>();

  const routed = app
    // better-auth 自带路由（sign-in/username、sign-out、get-session …）
    .on(['GET', 'POST'], '/api/auth/**', (c) => {
      if (!auth) return c.json({ error: '鉴权服务未就绪' }, 503);
      return auth.handler(c.req.raw);
    })
    .onError((err, c) => {
      // 自定义错误（ContractViolation/BadRequest）与 Hono 的 HTTPException 都带 status
      const raw = err as unknown as { status?: unknown };
      const declared = typeof raw.status === 'number' ? raw.status : 500;
      const s = declared >= 400 && declared <= 599 ? declared : 500;
      if (s >= 500) console.error('[error]', err);

      /* ⚠️ 这里曾经是 `if (s===400) ... if (s===401) ...` 的穷举链，结果 HTTPException(409)
       * 无处可去、被静默降级成 500（频道地址撞车的提示还在，但状态码错了，前端判不出冲突）。
       * 现在按声明值透传，只强制两件事：5xx 不吐内部 message、非 4xx/5xx 一律 500。 */
      const body = { error: s >= 500 ? '服务器内部错误' : err.message };
      return c.json(body, s as ContentfulStatusCode);
    })
    .notFound((c) => c.json({ error: '接口不存在' }, 404))
    .route('/', healthRoutes(db))
    .route('/', authRoutes(db, auth))
    .route('/', feedsRoutes(db, auth))
    .route('/', entriesRoutes(db, auth))
    .route('/', prefsRoutes(db, auth))
    .route('/', imgRoutes(db, auth));

  // 静态资源挂在同一个实例上；`route()` 返回的是 this，所以这里注册的路由同样生效。
  if (WEB_ROOT) mountWeb(app, WEB_ROOT);

  return routed;
}

/**
 * 前端类型化客户端的唯一入口：`hc<AppType>(baseUrl)`。
 * 改路由/改响应字段时，前端会在 `tsc` 阶段直接报错，而不是等到线上白屏。
 */
export type AppType = ReturnType<typeof createApp>;
