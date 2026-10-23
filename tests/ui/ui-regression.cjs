/* 笺川前端 UI 回归测试（jsdom，运行时挂载真实 React 组件）。
 *
 * 覆盖：
 *  - 设置弹层 SettingsModal（外壳 + 数据源 / 模型 / 账号 / 外观 / 状态 / 关于六面板）
 *  - AI 视图 AiView（导航 / 日报 / 日报设置）
 *  - 卡片视图 CardsView（工具栏 / 标签 / 卡片·列表 / 骨架 / 空态）
 *  - 跨面板共享机制（宿主开合 / tab 显隐 / 桥调用 / 权限过滤）
 *
 * 运行：`npm run test:ui`（先由 tests/ui/build.mjs 用 esbuild 打包三个挂载入口，再跑本文件）。
 * 数据源 / 卡片面板配一个「迷你服务端」：feeds / settings / groupOrder / entries 常驻内存，
 * apiFetch 桩按 server.js 的真实契约响应（DTO 字段、clampInt、归一化、去重、400/403/404），
 * loadFeeds / cardsLoad 桩复刻 app.js 桥写共享 state 的语义。
 * 拖拽路径用 monkey-patch 的 document.elementFromPoint + 元素级 getBoundingClientRect。 */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');

const dom = new JSDOM('<!DOCTYPE html><html><body>' +
  '<div id="settingsRoot"></div>' +
  '<div id="aiRoot"></div>' +
  '<div id="cardsRoot"></div>' +
  '<div id="readerRoot"></div>' +
  '<header class="topbar" id="topbarRoot"></header>' +
  '<div id="overlaysRoot"></div>' +
  '</body></html>', {
  url: 'http://localhost:3000/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});
const w = dom.window;
global.window = w;
global.document = w.document;
global.navigator = w.navigator;
global.HTMLElement = w.HTMLElement;
global.SVGElement = w.SVGElement;
global.Element = w.Element;
global.Node = w.Node;
global.KeyboardEvent = w.KeyboardEvent;
global.MouseEvent = w.MouseEvent;
global.location = w.location;   // AccountPane 读取 location.host 显示安装域名
global.requestAnimationFrame = (cb) => w.requestAnimationFrame(cb);
global.cancelAnimationFrame = (id) => w.cancelAnimationFrame(id);
global.confirm = () => true;   // SourcePane 删除订阅 / AccountPane 删除用户前的确认
let promptValue = 'newpass9';
global.prompt = () => promptValue;   // AccountPane「改密码」弹窗
// 剪贴板 & 安全上下文（状态面板「复制诊断」依赖）；写入内容记入 clipboardWrites。
// 注意：bundle 里裸写 navigator，Node 的 globalThis.navigator 是只读访问器，
// 顶部 `global.navigator = w.navigator` 静默失败，故这里直接给两者的 navigator 都挂上。
const clipboardStub = {
  writeText: (t) => { clipboardWrites.push(String(t)); return Promise.resolve(); },
};
w.navigator.clipboard = clipboardStub;
try { Object.defineProperty(globalThis.navigator, 'clipboard', { value: clipboardStub, configurable: true }); } catch (_) { /* 忽略 */ }
try { Object.defineProperty(w, 'isSecureContext', { value: true, configurable: true }); } catch (_) { /* 只读时忽略 */ }
// ---- 与线上 window.feedlore 同构的桩 ----
const calls = [];
const noop = (name) => (...a) => calls.push([name, ...a]);
const appearance = { theme: 'auto', accent: 'blue', fontSize: 'm', readerFont: 'sans', readerLh: 'm', readerFs: 'm', readerWidth: 'm' };
const fireAppearanceChanged = () => w.dispatchEvent(new w.Event('__appearanceChanged'));

let adminFlag = true;
let versionResponse = { ok: true, version: '1.2.0', updateEnabled: true };
let checkResponse = { ok: true, hasUpdate: true, current: '1.2.0', latest: '1.3.0', releaseUrl: 'https://github.com/chensnails/feedlore/releases/tag/v1.3.0' };

// 模型面板的可变响应（复刻 /api/prefs GET 的 llm 视图字段：不回填明文，只给 set + 掩码）
let prefsLlm = { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-8B', temperature: 0.3, apiKeySet: false, apiKeyHint: '' };
let prefsPostOk = true;

/* ---------- 迷你服务端（内存版，契约对齐 server.js / db.js） ---------- */
let miniNextId = 10;
const nextId = () => String(miniNextId++);
const clampInt = (v, d, lo, hi) => {
  const n = parseInt(v, 10);
  const x = Number.isFinite(n) ? n : d;
  return Math.min(Math.max(x, lo), hi);
};
const miniFeeds = [
  { id: '1', url: 'https://example.com/feed.xml', title: '例子星球', customTitle: null, groupName: '科技', enabled: true, cardEnabled: true, refreshMinutes: null, sortOrder: 0, entryCount: 12, lastFetchedAt: Date.now(), status: null, error: '' },
  { id: '2', url: 'https://tg.example/rss/channel/demo', title: 'demo - Telegram Channel', customTitle: null, groupName: '科技', enabled: true, cardEnabled: false, refreshMinutes: 60, sortOrder: 1, entryCount: 4, lastFetchedAt: Date.now() - 7200000, status: 'error', error: '502 Bad Gateway' },
  { id: '3', url: 'https://blog.example.org/atom.xml', title: '某人的博客', customTitle: null, groupName: '', enabled: false, cardEnabled: true, refreshMinutes: null, sortOrder: 2, entryCount: 88, lastFetchedAt: null, status: null, error: '' },
];
let miniGroupOrder = ['科技'];
// 条目过滤规则（v2.7.0）：AccountPane 读 /api/prefs 的 filters，保存后由 mock 的 sanitize 回填
let miniFilters = [
  { id: 'f1', on: true, act: 'block', field: 'title', kind: 'kw', pattern: '广告' },
  { id: 'f2', on: true, act: 'allow', field: 'desc', kind: 're', pattern: 'sk-' },
];
const miniSettingsSource = {
  refreshMinutes: 30, keepPerFeed: 300, keepDays: 0,
  timeoutSeconds: 25, concurrency: 3, autoRefreshMinutes: 0,
  proxyUrl: 'socks5://127.0.0.1:1080',
};
// 测试可控的挂起 / 失败开关
let addShouldFail = false;
let importShouldFail = false;
let refreshAllFailed = false;
let patchFailNext = false;
let feedsFailNext = false;
let feedsEmptyNext = false;
let cfgHold = null;      // 挂起 GET /api/config（测 cfgLoaded 守卫）
let patchHold = null;    // 挂起 PATCH（测保存期间控件禁用）
let urlProbeFail = false; // 改订阅地址后「服务端按新地址试抓」的成败（测当场反馈）

/* ---------- 账号 / 状态面板（P2d）测试可控状态 ---------- */
let miniUsers = [
  { id: '1', username: 'tester', role: 'admin', createdAt: null, feedCount: 3, isSelf: true },
  { id: '2', username: 'alice', role: 'user', createdAt: null, feedCount: 1, isSelf: false },
];
let usersFailNext = false;
let accountPostOk = true;
let statusFailNext = false;
let promptInstallResult = false;
const clipboardWrites = [];
/* ---- App Shell（顶栏，P4a）测试可控状态 ---- */
let shellSnap = {
  stat: 12, subtitle: '拾取值得读的 · 采集 2/3 个频道', view: 'reader',
  themeLabel: '跟随系统', themeIco: 'theme-auto',
  installReady: false, statVisible: false,
};
let refreshDeferred = null;   // 非空时 refresh() 返回它（测忙态）
/* ---- 覆盖层（toast / 新内容浮标 / 灯箱，v2.1.0 React 化）测试可控状态 ---- */
let overlayState = {
  toast: { msg: '', ok: true, show: false },
  pill: { show: false, text: '' },
  box: { src: '', show: false },
};
const overlaysTick = () => w.dispatchEvent(new w.Event('__overlaysTick'));
// /api/status 快照（字段对齐 server.js 的实际返回）
const statusPayload = () => ({
  app: {
    uptimeSec: 3661, startedAt: Date.now() - 3661000, node: 'v22.22.2', version: '1.6.0', pid: 123,
    memory: { rss: 104857600, heapUsed: 52428800 },
    container: { memoryUsed: 125829120, memoryLimit: 268435456, cpuPercent: 3 },
    loadavg: [0.5, 0.4, 0.3], cpuCount: 4, now: Date.now(),
  },
  db: { ready: true, latencyMs: 2, pool: { total: 3, max: 10, idle: 7, waiting: 0 }, tables: { feeds: 3, entries: 200, digests: 5 }, sizeBytes: 52428800 },
  rss: {
    refreshMinutes: 30, concurrency: 3, timeoutSeconds: 25,
    lastRefreshAt: Date.now() - 60000, nextRefreshAt: Date.now() + 1200000, dueCount: 1, refreshing: 0,
    lastResult: { added: 5, failed: 1, durationMs: 1200, pruned: 0, skipped: 0, autoDisabled: 1 },
    feeds: { total: 3, enabled: 2, cardEnabled: 2, neverFetched: 1, perFeedInterval: 1, error: 1, autoDisabled: 1 },
    entries: { total: 200, unread: 50, favorite: 8, added24h: 20, oldest: Date.now() - 2592000000, newest: Date.now() },
    keepPerFeed: 300, keepDays: 0, autoRefreshMinutes: 0, feedFailLimit: 5,
    problems: [{ feedId: '2', title: 'demo - Telegram Channel', error: '502 Bad Gateway', enabled: false, failStreak: 5 }],
  },
  digest: {
    enabled: true, time: '08:00', nextRunAt: Date.now() + 86400000, scope: 'enabled',
    latest: { date: '2026-10-16', fallback: false, model: 'Qwen/Qwen3-8B', stats: { collected: 20, kept: 12, feeds: 3 } },
    oldestDate: '2026-10-01', count: 5,
  },
});

/* ---------- AI 视图（P3a）测试可控状态 ---------- */
let miniDigestCfg = { enabled: true, time: '08:00', scope: 'selected', maxPerFeed: 20, maxTotal: 150, keepDays: 30 };
let miniDigestDates = ['2026-10-15'];
let genFailNext = false;const miniDigestFor = (date) => {
  if (date !== '2026-10-15') return null;
  return {
    date, generatedAt: Date.now(), model: 'Qwen/Qwen3-8B', overview: '今日概览一句话',
    fallback: false, usedMapReduce: false, error: '',
    stats: { collected: 20, kept: 12, feeds: 3 },
    highlights: [{ text: '亮点一', item: { name: '条目A' } }],
    sections: [{ title: '分类一', items: [{ comment: '点评', item: { name: '条目X', link: 'https://example.com/x', image: 'https://img.example/x.png', size: '1.2G', feedName: '频道一' } }] }],
  };
};
const todayStr = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/* ---------- 卡片视图（P3b）测试可控状态 ---------- */
const miniEntriesAll = () => [
  { id: 'e1', name: '条目一', desc: '描述一', tags: ['标签A', '标签B'], image: 'https://img.example/1.png', size: '1.2G', date: '2026-10-15T10:00:00Z', link: 'https://pan.quark.cn/s/abc', links: ['https://pan.quark.cn/s/abc', 'https://pan.baidu.com/s/xyz'], sourceUrl: 'https://example.com/a', feedId: '1', pwd: 'm8k2', feedName: '例子星球 - Telegram Channel', isRead: false, isFavorite: false },
  { id: 'e2', name: '条目二', desc: '', tags: ['标签A'], image: '', size: '', date: '2026-10-14T10:00:00Z', link: '', links: [], sourceUrl: '', feedId: '2', pwd: null, feedName: 'demo', isRead: true, isFavorite: true },
];

/* 详情接口（GET /api/entries/:id）比卡片多返回正文：e1 有正文与提取码，e2 什么正文都没有。
 * detailBodyMode 切换 e1 的正文形态（text 有文字 / images 纯图块 / no-text 老数据无文字），
 * 用来验证「摘要不会和正文重复出现两遍」。 */
let detailBodyMode = 'text';
const miniEntryDetail = (id) => {
  const base = miniEntriesAll().find((x) => x.id === id);
  if (!base) return null;
  const d = Object.assign({}, base, {
    content: id === 'e1' ? '正文第一段，说明这份资源怎么取。\n附线路两条，第二条是备份。' : '',
    bodyJson: null,
    images: [],
    pwd: id === 'e1' ? 'm8k2' : null,
  });
  if (id === 'e1' && detailBodyMode === 'images') {
    d.content = '';
    d.bodyJson = JSON.stringify([{ t: 'img', src: 'https://img.example/1.png' }]);
  } else if (id === 'e1' && detailBodyMode === 'no-text') {
    d.content = '';
  }
  return d;
};

const toDto = (f) => ({
  id: String(f.id), url: f.url, title: f.title || f.url,
  customTitle: f.customTitle || null, siteUrl: null, description: '', icon: null,
  enabled: !!f.enabled, cardEnabled: !!f.cardEnabled,
  groupName: f.groupName || '', sortOrder: Number(f.sortOrder || 0),
  entryCount: Number(f.entryCount || 0), unreadCount: 0,
  lastFetchedAt: f.lastFetchedAt || null,
  refreshMinutes: f.refreshMinutes == null ? null : Number(f.refreshMinutes),
  effectiveRefreshMinutes: f.refreshMinutes == null ? miniSettingsSource.refreshMinutes : Number(f.refreshMinutes),
  nextRefreshAt: null, status: f.status || null, error: f.error || '',
});
const groupsOf = (feeds) => {
  const set = new Set();
  for (const f of feeds) { const g = (f.groupName || '').trim(); if (g) set.add(g); }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
};
const feedsPayload = () => {
  const feeds = miniFeeds.slice().sort((a, b) => a.sortOrder - b.sortOrder).map(toDto);
  if (feedsEmptyNext) return { feeds: [], total: 0, enabled: 0, cardEnabled: 0, groups: [], groupOrder: miniGroupOrder.slice(), flags: {}, refreshMinutes: miniSettingsSource.refreshMinutes, keepDays: miniSettingsSource.keepDays, autoRefreshMinutes: miniSettingsSource.autoRefreshMinutes };
  return {
    feeds,
    total: feeds.length,
    enabled: feeds.filter((f) => f.enabled).length,
    cardEnabled: feeds.filter((f) => f.cardEnabled).length,
    groups: groupsOf(feeds),
    groupOrder: miniGroupOrder.slice(),
    flags: { total: 0, unread: 0, favorite: 0 },
    refreshMinutes: miniSettingsSource.refreshMinutes,
    keepDays: miniSettingsSource.keepDays,
    autoRefreshMinutes: miniSettingsSource.autoRefreshMinutes,
  };
};
const normUrl = (u) => String(u || '').replace(/\/+$/, '');
const pushFeed = (url, groupName) => {
  miniFeeds.push({
    id: nextId(), url, title: url.replace(/^https?:\/\//, '').split('/')[0], customTitle: null,
    groupName: groupName || '', enabled: true, cardEnabled: true, refreshMinutes: null,
    sortOrder: Math.max(...miniFeeds.map((f) => f.sortOrder), -1) + 1,
    entryCount: 0, lastFetchedAt: null, status: null, error: '',
  });
};

w.feedlore = {
  apiFetch: (url, opts) => {
    calls.push(['apiFetch', url, opts && opts.method, opts && opts.body]);
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const ok = (data, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(data) });
    const bad = (error, status = 400) => Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error }) });

    // ---- 模型 / 关于 / 偏好 ----
    if (url === '/api/prefs' && method === 'GET') {
      return ok({ llm: prefsLlm, groupOrder: miniGroupOrder.slice(), appearance: {}, layout: {}, filters: miniFilters.slice() });
    }
    if (url === '/api/prefs' && method === 'POST') {
      if (!prefsPostOk) return bad('炸了', 500);
      if (body && Array.isArray(body.groupOrder)) {
        miniGroupOrder = body.groupOrder.filter((g) => typeof g === 'string').map((g) => g.trim().slice(0, 40)).filter(Boolean);
      }
      if (body && body.llm) {
        const patch = Object.assign({}, prefsLlm);
        if (typeof body.llm.baseUrl === 'string') patch.baseUrl = body.llm.baseUrl;
        if (typeof body.llm.model === 'string') patch.model = body.llm.model;
        if (body.llm.temperature != null) patch.temperature = body.llm.temperature;
        if (body.llm.clearApiKey) { patch.apiKeySet = false; patch.apiKeyHint = ''; }
        else if (body.llm.apiKey) { patch.apiKeySet = true; patch.apiKeyHint = 'sk-…abcd'; }
        prefsLlm = patch;
      }
      // v2.7.0：过滤规则 —— 复刻服务端 sanitizeFilters 的清洗口径（空模式丢弃）后回填
      if (Array.isArray(body && body.filters)) {
        miniFilters = body.filters
          .filter((f) => f && typeof f === 'object' && typeof f.pattern === 'string' && f.pattern.trim())
          .slice(0, 50)
          .map((f, i) => ({
            id: typeof f.id === 'string' && f.id.trim() ? f.id.trim().slice(0, 40) : 'f' + (i + 1),
            on: f.on !== false,
            act: f.act === 'allow' ? 'allow' : 'block',
            field: ['title', 'desc', 'content', 'all'].indexOf(f.field) >= 0 ? f.field : 'all',
            kind: f.kind === 're' ? 're' : 'kw',
            pattern: f.pattern.trim().slice(0, 200),
          }));
      }
      return ok({ ok: true, groupOrder: miniGroupOrder.slice(), appearance: {}, layout: {}, filters: miniFilters.slice() });
    }
    if (url === '/api/digest/test-llm') return ok({ ok: true, reply: 'pong' });
    if (url === '/api/version') return ok(versionResponse);
    if (url === '/api/version/check') return ok(checkResponse);

    // ---- 数据源面板（P2c） ----
    if (url === '/api/feeds' && method === 'GET') {
      if (feedsFailNext) { feedsFailNext = false; return bad('HTTP 500', 500); }
      return ok(feedsPayload());
    }
    if (url === '/api/feeds/reorder' && method === 'POST') {
      const items = Array.isArray(body && body.feeds) ? body.feeds : (Array.isArray(body) ? body : []);
      for (const it of items) {
        const f = miniFeeds.find((x) => String(x.id) === String(it.id));
        if (!f) continue;
        f.sortOrder = clampInt(it.sortOrder, f.sortOrder, 0, 100000);
        const gn = String(it.groupName != null ? it.groupName : '').trim().slice(0, 40);
        f.groupName = gn || '';
      }
      return ok({ ok: true, updated: items.length });
    }
    if (url === '/api/feeds' && method === 'POST') {
      if (addShouldFail) { addShouldFail = false; return bad('抓取失败：连接超时'); }
      const u = String((body && body.url) || '').trim();
      if (!/^https?:\/\//i.test(u)) return bad('RSS 地址需以 http:// 或 https:// 开头');
      if (miniFeeds.some((f) => f.url === u)) return bad('该订阅已存在');
      pushFeed(u, body && body.groupName);
      const nf = miniFeeds[miniFeeds.length - 1];
      return ok({ ok: true, existed: false, feed: toDto(nf), added: 3 });
    }
    if (url === '/api/feeds/refresh' && method === 'POST') {
      return ok({
        ok: true, at: new Date().toISOString(), added: 5, skipped: 0,
        failed: refreshAllFailed ? [{ feedId: '1', error: 'timeout' }] : [],
      });
    }
    if (url === '/api/feeds/import' && method === 'POST') {
      if (importShouldFail) { importShouldFail = false; return bad('OPML 解析失败：格式不正确'); }
      const text = String((body && body.opml) || '');
      if (!text.trim()) return bad('未收到 OPML 内容');
      const urls = [...text.matchAll(/xmlUrl="([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
      const existing = new Set(miniFeeds.map((f) => normUrl(f.url)));
      const seen = new Set();
      const groups = new Set();
      let added = 0;
      const grp = /data-group="甲组"/.test(text) ? '甲组' : '';
      for (const u of urls) {
        const nu = normUrl(u);
        if (!nu || seen.has(nu) || existing.has(nu)) continue;
        seen.add(nu);
        pushFeed(u, grp);
        added++;
        if (grp) groups.add(grp);
      }
      return ok({ ok: true, added, duplicated: urls.length - added, groups: [...groups] });
    }
    const feedRoute = url.match(/^\/api\/feeds\/([^/]+)(\/refresh)?$/);
    if (feedRoute) {
      const id = feedRoute[1];
      const f = miniFeeds.find((x) => String(x.id) === String(id));
      if (!f) return bad('频道不存在', 404);
      if (feedRoute[2] && method === 'POST') {
        f.entryCount += 3;
        f.lastFetchedAt = Date.now();
        return ok({ ok: true, result: { added: 3 }, feed: toDto(f) });
      }
      if (method === 'PATCH' || method === 'POST') {
        if (patchHold) return patchHold;
        if (patchFailNext) { patchFailNext = false; return bad('boom', 500); }
        if (body.enabled !== undefined) f.enabled = !!body.enabled;
        if (body.cardEnabled !== undefined) f.cardEnabled = !!body.cardEnabled;
        if (body.groupName !== undefined) f.groupName = String(body.groupName).trim().slice(0, 40) || '';
        if (body.title !== undefined) f.customTitle = String(body.title).trim().slice(0, 200) || null;
        if (body.sortOrder !== undefined) f.sortOrder = clampInt(body.sortOrder, f.sortOrder, 0, 100000);
        if (body.refreshMinutes !== undefined) {
          const raw = body.refreshMinutes;
          const n = Number(raw);
          f.refreshMinutes = (raw === null || raw === '' || raw === 'global' || !Number.isFinite(n) || n <= 0)
            ? null : clampInt(n, 30, 5, 1440);
        }
        // 订阅地址：与真服务端同规则 —— 协议校验、每用户内 URL 唯一、改地址后按新地址试抓（probe）
        let urlChanged = false;
        if (body.url !== undefined) {
          const nu = String(body.url).trim();
          if (!/^https?:\/\//i.test(nu)) return bad('RSS 地址需以 http:// 或 https:// 开头');
          if (miniFeeds.some((x) => x.id !== f.id && normUrl(x.url) === normUrl(nu))) {
            return bad('这个地址已经是你的另一个频道', 409);
          }
          if (normUrl(nu) !== normUrl(f.url)) { f.url = nu; urlChanged = true; }
        }
        return ok({
          ok: true,
          urlChanged: urlChanged || undefined,
          probe: urlChanged
            ? (urlProbeFail ? { ok: false, error: '拿不到该地址的 feed' } : { ok: true, added: 4 })
            : undefined,
          feed: toDto(f),
        });
      }
      if (method === 'DELETE') {
        const i = miniFeeds.indexOf(f);
        if (i >= 0) miniFeeds.splice(i, 1);
        return ok({ ok: true });
      }
    }
    if (url === '/api/config' && method === 'GET') {
      if (cfgHold) return cfgHold;
      if (!adminFlag) return bad('需要管理员权限', 403);
      return ok({ username: 'tester', role: 'admin', llm: {}, digest: Object.assign({}, miniDigestCfg), source: Object.assign({}, miniSettingsSource) });
    }
    if (url === '/api/config' && method === 'POST') {
      if (body && body.digest) {
        const d = body.digest;
        if (d.enabled !== undefined) miniDigestCfg.enabled = !!d.enabled;
        if (d.time !== undefined) miniDigestCfg.time = String(d.time || '08:00');
        if (d.scope !== undefined) miniDigestCfg.scope = d.scope === 'all' ? 'all' : 'selected';
        if (d.maxPerFeed !== undefined) miniDigestCfg.maxPerFeed = clampInt(d.maxPerFeed, 20, 1, 100);
        if (d.maxTotal !== undefined) miniDigestCfg.maxTotal = clampInt(d.maxTotal, 150, 10, 500);
        if (d.keepDays !== undefined) miniDigestCfg.keepDays = clampInt(d.keepDays, 30, 1, 365);
      }
      if (body && body.source) {
        const s = body.source;
        if (s.refreshMinutes !== undefined) miniSettingsSource.refreshMinutes = clampInt(s.refreshMinutes, 20, 5, 1440);
        if (s.keepPerFeed !== undefined) miniSettingsSource.keepPerFeed = clampInt(s.keepPerFeed, 300, 0, 5000);
        if (s.keepDays !== undefined) miniSettingsSource.keepDays = clampInt(s.keepDays, 0, 0, 3650);
        if (s.timeoutSeconds !== undefined) miniSettingsSource.timeoutSeconds = clampInt(s.timeoutSeconds, 25, 5, 120);
        if (s.concurrency !== undefined) miniSettingsSource.concurrency = clampInt(s.concurrency, 3, 1, 10);
        if (s.autoRefreshMinutes !== undefined) miniSettingsSource.autoRefreshMinutes = clampInt(s.autoRefreshMinutes, 0, 0, 1440);
        if (s.proxyUrl !== undefined) miniSettingsSource.proxyUrl = String(s.proxyUrl || '').trim().slice(0, 500);
      }
      return ok({ ok: true });
    }
    // ---- 账号 / 用户管理 / 状态（P2d） ----
    if (url === '/api/users' && method === 'GET') {
      if (usersFailNext) { usersFailNext = false; return bad('boom', 500); }
      return ok({ users: miniUsers.map((u) => Object.assign({}, u)) });
    }
    if (url === '/api/users' && method === 'POST') {
      const un = String((body && body.username) || '').trim();
      if (!un) return bad('用户名不能为空');
      if (String((body && body.password) || '').length < 4) return bad('密码至少 4 位');
      if (miniUsers.some((u) => u.username === un)) return bad('用户名已存在');
      const nu = { id: String(100 + miniUsers.length), username: un, role: body.role === 'admin' ? 'admin' : 'user', createdAt: null, feedCount: 0, isSelf: false };
      miniUsers.push(nu);
      return ok({ ok: true, user: { id: nu.id, username: nu.username, role: nu.role } });
    }
    const userRoute = url.match(/^\/api\/users\/(\d+)$/);
    if (userRoute) {
      const uid = userRoute[1];
      const u = miniUsers.find((x) => x.id === uid);
      if (!u) return bad('用户不存在', 404);
      if (method === 'PATCH') {
        if (body && body.role !== undefined) u.role = body.role === 'admin' ? 'admin' : 'user';
        if (body && typeof body.password === 'string') {
          if (body.password.length < 4) return bad('密码至少 4 位');
        }
        return ok({ ok: true, user: { id: u.id, username: u.username, role: u.role } });
      }
      if (method === 'DELETE') { miniUsers = miniUsers.filter((x) => x.id !== uid); return ok({ ok: true }); }
    }
    if (url === '/api/account' && method === 'POST') {
      if (!accountPostOk) return bad('当前密码不正确');
      if (!body || (!String(body.username || '').trim() && !String(body.newPassword || ''))) return bad('用户名和新密码至少填一项');
      if (body.newPassword && String(body.newPassword).length < 4) return bad('新密码至少 4 位');
      return ok({ ok: true, username: String(body.username || '').trim() || 'tester', role: 'admin' });
    }
    if (url === '/api/logout' && method === 'POST') return ok({ ok: true });
    if (url === '/api/status' && method === 'GET') {
      if (statusFailNext) { statusFailNext = false; return bad('HTTP 500', 500); }
      return ok(statusPayload());
    }
    // ---- AI 视图 / 日报（P3a） ----
    if (url === '/api/digests' && method === 'GET') return ok({ dates: miniDigestDates.slice() });
    if (url.startsWith('/api/digest?') && method === 'GET') {
      const date = decodeURIComponent(url.split('date=')[1] || '');
      return ok({ date, digest: miniDigestFor(date) });
    }
    if (url === '/api/digest/generate' && method === 'POST') {
      if (genFailNext) { genFailNext = false; return bad('模型调用失败：401', 502); }
      const date = todayStr();
      const d = Object.assign(miniDigestFor('2026-10-15'), { date });
      if (!miniDigestDates.includes(date)) miniDigestDates.unshift(date);
      return ok({ ok: true, cached: false, digest: d });
    }
    // ---- 卡片视图 / 条目（P3b） ----
    if (url.indexOf('/api/entries?') === 0 && method === 'GET') {
      const params = new URLSearchParams(url.split('?')[1]);
      const q = params.get('q') || '';
      let list = miniEntriesAll();
      if (q) list = list.filter((e) => (e.name + e.desc + (e.tags || []).join('')).indexOf(q) >= 0);
      return ok({ entries: list, tags: [{ tag: '标签A', n: 2 }, { tag: '标签B', n: 1 }], hasMore: false });
    }
    const entryRoute = url.match(/^\/api\/entries\/([^/]+)$/);
    if (entryRoute && method === 'PATCH') return ok({ ok: true });
    if (entryRoute && method === 'GET') {
      const d = miniEntryDetail(decodeURIComponent(entryRoute[1]));
      return d ? ok(d) : bad('条目不存在', 404);
    }
    return bad('未实现的路由：' + method + ' ' + url, 404);
  },
  isAdmin: () => adminFlag,
  toast: noop('toast'),
  lockPageScroll: noop('lockPageScroll'), unlockPageScroll: noop('unlockPageScroll'),
  getSettingsSummary: () => '共 12 个订阅源 · 采集开启 10 个 · 卡片展示 8 个',
  setSettingsSummary: (v) => calls.push(['setSettingsSummary', v]),
  getAppearance: () => Object.assign({}, appearance),
  setAppearance: (k, v) => { calls.push(['setAppearance', k, v]); appearance[k] = v; fireAppearanceChanged(); },
  applyTheme: (m, animate) => { calls.push(['applyTheme', m, animate]); appearance.theme = m; fireAppearanceChanged(); },
  resetAppearance: () => {
    calls.push(['resetAppearance']);
    Object.assign(appearance, { theme: 'auto', accent: 'blue', fontSize: 'm', readerFont: 'sans', readerLh: 'm', readerFs: 'm', readerWidth: 'm' });
    fireAppearanceChanged();
  },

  /* ---- 数据源面板桥（P2c，对齐 app.js 语义） ---- */
  state: {
    feedList: [], feedMeta: {}, groupOrder: [], collapsedGroups: new Set(), tag: null, username: 'tester', role: 'admin',
    entries: [], tags: [], q: '', feedFilter: null, sort: 'new', size: 'all', view: 'grid',
    hasMore: false, loading: false, loadError: false, offset: 0, pageSize: 24,
    rdEntries: [], rdExpanded: new Set(), rdBody: new Map(), rdBodyErr: new Set(),
    rdScope: 'all', rdFeedId: null, rdGroup: null, rdQ: '',
    rdFlags: { total: 2, unread: 1, favorite: 1 }, rdLoading: false, rdReadError: false, rdReadErrorMsg: '',
  },
  loadFeeds: async () => {
    const res = await w.feedlore.apiFetch('/api/feeds');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    w.feedlore.state.feedList = data.feeds || [];
    w.feedlore.state.feedMeta = data;
    w.feedlore.state.groupOrder = Array.isArray(data.groupOrder) ? data.groupOrder : [];
    w.feedlore.state.collapsedGroups = new Set(layoutStub.collapsedGroups);
    if (data.flags) w.feedlore.state.rdFlags = data.flags;
    calls.push(['loadFeeds']);
    w.feedlore.renderFeedSelect();
    return data;
  },
  loadPage: noop('loadPage'),
  renderFeedSelect: noop('renderFeedSelect'),
  renderReaderChannels: noop('renderReaderChannels'),
  scheduleAutoRefresh: noop('scheduleAutoRefresh'),
  setLayout: (k, v) => {
    calls.push(['setLayout', k, v]);
    if (k === 'collapsedGroups') layoutStub.collapsedGroups = v;
  },
  bindSections: (root) => {
    calls.push(['bindSections']);
    const saved = layoutStub.sections;
    (root || document).querySelectorAll('details.sec[data-sec]').forEach((d) => {
      if (d.dataset.secBound === '1') return;
      d.dataset.secBound = '1';
      const k = d.getAttribute('data-sec');
      if (k in saved) d.open = !!saved[k];
      d.addEventListener('toggle', () => { saved[k] = d.open; });
    });
  },
  exportOpml: noop('exportOpml'),
  // v1.6.0：账号面板「一键安装」桥（旧 app.js promptInstall）
  promptInstall: () => { calls.push(['promptInstall']); return Promise.resolve(promptInstallResult); },
  // —— v1.10.0：App Shell 顶栏（P4a，组件见 src/shell/TopBar.jsx） ——
  getShell: () => Object.assign({}, shellSnap),
  switchView: (v) => { calls.push(['switchView', v]); shellSnap.view = v; shellSnap.statVisible = v === 'cards'; shellTick(); },
  refresh: () => { calls.push(['refresh']); return refreshDeferred || Promise.resolve(); },
  // —— v2.1.0：覆盖层（组件见 src/ui/Overlays.jsx） ——
  getToastState: () => Object.assign({}, overlayState.toast),
  getNewPillState: () => Object.assign({}, overlayState.pill),
  getLightboxState: () => Object.assign({}, overlayState.box),
  applyPendingFresh: () => { calls.push(['applyPendingFresh']); },
  closeLightbox: () => { calls.push(['closeLightbox']); overlayState.box = { src: '', show: false }; overlaysTick(); },
  cycleTheme: () => calls.push(['cycleTheme']),
  openSettings: (t) => { calls.push(['openSettings', t]); },
  // v1.7.0：AI 视图桥（P3a）
  getAiPage: () => w.feedlore.state.aiPage || 'digest',
  setAiPage: (n) => { calls.push(['setAiPage', n]); w.feedlore.state.aiPage = n; },
  linkLabel: (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return '链接'; } },
  // v1.8.0：卡片视图桥（P3b，对齐 app.js 语义）
  fmtDate: (d) => (d ? String(d).slice(0, 10) : ''),
  copyText: (t) => { clipboardWrites.push(String(t)); return Promise.resolve(true); },
  openLinkMenu: (anchor, urls, onPick) => { calls.push(['openLinkMenu', urls.length]); onPick(urls[1] || urls[0]); },
  filterEntries: () => {
    const st = w.feedlore.state;
    let list = (st.entries || []).filter((e) => {
      if (st.tag && !(e.tags || []).includes(st.tag)) return false;
      if (st.size && st.size !== 'all') { if (!e.size) return false; }
      return true;
    });
    if (st.sort === 'name') list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return list;
  },
  cardsSearch: (v) => { w.feedlore.state.q = v; w.feedlore.state.tag = null; return cardsLoad(true); },
  cardsFilterFeed: (v) => { w.feedlore.state.feedFilter = v ? v : null; w.feedlore.state.tag = null; return cardsLoad(true); },
  cardsSort: (v) => { w.feedlore.state.sort = v; cardsTick(); },
  cardsView: (m) => { w.feedlore.state.view = m; cardsTick(); },
  cardsTag: (t) => { w.feedlore.state.tag = t || null; cardsTick(); },
  cardsLoadMore: () => cardsLoad(false),
  cardsSetFlag: async (id, patch) => {
    const e = (w.feedlore.state.entries || []).find((x) => String(x.id) === String(id));
    if (e) Object.assign(e, patch);
    cardsTick();
    return true;
  },
  // 打开卡片详情即记为已读（真实实现见 core/ui.js cardDetailRead：卡片页不显示已读态）
  cardsDetailRead: (id) => {
    calls.push(['cardsDetailRead', id]);
    const e = (w.feedlore.state.entries || []).find((x) => String(x.id) === String(id));
    if (e) e.isRead = true;
  },
  jumpToFeed: (id) => { calls.push(['jumpToFeed', id]); },
  // v1.9.0：阅读页桥（P3c，对齐 app.js 语义）
  fmtFull: (d) => (d ? String(d).slice(0, 16).replace('T', ' ') : ''),
  readerAccordionOn: () => true,
  readerSetScope: (scope) => { calls.push(['readerSetScope', scope]); w.feedlore.state.rdScope = scope; w.feedlore.state.rdFeedId = null; w.feedlore.state.rdGroup = null; readerTick(); },
  readerSetFeed: (id) => { calls.push(['readerSetFeed', id]); w.feedlore.state.rdFeedId = Number(id); w.feedlore.state.rdGroup = null; w.feedlore.state.rdScope = 'all'; readerTick(); },
  readerSetGroup: (g) => { calls.push(['readerSetGroup', g]); w.feedlore.state.rdGroup = g; w.feedlore.state.rdFeedId = null; readerTick(); },
  readerOpenSource: () => calls.push(['readerOpenSource']),
  readerSearch: (q) => { calls.push(['readerSearch', q]); w.feedlore.state.rdQ = q; readerTick(); },
  readerToggleArt: (id) => {
    calls.push(['readerToggleArt', id]);
    const st = w.feedlore.state;
    if (st.rdExpanded.has(id)) { st.rdExpanded.delete(id); }
    else {
      st.rdExpanded.add(id);
      if (!st.rdBody.has(id)) {
        st.rdBody.set(id, {
          id, name: '条目一', tags: ['标签A'], content: '第一段正文。\n第二段正文。',
          link: 'https://pan.quark.cn/s/abc', links: ['https://pan.quark.cn/s/abc'],
          sourceUrl: 'https://example.com/a', date: '2026-10-15T10:00:00Z',
        });
      }
    }
    readerTick();
  },
  readerCollapseAll: () => { calls.push(['readerCollapseAll']); w.feedlore.state.rdExpanded.clear(); readerTick(); },
  readerReadAll: () => calls.push(['readerReadAll']),
  readerToggleFav: (id) => {
    calls.push(['readerToggleFav', id]);
    const e = (w.feedlore.state.rdEntries || []).find((x) => String(x.id) === String(id));
    if (e) e.isFavorite = !e.isFavorite;
    readerTick();
  },
  readerTagToCards: (t) => calls.push(['readerTagToCards', t]),
  readerToggleAccordion: () => calls.push(['readerToggleAccordion']),
  readerToggleDrawer: () => calls.push(['readerToggleDrawer']),
  readerCloseDrawer: () => calls.push(['readerCloseDrawer']),
  feedTitle: (f) => (!f || typeof f !== 'object' ? (f || '') : f.customTitle || f.title || f.url || ''),
  shortFeedName: (n) => String(n || '').replace(/\s*-\s*Telegram Channel\s*$/i, '').trim(),
  groupFeeds(feeds) {
    const map = new Map();
    for (const f of feeds) {
      const g = String(f.groupName || '').trim();
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(f);
    }
    const order = w.feedlore.state.groupOrder || [];
    const seen = new Set();
    const names = [];
    for (const g of order) if (g && map.has(g) && !seen.has(g)) { names.push(g); seen.add(g); }
    for (const g of map.keys()) if (g && !seen.has(g)) { names.push(g); seen.add(g); }
    if (map.has('')) names.push('');
    return names.map((name) => ({ name, feeds: map.get(name) }));
  },
};
// v2.0.0：组件改为 `import { core } from '@core'`，测试用 tests/ui/stub-core.js 顶上这个别名；
// 替身读的是 Node 的 globalThis.__uiCore（bundle 在 Node 里执行），这里把同一份桩暴露出去。
global.__uiCore = w.feedlore;
const layoutStub = { collapsedGroups: [], sections: {} };

/* 卡片视图（P3b）：复刻 app.js 的 loadPage 语义（数据归共享 state，UI 靠 __cardsTick 重绘） */
const cardsTick = () => w.dispatchEvent(new w.Event('__cardsTick'));
const shellTick = () => w.dispatchEvent(new w.Event('__shellTick'));
const readerTick = () => w.dispatchEvent(new w.Event('__readerTick'));

/** 阅读页条目（P3c 测试用） */
const READER_ENTRIES = () => ([
  { id: 'r1', name: '文章一', tags: ['标签A'], size: '2.5G', date: '2026-10-15T10:00:00Z', feedName: '例子星球 - Telegram Channel', isRead: false, isFavorite: false, sourceUrl: 'https://example.com/a1' },
  { id: 'r2', name: '文章二', tags: [], size: '', date: '2026-10-14T10:00:00Z', feedName: 'demo', isRead: true, isFavorite: true },
]);
const readerSetEntries = (list) => { w.feedlore.state.rdEntries = list; readerTick(); };
async function cardsLoad(reset) {
  const s = w.feedlore;
  if (s.state.loading) return;
  s.state.loading = true;
  if (reset) { s.state.offset = 0; s.state.hasMore = true; s.state.entries = []; }
  cardsTick();
  try {
    const qs = new URLSearchParams({ limit: String(s.state.pageSize || 24), offset: String(s.state.offset || 0) });
    if (s.state.q) qs.set('q', s.state.q);
    if (s.state.feedFilter) qs.set('feeds', String(s.state.feedFilter)); else qs.set('scope', 'cards');
    const res = await s.apiFetch('/api/entries?' + qs.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (reset) s.state.tags = data.tags || [];
    const seen = new Set(s.state.entries.map((e) => e.id));
    for (const e of data.entries || []) if (!seen.has(e.id)) s.state.entries.push(e);
    s.state.offset += (data.entries || []).length;
    s.state.hasMore = !!data.hasMore && (data.entries || []).length > 0;
    s.state.loadError = false;
  } catch (err) {
    if (!s.state.entries.length) s.state.loadError = true; else s.toast('加载失败：' + (err.message || err), false);
  } finally {
    s.state.loading = false;
    cardsTick();
  }
}

require('./.build/mount-settings.cjs');
require('./.build/mount-ai.cjs');
require('./.build/mount-cards.cjs');
require('./.build/mount-reader.cjs');
require('./.build/mount-shell.cjs');
require('./.build/mount-overlays.cjs');
const __mount = w.__mount;
const __mountAi = w.__mountAi;
const __mountCards = w.__mountCards;
const __mountReader = w.__mountReader;
const __mountTopBar = w.__mountTopBar;
const __mountOverlays = w.__mountOverlays;
__mount(document.getElementById('settingsRoot'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 轮询等待条件成立（最多 ms 毫秒），容忍 jsdom 下 React 渲染 / 副作用的时序抖动
const waitFor = async (fn, ms = 1000, step = 20) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (fn()) return true; } catch (_) { /* 元素尚未就绪 */ } await sleep(step); }
  return false;
};
const mask = () => document.querySelector('.modal-mask');
const tabBtn = (label) => [...document.querySelectorAll('.tabs .tab')].find((b) => b.textContent === label);
const clickTab = (label) => tabBtn(label).click();
const callsOf = (name) => calls.filter((c) => c[0] === name);
const lastCall = (name) => { const c = callsOf(name); return c[c.length - 1]; };
const setInput = (sel, v) => {
  const input = document.querySelector(sel);
  // React 会给实例打 value 补丁做变更追踪；必须走原型 setter 才能让 onChange 感知到变化（测试专用）
  const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set;
  setter.call(input, v);
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
};
const setVal = (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set;
  setter.call(el, v);
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
};
const setSel = (sel, v) => {
  const el = document.querySelector(sel);
  Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
};
const setSelEl = (el, v) => {
  Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
};
const keydown = (el, key) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true }));
const clickEl = (sel) => document.querySelector(sel).click();
const postsTo = (url) => callsOf('apiFetch').filter((c) => c[1] === url && c[2] === 'POST');
const patchesTo = (url) => callsOf('apiFetch').filter((c) => c[1] === url && c[2] === 'PATCH');
const lastPostBody = (url) => JSON.parse(postsTo(url)[postsTo(url).length - 1][3]);
const lastPatchBody = (url) => { const p = patchesTo(url); return p.length ? JSON.parse(p[p.length - 1][3]) : null; };
const countApi = (url, method) => callsOf('apiFetch').filter((c) => c[1] === url && ((c[2] || 'GET') === (method || 'GET'))).length;
const deletesTo = (url) => callsOf('apiFetch').filter((c) => c[1] === url && c[2] === 'DELETE');
const rowOf = (id) => document.querySelector('.feed-row[data-id="' + id + '"]');
const rowIds = () => [...document.querySelectorAll('.feed-row')].map((r) => r.getAttribute('data-id'));
const headNames = () => [...document.querySelectorAll('.feed-group-head')].map((h) => h.getAttribute('data-group'));
/** #feedList 的直接子元素里按 DOM 顺序归纳「分组 → 行 id 列表」 */
const rowsByGroup = () => {
  const out = new Map();
  let cur = '';
  for (const el of document.querySelector('#feedList').children) {
    if (el.classList.contains('feed-group-head')) cur = el.getAttribute('data-group') || '';
    else if (el.classList.contains('feed-row')) {
      if (!out.has(cur)) out.set(cur, []);
      out.get(cur).push(el.getAttribute('data-id'));
    }
  }
  return out;
};
const stubRect = (el, top, height) => {
  el.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, right: 100, width: 100, x: 0, y: top });
};
const origEFP = typeof w.document.elementFromPoint === 'function' ? w.document.elementFromPoint.bind(w.document) : null;
const withEFP = (el, fn) => {
  w.document.elementFromPoint = () => el;
  try { fn(); } finally { if (origEFP) w.document.elementFromPoint = origEFP; else delete w.document.elementFromPoint; }
};

