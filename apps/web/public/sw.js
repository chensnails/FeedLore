/* 笺川（FeedLore）v2 Service Worker
 *
 * 作用：① 满足浏览器「可安装」条件（Edge / Chrome / Safari 添加到主屏）；
 *       ② 断网时至少还能打开应用外壳，而不是白屏。
 *
 * 策略（沿用 v1.7 的口径，只改了预缓存清单）：
 *   - 带内容哈希的构建产物（/assets/*-<hash>.*）：**缓存优先**。
 *     文件名带哈希 = 内容唯一确定，命中即可直接用，弱网下省的是最大的一笔往返。
 *   - HTML / 无哈希资源（sw.js / manifest / 图标）：**网络优先**，保证在线时永远是最新代码。
 *   - /api/ **完全不接管**：接口带了会话，缓存下来既会过期也会串号。
 *
 * ⚠️ 预缓存里**不能写样式表 / JS 的具体路径**：v2 由 Vite 打包成
 * `/assets/index-<hash>.css`，文件名每次构建都变，写死等于每次发版都预缓存 404。
 * 只预缓存真正稳定的那几个（图标、manifest），其余靠运行时按需写入。
 */
const VERSION = 'feedlore-v2-3';
const CACHE = `${VERSION}-static`;

/** 带内容哈希的资源：/assets/xxx-<hash>.ext */
const HASHED = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i;

const PRECACHE = [
  '/',
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
  if (url.origin !== self.location.origin) return; // 只接管同源
  if (url.pathname.startsWith('/api/')) return; // 接口始终走网络

  event.respondWith((async () => {
    // 带哈希的资源：缓存优先
    if (HASHED.test(url.pathname)) {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === 'basic') {
          const cache = await caches.open(CACHE);
          void cache.put(req, res.clone());
        }
        return res;
      } catch {
        return Response.error();
      }
    }
    // 其余：网络优先，失败回退缓存
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') {
        const cache = await caches.open(CACHE);
        void cache.put(req, res.clone());
      }
      return res;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        // SPA 只有一个入口：任何导航失败都回退到缓存的 '/'，而不是离线错误页
        const shell = await caches.match('/');
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});
