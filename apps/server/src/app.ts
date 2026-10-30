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
import { aiRoutes } from './routes/ai';
import {
  adminAccountRoutes,
  adminConfigRoutes,
  adminImageCacheRoutes,
  adminStatusRoutes,
  adminUserRoutes,
  adminVersionRoutes,
} from './routes/admin';

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

  /* 根级静态文件（PWA 的 manifest / service worker / 图标）。
   *
   * ⚠️ 必须显式列出：`serveStatic({ root })` 只挂在 `/assets/*` 与 `/` 上，
   * 不列出来的话 `/manifest.json` / `/sw.js` 会落到 `notFound` 返回一段 JSON ——
   * 浏览器把这段 JSON 当 manifest 解析失败，结果是「PWA 装了但没图标、没名字」，
   * 而控制台只在安装时才报一句，平时完全看不出来。
   *
   * 缓存三档：
   * - `sw.js` **必须 no-cache**。sw 的更新检测靠字节比对，被缓存住就永远跑旧版本
   *   （改了策略也不生效，是 PWA 最经典的坑）。
   * - `manifest.json` 短缓存：改名字/主题色要能在一小时内生效。
   * - 图标长缓存：文件名固定但内容基本不变，一天一次足够。 */
  const ROOT_FILES: ReadonlyArray<readonly [string, string]> = [
    ['manifest.json', 'public, max-age=3600'],
    ['sw.js', 'no-cache'],
    ['favicon.ico', 'public, max-age=86400'],
    ['favicon.svg', 'public, max-age=86400'],
    ['favicon-32.png', 'public, max-age=86400'],
    ['apple-touch-icon.png', 'public, max-age=86400'],
    ['icon-192.png', 'public, max-age=86400'],
    ['icon-512.png', 'public, max-age=86400'],
    ['icon-maskable-512.png', 'public, max-age=86400'],
  ];
  for (const [file, maxAge] of ROOT_FILES) {
    app.use(`/${file}`, cache(maxAge));
    app.get(`/${file}`, serveStatic({ root }));
  }
}

export function createApp({ db, auth }: AppDeps) {
  const app = new Hono<AppEnv>();

  /* ==========================================================================
   * better-auth 直通挂载（sign-in/username、sign-out、get-session、admin/* …）
   *
   * ⚠️ 这里**不能**写成 `app.on(['GET','POST'], '/api/auth/**', …)`。
   *    Hono 的默认 SmartRouter 会先试 RegExpRouter，但只要路由表里同时存在
   *      · 与 `:id` 同位置的静态段（`/api/feeds/reorder`、`/api/feeds/import`），且
   *      · 让 `:id` 不在末位的路由（`/api/feeds/:id/refresh`），
   *    RegExpRouter 就会抛 "Unsupported path"，SmartRouter **静默退化成 TrieRouter**。
   *    而 TrieRouter 根本不认 `**` —— 于是 `/api/auth/**` 永远 404，
   *    且只在「全部路由注册完」之后才发生（单独注册 `**` 是好的），极难察觉。
   *
   *    实际后果：better-auth 的整套 HTTP 端点在生产里是不可达的。
   *    `seed.ts` 曾把这件事误记为「better-auth 1.7.x 没有 sign-up/username 的 HTTP 端点」，
   *    于是绕成进程内 `auth.api.signUpEmail()` —— 绕法本身没错（进程内更省事），
   *    但结论是错的：真因在我们自己的路由表。
   *
   * 修法用「全局中间件 + 前缀判断」而不是通配路由：不依赖任何 router 的 `*` 语义，
   * 将来路由表变化导致 SmartRouter 切回 RegExpRouter，这里也不会跟着坏。
   * ========================================================================== */
  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path !== '/api/auth' && !path.startsWith('/api/auth/')) return next();
    if (!auth) return c.json({ error: '鉴权服务未就绪' }, 503);

    /* 公开注册**默认关闭**。
     *
     * 挂通 `/api/auth/*` 会顺带把 `sign-up/email` 暴露出来 —— 对一个自托管实例来说，
     * 那等于「任何人拿到网址就能注册一个账号，然后开始消耗你的带宽和模型额度」。
     * 原来的 404 恰好把这条路堵死了，所以修 bug 时必须把这道门显式补回来，
     * 否则修一个 bug 换一个安全回退。
     *
     * 首个管理员与后续加人走 `pnpm seed` / `POST /api/users`（都在进程内调
     * `auth.api.signUpEmail`），不需要 HTTP 注册口。确实要开放时置 `ALLOW_SIGNUP=1`。
     */
    if (path.startsWith('/api/auth/sign-up') && process.env.ALLOW_SIGNUP !== '1') {
      return c.json({ error: '未开放注册' }, 403);
    }
    return auth.handler(c.req.raw);
  });

  const routed = app
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
    .route('/', imgRoutes(db, auth))
    .route('/', aiRoutes(db, auth))
    .route('/', adminStatusRoutes(db, auth))
    .route('/', adminConfigRoutes(db, auth))
    .route('/', adminImageCacheRoutes(db, auth))
    .route('/', adminUserRoutes(db, auth))
    .route('/', adminAccountRoutes(db, auth))
    .route('/', adminVersionRoutes(db, auth));

  // 静态资源挂在同一个实例上；`route()` 返回的是 this，所以这里注册的路由同样生效。
  if (WEB_ROOT) mountWeb(app, WEB_ROOT);

  return routed;
}

/**
 * 前端类型化客户端的唯一入口：`hc<AppType>(baseUrl)`。
 * 改路由/改响应字段时，前端会在 `tsc` 阶段直接报错，而不是等到线上白屏。
 */
export type AppType = ReturnType<typeof createApp>;