(async () => {
  await sleep(60);
  const results = [];
  const t = (name, fn) => { try { fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name + ' —— ' + e.message]); } };

  // ============ index.html 挂载点（防「手术误删挂载点」回归） ============
  // 背景：v1.7.0 迁移 AI 视图时，替换区间跨过了 #settingsRoot，导致设置弹层不再挂载、
  // 设置按钮失效（直到 v1.8.2 才发现）。这里把四个挂载点钉死。
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  t('index.html：React 挂载点齐全', () => {
    for (const id of ['settingsRoot', 'cmdkRoot', 'aiRoot', 'cardsRoot', 'readerRoot', 'topbarRoot', 'overlaysRoot']) {
      if (indexHtml.indexOf('id="' + id + '"') < 0) throw new Error('缺 #' + id);
    }
  });
  t('index.html：仅剩 Vite 模块入口（/app.js 已退役）', () => {
    const appRefs = (indexHtml.match(/src="\/app\.js"/g) || []).length;
    const modRefs = (indexHtml.match(/src="\/src\/main\.jsx"/g) || []).length;
    if (appRefs !== 0) throw new Error('public/app.js 应已退役，仍被引用 ' + appRefs + ' 次');
    if (modRefs !== 1) throw new Error('/src/main.jsx 引用 ' + modRefs + ' 次');
  });

  // 阅读页外层 #readerRoot 必须 display:contents，否则 .reader 的两列网格会塌成 232px 单列
  // （v1.9.0 曾因此导致「文章页侧栏 / 正文错位」线上问题）
  t('style.css：.reader > #readerRoot 用 display:contents 还原网格', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'style.css'), 'utf8');
    const m = css.match(/\.reader\s*>\s*#readerRoot\s*\{([^}]*)\}/);
    if (!m) throw new Error('缺 .reader > #readerRoot 规则');
    if (m[1].indexOf('display: contents') < 0) throw new Error('应设 display:contents，实际：' + m[1].trim());
  });

  // ============ 外壳与宿主 ============
  t('初始：遮罩常驻但 hidden', () => { const m = mask(); if (!m) throw new Error('无遮罩'); if (m.hidden !== true) throw new Error('初始应隐藏'); });
  t('初始：__settingsOpen 未定义/false', () => { if (w.__settingsOpen) throw new Error('__settingsOpen=' + w.__settingsOpen); });
  t('初始：宿主已注册', () => { if (!w.__settingsHost) throw new Error('宿主未注册'); });

  w.__settingsHost.open('source');
  await waitFor(() => w.__settingsOpen === true && mask().hidden === false, 1000);
  t('host.open 打开（hidden=false）', () => { if (mask().hidden !== false) throw new Error('未打开'); });
  t('__settingsOpen 同步=true', () => { if (w.__settingsOpen !== true) throw new Error('window.__settingsOpen=' + w.__settingsOpen); });
  t('打开时锁屏', () => { if (!callsOf('lockPageScroll').length) throw new Error('lockPageScroll 未调用'); });
  t('6 个 tab（管理员）', () => { if (document.querySelectorAll('.tabs .tab').length !== 6) throw new Error('实际 ' + document.querySelectorAll('.tabs .tab').length); });
  t('source tab 默认高亮', () => { if (!tabBtn('数据源').classList.contains('active')) throw new Error('source 未高亮'); });
  t('副标题取 getSettingsSummary', () => { const s = document.querySelector('.modal-sub').textContent; if (s !== '共 12 个订阅源 · 采集开启 10 个 · 卡片展示 8 个') throw new Error('实际: ' + s); });

  // ============ 面板挂载（全部 React 渲染，无 legacy 容器） ============
  t('source 为 React 渲染', () => {
    if (!document.querySelector('.tab-pane[data-pane="source"]')) throw new Error('无 React source 面板');
  });
  t('无 legacy 容器（P2d 已退役）', () => {
    if (document.getElementById('legacyPanes')) throw new Error('#legacyPanes 仍在');
    if (document.querySelector('.tab-pane-legacy')) throw new Error('.tab-pane-legacy 仍在');
  });

  // ============ 数据源面板（P2c React 化） ============
  await sleep(40);
  t('进入面板即拉频道列表（loadFeeds 桥）', () => { if (!countApi('/api/feeds')) throw new Error('未 GET /api/feeds'); });
  t('挂载即重启自动刷新定时器', () => { if (!callsOf('scheduleAutoRefresh').length) throw new Error('scheduleAutoRefresh 未调用'); });
  t('pushSummary 同步副标题', () => { if (!callsOf('setSettingsSummary').length) throw new Error('setSettingsSummary 未调用'); });
  t('管理员进入拉取采集参数', () => { if (!countApi('/api/config')) throw new Error('未 GET /api/config'); });
  t('采集参数各控件回填', () => {
    const v = (s) => document.querySelector(s).value;
    if (v('#srcRefresh') !== '30') throw new Error('refresh: ' + v('#srcRefresh'));
    if (v('#srcKeep') !== '300') throw new Error('keep: ' + v('#srcKeep'));
    if (v('#srcKeepDays') !== '0') throw new Error('keepDays: ' + v('#srcKeepDays'));
    if (v('#srcTimeout') !== '25') throw new Error('timeout: ' + v('#srcTimeout'));
    if (v('#srcConcurrency') !== '3') throw new Error('concurrency: ' + v('#srcConcurrency'));
    if (v('#srcAutoRefresh') !== '0') throw new Error('autoRefresh: ' + v('#srcAutoRefresh'));
  });
  t('出网代理回填（v1.5.0 修复：原实现漏返该字段）', () => {
    if (document.querySelector('#srcProxy').value !== 'socks5://127.0.0.1:1080') throw new Error('proxy: ' + document.querySelector('#srcProxy').value);
  });
  t('采集参数摘要行', () => {
    const s = document.querySelector('#srcParamsSub').textContent;
    if (s.indexOf('每 30 分钟抓取') < 0 || s.indexOf('保留 300 条') < 0 || s.indexOf('不限时长') < 0 || s.indexOf('代理 socks5://127.0.0.1:1080') < 0) throw new Error(s);
  });
  t('bindSections 已套用（sec-bound 标记）', () => {
    if (document.querySelector('[data-sec="src-params"]').dataset.secBound !== '1') throw new Error('未绑定');
    if (document.querySelector('[data-sec="src-feeds"]').dataset.secBound !== '1') throw new Error('未绑定');
  });
  t('3 个频道行', () => { if (rowIds().join(',') !== '1,2,3') throw new Error(rowIds().join(',')); });
  t('分组顺序：科技在前、未分组在后且渲染未分组头', () => {
    if (headNames().join('|') !== '科技|') throw new Error(headNames().join('|'));
    const heads = document.querySelectorAll('.feed-group-head');
    if (!heads[1].querySelector('.feed-group-name.muted')) throw new Error('未分组头应 muted');
    if (heads[0].querySelector('.feed-group-n').textContent !== '2') throw new Error('科技计数');
    if (heads[1].querySelector('.feed-group-n').textContent !== '1') throw new Error('未分组计数');
  });
  t('采集/卡片开关态与行样式', () => {
    if (!rowOf('1').querySelector('[data-toggle="1"]').checked) throw new Error('f1 采集应开');
    if (!rowOf('1').querySelector('[data-card-toggle="1"]').checked) throw new Error('f1 卡片应开');
    if (rowOf('2').querySelector('[data-card-toggle="2"]').checked) throw new Error('f2 卡片应关');
    if (rowOf('3').querySelector('[data-toggle="3"]').checked) throw new Error('f3 采集应关');
    if (!rowOf('3').classList.contains('off')) throw new Error('f3 行应 off');
    if (!rowOf('2').classList.contains('no-card')) throw new Error('f2 行应 no-card');
  });
  t('状态文案（条目数 / 频率 / 抓取时间）', () => {
    const s = rowOf('1').querySelector('.feed-stat').textContent;
    if (s.indexOf('12 条') < 0 || s.indexOf('每 30 分钟') < 0 || s.indexOf('今天') < 0) throw new Error(s);
    const s3 = rowOf('3').querySelector('.feed-stat').textContent;
    if (s3.indexOf('尚未抓取') < 0) throw new Error(s3);
  });
  t('抓取失败标记（status=error）', () => {
    const err = rowOf('2').querySelector('.feed-stat .err');
    if (!err || err.textContent.indexOf('抓取失败') < 0) throw new Error('无 err 标记');
  });
  t('单独频率 own 态', () => {
    const sel = rowOf('2').querySelector('.feed-freq');
    if (!sel.classList.contains('own') || sel.value !== '60') throw new Error(sel.className + '/' + sel.value);
    const sel1 = rowOf('1').querySelector('.feed-freq');
    if (sel1.classList.contains('own') || sel1.value !== '') throw new Error('f1 应跟随全局');
    if (sel1.options[0].textContent.indexOf('跟随全局（30 分钟）') < 0) throw new Error('默认项: ' + sel1.options[0].textContent);
  });
  t('底部计数', () => {
    const s = document.querySelector('#settingsHint').textContent;
    if (s.indexOf('2 / 3 个频道在定时采集') < 0 || s.indexOf('2 个在「卡片」页展示') < 0 || s.indexOf('1 个分组') < 0) throw new Error(s);
  });
  t('频道列表摘要行', () => {
    const s = document.querySelector('#feedToolbarHint').textContent;
    if (s.indexOf('3 个频道') < 0 || s.indexOf('1 个分组') < 0 || s.indexOf('1 个单独设了频率') < 0) throw new Error(s);
  });

  // ---- 添加订阅 ----
  const postsBeforeEmpty = postsTo('/api/feeds').length;
  clickEl('#addFeedBtn');
  await sleep(30);
  t('空地址添加：err 提示且不发请求', () => {
    if (postsTo('/api/feeds').length !== postsBeforeEmpty) throw new Error('不应 POST');
    const r = document.querySelector('#feedResult');
    if (!r.classList.contains('err') || r.textContent.indexOf('请先填入 RSS 地址') < 0) throw new Error(r.className + '/' + r.textContent);
  });
  setInput('#rssUrl', 'https://new.example.com/rss.xml');
  clickEl('#addFeedBtn');
  await sleep(80);
  t('添加成功：POST + ok 提示 + 新行 + toast + 重拉', () => {
    const body = lastPostBody('/api/feeds');
    if (body.url !== 'https://new.example.com/rss.xml') throw new Error(JSON.stringify(body));
    const r = document.querySelector('#feedResult');
    if (!r.classList.contains('ok') || r.textContent.indexOf('已添加') < 0) throw new Error(r.className + '/' + r.textContent);
    if (!rowOf('10')) throw new Error('新行未出现');
    if (document.querySelector('#rssUrl').value !== '') throw new Error('地址框未清空');
    if (!callsOf('toast').some((c) => c[1] === '订阅已添加')) throw new Error('无 toast');
    if (countApi('/api/feeds') < 2) throw new Error('未重拉列表');
    if (!callsOf('loadPage').length) throw new Error('未刷页面');
  });
  setInput('#rssUrl', 'https://bad.example.com/x');
  addShouldFail = true;
  clickEl('#addFeedBtn');
  await sleep(80);
  t('添加失败：显示服务端错误', () => {
    const r = document.querySelector('#feedResult');
    if (!r.classList.contains('err') || r.textContent.indexOf('连接超时') < 0) throw new Error(r.className + '/' + r.textContent);
  });

  // ---- OPML 导入 / 导出 ----
  clickEl('#exportOpmlBtn');
  t('导出 OPML 走桥', () => { if (!callsOf('exportOpml').length) throw new Error('exportOpml 未调用'); });
  const opmlInput = document.querySelector('#opmlFile');
  opmlInput.click = () => calls.push(['opmlFileClick']);
  clickEl('#importOpmlBtn');
  t('导入按钮触发文件选择', () => { if (!callsOf('opmlFileClick').length) throw new Error('未触发 #opmlFile'); });
  const opmlText = '<?xml version="1.0"?><opml version="1.0"><body data-group="甲组">' +
    '<outline text="甲域" title="甲域">' +
    '<outline type="rss" text="源一" xmlUrl="https://one.example.com/rss"/>' +
    '<outline type="rss" text="源二" xmlUrl="https://two.example.com/rss"/>' +
    '</outline></body></opml>';
  Object.defineProperty(opmlInput, 'files', { value: [{ name: 'subs.opml', text: () => Promise.resolve(opmlText) }], configurable: true });
  opmlInput.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(80);
  t('OPML 导入：POST 原样文本 + 新行 + 分组 + 计数', () => {
    if (!postsTo('/api/feeds/import').length) throw new Error('未 POST import');
    const body = lastPostBody('/api/feeds/import');
    if (body.opml !== opmlText) throw new Error('opml 文本不符');
    if (!rowOf('11') || !rowOf('12')) throw new Error('新行缺失: ' + rowIds().join(','));
    if (headNames().indexOf('甲组') < 0) throw new Error('无甲组头: ' + headNames().join('|'));
    const r = document.querySelector('#feedResult');
    if (!r.classList.contains('ok') || r.textContent.indexOf('已导入 2 个新频道') < 0 || r.textContent.indexOf('1 个分组') < 0) throw new Error(r.className + '/' + r.textContent);
    if (opmlInput.value !== '') throw new Error('文件框应重置');
    const by = rowsByGroup().get('甲组');
    if (!by || by.join(',') !== '11,12') throw new Error('甲组行: ' + (by || []).join(','));
  });
  const opml2 = '<opml><body><outline type="rss" text="源三" xmlUrl="https://three.example.com/rss"/></body></opml>';
  Object.defineProperty(opmlInput, 'files', { value: [{ name: 'x.opml', text: () => Promise.resolve(opml2) }], configurable: true });
  importShouldFail = true;
  opmlInput.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(80);
  t('导入失败：err 提示', () => {
    const r = document.querySelector('#feedResult');
    if (!r.classList.contains('err') || r.textContent.indexOf('OPML 解析失败') < 0) throw new Error(r.className + '/' + r.textContent);
    if (rowOf('13')) throw new Error('不应添加');
  });

  // ---- 开关（采集 / 卡片） ----
  rowOf('3').querySelector('[data-toggle="3"]').click();
  await sleep(80);
  t('采集开关：PATCH enabled + off 移除 + toast', () => {
    const body = lastPatchBody('/api/feeds/3');
    if (!body || body.enabled !== true) throw new Error(JSON.stringify(body));
    if (rowOf('3').classList.contains('off')) throw new Error('仍 off');
    if (!callsOf('toast').some((c) => c[1] === '已开启采集')) throw new Error('无 toast');
  });
  rowOf('2').querySelector('[data-card-toggle="2"]').click();
  await sleep(80);
  t('卡片开关：PATCH cardEnabled + no-card 移除', () => {
    const body = lastPatchBody('/api/feeds/2');
    if (!body || body.cardEnabled !== true) throw new Error(JSON.stringify(body));
    if (rowOf('2').classList.contains('no-card')) throw new Error('仍 no-card');
    if (!callsOf('toast').some((c) => c[1] === '已在卡片页展示')) throw new Error('无 toast');
  });

  // ---- 保存期间禁用 + 失败回滚 ----
  let releasePatch;
  patchHold = new Promise((r) => { releasePatch = r; });
  const pendCb = rowOf('3').querySelector('[data-toggle="3"]');
  pendCb.click();
  await sleep(30);
  t('保存期间：本行控件禁用（pendingIds）', () => {
    if (!pendCb.disabled) throw new Error('采集开关未禁用');
    if (!rowOf('3').querySelector('[data-card-toggle="3"]').disabled) throw new Error('卡片开关未禁用');
    if (!rowOf('3').querySelector('[data-freq="3"]').disabled) throw new Error('频率未禁用');
    if (!rowOf('3').querySelector('[data-group="3"]').disabled) throw new Error('分组未禁用');
    if (!rowOf('3').querySelector('[data-rename="3"]').disabled) throw new Error('重命名未禁用');
    if (!rowOf('3').querySelector('[data-del="3"]').disabled) throw new Error('删除未禁用');
  });
  miniFeeds.find((f) => f.id === '3').enabled = false;
  releasePatch({ ok: true, json: () => Promise.resolve({ ok: true, feed: null }) });
  await sleep(80);
  patchHold = null;
  t('保存后：解禁且状态生效', () => {
    if (rowOf('3').querySelector('[data-toggle="3"]').disabled) throw new Error('未解禁');
    if (!rowOf('3').classList.contains('off')) throw new Error('未 off');
  });
  patchFailNext = true;
  rowOf('1').querySelector('[data-toggle="1"]').click();
  await sleep(80);
  t('开关保存失败：错误 toast 且回滚', () => {
    const errToasts = callsOf('toast').filter((c) => typeof c[1] === 'string' && c[1].indexOf('保存失败') >= 0);
    if (!errToasts.length) throw new Error('无错误 toast');
    if (errToasts[errToasts.length - 1][2] !== false) throw new Error('toast 未标失败态');
    if (rowOf('1').classList.contains('off')) throw new Error('状态未回滚');
    if (!rowOf('1').querySelector('[data-toggle="1"]').checked) throw new Error('checkbox 未回滚');
    if (rowOf('1').querySelector('[data-toggle="1"]').disabled) throw new Error('未解禁');
  });

  // ---- 频道分组：提交式（v2.9.0：打字不发请求，失焦才保存） ----
  const fireBlur = (el) => el.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true }));
  const patchesBeforeGrp = patchesTo('/api/feeds/2').length;
  setVal(rowOf('2').querySelector('[data-group="2"]'), '甲组');
  await sleep(50);
  t('分组输入：打字期间不发请求、草稿本地生效', () => {
    if (patchesTo('/api/feeds/2').length !== patchesBeforeGrp) throw new Error('打字即保存（旧 bug 复发）');
    const inp = rowOf('2').querySelector('[data-group="2"]');
    if (inp.value !== '甲组') throw new Error('草稿未本地生效: ' + inp.value);
  });
  fireBlur(rowOf('2').querySelector('[data-group="2"]'));
  await sleep(80);
  t('分组失焦提交：PATCH groupName + 新分组头 + toast', () => {
    const body = lastPatchBody('/api/feeds/2');
    if (!body || body.groupName !== '甲组') throw new Error(JSON.stringify(body));
    if (headNames().indexOf('甲组') < 0) throw new Error('无甲组头');
    const inp = rowOf('2').querySelector('[data-group="2"]');
    if (inp.value !== '甲组') throw new Error('回写: ' + inp.value);
    if (!callsOf('toast').some((c) => c[1] === '已归入「甲组」')) throw new Error('无 toast');
  });
  // 无草稿再失焦：不发请求
  const patchesBeforeSame = patchesTo('/api/feeds/2').length;
  fireBlur(rowOf('2').querySelector('[data-group="2"]'));
  await sleep(60);
  t('分组无草稿失焦：不发请求', () => {
    if (patchesTo('/api/feeds/2').length !== patchesBeforeSame) throw new Error('重复提交');
  });
  // Escape：清草稿恢复原值、不发请求
  const patchesBeforeEsc = patchesTo('/api/feeds/2').length;
  const grpEsc = rowOf('2').querySelector('[data-group="2"]');
  setVal(grpEsc, '临时');
  await sleep(30);
  grpEsc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(40);
  t('分组 Escape：清草稿恢复原值且不发请求', () => {
    const inp = rowOf('2').querySelector('[data-group="2"]');
    if (inp.value !== '甲组') throw new Error('未恢复: ' + inp.value);
    if (patchesTo('/api/feeds/2').length !== patchesBeforeEsc) throw new Error('发了请求');
  });
  setSel('[data-freq="2"]', '720');
  await sleep(80);
  t('频率修改：PATCH refreshMinutes=720 + own 态 + toast', () => {
    const body = lastPatchBody('/api/feeds/2');
    if (!body || body.refreshMinutes !== 720) throw new Error(JSON.stringify(body));
    const sel = rowOf('2').querySelector('.feed-freq');
    if (sel.value !== '720' || !sel.classList.contains('own')) throw new Error(sel.value + '/' + sel.className);
    if (!callsOf('toast').some((c) => c[1] === '该频道已设为每 12 小时抓取')) throw new Error('无 toast');
  });
  setSel('[data-freq="2"]', '');
  await sleep(80);
  t('频率跟随全局：PATCH null + 回落非 own', () => {
    const body = lastPatchBody('/api/feeds/2');
    if (!body || body.refreshMinutes !== null) throw new Error(JSON.stringify(body));
    if (!callsOf('toast').some((c) => c[1] === '已改为跟随全局频率')) throw new Error('无 toast');
  });
  const reorderBefore = postsTo('/api/feeds/reorder').length;
  setVal(rowOf('2').querySelector('.feed-order'), '3');
  await sleep(80);
  t('序号重排：reorder POST + 序号回显', () => {
    if (postsTo('/api/feeds/reorder').length !== reorderBefore + 1) throw new Error('reorder 未发');
    const body = lastPostBody('/api/feeds/reorder');
    const f2 = body.feeds.find((x) => x.id === '2');
    if (!f2 || f2.sortOrder !== 3 || f2.groupName !== '甲组') throw new Error(JSON.stringify(body.feeds));
    if (rowOf('2').querySelector('.feed-order').value !== '3') throw new Error('序号: ' + rowOf('2').querySelector('.feed-order').value);
    const by = rowsByGroup().get('甲组');
    if (by.join(',') !== '11,12,2') throw new Error('甲组行序: ' + by.join(','));
  });
  setVal(rowOf('12').querySelector('.feed-order'), '0');
  await sleep(40);
  t('非法序号：不发请求且恢复显示', () => {
    if (postsTo('/api/feeds/reorder').length !== reorderBefore + 1) throw new Error('不应发 reorder');
    if (rowOf('12').querySelector('.feed-order').value !== '2') throw new Error('恢复值: ' + rowOf('12').querySelector('.feed-order').value);
  });
  clickEl('[data-rename="1"]');
  await sleep(40);
  t('重命名：编辑框出现且带原名', () => {
    const inp = rowOf('1').querySelector('.feed-title-edit');
    if (!inp) throw new Error('无编辑框');
    if (inp.value !== '例子星球') throw new Error(inp.value);
  });
  setVal(rowOf('1').querySelector('.feed-title-edit'), '例子星球 Pro');
  keydown(rowOf('1').querySelector('.feed-title-edit'), 'Enter');
  await sleep(80);
  t('重命名提交：PATCH title + 展示名更新', () => {
    const body = lastPatchBody('/api/feeds/1');
    if (!body || body.title !== '例子星球 Pro') throw new Error(JSON.stringify(body));
    if (rowOf('1').querySelector('.feed-title').textContent !== '例子星球 Pro') throw new Error(rowOf('1').querySelector('.feed-title').textContent);
    if (!callsOf('toast').some((c) => c[1] === '名称已更新')) throw new Error('无 toast');
  });
  clickEl('[data-rename="3"]');
  await sleep(40);
  keydown(rowOf('3').querySelector('.feed-title-edit'), 'Escape');
  await sleep(40);
  t('重命名取消：不 PATCH 且编辑框收回', () => {
    const bodies = patchesTo('/api/feeds/3').map((c) => JSON.parse(c[3]));
    if (bodies.some((b) => 'title' in b)) throw new Error('不应提交 title');
    if (rowOf('3').querySelector('.feed-title-edit')) throw new Error('编辑框未收回');
  });
  /* ---- 改订阅地址：编辑态 / 服务端校验反馈 / 改完按新地址试抓（probe） ---- */
  clickEl('[data-url="1"]');
  await sleep(40);
  t('改地址：编辑框出现且预填完整原地址', () => {
    const inp = rowOf('1').querySelector('.feed-url-edit');
    if (!inp) throw new Error('无编辑框');
    if (inp.value !== 'https://example.com/feed.xml') throw new Error(inp.value);
  });
  setVal(rowOf('1').querySelector('.feed-url-edit'), 'ftp://example.com/feed.xml');
  keydown(rowOf('1').querySelector('.feed-url-edit'), 'Enter');
  await sleep(80);
  t('改地址：非法协议 → 失败 toast，原地址不动', () => {
    const body = lastPatchBody('/api/feeds/1');
    if (!body || body.url !== 'ftp://example.com/feed.xml') throw new Error(JSON.stringify(body));
    if (rowOf('1').querySelector('.feed-url').textContent.indexOf('example.com/feed.xml') < 0) throw new Error('地址被改了');
    if (!callsOf('toast').some((c) => c[2] === false && /地址未更新/.test(c[1]))) throw new Error('无失败 toast');
  });
  clickEl('[data-url="1"]');
  await sleep(40);
  setVal(rowOf('1').querySelector('.feed-url-edit'), 'https://tg.example/rss/channel/demo');
  keydown(rowOf('1').querySelector('.feed-url-edit'), 'Enter');
  await sleep(80);
  t('改地址：撞上自己另一个频道 → 判重文案进 toast', () => {
    if (!callsOf('toast').some((c) => /另一个频道/.test(c[1]))) throw new Error('无判重提示');
    if (rowOf('1').querySelector('.feed-url').textContent.indexOf('example.com/feed.xml') < 0) throw new Error('地址不应变');
  });
  clickEl('[data-url="1"]');
  await sleep(40);
  setVal(rowOf('1').querySelector('.feed-url-edit'), 'https://example.com/feed.atom');
  keydown(rowOf('1').querySelector('.feed-url-edit'), 'Enter');
  await sleep(80);
  t('改地址提交：PATCH url + 行内换成新地址 + 试抓成功反馈', () => {
    const body = lastPatchBody('/api/feeds/1');
    if (!body || body.url !== 'https://example.com/feed.atom') throw new Error(JSON.stringify(body));
    if (rowOf('1').querySelector('.feed-url').textContent !== 'example.com/feed.atom') {
      throw new Error(rowOf('1').querySelector('.feed-url').textContent);
    }
    if (!callsOf('toast').some((c) => c[1] === '订阅地址已更新')) throw new Error('无成功 toast');
    if (!callsOf('toast').some((c) => /新地址可用/.test(c[1]))) throw new Error('无试抓反馈');
  });
  const patchesBeforeSameUrl = patchesTo('/api/feeds/1').length;
  clickEl('[data-url="1"]');
  await sleep(40);
  keydown(rowOf('1').querySelector('.feed-url-edit'), 'Enter');
  await sleep(60);
  t('改地址：原值直接回车不发请求', () => {
    if (patchesTo('/api/feeds/1').length !== patchesBeforeSameUrl) throw new Error('重复提交');
    if (rowOf('1').querySelector('.feed-url-edit')) throw new Error('编辑框未收回');
  });
  const patchesBeforeUrlEsc = patchesTo('/api/feeds/1').length;
  clickEl('[data-url="1"]');
  await sleep(40);
  setVal(rowOf('1').querySelector('.feed-url-edit'), 'https://never.example/rss');
  keydown(rowOf('1').querySelector('.feed-url-edit'), 'Escape');
  await sleep(60);
  t('改地址取消：Esc 不 PATCH 且编辑框收回', () => {
    if (patchesTo('/api/feeds/1').length !== patchesBeforeUrlEsc) throw new Error('发了请求');
    if (rowOf('1').querySelector('.feed-url-edit')) throw new Error('编辑框未收回');
    if (rowOf('1').querySelector('.feed-url').textContent !== 'example.com/feed.atom') throw new Error('值不该留下');
  });
  urlProbeFail = true;
  clickEl('[data-url="1"]');
  await sleep(40);
  setVal(rowOf('1').querySelector('.feed-url-edit'), 'https://mirror.example.com/rss');
  keydown(rowOf('1').querySelector('.feed-url-edit'), 'Enter');
  await sleep(80);
  urlProbeFail = false;
  t('改地址：新地址当场抓不到 → 失败态提示但地址保留', () => {
    if (rowOf('1').querySelector('.feed-url').textContent !== 'mirror.example.com/rss') throw new Error('地址应保留');
    if (!callsOf('toast').some((c) => c[2] === false && /新地址抓取失败/.test(c[1]))) throw new Error('无试抓失败提示');
  });
  clickEl('[data-refresh="1"]');
  await sleep(80);
  t('立即抓取：POST :id/refresh + toast', () => {
    if (!postsTo('/api/feeds/1/refresh').length) throw new Error('未 POST');
    if (!callsOf('toast').some((c) => c[1] === '新增 3 条')) throw new Error('无 toast');
  });
  const toastCountBeforeDel = callsOf('toast').length;
  clickEl('[data-del="10"]');
  await sleep(80);
  t('删除订阅：DELETE + 行消失 + toast', () => {
    if (!deletesTo('/api/feeds/10').length) throw new Error('未 DELETE');
    if (rowOf('10')) throw new Error('行仍在');
    if (callsOf('toast').length <= toastCountBeforeDel) throw new Error('无 toast');
  });

  // ---- 折叠分组（按账号持久化） ----
  const techHead = document.querySelector('.feed-group-head[data-group="科技"]');
  techHead.click();
  await sleep(40);
  t('折叠分组：setLayout 持久化 + 行隐藏', () => {
    const last = callsOf('setLayout').filter((c) => c[1] === 'collapsedGroups');
    if (!last.length || last[last.length - 1][2].indexOf('科技') < 0) throw new Error(JSON.stringify(last));
    if (!document.querySelector('.feed-group-head[data-group="科技"]').classList.contains('collapsed')) throw new Error('未 collapsed');
    if (rowsByGroup().has('科技') && rowsByGroup().get('科技').length) throw new Error('行未隐藏');
  });
  t('折叠态写入共享 state（collapsedGroups）', () => {
    if (!w.feedlore.state.collapsedGroups.has('科技')) throw new Error('state 未写入');
  });
  document.querySelector('.feed-group-head[data-group="科技"]').click();
  await sleep(40);
  t('再次点击展开', () => {
    if (document.querySelector('.feed-group-head[data-group="科技"]').classList.contains('collapsed')) throw new Error('仍 collapsed');
    if ((rowsByGroup().get('科技') || []).join(',') !== '1') throw new Error('科技行: ' + (rowsByGroup().get('科技') || []).join(','));
  });

  // ---- details 开合状态跨次进入（bindSections 持久化） ----
  const paramsDetails = document.querySelector('[data-sec="src-params"]');
  paramsDetails.open = true;
  paramsDetails.dispatchEvent(new w.Event('toggle', { bubbles: true }));
  await sleep(20);
  clickTab('外观'); await sleep(40);
  const feedsGetsBefore = countApi('/api/feeds');
  clickTab('数据源'); await sleep(100);
  t('二次进入重新 loadFeeds', () => { if (countApi('/api/feeds') !== feedsGetsBefore + 1) throw new Error('GET 次数=' + countApi('/api/feeds')); });
  t('details 开合状态跨次进入保持', () => {
    if (document.querySelector('[data-sec="src-params"]').open !== true) throw new Error('未记住展开');
  });
  t('折叠分组跨次进入保持（展开态也记）', () => {
    if (document.querySelector('.feed-group-head[data-group="科技"]').classList.contains('collapsed')) throw new Error('展开态未保持');
  });

  // ---- 拖拽：频道跨组 ----
  const row1 = rowOf('1');
  const row3 = rowOf('3');
  stubRect(row1, 0, 100);
  withEFP(row1, () => {
    row3.querySelector('.drag-handle').dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new w.MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 10 }));
    document.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, clientX: 40, clientY: 10 }));
  });
  await sleep(60);
  t('拖拽跨组：reorder POST + f3 归入科技 + 侧栏同步', () => {
    const body = lastPostBody('/api/feeds/reorder');
    const f3 = body.feeds.find((x) => x.id === '3');
    if (!f3 || f3.groupName !== '科技' || f3.sortOrder !== 0) throw new Error(JSON.stringify(body.feeds.find((x) => x.id === '3')));
    const by = rowsByGroup();
    if ((by.get('科技') || []).join(',') !== '3,1') throw new Error('科技行: ' + (by.get('科技') || []).join(','));
    if (by.has('')) throw new Error('无未分组频道时不应渲染未分组头');
    if (headNames().indexOf('') >= 0) throw new Error(headNames().join('|'));
    if (!callsOf('renderReaderChannels').length) throw new Error('未同步频道侧栏');
    if (!callsOf('renderFeedSelect').length) throw new Error('未同步筛选下拉');
  });

  // ---- 拖拽：分组重排 ----
  const headJia = document.querySelector('.feed-group-head[data-group="甲组"]');
  const headTech = document.querySelector('.feed-group-head[data-group="科技"]');
  stubRect(headTech, 0, 40);
  const prefsPostsBefore = postsTo('/api/prefs').length;
  withEFP(headTech, () => {
    headJia.querySelector('.drag-handle').dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new w.MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 10 }));
    document.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, clientX: 40, clientY: 10 }));
  });
  await sleep(60);
  t('分组拖拽：POST /api/prefs groupOrder + 头序变化', () => {
    if (postsTo('/api/prefs').length !== prefsPostsBefore + 1) throw new Error('未 POST prefs');
    const body = lastPostBody('/api/prefs');
    if (body.groupOrder.join(',') !== '甲组,科技') throw new Error(JSON.stringify(body.groupOrder));
    if (headNames()[0] !== '甲组') throw new Error(headNames().join('|'));
  });

  // ---- 分组重命名（v2.9.0 新增）：组头内联编辑，组内频道一并改名 ----
  const prefsBeforeGrp = postsTo('/api/prefs').length;
  clickEl('.feed-group-head[data-group="科技"] .feed-group-rename');
  await sleep(50);
  t('分组重命名：点击组头按钮出输入框并预填原组名', () => {
    const ed = document.querySelector('.feed-group-edit');
    if (!ed) throw new Error('无 .feed-group-edit');
    if (ed.value !== '科技') throw new Error('预填: ' + ed.value);
  });
  const patchesBeforeGr = patchesTo('/api/feeds/1').length;
  setVal(document.querySelector('.feed-group-edit'), '技术');
  await sleep(40);
  fireBlur(document.querySelector('.feed-group-edit'));
  await sleep(150);
  t('分组重命名提交：组内 PATCH + groupOrder 同步 + 新组头 + toast', () => {
    const body = lastPatchBody('/api/feeds/1');
    if (!body || body.groupName !== '技术') throw new Error('PATCH feed1: ' + JSON.stringify(body));
    const prefsBody = lastPostBody('/api/prefs');
    if (!Array.isArray(prefsBody.groupOrder) || prefsBody.groupOrder.indexOf('技术') < 0 || prefsBody.groupOrder.indexOf('科技') >= 0) {
      throw new Error('groupOrder: ' + JSON.stringify(prefsBody.groupOrder));
    }
    const heads = headNames();
    if (heads.indexOf('技术') < 0) throw new Error('无新技术头');
    if (heads.indexOf('科技') >= 0) throw new Error('旧组头仍在');
    if (!callsOf('toast').some((c) => typeof c[1] === 'string' && c[1].indexOf('分组已改名「技术」') === 0)) throw new Error('toast 不符: ' + JSON.stringify(callsOf('toast').slice(-1)));
    if (!document.querySelector('.feed-group-head[data-group="技术"] .feed-group-n')) throw new Error('新组计数缺失');
  });

  // ---- 采集参数保存（含 cfgLoaded 守卫） ----
  clickTab('外观'); await sleep(40);
  let releaseCfg;
  cfgHold = new Promise((r) => { releaseCfg = r; });
  clickTab('数据源'); await sleep(40);
  const cfgPostsBefore = postsTo('/api/config').length;
  clickEl('#saveSourceBtn');
  await sleep(30);
  t('配置未加载完：保存被拦截（复刻 srcFormReady）', () => {
    const r = document.querySelector('#feedResult');
    if (!r.classList.contains('err') || r.textContent.indexOf('设置尚未加载完成') < 0) throw new Error(r.className + '/' + r.textContent);
    if (postsTo('/api/config').length !== cfgPostsBefore) throw new Error('不应 POST');
  });
  releaseCfg({ ok: true, json: () => Promise.resolve({ username: 'tester', role: 'admin', llm: {}, digest: {}, source: Object.assign({}, miniSettingsSource) }) });
  await sleep(60);
  cfgHold = null;
  t('迟到配置到达后回填', () => { if (document.querySelector('#srcRefresh').value !== '30') throw new Error(document.querySelector('#srcRefresh').value); });
  setSel('#srcKeepDays', '90');
  clickEl('#saveSourceBtn');
  await sleep(80);
  t('保存采集参数：POST source 全字段 + ok 提示 + 重启自动刷新', () => {
    const body = lastPostBody('/api/config');
    if (body.source.refreshMinutes !== '30' || body.source.keepDays !== '90') throw new Error(JSON.stringify(body.source));
    if (body.source.proxyUrl !== 'socks5://127.0.0.1:1080') throw new Error('proxy: ' + body.source.proxyUrl);
    const r = document.querySelector('#feedResult');
    if (!r.classList.contains('ok') || r.textContent.indexOf('抓取设置已保存') < 0) throw new Error(r.className + '/' + r.textContent);
    const sch = callsOf('scheduleAutoRefresh');
    if (sch.length < 2) throw new Error('保存后应重启定时器');
  });

  // ---- 刷新全部（成功 / 有失败） ----
  clickEl('#refreshAllFeedsBtn');
  await sleep(80);
  t('刷新全部：POST + ok 结果 + 重拉', () => {
    if (!postsTo('/api/feeds/refresh').length) throw new Error('未 POST');
    const r = document.querySelector('#feedResult');
    if (!r.classList.contains('ok') || r.textContent.indexOf('抓取完成，新增 5 条') < 0) throw new Error(r.className + '/' + r.textContent);
  });
  refreshAllFailed = true;
  clickEl('#refreshAllFeedsBtn');
  await sleep(80);
  t('刷新全部（有失败频道）：err 态', () => {
    const r = document.querySelector('#feedResult');
    if (!r.classList.contains('err') || r.textContent.indexOf('1 个频道失败') < 0) throw new Error(r.className + '/' + r.textContent);
  });
  refreshAllFailed = false;

  // ---- 异常路径：列表拉取失败 / 空列表 ----
  clickTab('外观'); await sleep(40);
  feedsFailNext = true;
  clickTab('数据源'); await sleep(100);
  t('频道列表拉取失败：列表区提示', () => {
    const hint = document.querySelector('#feedList .hint');
    if (!hint || hint.textContent.indexOf('读取失败') < 0) throw new Error(hint && hint.textContent);
  });
  clickTab('外观'); await sleep(40);
  feedsEmptyNext = true;
  clickTab('数据源'); await sleep(100);
  t('空列表：引导文案 + 底部兜底', () => {
    const hint = document.querySelector('#feedList .hint');
    if (!hint || hint.textContent.indexOf('还没有订阅源') < 0) throw new Error(hint && hint.textContent);
    if (document.querySelector('#settingsHint').textContent.indexOf('添加一个 RSS 地址即可开始') < 0) throw new Error(document.querySelector('#settingsHint').textContent);
  });
  feedsEmptyNext = false;

  // ============ 模型面板（P2b React 化） ============
  clickTab('模型');
  await sleep(80);
  t('模型面板渲染', () => { if (!document.querySelector('#llmBaseUrl')) throw new Error('无 #llmBaseUrl'); });
  t('进入即拉 /api/prefs 回填', () => {
    if (!callsOf('apiFetch').some((c) => c[1] === '/api/prefs' && !c[2])) throw new Error('未 GET /api/prefs');
    if (document.querySelector('#llmBaseUrl').value !== 'https://api.siliconflow.cn/v1') throw new Error('baseUrl 未回填: ' + document.querySelector('#llmBaseUrl').value);
    if (document.querySelector('#llmModel').value !== 'Qwen/Qwen3-8B') throw new Error('model 未回填');
    if (document.querySelector('#llmTemp').value !== '0.3') throw new Error('temperature 未回填: ' + document.querySelector('#llmTemp').value);
  });
  t('未存 Key：输入框空+占位 sk- + 清除按钮隐藏', () => {
    if (document.querySelector('#llmApiKey').value !== '') throw new Error('Key 应留空');
    if (document.querySelector('#llmApiKey').placeholder !== 'sk-...') throw new Error('占位不符: ' + document.querySelector('#llmApiKey').placeholder);
    if (document.querySelector('#clearLlmKey').hidden !== true) throw new Error('清除按钮应隐藏');
    if (document.querySelector('#llmKeyHint').textContent.indexOf('尚未设置') < 0) throw new Error('hint: ' + document.querySelector('#llmKeyHint').textContent);
  });
  t('模型预设 datalist 5 项', () => { if (document.querySelectorAll('#modelPresets option').length !== 5) throw new Error('实际 ' + document.querySelectorAll('#modelPresets option').length); });
  t('温度输入为 number 0~1.5', () => { const el = document.querySelector('#llmTemp'); if (el.type !== 'number' || el.min !== '0' || el.max !== '1.5') throw new Error(el.type + '/' + el.min + '/' + el.max); });

  // 显示/隐藏 Key
  document.querySelector('#toggleLlmKey').click();
  await sleep(30);
  t('切换 Key 可见（text + 隐藏）', () => { if (document.querySelector('#llmApiKey').type !== 'text') throw new Error('未切 text'); if (document.querySelector('#toggleLlmKey').textContent !== '隐藏') throw new Error('按钮文案: ' + document.querySelector('#toggleLlmKey').textContent); });
  document.querySelector('#toggleLlmKey').click();
  await sleep(30);
  t('切回掩码（password + 显示）', () => { if (document.querySelector('#llmApiKey').type !== 'password') throw new Error('未切回'); });

  // 测试模型
  setInput('#llmBaseUrl', 'https://api.example.com/v1');
  setInput('#llmModel', 'deepseek-ai/DeepSeek-V3');
  setInput('#llmApiKey', 'sk-test123');
  await sleep(30);
  document.querySelector('#testLlmBtn').click();
  await sleep(60);
  t('测试模型：POST /api/digest/test-llm 带表单值', () => {
    if (!postsTo('/api/digest/test-llm').length) throw new Error('未 POST');
    const body = lastPostBody('/api/digest/test-llm');
    if (body.llm.baseUrl !== 'https://api.example.com/v1') throw new Error('baseUrl: ' + body.llm.baseUrl);
    if (body.llm.apiKey !== 'sk-test123') throw new Error('apiKey: ' + body.llm.apiKey);
    if (body.llm.model !== 'deepseek-ai/DeepSeek-V3') throw new Error('model: ' + body.llm.model);
  });
  t('测试 ok 态', () => { const r = document.querySelector('#llmResult'); if (!r || !r.classList.contains('ok')) throw new Error('类名: ' + (r && r.className)); if (r.textContent.indexOf('模型可用') < 0) throw new Error('文案: ' + r.textContent); });

  // 保存（带 Key）：temperature 数值化、apiKey 仅在填写时传
  setInput('#llmTemp', '0.4');
  await sleep(30);
  document.querySelector('#saveLlmBtn').click();
  await sleep(80);
  t('保存：POST /api/prefs（含 Key + 数值温度）', () => {
    if (!postsTo('/api/prefs').length) throw new Error('未 POST');
    const body = lastPostBody('/api/prefs');
    if (body.llm.apiKey !== 'sk-test123') throw new Error('apiKey 未传');
    if (body.llm.temperature !== 0.4 || typeof body.llm.temperature !== 'number') throw new Error('temperature 应数值化: ' + JSON.stringify(body.llm.temperature));
    if (body.llm.baseUrl !== 'https://api.example.com/v1') throw new Error('baseUrl 未传');
  });
  t('保存 ok + toast', () => {
    const r = document.querySelector('#llmResult');
    if (!r || !r.classList.contains('ok')) throw new Error('结果类名: ' + (r && r.className));
    if (r.textContent.indexOf('模型配置与 API Key 已保存') < 0) throw new Error('文案: ' + r.textContent);
    if (!callsOf('toast').length) throw new Error('toast 未调用');
  });
  t('保存后重拉：掩码态更新（set + hint + 清除可见 + Key 清空）', () => {
    if (document.querySelector('#llmApiKey').value !== '') throw new Error('Key 未清空');
    if (document.querySelector('#llmApiKey').type !== 'password') throw new Error('未回掩码态');
    if (document.querySelector('#llmApiKey').placeholder !== '已保存，留空则不修改') throw new Error('占位: ' + document.querySelector('#llmApiKey').placeholder);
    if (document.querySelector('#clearLlmKey').hidden !== false) throw new Error('清除按钮应可见');
    const hint = document.querySelector('#llmKeyHint');
    if (hint.textContent.indexOf('已保存') < 0 || !hint.querySelector('code')) throw new Error('hint 未显示掩码: ' + hint.textContent);
  });

  // 保存（不带 Key）：不传 apiKey 字段
  document.querySelector('#saveLlmBtn').click();
  await sleep(80);
  t('保存（Key 留空）：不传 apiKey 字段', () => {
    const body = lastPostBody('/api/prefs');
    if ('apiKey' in body.llm) throw new Error('不应传 apiKey');
    if (body.llm.temperature !== 0.4) throw new Error('temperature: ' + body.llm.temperature);
    if (document.querySelector('#llmResult').textContent.indexOf('模型配置已保存') < 0) throw new Error('文案: ' + document.querySelector('#llmResult').textContent);
  });

  // 清除 Key
  document.querySelector('#clearLlmKey').click();
  await sleep(80);
  t('清除 Key：POST clearApiKey 且 set 回落', () => {
    const body = lastPostBody('/api/prefs');
    if (body.llm.clearApiKey !== true) throw new Error('clearApiKey 未传');
    if (document.querySelector('#llmResult').textContent.indexOf('API Key 已清除') < 0) throw new Error('文案: ' + document.querySelector('#llmResult').textContent);
    if (document.querySelector('#clearLlmKey').hidden !== true) throw new Error('清除按钮应重新隐藏');
    if (document.querySelector('#llmApiKey').placeholder !== 'sk-...') throw new Error('占位未回落');
  });

  // 失败路径：POST !ok
  prefsPostOk = false;
  document.querySelector('#saveLlmBtn').click();
  await sleep(80);
  t('保存失败 err 态', () => { const r = document.querySelector('#llmResult'); if (!r.classList.contains('err')) throw new Error('类名: ' + r.className); if (r.textContent.indexOf('炸了') < 0) throw new Error('文案: ' + r.textContent); });
  prefsPostOk = true;

  // 切走再进：重新拉取（与旧 switchTab 行为一致）
  // GET 计数：进入 1 + 保存1重拉 1 + 保存2重拉 1 + 清除重拉 1 + 再进入 1 = 5
  clickTab('数据源'); await sleep(40); clickTab('模型'); await sleep(80);
  t('模型二次进入重新拉取', () => { if (callsOf('apiFetch').filter((c) => c[1] === '/api/prefs' && !c[2]).length !== 5) throw new Error('GET 次数=' + callsOf('apiFetch').filter((c) => c[1] === '/api/prefs' && !c[2]).length); });

  // ============ 外观面板 ============
  clickTab('外观');
  await sleep(60);
  t('外观面板渲染', () => { if (!document.querySelector('.appr')) throw new Error('无 .appr'); });
  t('分段控件总数 19', () => { if (document.querySelectorAll('.seg-btn').length !== 19) throw new Error('实际 ' + document.querySelectorAll('.seg-btn').length); });
  t('调板 6 色 + 预览 + 重置', () => {
    if (document.querySelectorAll('.swatch').length !== 6) throw new Error('swatch 数不符');
    if (!document.querySelector('.appr-preview-t')) throw new Error('无预览');
    if (!document.querySelector('#apprResetBtn')) throw new Error('无重置按钮');
  });
  t('选中态与偏好一致（auto/blue/m）', () => {
    const on = (sel) => document.querySelector(sel + '.active');
    if (!on('[data-theme-mode="auto"]')) throw new Error('auto 未选中');
    if (!on('.swatch[data-accent="blue"]')) throw new Error('blue 未选中');
    if (!on('[data-font-size="m"]')) throw new Error('m 未选中');
    if (document.querySelectorAll('.seg-btn.active').length !== 6) throw new Error('active seg-btn 应为 6，实际 ' + document.querySelectorAll('.seg-btn.active').length);
  });

  document.querySelector('[data-reader-width="full"]').click();
  await sleep(40);
  t('点阅读宽度 → setAppearance(readerWidth, full)', () => { const c = callsOf('setAppearance'); if (!c.length || c[c.length - 1][1] !== 'readerWidth' || c[c.length - 1][2] !== 'full') throw new Error(JSON.stringify(c)); });
  t('外部改动经事件回流（full 选中）', () => { if (!document.querySelector('[data-reader-width="full"].active')) throw new Error('full 未选中'); });

  document.querySelector('[data-reader-fs="l"]').click();
  await sleep(40);
  t('点正文字号 → setAppearance(readerFs, l)', () => { const c = callsOf('setAppearance'); if (!c.length || c[c.length - 1][1] !== 'readerFs' || c[c.length - 1][2] !== 'l') throw new Error(JSON.stringify(c)); });
  t('外部改动经事件回流（l 选中）', () => { if (!document.querySelector('[data-reader-fs="l"].active')) throw new Error('l 未选中'); });

  document.querySelector('[data-theme-mode="github"]').click();
  await sleep(40);
  t('点 GitHub 主题 → applyTheme(github, true)', () => { const c = callsOf('applyTheme'); if (!c.length || c[c.length - 1][1] !== 'github' || c[c.length - 1][2] !== true) throw new Error(JSON.stringify(c)); });

  await sleep(20);
  t('github 下调板禁用+hint 切换', () => {
    const sw = document.querySelector('#apprAccent');
    if (!sw.classList.contains('disabled')) throw new Error('未加 disabled');
    const hint = document.querySelector('.appr-label small');   // 主色调行的 small
    if (!hint || hint.textContent.indexOf('固定为 GitHub 蓝') < 0) throw new Error('hint 未切换: ' + (hint && hint.textContent));
    if (!document.querySelector('.swatch[aria-disabled="true"]')) throw new Error('swatch 未标 aria-disabled');
  });
  document.querySelector('.swatch[data-accent="teal"]').click();
  await sleep(40);
  t('github 下点调板不改 accent', () => { if (callsOf('setAppearance').some((c) => c[1] === 'accent')) throw new Error('accent 被修改'); });

  document.querySelector('[data-theme-mode="light"]').click();
  await sleep(40);
  t('浅色下调板恢复', () => { if (document.querySelector('#apprAccent').classList.contains('disabled')) throw new Error('仍禁用'); });

  document.querySelector('.swatch[data-accent="teal"]').click();
  await sleep(40);
  t('非 github 点调板生效', () => { const c = callsOf('setAppearance'); const last = c[c.length - 1]; if (last[1] !== 'accent' || last[2] !== 'teal') throw new Error(JSON.stringify(last)); if (!document.querySelector('.swatch[data-accent="teal"].active')) throw new Error('teal 未选中'); if (document.querySelector('.swatch[data-accent="blue"].active')) throw new Error('blue 仍选中'); });

  document.querySelector('#apprResetBtn').click();
  await sleep(40);
  t('恢复默认 → resetAppearance 且选中态回落', () => { if (!callsOf('resetAppearance').length) throw new Error('resetAppearance 未调用'); if (!document.querySelector('.swatch[data-accent="blue"].active')) throw new Error('未回落 blue'); if (!document.querySelector('[data-theme-mode="auto"].active')) throw new Error('未回落 auto'); });

  // ============ 关于面板 ============
  clickTab('关于');
  await sleep(80);
  t('关于面板渲染', () => { if (!document.querySelector('.about-body')) throw new Error('无 about-body'); });
  t('版本号拉取并显示', () => { const dd = document.querySelector('#aboutVersion'); if (dd.textContent !== 'v1.2.0') throw new Error('实际: ' + dd.textContent); if (!callsOf('apiFetch').some((c) => c[1] === '/api/version')) throw new Error('未请求 /api/version'); });
  clickTab('数据源'); await sleep(40); clickTab('关于'); await sleep(80);
  t('关于二次进入重新拉取', () => { if (callsOf('apiFetch').filter((c) => c[1] === '/api/version').length !== 2) throw new Error('fetch 次数=' + callsOf('apiFetch').filter((c) => c[1] === '/api/version').length); });

  document.querySelector('#aboutCheckBtn').click();
  await sleep(80);
  t('检查更新 POST 且 upd 态', () => {
    const c = callsOf('apiFetch').filter((x) => x[1] === '/api/version/check');
    if (!c.length || c[c.length - 1][2] !== 'POST') throw new Error('未 POST');
    const r = document.querySelector('.test-result');
    if (!r || !r.classList.contains('show') || !r.classList.contains('upd')) throw new Error('结果类名不符: ' + (r && r.className));
    if (r.textContent.indexOf('发现新版本') < 0 || r.textContent.indexOf('v1.3.0') < 0) throw new Error('文案: ' + r.textContent);
    const a = r.querySelector('a[href*="releases"]');
    if (!a) throw new Error('缺查看发布链接');
  });

  checkResponse = { ok: false, error: 'rate limited' };
  document.querySelector('#aboutCheckBtn').click();
  await sleep(80);
  t('检查失败 err 态', () => { const r = document.querySelector('.test-result'); if (!r.classList.contains('err')) throw new Error('类名: ' + r.className); if (r.textContent.indexOf('检测失败') < 0) throw new Error('文案: ' + r.textContent); });

  checkResponse = { ok: true, hasUpdate: false, current: '1.2.0' };
  document.querySelector('#aboutCheckBtn').click();
  await sleep(80);
  t('已是最新 ok 态', () => { const r = document.querySelector('.test-result'); if (!r.classList.contains('ok')) throw new Error('类名: ' + r.className); if (r.textContent.indexOf('已是最新版本') < 0) throw new Error('文案: ' + r.textContent); });

  // ---- 一键更新（v1.1.0）：仅管理员、upd 态出按钮 ----
  checkResponse = { ok: true, hasUpdate: true, current: '1.2.0', latest: '1.1.0', releaseUrl: 'https://github.com/chensnails/feedlore/releases/tag/v1.1.0' };
  document.querySelector('#aboutCheckBtn').click();
  await sleep(80);
  clickTab('数据源'); await sleep(40); clickTab('关于'); await sleep(80);
  document.querySelector('#aboutCheckBtn').click();
  await sleep(80);
  t('一键更新：upd 态出现按钮（管理员）', () => {
    if (!document.querySelector('#aboutUpdateBtn')) throw new Error('应有 #aboutUpdateBtn');
  });
  adminFlag = false;
  clickTab('数据源'); await sleep(40); clickTab('关于'); await sleep(80);
  document.querySelector('#aboutCheckBtn').click();
  await sleep(80);
  t('一键更新：非管理员无按钮', () => {
    if (document.querySelector('#aboutUpdateBtn')) throw new Error('非管理员不应出现按钮');
  });
  adminFlag = true;
  clickTab('数据源'); await sleep(40); clickTab('关于'); await sleep(80);
  document.querySelector('#aboutCheckBtn').click();
  await sleep(80);
  // 桩 confirm / location.reload / apiFetch（轮询到新版本即 reload）
  const confirmOrig = w.confirm; w.confirm = () => true;
  try { Object.defineProperty(w.location, 'reload', { value: () => {}, configurable: true }); } catch (_) {}
  const apiFetchFull2 = w.feedlore.apiFetch;
  const updateCalls = [];
  w.feedlore.apiFetch = (url, opts) => {
    if (url === '/api/update') { updateCalls.push(opts && opts.method); return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }); }
    if (url === '/api/version') return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '1.1.0' }) });
    return apiFetchFull2(url, opts);
  };
  document.querySelector('#aboutUpdateBtn').click();
  await sleep(40);
  t('一键更新：POST /api/update + 更新中提示', () => {
    if (!updateCalls.length || updateCalls[updateCalls.length - 1] !== 'POST') throw new Error('update 调用: ' + JSON.stringify(updateCalls));
    const tips = [...document.querySelectorAll('.test-result.upd')];
    if (!tips.some((r) => r.textContent.indexOf('正在更新') >= 0)) throw new Error('更新中提示缺失: ' + tips.map((r) => r.textContent.slice(0, 24)));
  });
  await sleep(5600);   // 等第一轮轮询（3s）→ 版本变化 → toast + reload
  t('一键更新完成：版本变化 toast', () => {
    if (!callsOf('toast').some((c) => typeof c[1] === 'string' && c[1].indexOf('已更新到 v1.1.0') >= 0)) {
      throw new Error('无完成 toast: ' + JSON.stringify(callsOf('toast').slice(-2)));
    }
  });
  w.confirm = confirmOrig;
  w.feedlore.apiFetch = apiFetchFull2;

  clickTab('数据源'); await sleep(40);
  const apiFetchFull = w.feedlore.apiFetch;   // 供关闭 / 角色过滤区恢复完整路由
  w.feedlore.apiFetch = (url) => {
    if (url === '/api/version') return Promise.reject(new Error('boom'));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(checkResponse) });
  };
  clickTab('关于'); await sleep(80);
  t('版本读取失败兜底', () => { if (document.querySelector('#aboutVersion').textContent !== '读取失败') throw new Error('实际: ' + document.querySelector('#aboutVersion').textContent); });
  w.feedlore.apiFetch = apiFetchFull;

  // 源码部署（无 Watchtower）：一键更新按钮不应出现，且应给出手动更新提示（Issue 修复）
  versionResponse = { ok: true, version: '1.2.0', updateEnabled: false };
  clickTab('数据源'); await sleep(40); clickTab('关于'); await sleep(80);
  document.querySelector('#aboutCheckBtn').click();
  await sleep(80);
  t('源码模式：无「一键更新」按钮 + 提示手动更新', () => {
    if (document.querySelector('#aboutUpdateBtn')) throw new Error('源码模式不应出现更新按钮');
    const note = document.querySelector('.about-note');
    if (!note || note.textContent.indexOf('未接入一键更新') < 0) throw new Error('缺少源码模式提示: ' + (note ? note.textContent : '无'));
  });
  versionResponse = { ok: true, version: '1.2.0', updateEnabled: true };

  // ============ 账号面板（P2d React 化） ============
  clickTab('账号');
  await sleep(80);
  t('账号面板渲染 + 登录信息回填', () => {
    if (!document.querySelector('.tab-pane[data-pane="account"]')) throw new Error('无账号面板');
    if (document.querySelector('#accUsername').value !== 'tester') throw new Error('用户名未回填: ' + document.querySelector('#accUsername').value);
    if (document.querySelector('#accCurrent').value !== '') throw new Error('当前密码应留空');
    if (document.querySelector('#accNew').value !== '') throw new Error('新密码应留空');
    const sub = document.querySelector('[data-sec="acc-login"] .sec-sub').textContent;
    if (sub !== '当前用户 tester') throw new Error('副标题: ' + sub);
  });
  t('管理员：用户管理区可见 + 拉取', () => {
    if (!document.querySelector('#accUsersSec')) throw new Error('用户管理区缺失');
    if (!countApi('/api/users')) throw new Error('未 GET /api/users');
  });
  t('用户行渲染（自我标记 / 角色徽章 / 操作按钮）', () => {
    const rows = document.querySelectorAll('#userList .user-row');
    if (rows.length !== 2) throw new Error('行数 ' + rows.length);
    const self = document.querySelector('#userList .user-row[data-id="1"]');
    if (!self.querySelector('.u-self')) throw new Error('自我标记缺失');
    if (self.querySelector('[data-act="del"]') || self.querySelector('[data-act="role"]')) throw new Error('自己不应有删除/改角色按钮');
    if (!self.querySelector('[data-act="pass"]')) throw new Error('应有改密码按钮');
    const alice = document.querySelector('#userList .user-row[data-id="2"]');
    if (!alice.querySelector('.u-badge.role-user')) throw new Error('alice 应为普通用户');
    if (!alice.querySelector('[data-act="del"]')) throw new Error('alice 应有删除按钮');
    if (document.querySelector('#accUsersSec .sec-sub').textContent !== '共 2 个') throw new Error('计数: ' + document.querySelector('#accUsersSec .sec-sub').textContent);
  });
  t('安装指引显示当前域名', () => { if (document.querySelector('#installHost').textContent !== 'localhost:3000') throw new Error(document.querySelector('#installHost').textContent); });

  // 条目过滤规则（v2.7.0）
  t('过滤规则区渲染：从 /api/prefs 回填', () => {
    const rows = document.querySelectorAll('[data-sec="acc-filters"] .filter-row');
    if (rows.length !== 2) throw new Error('行数 ' + rows.length);
    const r1 = rows[0], r2 = rows[1];
    if (r1.querySelector('.filter-act').value !== 'block') throw new Error('r1 act');
    if (r1.querySelector('.filter-field').value !== 'title') throw new Error('r1 field');
    if (r1.querySelector('.filter-kind').value !== 'kw') throw new Error('r1 kind');
    if (r1.querySelector('.filter-pattern').value !== '广告') throw new Error('r1 pattern');
    if (!r1.querySelector('.filter-on').checked) throw new Error('r1 应勾选');
    if (r2.querySelector('.filter-act').value !== 'allow') throw new Error('r2 act');
    if (r2.querySelector('.filter-kind').value !== 're') throw new Error('r2 kind');
    if (r2.querySelector('.filter-field').value !== 'desc') throw new Error('r2 field');
    const sub = document.querySelector('[data-sec="acc-filters"] .sec-sub').textContent;
    if (sub !== '2 条') throw new Error('sub: ' + sub);
  });
  // 添加一条规则（React 18：click 后 DOM 重绘在微任务，须移出 t() 再断言）
  document.querySelector('#addFilterBtn').click();
  await sleep(40);
  t('添加规则：行数 +1，默认屏蔽/标题/关键词', () => {
    const rows = document.querySelectorAll('[data-sec="acc-filters"] .filter-row');
    if (rows.length !== 3) throw new Error('行数 ' + rows.length);
    const r = rows[2];
    if (r.querySelector('.filter-act').value !== 'block') throw new Error('默认 act');
    if (r.querySelector('.filter-field').value !== 'title') throw new Error('默认 field');
    if (r.querySelector('.filter-kind').value !== 'kw') throw new Error('默认 kind');
    if (r.querySelector('.filter-pattern').value !== '') throw new Error('默认 pattern 应为空');
    if (!r.querySelector('.filter-on').checked) throw new Error('默认应启用');
  });
  // 改新行的动作/范围/方式/模式（受控更新同样需等微任务）
  setSelEl(document.querySelectorAll('[data-sec="acc-filters"] .filter-row')[2].querySelector('.filter-act'), 'allow');
  setSelEl(document.querySelectorAll('[data-sec="acc-filters"] .filter-row')[2].querySelector('.filter-field'), 'content');
  setSelEl(document.querySelectorAll('[data-sec="acc-filters"] .filter-row')[2].querySelector('.filter-kind'), 're');
  setVal(document.querySelectorAll('[data-sec="acc-filters"] .filter-row')[2].querySelector('.filter-pattern'), 'v\\d+');
  await sleep(40);
  t('改字段：动作/范围/方式/模式都走受控更新', () => {
    const r2 = document.querySelectorAll('[data-sec="acc-filters"] .filter-row')[2];
    if (r2.querySelector('.filter-act').value !== 'allow') throw new Error('act 未更新');
    if (r2.querySelector('.filter-field').value !== 'content') throw new Error('field 未更新');
    if (r2.querySelector('.filter-kind').value !== 're') throw new Error('kind 未更新');
    if (r2.querySelector('.filter-pattern').value !== 'v\\d+') throw new Error('pattern 未更新');
  });
  // 删掉第一条（f1 屏蔽「广告」）
  document.querySelector('[data-sec="acc-filters"] .filter-row .filter-del').click();
  await sleep(40);
  t('删除规则：行数 -1', () => {
    if (document.querySelectorAll('[data-sec="acc-filters"] .filter-row').length !== 2) throw new Error('删除后行数');
  });
  // 保存：提交剩余 2 条 → mock 按内容定位校验新规则
  document.querySelector('#saveFilterBtn').click();
  await sleep(80);
  t('保存：POST /api/prefs filters + toast + ok', () => {
    const body = lastPostBody('/api/prefs');
    if (!Array.isArray(body.filters) || body.filters.length !== 2) throw new Error('filters: ' + JSON.stringify(body.filters));
    const saved = body.filters.find((f) => f.pattern === 'v\\d+');
    if (!saved) throw new Error('未提交新规则: ' + JSON.stringify(body.filters));
    if (saved.act !== 'allow' || saved.field !== 'content' || saved.kind !== 're') throw new Error('保存内容: ' + JSON.stringify(saved));
    const res = document.querySelector('#filterResult');
    if (!res.classList.contains('ok') || res.textContent.indexOf('已保存') < 0) throw new Error(res.className + '/' + res.textContent);
    if (!callsOf('toast').length) throw new Error('toast 未调用');
  });
  // 再造一条空模式规则：保存时服务端（mock sanitize）会丢弃，回填差量提示
  document.querySelector('#addFilterBtn').click();
  await sleep(40);
  document.querySelector('#saveFilterBtn').click();
  await sleep(80);
  t('空模式被服务端丢弃：差量提示', () => {
    const body = lastPostBody('/api/prefs');
    if (!Array.isArray(body.filters) || body.filters.length !== 3) throw new Error('提交 3 条');
    // mock 的 sanitize 丢掉空模式 → 回填 2 条 → 提示差量
    const rows = document.querySelectorAll('[data-sec="acc-filters"] .filter-row');
    if (rows.length !== 2) throw new Error('回填后行数 ' + rows.length);
    const res = document.querySelector('#filterResult');
    if (res.textContent.indexOf('1 条为空或非法，已丢弃') < 0) throw new Error('差量提示: ' + res.textContent);
  });

  // 保存账号（改用户名 + 密码）
  setInput('#accUsername', 'tester2');
  setInput('#accCurrent', 'oldpass');
  setInput('#accNew', 'newpass1');
  await sleep(30);
  document.querySelector('#saveAccBtn').click();
  await sleep(80);
  t('保存账号：POST /api/account + ok + 清空密码 + 同步 state', () => {
    if (!postsTo('/api/account').length) throw new Error('未 POST');
    const body = lastPostBody('/api/account');
    if (body.currentPassword !== 'oldpass' || body.newPassword !== 'newpass1' || body.username !== 'tester2') throw new Error(JSON.stringify(body));
    const r = document.querySelector('#accResult');
    if (!r.classList.contains('ok') || r.textContent.indexOf('账号已更新') < 0) throw new Error(r.className + '/' + r.textContent);
    if (document.querySelector('#accCurrent').value !== '' || document.querySelector('#accNew').value !== '') throw new Error('密码未清空');
    if (w.feedlore.state.username !== 'tester2') throw new Error('state.username 未同步: ' + w.feedlore.state.username);
    if (!callsOf('toast').length) throw new Error('toast 未调用');
  });

  // 保存账号失败
  accountPostOk = false;
  document.querySelector('#saveAccBtn').click();
  await sleep(80);
  t('保存账号失败：err 提示', () => {
    const r = document.querySelector('#accResult');
    if (!r.classList.contains('err') || r.textContent.indexOf('当前密码不正确') < 0) throw new Error(r.className + '/' + r.textContent);
  });
  accountPostOk = true;

  // 添加用户
  setInput('#newUserName', 'bob');
  setInput('#newUserPass', 'bobpass');
  await sleep(30);
  document.querySelector('#addUserBtn').click();
  await sleep(80);
  t('添加用户：POST /api/users + ok + 表单清空 + 重拉列表', () => {
    if (!postsTo('/api/users').length) throw new Error('未 POST');
    const body = lastPostBody('/api/users');
    if (body.username !== 'bob' || body.password !== 'bobpass' || body.role !== 'user') throw new Error(JSON.stringify(body));
    const r = document.querySelector('#userResult');
    if (!r.classList.contains('ok') || r.textContent.indexOf('已创建用户 bob') < 0) throw new Error(r.className + '/' + r.textContent);
    if (document.querySelector('#newUserName').value !== '' || document.querySelector('#newUserPass').value !== '') throw new Error('表单未清空');
    if (document.querySelectorAll('#userList .user-row').length !== 3) throw new Error('未重拉列表');
  });

  // 添加用户校验：空用户名不发请求
  setInput('#newUserName', '');
  await sleep(30);
  const postsBefore = postsTo('/api/users').length;
  document.querySelector('#addUserBtn').click();
  await sleep(40);
  t('添加用户校验：空用户名不发请求 + err', () => {
    if (postsTo('/api/users').length !== postsBefore) throw new Error('不应 POST');
    const r = document.querySelector('#userResult');
    if (!r.classList.contains('err') || r.textContent.indexOf('请填写用户名') < 0) throw new Error(r.className + '/' + r.textContent);
  });

  // 改角色（alice → admin）
  document.querySelector('#userList .user-row[data-id="2"] [data-act="role"]').click();
  await sleep(80);
  t('改角色：PATCH /api/users/2 {role:admin}', () => {
    const p = patchesTo('/api/users/2');
    if (!p.length) throw new Error('未 PATCH');
    if (JSON.parse(p[p.length - 1][3]).role !== 'admin') throw new Error('body 不符');
    if (!document.querySelector('#userList .user-row[data-id="2"] .u-badge:not(.role-user)')) throw new Error('徽章未更新为管理员');
  });

  // 改密码（bob）
  promptValue = 'bobpass2';
  document.querySelector('#userList .user-row[data-id="102"] [data-act="pass"]').click();
  await sleep(80);
  t('改密码：prompt 取值 + PATCH password', () => {
    const p = patchesTo('/api/users/102');
    if (!p.length) throw new Error('未 PATCH');
    if (JSON.parse(p[p.length - 1][3]).password !== 'bobpass2') throw new Error('body: ' + p[p.length - 1][3]);
  });

  // 删除用户（alice）
  document.querySelector('#userList .user-row[data-id="2"] [data-act="del"]').click();
  await sleep(80);
  t('删除用户：DELETE + 列表刷新', () => {
    if (!deletesTo('/api/users/2').length) throw new Error('未 DELETE');
    if (document.querySelector('#userList .user-row[data-id="2"]')) throw new Error('用户仍在');
  });

  // 一键安装
  document.querySelector('.install-trigger').click();
  await sleep(40);
  t('一键安装：promptInstall=false → 提示手动安装', () => {
    if (!callsOf('promptInstall').length) throw new Error('未调用 promptInstall');
    const t0 = callsOf('toast');
    if (!t0.length || t0[t0.length - 1][1].indexOf('安装应用') < 0) throw new Error('toast: ' + JSON.stringify(t0[t0.length - 1] || null));
  });
  const toastN = callsOf('toast').length;
  promptInstallResult = true;
  document.querySelector('.install-trigger').click();
  await sleep(40);
  t('一键安装：promptInstall=true → 不再提示', () => { if (callsOf('toast').length !== toastN) throw new Error('不应新增 toast'); });
  promptInstallResult = false;

  // ============ 状态面板（P2d React 化） ============
  clickTab('状态');
  await sleep(120);
  t('状态面板渲染：健康条 + 四个分组 + 卡片', () => {
    if (!document.querySelector('.tab-pane[data-pane="status"]')) throw new Error('无状态面板');
    if (!countApi('/api/status')) throw new Error('未 GET /api/status');
    if (!document.querySelector('.stat-health')) throw new Error('无健康条');
    const secs = [...document.querySelectorAll('[data-pane="status"] details.sec')].map((d) => d.getAttribute('data-sec'));
    ['st-runtime', 'st-collect', 'st-problems', 'st-digest'].forEach((k) => { if (secs.indexOf(k) < 0) throw new Error('缺分组 ' + k); });
    if (document.querySelectorAll('[data-pane="status"] .stat-card').length !== 9) throw new Error('卡片数 ' + document.querySelectorAll('[data-pane="status"] .stat-card').length);
  });
  t('运行时长渲染（>1h 显示「小时」）', () => {
    const up = document.querySelector('#statUptime');
    if (!up || up.textContent.indexOf('小时') < 0) throw new Error('uptime: ' + (up && up.textContent));
  });
  t('健康文案与 warn 态', () => {
    const msg = document.querySelector('.stat-health-msg');
    if (msg.textContent !== '1 个频道抓取失败') throw new Error(msg.textContent);
    if (!msg.classList.contains('warn')) throw new Error('应 warn');
  });
  t('异常频道重试按钮', () => { if (!document.querySelector('[data-retry="2"]')) throw new Error('无重试按钮'); });
  t('数据库体积卡片（v2.5.0）', () => {
    const cards = [...document.querySelectorAll('[data-pane="status"] .stat-card')];
    const card = cards.find((c) => c.querySelector('.stat-label') && c.querySelector('.stat-label').textContent === '数据库体积');
    if (!card) throw new Error('无数据库体积卡片');
    const v = card.querySelector('.stat-value').textContent;
    if (v !== '50.0 MB') throw new Error('体积: ' + v);
  });
  t('自动停用徽标 + 重试并恢复文案（v2.5.0）', () => {
    const badge = document.querySelector('.stat-problem-off');
    if (!badge || badge.textContent.indexOf('已自动停用') < 0) throw new Error('无自动停用徽标');
    const btn = document.querySelector('[data-retry="2"]');
    if (btn.textContent.indexOf('重试并恢复') < 0) throw new Error('按钮: ' + btn.textContent);
  });
  t('自动停用计数与阈值行（v2.5.0）', () => {
    const warn = document.querySelector('.stat-warn');
    if (!warn || warn.textContent.indexOf('自动停用 1') < 0) throw new Error('无自动停用计数');
    const rows = [...document.querySelectorAll('[data-sec="st-collect"] .stat-row')];
    const row = rows.find((r) => r.querySelector('.stat-k') && r.querySelector('.stat-k').textContent === '自动停用');
    if (!row) throw new Error('无自动停用阈值行');
    if (row.textContent.indexOf('连续失败 ≥ 5 次') < 0) throw new Error('阈值: ' + row.textContent);
  });
  t('分组默认展开态（异常开、运行收）', () => {
    if (!document.querySelector('[data-sec="st-problems"]').open) throw new Error('异常分组应默认展开');
    if (document.querySelector('[data-sec="st-runtime"]').open) throw new Error('运行分组应默认收起');
  });
  t('bindSections 已绑定状态分组', () => { if (document.querySelector('[data-sec="st-collect"]').dataset.secBound !== '1') throw new Error('未绑定'); });

  // 异常频道重试
  document.querySelector('[data-retry="2"]').click();
  await sleep(120);
  t('重试：POST :id/refresh + toast + loadFeeds + 重拉状态', () => {
    if (!postsTo('/api/feeds/2/refresh').length) throw new Error('未 POST');
    if (!callsOf('loadFeeds').length) throw new Error('未 loadFeeds');
    const t0 = callsOf('toast');
    if (!t0.length || t0[t0.length - 1][1].indexOf('抓取成功') < 0) throw new Error('toast: ' + JSON.stringify(t0[t0.length - 1] || null));
  });

  // 复制诊断
  clipboardWrites.length = 0;
  document.querySelector('#statusCopyBtn').click();
  await sleep(80);
  t('复制诊断：写入剪贴板 + toast', () => {
    if (!clipboardWrites.length) throw new Error('未写剪贴板');
    const text = clipboardWrites[clipboardWrites.length - 1];
    if (text.indexOf('笺川（FeedLore）诊断信息') < 0 || text.indexOf('[RSS]') < 0 || text.indexOf('[数据库]') < 0) throw new Error('内容不符: ' + text.slice(0, 60));
    if (text.indexOf('数据库体积: 50.0 MB') < 0 || text.indexOf('自动停用阈值: 连续失败 5 次') < 0 || text.indexOf('上次结果: 新增 5 | 失败 1 | 自动停用 1') < 0) throw new Error('v2.5.0 诊断字段缺失: ' + text.slice(0, 400));
    const t0 = callsOf('toast');
    if (!t0.length || t0[t0.length - 1][1].indexOf('诊断信息已复制') < 0) throw new Error('toast 不符');
  });

  // 刷新按钮
  const stGetsBefore = countApi('/api/status');
  document.querySelector('#statusRefreshBtn').click();
  await sleep(80);
  t('刷新按钮：重新 GET /api/status', () => { if (countApi('/api/status') !== stGetsBefore + 1) throw new Error('GET ' + countApi('/api/status')); });

  // 状态读取失败
  clickTab('数据源'); await sleep(40);
  statusFailNext = true;
  clickTab('状态'); await sleep(120);
  t('状态读取失败：err 文案 + hint', () => {
    const err = document.querySelector('.stat-error');
    if (!err || err.textContent.indexOf('读取失败') < 0) throw new Error(err && err.textContent);
    if (document.querySelector('#statusHint').textContent.indexOf('读取失败') < 0) throw new Error('hint: ' + document.querySelector('#statusHint').textContent);
  });

  // ============ 关闭 / 角色过滤 ============
  clickTab('数据源'); await sleep(40);
  t('关闭前 source 为 React 面板', () => { if (!document.querySelector('.tab-pane[data-pane="source"]')) throw new Error('React 面板不在'); });
  document.querySelector('#settingsClose').click();
  await sleep(60);
  t('关闭按钮关闭', () => { if (mask().hidden !== true) throw new Error('未关闭'); if (w.__settingsOpen !== false) throw new Error('__settingsOpen 未同步'); });
  t('解锁滚动', () => { if (!callsOf('unlockPageScroll').length) throw new Error('unlockPageScroll 未调用'); });

  const cfgGetsBeforeUser = countApi('/api/config');
  adminFlag = false;
  w.__settingsHost.open('status');
  await sleep(80);
  t('普通用户 open(status) 回落 source', () => { if (!tabBtn('数据源').classList.contains('active')) throw new Error('未回落 source'); });
  t('普通用户无状态 tab', () => { if (tabBtn('状态')) throw new Error('状态 tab 仍渲染'); if (document.querySelectorAll('.tabs .tab').length !== 5) throw new Error('tab 数 ' + document.querySelectorAll('.tabs .tab').length); });
  t('普通用户：无采集参数区 + 保存按钮隐藏', () => {
    if (document.querySelector('[data-sec="src-params"]')) throw new Error('采集参数区不应渲染');
    if (document.querySelector('#saveSourceBtn').hidden !== true) throw new Error('保存按钮应隐藏');
  });
  t('普通用户：频道列表仍可见但不拉 /api/config', () => {
    if (!document.querySelectorAll('.feed-row').length) throw new Error('无频道行');
    if (countApi('/api/config') !== cfgGetsBeforeUser) throw new Error('不应 GET /api/config');
  });

  // 普通用户：账号面板无用户管理区、也不拉 /api/users
  const usersGetsBeforeUser = countApi('/api/users');
  clickTab('账号'); await sleep(60);
  t('普通用户：账号面板无用户管理且不拉 /api/users', () => {
    if (!document.querySelector('.tab-pane[data-pane="account"]')) throw new Error('无账号面板');
    if (document.querySelector('#accUsersSec')) throw new Error('不应渲染用户管理区');
    if (countApi('/api/users') !== usersGetsBeforeUser) throw new Error('不应 GET /api/users');
  });
  clickTab('数据源'); await sleep(40);

  w.__settingsHost.setAdminFlag(true);
  await sleep(80);
  t('setAdminFlag(true) 恢复 6 tab', () => { if (document.querySelectorAll('.tabs .tab').length !== 6) throw new Error('tab 数 ' + document.querySelectorAll('.tabs .tab').length); });
  t('恢复管理员：采集参数区出现并拉配置', () => {
    if (!document.querySelector('[data-sec="src-params"]')) throw new Error('采集参数区未出现');
    if (document.querySelector('#saveSourceBtn').hidden !== false) throw new Error('保存按钮应可见');
    if (countApi('/api/config') <= cfgGetsBeforeUser) throw new Error('应补拉 /api/config');
  });

  document.querySelector('.modal-mask').click();
  await sleep(60);
  t('点遮罩关闭', () => { if (mask().hidden !== true) throw new Error('未关闭'); });

  // ============ AI 视图（P3a React 化） ============
  adminFlag = true;
  w.feedlore.state.tab = 'ai';
  const aiEl = w.document.createElement('div');
  w.document.body.appendChild(aiEl);
  const aiRoot1 = __mountAi(aiEl);
  await sleep(80);
  w.dispatchEvent(new w.CustomEvent('__viewChanged', { detail: 'ai' }));
  await sleep(150);
  const Q = (sel) => aiEl.querySelector(sel);
  const QA = (sel) => [...aiEl.querySelectorAll(sel)];

  t('AI 视图渲染：导航 + 日报子页', () => {
    if (!Q('.ai-head')) throw new Error('无 ai-head');
    if (QA('#aiNav .ainav-btn').length !== 2) throw new Error('导航项数 ' + QA('#aiNav .ainav-btn').length);
    if (!Q('[data-ai-pane="digest"]')) throw new Error('无日报子页');
    if (!countApi('/api/digests')) throw new Error('未 GET /api/digests');
    if (!callsOf('apiFetch').some((c) => c[1].indexOf('/api/digest?') === 0)) throw new Error('未 GET /api/digest');
  });
  t('日报子页默认高亮 + 副标题含范围/频道数', () => {
    if (!Q('#aiNav .ainav-btn[data-ai="digest"]').classList.contains('active')) throw new Error('digest 未高亮');
    const sub = Q('#digestSub').textContent;
    if (sub.indexOf('把「采集」开启的频道过去') < 0) throw new Error('subtitle: ' + sub);
    if (sub.indexOf('个频道，采集开启') < 0) throw new Error('subtitle 频道数: ' + sub);
  });
  t('日期选择：今天置顶 + 历史日期', () => {
    const opts = QA('#digestDate option').map((o) => o.value);
    if (opts[0] !== todayStr()) throw new Error('首项应为今天: ' + opts[0]);
    if (opts.indexOf('2026-10-15') < 0) throw new Error('缺历史日期');
  });
  t('默认空态（今天无摘要）', () => {
    const e = Q('#digestBody .dg-empty');
    if (!e || e.textContent.indexOf(todayStr()) < 0) throw new Error('空态: ' + (e && e.textContent));
  });

  // 切换日期 → 有数据
  setSelEl(Q('#digestDate'), '2026-10-15');
  await sleep(120);
  t('切日期 → 渲染概览/元信息/亮点/条目', () => {
    const b = Q('#digestBody');
    if (!b.querySelector('.dg-overview') || b.querySelector('.dg-overview').textContent.indexOf('今日概览') < 0) throw new Error('无概览');
    if (!b.querySelector('.dg-hl')) throw new Error('无亮点');
    if (!b.querySelector('.dg-section-title')) throw new Error('无分组标题');
    if (b.querySelectorAll('.dg-item').length !== 1) throw new Error('条目数 ' + b.querySelectorAll('.dg-item').length);
    const meta = b.querySelector('.dg-meta').textContent;
    if (meta.indexOf('Qwen/Qwen3-8B') < 0 || meta.indexOf('精选 12 条') < 0) throw new Error('meta: ' + meta);
  });

  clipboardWrites.length = 0;
  Q('#digestBody .icon-btn').click();
  await sleep(60);
  t('条目复制按钮：写剪贴板 + toast', () => {
    if (!clipboardWrites.length) throw new Error('未写剪贴板');
    if (clipboardWrites[clipboardWrites.length - 1] !== 'https://example.com/x') throw new Error('复制内容: ' + clipboardWrites[clipboardWrites.length - 1]);
    const tn = callsOf('toast');
    if (!tn.length || tn[tn.length - 1][1].indexOf('已复制') < 0) throw new Error('toast: ' + JSON.stringify(tn[tn.length - 1] || null));
  });

  // 生成摘要
  Q('#genDigestBtn').click();
  await sleep(150);
  t('生成摘要：POST + toast + 渲染结果', () => {
    if (!postsTo('/api/digest/generate').length) throw new Error('未 POST');
    if (!Q('#digestBody .dg-overview')) throw new Error('未渲染生成结果');
    const tn = callsOf('toast');
    if (!tn.length || tn[tn.length - 1][1].indexOf('摘要生成完成') < 0) throw new Error('toast: ' + JSON.stringify(tn[tn.length - 1] || null));
  });
  t('生成后日期选项今天置顶', () => {
    const opts = QA('#digestDate option').map((o) => o.value);
    if (opts[0] !== todayStr()) throw new Error('今天未置顶: ' + opts[0]);
  });

  // 生成失败
  genFailNext = true;
  Q('#genDigestBtn').click();
  await sleep(150);
  t('生成失败：genError 文案 + 模型提示', () => {
    const err = Q('#digestBody .dg-error');
    if (!err || err.textContent.indexOf('生成失败') < 0) throw new Error(err && err.textContent);
    if (err.textContent.indexOf('检查模型地址') < 0) throw new Error('缺模型提示');
  });

  // 子页：日报设置
  Q('#aiNav .ainav-btn[data-ai="settings"]').click();
  await sleep(150);
  t('切到日报设置：拉配置 + 表单回填 + 持久化 aiPage', () => {
    if (!Q('[data-ai-pane="settings"]')) throw new Error('设置子页未渲染');
    if (Q('[data-ai-pane="digest"]')) throw new Error('日报子页应卸载');
    if (Q('#dgTime').value !== '08:00') throw new Error('time: ' + Q('#dgTime').value);
    if (Q('#dgEnabled').checked !== true) throw new Error('enabled 未回填');
    if (Q('#dgMode').value !== 'enabled') throw new Error('mode 未回填: ' + (Q('#dgMode') && Q('#dgMode').value));
    if (Q('#dgMaxPerFeed').value !== '20') throw new Error('maxPerFeed: ' + Q('#dgMaxPerFeed').value);
    if (!callsOf('setAiPage').some((c) => c[1] === 'settings')) throw new Error('未持久化 aiPage');
  });
  t('设置分组摘要行', () => {
    const autoSub = Q('[data-sec="dg-auto"] .sec-sub').textContent;
    if (autoSub !== '每天 08:00 · 仅「采集」开启的频道') throw new Error('autoSub: ' + autoSub);
    const limSub = Q('[data-sec="dg-limits"] .sec-sub').textContent;
    if (limSub.indexOf('每频道 20 条') < 0) throw new Error('limSub: ' + limSub);
  });

  // 修改并保存
  Q('#dgEnabled').click();
  setVal(Q('#dgMaxPerFeed'), '25');
  await sleep(40);
  Q('#saveDgBtn').click();
  await sleep(120);
  t('保存日报设置：POST /api/config digest + ok + toast', () => {
    const body = lastPostBody('/api/config');
    if (!body.digest) throw new Error('无 digest 段');
    if (body.digest.enabled !== false || body.digest.maxPerFeed !== '25') throw new Error('body: ' + JSON.stringify(body.digest));
    const r = Q('[data-ai-pane="settings"] .test-result');
    if (!r.classList.contains('ok') || r.textContent.indexOf('日报设置已保存') < 0) throw new Error(r.className + '/' + r.textContent);
    if (!callsOf('toast').some((c) => c[1] === '日报设置已保存')) throw new Error('无 toast');
  });
  t('保存后 hint 更新为已关闭', () => {
    if (Q('#dgHint').textContent.indexOf('自动生成已关闭') < 0) throw new Error('hint: ' + Q('#dgHint').textContent);
  });

  // 普通用户：无日报设置导航
  aiRoot1.unmount();
  await sleep(30);
  aiEl.innerHTML = '';
  adminFlag = false;
  w.feedlore.state.aiPage = 'digest';
  __mountAi(aiEl);
  await sleep(80);
  w.dispatchEvent(new w.CustomEvent('__viewChanged', { detail: 'ai' }));
  await sleep(140);
  t('普通用户：仅日报导航、无日报设置入口', () => {
    if (QA('#aiNav .ainav-btn').length !== 1) throw new Error('导航项 ' + QA('#aiNav .ainav-btn').length);
    if (Q('[data-ai="settings"]')) throw new Error('不应有日报设置入口');
    if (!Q('[data-ai-pane="digest"]')) throw new Error('无日报子页');
  });

  adminFlag = true;

  // ============ 卡片视图（P3b React 化） ============
  w.feedlore.state.tab = 'cards';
  w.feedlore.state.feedList = [
    { id: '1', title: '例子星球', customTitle: null, cardEnabled: true, enabled: true, entryCount: 12, groupName: '科技' },
    { id: '2', title: 'demo', customTitle: null, cardEnabled: true, enabled: true, entryCount: 4, groupName: '' },
  ];
  w.feedlore.state.feedMeta = { total: 2, enabled: 2, cardEnabled: 2 };
  w.feedlore.state.groupOrder = ['科技'];
  const cardsEl = w.document.createElement('div');
  w.document.body.appendChild(cardsEl);
  __mountCards(cardsEl);
  await cardsLoad(true);
  await sleep(60);
  const C = (sel) => cardsEl.querySelector(sel);
  const CA = (sel) => [...cardsEl.querySelectorAll(sel)];
  const cardIds = () => CA('#grid .card').map((el) => el.getAttribute('data-id'));

  t('卡片视图渲染：工具栏 + 卡片 + 标签栏', () => {
    if (!C('#searchInput')) throw new Error('无搜索框');
    if (!C('#feedSelect')) throw new Error('无频道下拉');
    if (C('#feedSelect .dd-label').textContent.indexOf('全部频道') < 0) throw new Error('频道触发器文案: ' + C('#feedSelect .dd-label').textContent);
    if (cardIds().join(',') !== 'e1,e2') throw new Error('卡片 ' + cardIds().join(','));
    if (CA('#tagBar .tag-chip').length !== 3) throw new Error('标签数 ' + CA('#tagBar .tag-chip').length);
    if (!C('#viewMode .viewmode-btn.active[data-mode="grid"]')) throw new Error('grid 未高亮');
  });

  // 频道下拉（v1.1.9 自定义弹层替代原生 select 的系统弹窗）
  C('#feedSelect').click();
  await sleep(20);
  t('频道下拉：自定义弹层 3 项 + 分组标题 + 选中勾', () => {
    if (CA('#feedDD .dd-item').length !== 3) throw new Error('频道选项 ' + CA('#feedDD .dd-item').length);
    if (CA('#feedDD .dd-group').length !== 1) throw new Error('分组标题 ' + CA('#feedDD .dd-group').length);
    if (!C('#feedDD .dd-item.active')) throw new Error('当前项未高亮');
  });
  CA('#feedDD .dd-item').find((el) => el.textContent.indexOf('例子星球') >= 0).click();
  await sleep(40);
  t('频道下拉：选中频道 → 带 feeds 重拉 + 触发器文案更新 + 弹层收起', () => {
    if (!callsOf('apiFetch').some((c) => c[1].indexOf('/api/entries?') === 0 && c[1].indexOf('feeds=') >= 0)) throw new Error('未带 feeds 重拉');
    if (C('#feedSelect .dd-label').textContent.indexOf('例子星球') < 0) throw new Error('触发器文案未更新: ' + C('#feedSelect .dd-label').textContent);
    if (C('#feedDD .dd-panel')) throw new Error('弹层未收起');
  });
  // 还原为「全部频道」，避免影响后续用例
  C('#feedSelect').click();
  await sleep(20);
  CA('#feedDD .dd-item')[0].click();
  await sleep(40);

  // 移动端（≤720px）：频道下拉改为底部弹窗（v1.1.10）
  const realMM = w.matchMedia;
  w.matchMedia = (q) => ({ matches: String(q).indexOf('max-width: 720px') >= 0, media: String(q),
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  C('#feedSelect').click();
  await sleep(20);
  t('频道下拉（移动端）：底部弹窗渲染（遮罩/标题栏/大选项）', () => {
    if (!C('#feedDD .dd-mask')) throw new Error('无遮罩');
    if (!C('#feedDD .dd-sheet')) throw new Error('无弹窗面板');
    if (!C('#feedDD .dd-sheet-head .dd-sheet-title')) throw new Error('无标题栏');
    if (CA('#feedDD .dd-sheet .dd-item').length !== 3) throw new Error('弹窗选项 ' + CA('#feedDD .dd-sheet .dd-item').length);
    if (!C('#feedDD .dd-sheet .dd-item.active')) throw new Error('当前项未高亮');
  });
  C('#feedDD .dd-sheet-close').click();
  await sleep(20);
  t('频道下拉（移动端）：点关闭收起弹窗', () => {
    if (C('#feedDD .dd-mask')) throw new Error('弹窗未收起');
  });
  w.matchMedia = realMM;
  t('卡片内容：标题 / 来源短名 / 体积 / 标签 / 日期', () => {
    const c1 = C('#grid .card[data-id="e1"]');
    if (c1.querySelector('.card-title').textContent !== '条目一') throw new Error('标题');
    if (c1.querySelector('.badge-source').textContent !== '例子星球') throw new Error('来源短名: ' + c1.querySelector('.badge-source').textContent);
    if (c1.querySelector('.badge-size').textContent !== '1.2G') throw new Error('体积');
    if (c1.querySelectorAll('.mini-tag').length !== 2) throw new Error('标签数');
    if (c1.querySelector('.badge-idx').textContent !== '2026-10-15') throw new Error('日期: ' + c1.querySelector('.badge-idx').textContent);
    if (!c1.querySelector('.card-media-actions a.btn-open[href]')) throw new Error('有原文地址应有打开按钮');
  });
  t('无图卡片状态类（只剩收藏，卡片页不再显示已读）', () => {
    const c2 = C('#grid .card[data-id="e2"]');
    if (!c2.classList.contains('is-fav')) throw new Error('缺 is-fav');
    if (c2.classList.contains('is-read') || c2.classList.contains('is-unread')) throw new Error('卡片页不该再带已读 / 未读态');
    if (!C('#grid .card[data-id="e1"]').querySelector('.title-btn')) throw new Error('标题应是可聚焦按钮');
    if (!c2.querySelector('.card-foot .btn-copy')) throw new Error('无图卡片复制按钮应在底部操作条');
    // v2.2.4：无原文地址不再渲染置灰「打开」按钮（曾被误读为「上锁」）
    if (c2.querySelector('.btn-open')) throw new Error('无原文地址不应渲染打开按钮');
  });

  // 卡片详情弹窗（桌面形态：居中模态）
  C('#grid .card[data-id="e1"] .card-desc').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  t('点卡片空白处 → 打开详情弹窗 + 拉正文 + 记为已读', () => {
    const dlg = C('.modal-mask [role="dialog"][aria-modal="true"]');
    if (!dlg) throw new Error('未弹出模态');
    if (dlg.getAttribute('aria-label') !== '条目一') throw new Error('弹窗缺可读名称：' + dlg.getAttribute('aria-label'));
    if (!callsOf('apiFetch').some((c) => c[1] === '/api/entries/e1')) throw new Error('未按 id 拉正文');
    if (!callsOf('cardsDetailRead').some((c) => c[1] === 'e1')) throw new Error('未记已读');
    if (C('.cd-meta') || C('.cd-pwd')) throw new Error('弹窗顶部不该再重复列频道 / 大小 / 日期 / 提取码');
    if (!C('.art-inner')) throw new Error('有正文时应渲染正文区');
    if (!C('.modal-close')) throw new Error('无关闭按钮');
  });
  t('弹窗只剩正文：标题栏与底栏都撤掉，四个动作并到正文底部一行', () => {
    if (C('.modal .modal-head')) throw new Error('标题栏没撤干净');
    if (C('.modal .cd-foot')) throw new Error('底栏没撤干净');
    if (CA('.modal .art-actions > *').length !== 4) throw new Error('动作行应有复制 / 打开 / 收藏 / 跳文章页四个：' + CA('.modal .art-actions > *').length);
    if (!C('.modal .art-actions .btn-copy') || !C('.modal .art-actions .btn-open')) throw new Error('复制 / 打开不在动作行里');
    if (!C('.modal .art-actions .btn-fav') || !C('.modal .art-actions .btn-jump')) throw new Error('收藏 / 在文章页查看没并进动作行');
    if (CA('.modal .art-actions .ico').length !== 4) throw new Error('动作行四个按钮都该是 SVG 图标');
    if (C('.modal .art-actions .btn-fav').textContent.trim()) throw new Error('纯图标按钮不该再带文字');
    if (C('.modal .art-actions .btn-jump').textContent.trim()) throw new Error('纯图标按钮不该再带文字');
  });
  C('.modal .art-actions .btn-fav').click();
  await sleep(40);
  t('动作行里的收藏按钮：切收藏态但不关弹窗', () => {
    if (!C('.modal .art-actions .btn-fav.is-fav')) throw new Error('未切到已收藏');
    if (!C('.modal-mask')) throw new Error('点收藏不该关闭弹窗');
  });
  C('.modal .art-actions .btn-fav').click();
  await sleep(40);
  t('再点一次取消收藏（回到初始态，不影响后续用例）', () => {
    if (C('.modal .art-actions .btn-fav.is-fav')) throw new Error('未取消收藏');
  });
  C('#grid .card[data-id="e1"] .btn-copy').click();
  await sleep(30);
  t('点卡内复制按钮不应再触发弹窗', () => {
    if (callsOf('cardsDetailRead').length !== 1) throw new Error('卡内按钮被劫持：' + callsOf('cardsDetailRead').length);
  });
  const detailGets = () => callsOf('apiFetch').filter((c) => c[1] === '/api/entries/e1').length;
  const getsBefore = detailGets();
  cardsTick();
  await sleep(40);
  t('列表重绘不应让弹窗重复拉正文 / 重复记已读', () => {
    if (detailGets() !== getsBefore) throw new Error('重复拉正文');
    if (callsOf('cardsDetailRead').length !== 1) throw new Error('重复记已读');
  });
  C('.modal .art-actions .btn-jump').click();
  await sleep(40);
  t('「在文章页查看」→ jumpToFeed(频道) 且弹窗关闭', () => {
    if (C('.modal-mask')) throw new Error('弹窗未关闭');
    if (!callsOf('jumpToFeed').some((c) => c[1] === '1')) throw new Error('未跳到该频道');
  });
  C('#grid .card[data-id="e2"] .title-btn').click();
  await sleep(60);
  t('无正文条目：正文区收起，只留摘要 / 链接动作', () => {
    if (!C('.modal-mask [role="dialog"]')) throw new Error('未弹出');
    if (C('.art-inner')) throw new Error('无正文时不应渲染正文区');
    if (!C('.cd-none')) throw new Error('无兜底区');
    if (!C('.cd-none .art-actions')) throw new Error('兜底区缺复制 / 打开动作');
    if (!C('.cd-none .art-actions .btn-fav') || !C('.cd-none .art-actions .btn-jump')) throw new Error('无正文时收藏 / 跳文章页也要在动作行里');
    if (C('.cd-foot') || C('.modal-head')) throw new Error('无正文分支也不该出现底栏 / 标题栏');
    if (C('.cd-meta') || C('.cd-pwd')) throw new Error('顶部信息条 / 提取码行不该再渲染');
  });
  document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(40);
  t('Esc 关闭详情弹窗', () => {
    if (C('.modal-mask')) throw new Error('未关闭');
  });

  // 摘要与正文同源（rss.js 里 desc 就是 content 压平换行），正文有文字时再列摘要等于同一段话摆两遍
  C('#grid .card[data-id="e1"] .title-btn').click();
  await sleep(60);
  t('正文有文字 → 不再另列摘要行', () => {
    if (C('.cd-desc')) throw new Error('正文已含文字，不该再列一行摘要');
    if (!C('.art-inner .art-text')) throw new Error('正文没渲染出来');
  });
  C('.modal-close').click();
  await sleep(40);
  detailBodyMode = 'images';
  C('#grid .card[data-id="e1"] .title-btn').click();
  await sleep(60);
  t('正文只有图片 → 摘要仍单独列一行（此时它是唯一的文字）', () => {
    if (!C('.cd-desc') || C('.cd-desc').textContent !== '描述一') throw new Error('纯图正文缺少摘要行');
    if (!C('.art-inner .art-img')) throw new Error('正文图没渲染');
  });
  C('.modal-close').click();
  await sleep(40);
  detailBodyMode = 'no-text';
  C('#grid .card[data-id="e1"] .title-btn').click();
  await sleep(60);
  t('老数据没有正文文字 → desc 只出现一次（当正文渲染，不再重复列摘要）', () => {
    if (C('.cd-desc')) throw new Error('回退路径已把 desc 当正文，不该再列摘要');
    const txt = C('.art-inner .art-text');
    if (!txt || txt.textContent !== '描述一') throw new Error('desc 未作为正文渲染：' + (txt ? txt.textContent : 'null'));
  });
  C('.modal-close').click();
  await sleep(40);
  detailBodyMode = 'text';

  // 移动端形态：同一组件切底部抽屉
  const realMM2 = w.matchMedia;
  w.matchMedia = (q) => ({ matches: /max-width:\s*720px/.test(q), addEventListener() {}, removeEventListener() {} });
  C('#grid .card[data-id="e1"] .title-btn').click();
  await sleep(60);
  t('移动端形态：详情用底部抽屉（.dd-mask / .dd-sheet）', () => {
    if (!C('.dd-mask .dd-sheet[role="dialog"]')) throw new Error('未弹出抽屉');
    if (C('.modal-mask')) throw new Error('移动端不应再用居中模态');
    if (!C('.dd-sheet-grip')) throw new Error('无抽屉手势条');
    if (C('.dd-sheet .dd-sheet-head') || C('.dd-sheet .cd-foot')) throw new Error('抽屉同样不再有标题栏 / 底栏');
    if (!C('.dd-sheet .art-actions .btn-fav') || !C('.dd-sheet .art-actions .btn-jump')) throw new Error('抽屉的动作行缺收藏 / 跳文章页');
  });
  C('.dd-sheet .cd-close').click();
  await sleep(40);
  t('移动端：抽屉关闭按钮收起弹窗', () => {
    if (C('.dd-mask')) throw new Error('未关闭');
  });
  w.matchMedia = realMM2;

  // 搜索（去抖）
  setVal(C('#searchInput'), '条目一');
  await sleep(520);
  t('搜索：去抖后带 q 重拉 + 过滤', () => {
    const hits = callsOf('apiFetch').filter((c) => c[1].indexOf('/api/entries?') === 0 && c[1].indexOf('q=') >= 0);
    if (!hits.length) throw new Error('未带 q 重拉');
    if (cardIds().join(',') !== 'e1') throw new Error('过滤后 ' + cardIds().join(','));
  });
  setVal(C('#searchInput'), '');
  await sleep(520);

  // 标签筛选
  CA('#tagBar .tag-chip').find((c) => c.getAttribute('data-tag') === '标签B').click();
  await sleep(40);
  t('标签筛选：仅含该标签的条目 + chip 高亮', () => {
    if (cardIds().join(',') !== 'e1') throw new Error('过滤后 ' + cardIds().join(','));
    const chip = CA('#tagBar .tag-chip').find((c) => c.getAttribute('data-tag') === '标签B');
    if (!chip.classList.contains('active')) throw new Error('chip 未高亮');
  });
  CA('#tagBar .tag-chip').find((c) => c.getAttribute('data-tag') === '').click();
  await sleep(40);

  // 视图切换
  C('#viewMode .viewmode-btn[data-mode="list"]').click();
  await sleep(40);
  t('列表视图切换：行渲染 + 按钮高亮', () => {
    if (!C('#grid').classList.contains('list-mode')) throw new Error('未 list-mode');
    if (CA('#grid .row-item').length !== 2) throw new Error('行数 ' + CA('#grid .row-item').length);
    if (!C('#viewMode .viewmode-btn.active[data-mode="list"]')) throw new Error('list 未高亮');
  });
  C('#viewMode .viewmode-btn[data-mode="grid"]').click();
  await sleep(40);

  // 复制（多条走菜单）
  clipboardWrites.length = 0;
  C('#grid .card[data-id="e1"] .btn-copy').click();
  await sleep(40);
  t('复制：多条走选择菜单 + 写入剪贴板 + toast', () => {
    const menu = callsOf('openLinkMenu');
    if (!menu.length || menu[menu.length - 1][1] !== 2) throw new Error('未弹菜单或条数不符: ' + JSON.stringify(menu.slice(-1)));
    if (clipboardWrites[clipboardWrites.length - 1] !== 'https://pan.baidu.com/s/xyz') throw new Error('复制内容: ' + clipboardWrites[clipboardWrites.length - 1]);
    if (!callsOf('toast').some((c) => String(c[1]).indexOf('已复制') >= 0)) throw new Error('无 toast');
  });

  // 收藏标记经桥（等价 app.js cardSetFlag → tick）
  await w.feedlore.cardsSetFlag('e2', { isFavorite: false });
  await sleep(40);
  t('收藏标记：改共享 state 后卡片取消 is-fav', () => {
    if (C('#grid .card[data-id="e2"]').classList.contains('is-fav')) throw new Error('仍标记收藏');
  });

  // 加载更多
  w.feedlore.state.hasMore = true; cardsTick();
  await sleep(30);
  t('加载更多按钮：hasMore 时显示', () => { if (C('#loadMoreBtn').hidden) throw new Error('应显示'); });

  // 骨架态
  w.feedlore.state.loading = true; w.feedlore.state.entries = []; cardsTick();
  await sleep(30);
  t('骨架态：首屏加载显示 8 个骨架卡', () => {
    if (!C('#skeleton')) throw new Error('无骨架');
    if (CA('#skeleton .sk-card').length !== 8) throw new Error('骨架数 ' + CA('#skeleton .sk-card').length);
  });
  w.feedlore.state.loading = false; w.feedlore.state.entries = miniEntriesAll(); cardsTick();
  await sleep(30);

  // 空态
  w.feedlore.state.feedList = []; w.feedlore.state.entries = []; cardsTick();
  await sleep(30);
  t('空态：无订阅源提示', () => {
    if (!C('#empty')) throw new Error('无空态');
    if (C('#empty').textContent.indexOf('还没有订阅源') < 0) throw new Error('文案: ' + C('#empty').textContent);
  });

  // ============ 阅读页（P3c React 化） ============
  adminFlag = true;
  w.feedlore.state.tab = 'reader';
  w.feedlore.state.feedList = [
    { id: '1', title: '例子星球', customTitle: null, cardEnabled: true, enabled: true, entryCount: 12, unreadCount: 3, groupName: '科技' },
    { id: '2', title: 'demo', customTitle: null, cardEnabled: true, enabled: true, entryCount: 4, unreadCount: 0, groupName: '' },
  ];
  w.feedlore.state.groupOrder = ['科技'];
  w.feedlore.state.rdFlags = { total: 2, unread: 1, favorite: 1 };
  const readerEl = w.document.createElement('div');
  w.document.body.appendChild(readerEl);
  __mountReader(readerEl);
  readerSetEntries(READER_ENTRIES());
  await sleep(60);
  const R = (sel) => readerEl.querySelector(sel);
  const RA = (sel) => [...readerEl.querySelectorAll(sel)];

  t('阅读页渲染：侧栏 + 头部 + 列表 + 条目', () => {
    if (!R('#readerChannels')) throw new Error('无频道侧栏');
    if (RA('#readerChannels .rd-ch').length !== 5) throw new Error('频道项 ' + RA('#readerChannels .rd-ch').length);
    if (RA('#readerChannels .rd-ch-group').length !== 2) throw new Error('分组行 ' + RA('#readerChannels .rd-ch-group').length);  // 科技 + 未分组
    if (!R('#readerChannels .rd-ch-sep')) throw new Error('无分隔');
    if (!R('#readerChannels .rd-ch-add')) throw new Error('无添加频道');
    if (RA('#readerList .art-item').length !== 2) throw new Error('条目 ' + RA('#readerList .art-item').length);
    if (R('#readerSideN').textContent !== '2 个') throw new Error('sideN: ' + R('#readerSideN').textContent);
  });
  t('标题与工具按钮显隐', () => {
    if (R('#readerTitle').textContent !== '全部文章') throw new Error('title: ' + R('#readerTitle').textContent);
    if (R('#readerAccLabel').textContent !== '单篇') throw new Error('accLabel: ' + R('#readerAccLabel').textContent);
    if (R('#readerReadAllBtn').hidden) throw new Error('有未读，应显示「全部已读」');
    if (!R('#readerCollapseAll').hidden) throw new Error('未展开时「全部收起」应隐藏');
  });
  t('列表项内容与状态类', () => {
    const it1 = R('#readerList .art-item[data-id="r1"]');
    if (!it1.classList.contains('is-unread')) throw new Error('r1 应未读');
    if (it1.querySelector('.art-title').textContent !== '文章一') throw new Error('标题');
    if (it1.querySelector('.src-pill').textContent !== '例子星球') throw new Error('来源短名: ' + it1.querySelector('.src-pill').textContent);
    const it2 = R('#readerList .art-item[data-id="r2"]');
    if (!it2.classList.contains('is-read') || !it2.classList.contains('is-fav')) throw new Error('r2 状态类不符');
  });

  // 展开 → 正文
  R('#readerList .art-item[data-id="r1"] .art-head').click();
  await sleep(40);
  t('展开：readerToggleArt + 正文段落/标签/操作', () => {
    if (!callsOf('readerToggleArt').some((c) => c[1] === 'r1')) throw new Error('未调用 readerToggleArt');
    const it1 = R('#readerList .art-item[data-id="r1"]');
    if (!it1.classList.contains('open')) throw new Error('未加 open');
    const body = it1.querySelector('.art-body');
    if (body.hidden) throw new Error('正文应显示');
    if (!body.querySelector('.art-inner')) throw new Error('无 art-inner');
    if (body.querySelectorAll('.art-text p').length !== 2) throw new Error('段落数 ' + body.querySelectorAll('.art-text p').length);
    if (!body.querySelector('.art-tags .mini-tag')) throw new Error('无标签');
    if (!body.querySelector('.art-actions .btn-open')) throw new Error('无打开按钮');
    if (!body.querySelector('.art-actions .btn-copy')) throw new Error('无复制按钮');
  });
  t('展开后「全部收起」出现', () => { if (R('#readerCollapseAll').hidden) throw new Error('应显示'); });

  // 正文标签 → 卡片筛选
  R('#readerList .art-item[data-id="r1"] .art-tags .mini-tag').click();
  await sleep(30);
  t('正文标签 → readerTagToCards', () => {
    if (!callsOf('readerTagToCards').some((c) => c[1] === '标签A')) throw new Error('未触发');
  });

  // 收藏
  R('#readerList .art-item[data-id="r1"] .art-star').click();
  await sleep(30);
  t('收藏按钮 → readerToggleFav + 卡片加 is-fav', () => {
    if (!callsOf('readerToggleFav').some((c) => c[1] === 'r1')) throw new Error('未触发');
    if (!R('#readerList .art-item[data-id="r1"]').classList.contains('is-fav')) throw new Error('未标记收藏');
  });

  // 收起
  R('#readerList .art-item[data-id="r1"] .art-head').click();
  await sleep(30);
  t('再点收起：open 移除 + 正文隐藏', () => {
    const it1 = R('#readerList .art-item[data-id="r1"]');
    if (it1.classList.contains('open')) throw new Error('仍 open');
    if (!it1.querySelector('.art-body').hidden) throw new Error('正文应隐藏');
  });

  // 范围切换
  RA('#readerChannels .rd-ch')[1].click();
  await sleep(30);
  t('范围切换 → readerSetScope(unread) + 高亮', () => {
    if (!callsOf('readerSetScope').some((c) => c[1] === 'unread')) throw new Error('未触发');
    if (!RA('#readerChannels .rd-ch')[1].classList.contains('active')) throw new Error('未高亮');
  });

  // 频道切换
  RA('#readerChannels .rd-ch')[3].click();
  await sleep(30);
  t('频道切换 → readerSetFeed + 标题更新', () => {
    if (!callsOf('readerSetFeed').length) throw new Error('未触发');
    if (R('#readerTitle').textContent !== '例子星球') throw new Error('title: ' + R('#readerTitle').textContent);
  });

  // 搜索（去抖）
  setVal(R('#readerSearch'), '关键词');
  await sleep(360);
  t('搜索：去抖后 readerSearch(q)', () => {
    if (!callsOf('readerSearch').some((c) => c[1] === '关键词')) throw new Error('未触发: ' + JSON.stringify(callsOf('readerSearch')));
  });
  t('搜索清除按钮出现（q 生效后）', () => { if (R('#readerSearchClear').hidden) throw new Error('应显示'); });
  R('#readerSearchClear').click();
  await sleep(40);
  t('清除 → readerSearch("")', () => { if (!callsOf('readerSearch').some((c) => c[1] === '')) throw new Error('未触发'); });

  // 空态（未读）
  w.feedlore.state.rdScope = 'unread'; w.feedlore.state.rdFeedId = null; w.feedlore.state.rdGroup = null;
  w.feedlore.state.rdQ = '';
  readerSetEntries([]);
  await sleep(30);
  t('空态文案（未读）', () => {
    if (R('#readerEmpty').hidden) throw new Error('空态应显示');
    if (R('#readerEmpty').textContent.indexOf('没有未读文章了') < 0) throw new Error(R('#readerEmpty').textContent);
  });
  // 空态（读取失败）
  w.feedlore.state.rdReadError = true; w.feedlore.state.rdReadErrorMsg = '加载失败：HTTP 500';
  readerSetEntries([]);
  await sleep(30);
  t('空态文案（读取失败）', () => {
    if (R('#readerEmpty').textContent.indexOf('加载失败：HTTP 500') < 0) throw new Error(R('#readerEmpty').textContent);
  });
  w.feedlore.state.rdReadError = false;

  // ============ App Shell 顶栏（P4a React 化） ============
  __mountTopBar(document.getElementById('topbarRoot'));
  await sleep(40);
  const S = (sel) => document.querySelector(sel);
  const navBtns = () => [...document.querySelectorAll('#viewNav .viewnav-btn')];

  t('顶栏渲染：品牌 / 三个导航 / 统计 / 按钮', () => {
    if (!S('#topbarRoot .topbar-inner')) throw new Error('无 .topbar-inner');
    if (!S('#topbarRoot .brand-logo')) throw new Error('无 logo');
    if (navBtns().length !== 3) throw new Error('导航按钮 ' + navBtns().length);
    if (S('#statCount').textContent !== '12') throw new Error('statCount: ' + S('#statCount').textContent);
    if (S('#subtitle').textContent !== '拾取值得读的 · 采集 2/3 个频道') throw new Error('subtitle: ' + S('#subtitle').textContent);
    for (const id of ['refreshBtn', 'themeBtn', 'settingsBtn']) if (!S('#' + id)) throw new Error('缺 #' + id);
  });
  t('导航高亮跟随 view（reader）', () => {
    const a = navBtns().filter((b) => b.classList.contains('active')).map((b) => b.getAttribute('data-view'));
    if (a.join() !== 'reader') throw new Error('active: ' + a.join());
  });
  t('reader 视图下「条资源」隐藏', () => { if (S('#stat').hidden !== true) throw new Error('应隐藏'); });

  navBtns()[1].click();
  await sleep(20);
  t('点「卡片」→ switchView(cards)', () => {
    if (!callsOf('switchView').some((c) => c[1] === 'cards')) throw new Error('未触发');
  });
  t('切卡片后：卡片高亮 + 条资源可见', () => {
    if (!navBtns()[1].classList.contains('active')) throw new Error('卡片未高亮');
    if (S('#stat').hidden) throw new Error('stat 应可见');
  });

  shellSnap.themeLabel = 'GitHub 暗黑';
  shellSnap.themeIco = 'github';
  shellTick();
  await sleep(20);
  t('主题按钮随快照更新（图标 / title）', () => {
    const use = S('#themeIco use');
    if (use.getAttribute('href') !== '#i-github') throw new Error('href: ' + use.getAttribute('href'));
    if (S('#themeBtn').title.indexOf('GitHub 暗黑') < 0) throw new Error('title: ' + S('#themeBtn').title);
  });
  S('#themeBtn').click();
  await sleep(10);
  t('点主题 → cycleTheme', () => { if (!callsOf('cycleTheme').length) throw new Error('未触发'); });

  S('#settingsBtn').click();
  await sleep(10);
  t('点设置 → openSettings', () => { if (!callsOf('openSettings').length) throw new Error('未触发'); });

  // 刷新忙态（refresh 返回挂起的 Promise）
  let resolveRefresh;
  refreshDeferred = new Promise((r) => { resolveRefresh = r; });
  S('#refreshBtn').click();
  await sleep(20);
  t('刷新中：按钮禁用 + 图标自旋', () => {
    if (!callsOf('refresh').length) throw new Error('未触发 refresh');
    if (S('#refreshBtn').disabled !== true) throw new Error('按钮未禁用');
    if (!S('#refreshBtn .ico').classList.contains('spin')) throw new Error('未自旋');
  });
  resolveRefresh();
  refreshDeferred = null;
  await sleep(30);
  t('刷新完成：恢复可点', () => {
    if (S('#refreshBtn').disabled) throw new Error('仍禁用');
    if (S('#refreshBtn .ico').classList.contains('spin')) throw new Error('仍自旋');
  });

  // ============ 覆盖层：toast / 新内容浮标 / 灯箱（v2.1.0 React 化） ============
  __mountOverlays(document.getElementById('overlaysRoot'));
  await sleep(30);
  const O = (sel) => document.querySelector('#overlaysRoot ' + sel);

  t('toast：初始为空且不显示', () => {
    const el = O('.toast');
    if (!el) throw new Error('无 .toast');
    if (el.className !== 'toast') throw new Error('class: ' + el.className);
  });
  overlayState.toast = { msg: '订阅已添加', ok: true, show: true };
  overlaysTick();
  await sleep(20);
  t('toast：show + ok + 文案', () => {
    const el = O('.toast');
    if (el.className !== 'toast show ok') throw new Error('class: ' + el.className);
    if (el.textContent !== '订阅已添加') throw new Error('text: ' + el.textContent);
  });
  overlayState.toast = { msg: '操作失败', ok: false, show: true };
  overlaysTick();
  await sleep(20);
  t('toast：失败态无 .ok', () => {
    const el = O('.toast');
    if (el.className !== 'toast show') throw new Error('class: ' + el.className);
  });

  t('浮标：默认隐藏', () => { if (!O('.new-pill') || O('.new-pill').hidden !== true) throw new Error('应隐藏'); });
  overlayState.pill = { show: true, text: '3 条新内容' };
  overlaysTick();
  await sleep(20);
  t('浮标：显示 + 文案', () => {
    const el = O('.new-pill');
    if (el.hidden) throw new Error('应显示');
    if (el.textContent.indexOf('3 条新内容') < 0) throw new Error(el.textContent);
  });
  O('.new-pill').click();
  await sleep(10);
  t('点浮标 → applyPendingFresh', () => {
    if (!callsOf('applyPendingFresh').length) throw new Error('未触发');
  });

  t('灯箱：默认不渲染', () => { if (O('.lightbox')) throw new Error('不应存在'); });
  overlayState.box = { src: 'https://example.com/a.png', show: true };
  overlaysTick();
  await sleep(20);
  t('灯箱：显示 + 图片 src', () => {
    const el = O('.lightbox');
    if (!el) throw new Error('无 .lightbox');
    if (el.getAttribute('role') !== 'dialog') throw new Error('role 不对');
    const img = O('.lightbox-img');
    if (!img || img.getAttribute('src') !== 'https://example.com/a.png') throw new Error('src 不对');
    if (!O('.lightbox-hint')) throw new Error('无提示');
  });
  O('.lightbox').click();
  await sleep(10);
  t('点灯箱 → closeLightbox', () => {
    if (!callsOf('closeLightbox').length) throw new Error('未触发');
  });

  // ============ 冒烟：真实核心模块（src/core/index.js）顶层加载无异常 ============
  // 背景：v1.9.0 曾因桥里引用了不存在的标识符，顶层抛 ReferenceError → 整页 JS 中断
  // （node --check 查不出）。本用例在 jsdom 里真实执行核心模块的顶层代码 + init()。
  {
    const vc2 = new VirtualConsole();
    const errs = [];
    vc2.on('jsdomError', (e) => {
      const d = e.detail;
      const m = d ? (d.message || String(d)) : e.message;
      if (!/Not implemented: Window's scrollTo/.test(m)) errs.push(m);
    });
    let smokeHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
    const coreIife = fs.readFileSync(path.join(__dirname, '.build', 'core-iife.js'), 'utf8')
      .replace(/<\/script/gi, '<\\/script');
    smokeHtml = smokeHtml.replace(/<script type="module"[^>]*><\/script>/, () => '<script>' + coreIife + '</script>');
    const dom2 = new JSDOM(smokeHtml, {
      url: 'http://localhost:3000/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: vc2,
      beforeParse(win) {
        win.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ authenticated: true, username: 'tester', role: 'admin' }) });
        win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
        win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
        win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      },
    });
    const sw = dom2.window;
    await sleep(80);
    t('冒烟：核心模块顶层加载无异常 + core 已导出', () => {
      if (errs.length) throw new Error(errs[0]);
      if (!sw.__coreForTest) throw new Error('core 未导出');
    });
    t('冒烟：core 的视图 / 卡片 / AI / 外壳接口齐全', () => {
      const c2 = sw.__coreForTest;
      const need = [
        'state', 'switchView', 'loadFeeds', 'loadPage', 'refresh', 'cycleTheme', 'getShell',
        'readerSetScope', 'readerSetFeed', 'readerSetGroup', 'readerOpenSource', 'readerSearch',
        'readerToggleArt', 'readerCollapseAll', 'readerReadAll', 'readerToggleFav', 'readerTagToCards',
        'readerToggleAccordion', 'readerAccordionOn', 'readerToggleDrawer', 'readerCloseDrawer', 'fmtFull',
        'cardsSearch', 'cardsFilterFeed', 'cardsSort', 'cardsView', 'cardsTag',
        'cardsLoadMore', 'cardsSetFlag', 'cardsDetailRead', 'filterEntries', 'getAiPage', 'setAiPage', 'promptInstall',
        'openSettings', 'toast', 'apiFetch', 'isAdmin', 'exportOpml', 'bindSections', 'groupFeeds',
        'getToastState', 'getNewPillState', 'getLightboxState', 'applyPendingFresh',
        'closeLightbox',
      ];
      for (const k of need) if (c2[k] === undefined) throw new Error('core 缺 ' + k);
    });
    sw.close();
  }

  let fail = 0;
  results.forEach(([s, n]) => { if (s === 'FAIL') fail++; console.log(s, n); });
  console.log(`\n共 ${results.length} 项，通过 ${results.length - fail}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
