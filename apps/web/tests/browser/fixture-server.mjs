import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = join(root, 'dist');
const port = Number(process.env.PORT || 4174);
const now = new Date().toISOString();
const groups = ['科技', '设计', '产品', '资讯'];
const feeds = Array.from({ length: 8 }, (_, i) => ({
  id: i + 1,
  url: `https://example.com/feed/${i + 1}`,
  title: `测试频道 ${i + 1}`,
  customTitle: null,
  siteUrl: `https://example.com/${i + 1}`,
  description: '浏览器回归测试频道',
  icon: null,
  enabled: true,
  cardEnabled: true,
  groupName: groups[i % groups.length],
  sortOrder: i,
  entryCount: 3,
  unreadCount: 2,
  refreshMinutes: null,
  fullText: false,
  effectiveRefreshMinutes: 30,
  nextRefreshAt: null,
  status: 'ok',
  error: null,
  lastFetchedAt: now,
  failStreak: 0,
}));
const entries = Array.from({ length: 24 }, (_, i) => ({
  id: i + 1,
  name: `移动端测试文章 ${String(i + 1).padStart(2, '0')}`,
  desc: '这是用于验证 720px 布局、触控命中区和弹层几何的摘要文本，长度应保持稳定并允许两行显示。',
  size: '',
  tags: i % 3 === 0 ? ['深度阅读'] : [],
  aiTags: [],
  link: `https://example.com/post/${i + 1}`,
  pwd: null,
  links: [`https://example.com/post/${i + 1}`],
  image: i % 4 === 0 ? `/api/img?u=${i + 1}` : null,
  images: [],
  bodyJson: null,
  bodyVersion: 1,
  sourceUrl: `https://example.com/post/${i + 1}`,
  date: new Date(Date.now() - i * 3_600_000).toISOString(),
  feedId: (i % feeds.length) + 1,
  feedName: feeds[i % feeds.length].title,
  isRead: i % 3 === 0,
  isFavorite: i === 2,
  favoritedAt: i === 2 ? now : null,
}));
const content = Array.from(
  { length: 24 },
  (_, i) =>
    `<p>第 ${i + 1} 段：真实浏览器中的正文内容，用于验证移动端阅读布局、滚动位置和触控交互。</p>`,
).join('');
const flags = { total: entries.length, unread: 16, favorite: 1, watching: 2, blocked: 1 };
const layout = {
  view: 'grid',
  tab: 'reader',
  sort: 'new',
  rdScope: 'all',
  readerSideWidth: 232,
  accordion: true,
  sections: {},
  collapsedGroups: [],
  rdCollapsedGroups: [],
  digestEnabled: true,
};
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  const send = (status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const json = (status, body) => send(status, JSON.stringify(body));
  const path = url.pathname;

  if (path === '/api/session')
    return json(200, {
      authenticated: true,
      username: 'tester',
      role: 'admin',
      mustChangePassword: false,
    });
  if (path === '/api/feeds')
    return json(200, {
      feeds,
      groups,
      groupOrder: groups,
      flags,
      total: feeds.length,
      enabled: feeds.length,
      cardEnabled: feeds.length,
      refreshMinutes: 30,
      keepDays: 90,
      autoRefreshMinutes: 5,
      lastRefreshAt: now,
      nextRefreshAt: null,
    });
  if (path === '/api/entries') {
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const limit = Math.max(1, Number(url.searchParams.get('limit') || 20));
    return json(200, {
      entries: entries.slice(offset, offset + limit),
      hasMore: offset + limit < entries.length,
      total: entries.length,
      offset,
      limit,
      tags: [{ tag: '深度阅读', n: 8 }],
    });
  }
  if (path === '/api/entries/flags') return json(200, flags);
  if (path.startsWith('/api/entries/')) {
    const id = Number(path.split('/').pop());
    const entry = entries.find((item) => item.id === id);
    return entry
      ? json(200, { ...entry, content })
      : json(404, { error: 'E_ENTRY_NOT_FOUND', message: 'Entry not found' });
  }
  if (path === '/api/config')
    return json(200, { refreshMinutes: 30, concurrency: 4, keepPerFeed: 300, keepDays: 90 });
  if (path === '/api/prefs')
    return json(200, { ok: true, config: { refreshMinutes: 30, keepPerFeed: 300, keepDays: 90 } });
  if (path === '/api/version')
    return json(200, { ok: true, version: '3.0.0', latest: '3.0.0', hasUpdate: false });
  if (path === '/api/version/check')
    return json(200, { ok: true, hasUpdate: false, current: '3.0.0', latest: '3.0.0' });
  if (path === '/api/feeds/refresh-progress')
    return json(200, { running: false, label: '', total: 0, done: 0, startedAt: null });
  if (path === '/api/image-cache') return json(200, { ok: true, count: 0, bytes: 0 });
  if (path === '/api/img') {
    const hue = (Number(url.searchParams.get('u')) || 1) * 37;
    return send(
      200,
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="hsl(${hue} 45% 62%)"/><circle cx="320" cy="200" r="80" fill="rgba(255,255,255,.35)"/></svg>`,
      'image/svg+xml',
    );
  }
  if (path.startsWith('/api/') && req.method !== 'GET')
    return json(200, { ok: true, updated: 1, undo: { at: now } });
  if (path.startsWith('/api/')) return json(200, { ok: true });

  let rel;
  try {
    rel = decodeURIComponent(path).replace(/^\/+/, '') || 'index.html';
  } catch {
    return json(400, { error: 'E_BAD_REQUEST', message: 'Bad request' });
  }
  let file = resolve(dist, rel);
  if (file !== dist && !file.startsWith(dist + sep))
    return json(403, { error: 'E_FORBIDDEN', message: 'Forbidden' });
  if (!existsSync(file)) file = join(dist, 'index.html');
  let body = readFileSync(file);
  if (file.endsWith('index.html')) {
    body = Buffer.from(
      body
        .toString('utf8')
        .replace('</head>', `<script>window.__LAYOUT__=${JSON.stringify(layout)};</script></head>`),
    );
  }
  return send(200, body, mime[extname(file)] || 'application/octet-stream');
});

server.listen(port, '127.0.0.1', () =>
  console.log(`browser fixture listening on http://127.0.0.1:${port}`),
);
