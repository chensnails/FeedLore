/* 笺川（FeedLore）Service Worker
 * 作用：① 满足浏览器「可安装」条件，让 Edge / Chrome 能「添加到手机」；
 *       ② 断网时静态资源仍可用。
 * 策略（v1.5.0 调整）：
 *   - 带内容哈希的构建产物（/assets/*-<hash>.*）：**缓存优先**。
 *     文件名带哈希 = 内容唯一确定，命中即可直接用，省一次往返（弱网下是最大头）。
 *   - HTML / 无哈希资源（sw.js / manifest / 图标）：**网络优先**，
 *     保证在线时永远是最新代码；离线才回退缓存。
 *   - /api/ 接口不缓存（避免拿到过期的数据或越权响应）。
 * 注意：Service Worker 只在安全上下文（HTTPS 或 localhost）注册，
 *       所以必须通过 https 访问（或本机 localhost）才会生效。
 */
const VERSION = 'feedlore-v2';   // v1.5.0：静态资源缓存优先 + 预缓存清单不再含无哈希的 CSS
const CACHE = `${VERSION}-static`;

/* 带内容哈希的资源：正则匹配 /assets/xxx-<hash>.ext */
const HASHED = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i;

// 预缓存：应用外壳（不含需要登录的接口数据）
// ⚠️ 样式表已随 Vite 打包成带哈希的 /assets/*.css，文件名随内容变，
//    预缓存具体路径没有意义（下次构建就失效了）—— 改为运行时按需缓存。
const PRECACHE = [
  '/login.html',
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
    // 带哈希的资源：缓存优先（命中即用，弱网省往返；文件名变了自然就是新资源）
    if (HASHED.test(url.pathname)) {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === 'basic') {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch (_) {
        return Response.error();
      }
    }
    // 其余（HTML / sw.js / 图标）：网络优先
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
