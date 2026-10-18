/* 笺川（Feedlore）Service Worker
 * 作用：① 满足浏览器「可安装」条件，让 Edge / Chrome 能「添加到手机」；
 *       ② 断网时静态资源仍可用。
 * 策略：同源 GET 一律「网络优先、失败回退缓存」，保证在线时永远是最新代码；
 *       /api/ 接口不缓存（避免拿到过期的数据或越权响应）。
 * 注意：Service Worker 只在安全上下文（HTTPS 或 localhost）注册，
 *       所以必须通过 https 访问（或本机 localhost）才会生效。
 */
const VERSION = 'shiyue-v2';   // v2.0.0：核心逻辑进 bundle，旧的 /app.js 预缓存作废
const CACHE = `${VERSION}-static`;

// 预缓存：应用外壳的静态资源（不含需要登录的接口数据）
const PRECACHE = [
  '/login.html',
  '/login.css',
  '/style.css',
  '/manifest.json',
  '/favicon.svg',
  '/favicon.ico',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 单个资源失败不影响整体安装
    await Promise.allSettled(PRECACHE.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 只接管同源
  if (url.pathname.startsWith('/api/')) return;      // 接口始终走网络，不缓存

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      // 只缓存正常的同源响应（跳过重定向 / 错误）
      if (res && res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (_) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('/login.html');
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});
