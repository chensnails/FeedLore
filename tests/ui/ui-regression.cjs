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
const appearance = { theme: 'auto', accent: 'blue', fontSize: 'm', density: 'cozy', readerFont: 'sans', readerLh: 'm', readerFs: 'm', readerWidth: 'm' };
const fireAppearanceChanged = () => w.dispatchEvent(new w.Event('__appearanceChanged'));

let adminFlag = true;
let versionResponse = { ok: true, version: '1.2.0', updateEnabled: true };
let checkResponse = { ok: true, hasUpdate: true, current: '1.2.0', latest: '1.3.0', releaseUrl: 'https://github.com/chensnails/feedlore/releases/tag/v1.3.0' };

// 模型面板的可变响应（复刻 /api/prefs GET 的 llm 视图字段：不回填明文，只给 set + 掩码）
let prefsLlm = { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-8B', temperature: 0.3, thinking: false, thinkingDepth: 'medium', apiKeySet: false, apiKeyHint: '' };
let prefsPostOk = true;
// 日报：账号级开关（layout.digestEnabled）+ 整组按账号配置（prefs.digest）
let prefsDigestEnabled = true;
const DIGEST_CFG_DEFAULT = {
  auto: false, time: '08:00', mode: 'enabled', feeds: [],
  maxPerFeed: 20, maxTotal: 150, keepDays: 30, style: '', lastAuto: '',
};
let prefsDigest = Object.assign({}, DIGEST_CFG_DEFAULT);

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
  installReady: false, statVisible: false, digestVisible: true,
};
let refreshDeferred = null;   // 非空时 refresh() 返回它（测忙态）
/* ---- 覆盖层（toast / 新内容浮标 / 灯箱，v2.1.0 React 化）测试可控状态 ---- */
let overlayState = {
  toast: { msg: '', ok: true, show: false },
  pill: { show: false, text: '' },
  box: { src: '', show: false },
  confirm: { open: false, title: '', desc: '', confirmText: '确定', cancelText: '取消', danger: false, input: null },
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
    autoUsers: 2, totalUsers: 5, nextRunAt: Date.now() + 86400000,
    latest: { date: '2026-10-16', fallback: false, model: 'Qwen/Qwen3-8B', stats: { collected: 20, kept: 12, feeds: 3 } },
    oldestDate: '2026-10-01', count: 5,
  },
});

/* ---------- AI 视图（P3a）测试可控状态 ---------- */
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
      return ok({
        llm: prefsLlm, groupOrder: miniGroupOrder.slice(), appearance: {}, filters: miniFilters.slice(),
        layout: { digestEnabled: prefsDigestEnabled }, digest: Object.assign({}, prefsDigest),
      });
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
        // 与 lib/llm.js sanitizeUserLlm 同口径：思考只认严格布尔 / 三档白名单
        if (typeof body.llm.thinking === 'boolean') patch.thinking = body.llm.thinking;
        if (['low', 'medium', 'high'].indexOf(body.llm.thinkingDepth) >= 0) patch.thinkingDepth = body.llm.thinkingDepth;
        if (body.llm.clearApiKey) { patch.apiKeySet = false; patch.apiKeyHint = ''; }
        else if (body.llm.apiKey) { patch.apiKeySet = true; patch.apiKeyHint = 'sk-…abcd'; }
        prefsLlm = patch;
      }
      // 日报整组：服务端 lib/prefs.js sanitizeDigest 的口径（白名单 + clamp + lastAuto 由服务端独占）
      if (body && body.digest && typeof body.digest === 'object') {
        const d = body.digest;
        const merged = Object.assign({}, prefsDigest, d);
        prefsDigest = {
          auto: merged.auto === true,
          time: /^\d{2}:\d{2}$/.test(String(merged.time)) && merged.time < '24:00' ? String(merged.time) : DIGEST_CFG_DEFAULT.time,
          mode: ['enabled', 'all', 'custom'].indexOf(merged.mode) >= 0 ? merged.mode : 'enabled',
          feeds: Array.isArray(merged.feeds) ? merged.feeds.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [],
          maxPerFeed: clampInt(merged.maxPerFeed, 20, 1, 100),
          maxTotal: clampInt(merged.maxTotal, 150, 10, 500),
          keepDays: clampInt(merged.keepDays, 30, 1, 365),
          style: typeof merged.style === 'string' ? merged.style.trim().slice(0, 2000) : '',
          lastAuto: prefsDigest.lastAuto,   // 客户端提交一律不影响
        };
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
      return ok({ ok: true, groupOrder: miniGroupOrder.slice(), appearance: {}, layout: {}, filters: miniFilters.slice(), digest: Object.assign({}, prefsDigest) });
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
      // 站点级只剩采集参数：模型与日报都改走 /api/prefs（账号级）
      return ok({ username: 'tester', role: 'admin', source: Object.assign({}, miniSettingsSource) });
    }
    if (url === '/api/config' && method === 'POST') {
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
    entries: [], tags: [], q: '', feedFilter: null, sort: 'new', size: 'all', view: 'grid', tab: 'reader',
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
  // 日报开关：与 core/reader.js 同口径——写偏好 + 刷顶栏快照；关掉时正停在日报页要弹回文章页
  digestIsEnabled: () => shellSnap.digestVisible !== false,
  setDigestEnabled: (on) => {
    calls.push(['setDigestEnabled', on]);
    const next = on !== false;
    shellSnap.digestVisible = next;
    if (!next && shellSnap.view === 'ai') shellSnap.view = 'reader';
    shellTick();
  },
  refresh: () => { calls.push(['refresh']); return refreshDeferred || Promise.resolve(); },
  // —— v2.1.0：覆盖层（组件见 src/ui/Overlays.jsx） ——
  getToastState: () => Object.assign({}, overlayState.toast),
  getNewPillState: () => Object.assign({}, overlayState.pill),
  getLightboxState: () => Object.assign({}, overlayState.box),
  // v1.3.8-test2：统一确认框（组件在 Overlays，设置面板只 await 结果）
  getConfirmState: () => Object.assign({}, overlayState.confirm),
  confirm: (opts) => { calls.push(['confirm', opts]); return Promise.resolve(opts && opts.input ? promptValue : true); },
  settleConfirm: (ok, v) => { calls.push(['settleConfirm', ok, v]); overlayState.confirm = Object.assign({}, overlayState.confirm, { open: false }); overlaysTick(); },
  cancelConfirm: () => { calls.push(['cancelConfirm']); overlayState.confirm = Object.assign({}, overlayState.confirm, { open: false }); overlaysTick(); },
  applyPendingFresh: () => { calls.push(['applyPendingFresh']); },
  closeLightbox: () => { calls.push(['closeLightbox']); overlayState.box = { src: '', show: false }; overlaysTick(); },
  stepLightbox: (d) => { calls.push(['stepLightbox', d]); },
  cycleTheme: () => calls.push(['cycleTheme']),
  openSettings: (t) => { calls.push(['openSettings', t]); },
  // v1.7.0：AI 视图桥（P3a；v1.4.0 起子页导航随「日报设置」一起删除）
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
  // 窄屏频道抽屉（v1.3.10）：与真实 core 一样，状态落在 body 的类上
  cardsToggleDrawer: () => {
    const on = !w.document.body.classList.contains('cards-drawer-open');
    w.document.body.classList.toggle('cards-drawer-open', on);
    calls.push(['cardsToggleDrawer', on]);
  },
  cardsCloseDrawer: () => {
    w.document.body.classList.remove('cards-drawer-open');
    calls.push(['cardsCloseDrawer']);
  },
  // 条目状态改动一律「换新对象」，与 core 同口径（列表项是 React.memo 的，引用不变不重绘）
  cardsSetFlag: async (id, patch) => {
    const st = w.feedlore.state;
    const idx = (st.entries || []).findIndex((x) => String(x.id) === String(id));
    if (idx >= 0) {
      const arr = st.entries.slice();
      arr[idx] = Object.assign({}, arr[idx], patch);
      st.entries = arr;
    }
    cardsTick();
    return true;
  },
  // 打开卡片详情即记为已读（真实实现见 core/ui.js cardDetailRead：卡片页不显示已读态）
  cardsDetailRead: (id) => {
    calls.push(['cardsDetailRead', id]);
    const st = w.feedlore.state;
    st.entries = (st.entries || []).map((x) => (String(x.id) === String(id) ? Object.assign({}, x, { isRead: true }) : x));
  },
  jumpToFeed: (id, focusId) => { calls.push(['jumpToFeed', id, focusId]); },
  // v1.9.0：阅读页桥（P3c，对齐 app.js 语义）
  fmtFull: (d) => (d ? String(d).slice(0, 16).replace('T', ' ') : ''),
  readerAccordionOn: () => true,
  readerSetScope: (scope) => { calls.push(['readerSetScope', scope]); w.feedlore.state.rdScope = scope; w.feedlore.state.rdFeedId = null; w.feedlore.state.rdGroup = null; w.feedlore.state.rdWatch = null; readerTick(); },
  readerSetWatch: (key) => { calls.push(['readerSetWatch', key]); const v = (key === 'watch' || key === 'block') ? key : null; w.feedlore.state.rdWatch = (v && w.feedlore.state.rdWatch === v) ? null : v; w.feedlore.state.rdFeedId = null; w.feedlore.state.rdGroup = null; readerTick(); },
  readerSetFeed: (id) => { calls.push(['readerSetFeed', id]); w.feedlore.state.rdFeedId = Number(id); w.feedlore.state.rdGroup = null; w.feedlore.state.rdScope = 'all'; w.feedlore.state.rdWatch = null; readerTick(); },
  readerSetGroup: (g) => {
    calls.push(['readerSetGroup', g]);
    const st = w.feedlore.state;
    // 与 core/reader.js 同口径：再点同一个组 = 取消筛选
    st.rdGroup = (g === st.rdGroup) ? null : g;
    st.rdFeedId = null;
    readerTick();
  },
  readerOpenSource: () => calls.push(['readerOpenSource']),
  readerSearch: (q) => { calls.push(['readerSearch', q]); w.feedlore.state.rdQ = q; readerTick(); },
  readerGotoArt: (id) => {
    // 前后篇导航：跳到相邻条目（强制展开并置顶）
    calls.push(['readerGotoArt', id]);
    const st = w.feedlore.state;
    st.rdCursor = id;
    st.rdExpanded.add(id);
    if (!st.rdBody.has(id)) {
      st.rdBody.set(id, {
        id, name: '条目一', tags: ['标签A'], content: '第一段正文。\n第二段正文。',
        link: 'https://pan.quark.cn/s/abc', links: ['https://pan.quark.cn/s/abc'],
        sourceUrl: 'https://example.com/a', date: '2026-10-15T10:00:00Z',
      });
    }
    readerTick();
  },
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
    const st = w.feedlore.state;
    // 与 core/reader.js applyEntryFlag 同口径：换掉那一条对象，其余保持同一引用
    st.rdEntries = (st.rdEntries || []).map((x) => (String(x.id) === String(id) ? Object.assign({}, x, { isFavorite: !x.isFavorite }) : x));
    readerTick();
  },
  readerTagToCards: (t) => calls.push(['readerTagToCards', t]),
  readerToggleAccordion: () => calls.push(['readerToggleAccordion']),
  readerToggleDrawer: () => calls.push(['readerToggleDrawer']),
  readerCloseDrawer: () => calls.push(['readerCloseDrawer']),
  // —— 频道栏分组折叠 + 栏宽（折叠集合与栏宽存在 stub 的 state 上，模拟账号布局偏好） ——
  readerCollapsedGroups: () => new Set((w.feedlore.state.rdCollapsedGroups || []).map(String)),
  readerToggleGroupCollapse: (g) => {
    calls.push(['readerToggleGroupCollapse', g]);
    const st = w.feedlore.state;
    const set = new Set((st.rdCollapsedGroups || []).map(String));
    const k = String(g || '');
    if (set.has(k)) set.delete(k); else set.add(k);
    st.rdCollapsedGroups = Array.from(set);
    readerTick();
    cardsTick();   // 折叠集合两边共用（侧栏 + 卡片页筛选），核心改动会派发两个信号
  },
  readerToggleAllGroups: () => {
    calls.push(['readerToggleAllGroups']);
    const st = w.feedlore.state;
    const names = (st.feedList || []).map((f) => String(f.groupName || '').trim());
    const uniq = Array.from(new Set(names));
    const cur = (st.rdCollapsedGroups || []).map(String);
    st.rdCollapsedGroups = (uniq.length && uniq.every((n) => cur.indexOf(n) >= 0)) ? [] : uniq;
    readerTick();
    cardsTick();
  },
  READER_SIDE_DEFAULT: 232,
  READER_SIDE_MIN: 180,
  READER_SIDE_MAX: 400,
  readerSideCap: () => Math.max(180, Math.min(400, Math.floor((w.innerWidth || 1024) * 0.4))),
  getReaderSideWidth: () => (w.feedlore.state.readerSideWidth == null ? 232 : w.feedlore.state.readerSideWidth),
  applyReaderSideWidth: (px) => {
    const v = Math.min(w.feedlore.readerSideCap(), Math.max(180, Math.round(Number(px)) || 232));
    document.documentElement.style.setProperty('--reader-side-w', v + 'px');
    return v;
  },
  setReaderSideWidth: (px) => {
    const v = w.feedlore.applyReaderSideWidth(px);
    calls.push(['setReaderSideWidth', v]);
    w.feedlore.state.readerSideWidth = v;
  },
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
const setArea = (sel, v) => {
  const el = document.querySelector(sel);
  const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, v);
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
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
    // v1.6.0：全局顶栏并入各视图后不再有独立的 <header class="topbar"> 顶栏元素
    for (const id of ['settingsRoot', 'cmdkRoot', 'aiRoot', 'cardsRoot', 'readerRoot', 'overlaysRoot']) {
      if (indexHtml.indexOf('id="' + id + '"') < 0) throw new Error('缺 #' + id);
    }
    if (indexHtml.indexOf('<header class="topbar"') >= 0) throw new Error('顶栏已并入各视图，不应再有独立 <header class="topbar">');
  });
  t('index.html：仅剩 Vite 模块入口（/app.js 已退役）', () => {
    const appRefs = (indexHtml.match(/src="\/app\.js"/g) || []).length;
    const modRefs = (indexHtml.match(/src="\/src\/main\.jsx"/g) || []).length;
    if (appRefs !== 0) throw new Error('public/app.js 应已退役，仍被引用 ' + appRefs + ' 次');
    if (modRefs !== 1) throw new Error('/src/main.jsx 引用 ' + modRefs + ' 次');
  });

  // 阅读页网格必须落在挂载点 #readerRoot 自身：以前是外面套一层 + display:contents 抹盒子，
  // 而「display:contents 的祖先 + position:sticky」在部分引擎会静默失效（头部跟着内容滚走）。
  t('style.css：#readerRoot 自己承载阅读页网格（不靠 display:contents 抹盒子）', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'style.css'), 'utf8');
    const m = css.match(/\.reader\s*>\s*#readerRoot\s*\{([^}]*)\}/);
    if (!m) throw new Error('缺 .reader > #readerRoot 规则');
    if (m[1].indexOf('display: grid') < 0) throw new Error('应设 display:grid，实际：' + m[1].trim());
    if (m[1].indexOf('var(--reader-side-w)') < 0) throw new Error('网格列宽应引用 --reader-side-w');
    const cards = css.match(/\.cards-sticky\s*\{([^}]*)\}/);
    if (!cards) throw new Error('缺 .cards-sticky 规则');
    if (/display:\s*contents/.test(cards[1])) {
      throw new Error('.cards-sticky 不能再是 display:contents（吸顶元素挂在没有盒子的父级下面会失效）');
    }
    if (!/position:\s*sticky/.test(cards[1])) throw new Error('.cards-sticky 自己应承担吸顶');
  });

  // 动效令牌（v1.5.2 修复 P1）：--dur-* 必须给出具体时长，严禁自引用 var(--dur-xxx)。
  // 自引用会形成 CSS 循环依赖、解析为「保证无效值」，使全站 transition/animation 回落 0s 硬切。
  t('style.css：动效令牌 --dur-* 不得自引用，且核心令牌须为具体时长', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'style.css'), 'utf8');
    const decls = [...css.matchAll(/--(dur-[a-z]+)\s*:\s*([^;]*);/g)];
    if (!decls.length) throw new Error('未找到任何 --dur-* 令牌声明');
    const coreDurs = ['dur-fast', 'dur-base', 'dur-med'];
    const seen = new Set();
    for (const [, name, rawVal] of decls) {
      if (seen.has(name)) continue; // 只看 :root 首次定义
      seen.add(name);
      const val = rawVal.trim();
      if (new RegExp('var\\(--' + name + '\\)').test(val)) {
        throw new Error(name + ' 自引用 var(--' + name + ')，会形成循环依赖使全站动效失效');
      }
      if (coreDurs.includes(name) && !/^[0-9.]+s$/.test(val)) {
        throw new Error(name + ' 必须是具体时长（如 .15s），实际：' + val);
      }
    }
  });

  // 移动端弹层只有一种形态（v1.3.6）：.dd-sheet 自己就是整屏，别再长出 .dd-page 这类形态变体类
  t('style.css：移动端弹层单一整屏形态（.dd-sheet 自带 100dvh，无 .dd-page 变体）', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    const m = css.match(/\.dd-sheet\s*\{([^}]*)\}/);
    if (!m) throw new Error('缺 .dd-sheet 规则');
    if (m[1].indexOf('100dvh') < 0) throw new Error('.dd-sheet 应自带整屏高度，实际：' + m[1].trim());
    if (/\.dd-page|\.dd-mask-page|ddUp|ddFade/.test(css)) throw new Error('半屏 / 整屏已合并，那些是死类与死动画');
    for (const f of ['src/views/Dropdown.jsx', 'src/views/CardDetail.jsx']) {
      if (fs.readFileSync(path.join(root, f), 'utf8').indexOf('dd-page') >= 0) throw new Error(f + ' 仍在渲染 dd-page');
    }
  });

  // 设置弹层的 tab 栏 / 标题栏不许被压扁（v1.3.9）：.tabs 一旦 overflow 不是 visible，
  // 它作为 flex item 的自动最小尺寸就变成 0，会被 .modal-body 的长内容挤到 0 高，
  // 再被 overflow-y:hidden 整条裁掉 —— 症状就是「设置里子页全没了」。
  t('style.css：.tabs / .modal-head / .confirm-foot 不参与压缩', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'style.css'), 'utf8');
    for (const sel of ['.tabs', '.modal-head', '.confirm-foot']) {
      const m = css.match(new RegExp(sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}'));
      if (!m) throw new Error('缺 ' + sel + ' 规则');
      if (!/flex:\s*0\s+0\s+auto/.test(m[1])) throw new Error(sel + ' 必须 flex:0 0 auto，否则长内容会把它挤扁：' + m[1].trim().slice(0, 120));
    }
  });

  // 卡片页与文章页共用一套抽屉（v1.3.10）：「和文章页一样」不能靠两份长得差不多的规则维持，
  // 必须是同一条规则；同时窄屏不该再留工具栏里的频道下拉（两个入口抢同一件事）。
  t('style.css：卡片页抽屉复用文章页那套规则 + 窄屏收起频道下拉', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'style.css'), 'utf8');
    const masks = [...css.matchAll(/\.reader-mask,\s*\.cards-mask\s*\{([^}]*)\}/g)].map((m) => m[1]);
    if (!masks.some((x) => x.includes('position: fixed'))) throw new Error('遮罩应由 .reader-mask, .cards-mask 共用同一条规则');
    const sides = [...css.matchAll(/\.reader-side,\s*\.cards-side\s*\{([^}]*)\}/g)].map((m) => m[1]);
    const drawer = sides.find((x) => x.includes('position: fixed'));
    if (!drawer) throw new Error('抽屉应由 .reader-side, .cards-side 共用同一条规则');
    if (drawer.indexOf('var(--z-drawer)') < 0) throw new Error('抽屉没走 --z-drawer 层级');
    if (drawer.indexOf('min(272px, 84vw)') < 0) throw new Error('抽屉宽度应与文章页一致');
    if (!/body\.cards-drawer-open\s+\.cards-side\s*\{\s*transform:\s*none/.test(css)) throw new Error('缺 body.cards-drawer-open 的展开态');
    // ≤1080px 起抽屉就是唯一入口，头部下拉整体退场（不再只管窄屏工具栏那一处）
    if (!/#feedDD\s*\{\s*display:\s*none/.test(css)) throw new Error('≤1080px 应把频道下拉收起（抽屉代替）');
  });

  // 窄屏卡片页顶栏压成一行 + 排序收成图标按钮（v1.3.11）：
  // 两行顶栏在手机上白吃一张卡片的高度；「最新发布 ▾」这种带文字的方块在 360px 下把标题挤没。
  t('style.css + sprite：卡片页窄屏一行顶栏、排序图标模式', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    if (!/\.dd-icon\s*\{\s*display:\s*none/.test(css)) throw new Error('图标模式下 .dd-icon 应默认隐藏（宽屏仍用文字）');
    if (!/\.cards-head,\s*\.cards-head \.page-tools[^{]*\{\s*display:\s*contents/.test(css)) {
      throw new Error('窄屏应把 .cards-head / .page-tools 退化成 display:contents，子元素才能并进同一行');
    }
    if (!/#sortDD \.dd-label,\s*#sortDD \.dd-caret\s*\{\s*display:\s*none/.test(css)) throw new Error('窄屏排序应只留图标');
    if (!/#sortDD \.dd-trigger\.has-icon/.test(css)) throw new Error('缺排序图标按钮的方形尺寸规则');
    if (!/#sortDD \.dd-trigger\.has-icon\s*\{[^}]*background-image:\s*none/.test(css)) {
      throw new Error('图标模式要去掉 .select 自带的下拉箭头背景，否则 32px 方块里会挤出第二个箭头');
    }
    // 视图切换的尺寸已上移到基础规则（桌面与窄屏同高），窄屏只管排位
    if (!/#viewMode\s*\{\s*order:\s*4/.test(css)) throw new Error('窄屏视图切换应排在第 4 位（标题右侧、搜索左侧）');
    if (!/\.viewmode\s*\{[^}]*height:\s*var\(--head-ctl/.test(css)) throw new Error('视图切换外壳应跟 --head-ctl 走，与标题行其它按钮同高');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    if (html.indexOf('id="i-sort"') < 0) throw new Error('缺 #i-sort 图标');
  });

  // 两页头部同构（v1.3.10 统一）：一条「标题 + 图标工具组」吸顶条 + 一行搜索/筛选。
  // 此前卡片页桌面压根没有标题行（只有工具栏），文章页有 —— 同一个产品跑出两套头部。
  // 这组断言守的是「结构同构」，不是像素：谁把 .cards-head 藏回去、把排序塞回工具栏、
  // 把文章页的「频道」文字收掉或把放大镜挪到最左，都会在这里被拦下。
  t('style.css + 视图：文章页与卡片页共用同一套头部结构', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    if (/\.cards-search-toggle,\s*\.cards-head\s*\{\s*display:\s*none/.test(css)) {
      throw new Error('桌面卡片页也应有标题行，不能把 .cards-head 一起隐藏');
    }
    // 两页头部走同一组选择器（.page-head / .reader-head / .cards-head 共用一条规则）
    const headRule = [...css.matchAll(/\.page-head,[\s\S]{0,120}?\{([^}]*)\}/g)].map((m) => m[1])[0] || '';
    if (!/display:\s*flex/.test(headRule)) throw new Error('两页头部应由同一条 flex 规则定义');
    if (!/position:\s*sticky/.test(headRule)) throw new Error('两页头部应同一条吸顶规则（top: --topbar-h）');
    if (!/min-height:\s*var\(--head-h\)/.test(headRule)) throw new Error('头部高度应走 --head-h 令牌');
    if (!/\.page-head \.dd-trigger\s*\{[^}]*height:\s*var\(--head-ctl\)/.test(css)) {
      throw new Error('头部下拉应与其它图标按钮同高（--head-ctl）');
    }
    // 排序 / 视图切换 / 搜索都在标题行里，卡片页不再单独留一行工具栏
    const cards = fs.readFileSync(path.join(root, 'src', 'views', 'CardsView.jsx'), 'utf8');
    const head = cards.slice(cards.indexOf('wrap cards-head'), cards.indexOf('id="tagBar"'));
    // v1.6.0：排序 / 视图切换移入右侧 ⋮ 菜单（OverflowMenu），不再是工具栏上的并排控件
    if (head.indexOf('OverflowMenu') < 0 || head.indexOf('head-right') < 0) {
      throw new Error('右簇应含 ⋮ 溢出菜单（排序 / 视图切换 / 三视图 / 主题 / 设置）');
    }
    if (head.indexOf('cardControls') < 0 || head.indexOf('sortValue') < 0) {
      throw new Error('卡片页 ⋮ 菜单应传入排序与视图切换（cardControls / sortValue）');
    }
    if (head.indexOf('search-box page-search') < 0) {
      throw new Error('搜索框应住在标题行里，不该再单独占一行');
    }
    if (/className="wrap toolbar"/.test(cards)) {
      throw new Error('搜索搬进标题行后，卡片页不该还留着一层 .toolbar（那是多余的一整行高度）');
    }
    // 文章页：搜索同样在头部行内，且与卡片页一致地排在右簇末端（工具组之后）
    const reader = fs.readFileSync(path.join(root, 'src', 'views', 'ReaderView.jsx'), 'utf8');
    const rh = reader.slice(reader.indexOf('reader-head page-head'), reader.indexOf('className="reader-list"'));
    if (rh.indexOf('reader-search page-search') < 0) throw new Error('文章页搜索应住在头部行里');
    if (rh.indexOf('reader-search page-search') < rh.indexOf('reader-head-tools')) {
      throw new Error('搜索应排在工具组之后（右簇末端），两页顺序必须一致');
    }
    if (reader.slice(reader.indexOf('className="reader-list"')).indexOf('reader-search page-search') >= 0) {
      throw new Error('文章页不应再有独立的搜索行');
    }
    // v1.6.0：文章页右簇（动作 + 搜索 + ⋮）统一收进 .reader-head-tools
    const tools = reader.slice(reader.indexOf('reader-head-tools'), reader.indexOf('id="readerList"'));
    if (tools.indexOf('readerSearchToggle') < 0) throw new Error('文章页右簇缺搜索放大镜');
    if (tools.indexOf('OverflowMenu') < 0) throw new Error('文章页右簇缺 ⋮ 菜单');
    // 右簇整体靠右：auto 外边距挂在工具组上。挂在搜索框上会让右簇裂成两段 ——
    // 搜索现在是右簇的末端，空白必须出现在它前面（标题之后），而不是工具组与搜索之间。
    if (!/\.reader-head-tools\s*\{[^}]*margin-left:\s*auto/.test(css)) {
      throw new Error('右簇应靠右（.page-tools / .reader-head-tools 的 margin-left:auto）');
    }
    if (/\.reader-menu-label\s*\{\s*display:\s*none/.test(css)) {
      throw new Error('窄屏频道开关要保留「频道」文字，一枚光秃秃的 ☰ 读不出是菜单还是收起');
    }
  });

  // 断点体系（v1.3.10 头部重构）：1080 换导航形态、720 换密度。
  // 这两个语义以后就是全站约定，谁再临时自造 640 / 900 之类的断点做布局降级，
  // 页面就会开始「一档一档地跳」，所以在这里钉住。
  t('style.css：断点体系（1080 导航降级 / 720 密度降级）+ 头部令牌', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'style.css'), 'utf8');

    // 令牌
    if (!/--head-h:\s*48px/.test(css)) throw new Error('缺 --head-h 桌面值');
    if (!/--head-ctl:\s*32px/.test(css)) throw new Error('缺 --head-ctl 桌面值');
    const tablet = css.match(/--head-h:\s*44px;\s*--head-ctl:\s*36px/);
    if (!tablet) throw new Error('移动档应把 --head-h / --head-ctl 覆盖成 44 / 36（控件变大、条更矮）');

    // ≤1080：侧栏收进抽屉 + 频道按钮出场 + 筛选下拉退场
    const i1080 = css.indexOf('@media (max-width: 1080px)');
    const i720 = css.indexOf('@media (max-width: 720px)', i1080);
    if (i1080 < 0 || i720 < 0) throw new Error('缺 ≤1080px / ≤720px 两档断点');
    const block1080 = css.slice(i1080, i720);
    if (!/\.reader\s*>\s*#readerRoot\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/.test(block1080)) {
      throw new Error('≤1080px 应把阅读页分栏降成单列（网格在 #readerRoot 上）');
    }
    if (!/\.reader-side, \.cards-side\s*\{[^}]*position:\s*fixed/.test(block1080)) {
      throw new Error('≤1080px 应把两页的频道栏变成抽屉（同一条规则）');
    }
    if (!/\.reader-menu-btn, \.cards-menu-btn\s*\{[^}]*display:\s*inline-flex/.test(block1080)) {
      throw new Error('≤1080px 两页都该出现「频道」按钮');
    }
    if (!/#feedDD\s*\{\s*display:\s*none/.test(block1080)) {
      throw new Error('≤1080px 抽屉是唯一入口，头部筛选下拉该退场');
    }
    // 720 那段不该再重复写抽屉规则（导航形态只在 1080 换一次）
    const i720end = css.indexOf('@media (max-width: 560px)', i720);
    const block720 = css.slice(i720, i720end);
    if (/\.reader-side, \.cards-side\s*\{[^}]*position:\s*fixed/.test(block720)) {
      throw new Error('抽屉规则只该写在 ≤1080px，别在 ≤720px 再抄一份');
    }

    // 触屏命中区：视觉 36px，纵向补到 44px（只扩上下，避免和邻键抢点击）
    if (!/\.page-head \.btn::after[\s\S]{0,200}?- 44px\) \/ 2/.test(css)) {
      throw new Error('移动端命中区应纵向补到 44px');
    }
  });

  // 搜索框统一成胶囊 + 去掉头部那条分隔线（v1.3.10）
  // 三处搜索（卡片页 .search-box、文章页 .reader-search、共用 .page-search）必须
  // 共用一条输入框规则，否则又会退化成「两个页面两种搜索框」。
  t('style.css：两页搜索框统一胶囊、头部不画分隔线', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'style.css'), 'utf8');
    if (!/--search-h:\s*32px/.test(css)) throw new Error('缺 --search-h 令牌（胶囊定高，须与 --head-ctl 同高）');
    if (!/--head-ctl:\s*32px/.test(css)) throw new Error('缺 --head-ctl 桌面值');
    if (!/--search-w:\s*560px/.test(css)) throw new Error('缺 --search-w 令牌（桌面宽度上限）');
    const input = css.match(/\.page-search input,\s*\.reader-search input,\s*\.search-box input \{([^}]*)\}/);
    if (!input) throw new Error('三处搜索框必须共用一条规则');
    if (!/height:\s*var\(--search-h\)/.test(input[1])) throw new Error('搜索框高度应引用 --search-h');
    if (!/border-radius:\s*var\(--radius-pill\)/.test(input[1])) {
      throw new Error('搜索框应统一成胶囊（999px），不再是方角矩形');
    }
    if (!/padding:\s*0 var\(--sp-8\) 0 36px/.test(input[1])) {
      throw new Error('胶囊左右内边距要按端头重排（左 36px 给图标）');
    }
    // 头部条不画底边线
    const head = css.match(/\.page-head,\s*\.reader-head,\s*\.cards-head \{([^}]*)\}/);
    if (!head) throw new Error('缺两页共用的头部条规则');
    if (!/border-bottom:\s*0/.test(head[1])) throw new Error('头部条不该再画底部分隔线');
    // 窄屏卡片页那条线同理（它就是贴在搜索框上方的那条）
    const i720 = css.lastIndexOf('@media (max-width: 720px)');
    const sticky = css.slice(i720, css.indexOf('@media (max-width: 560px)', i720));
    const stickyRule = sticky.match(/\.cards-sticky \{([^}]*)\}/);
    if (!stickyRule) throw new Error('缺窄屏吸顶栏规则');
    if (!/border-bottom:\s*0/.test(stickyRule[1])) throw new Error('窄屏吸顶栏也不该有分隔线');
    // 移动端只留图标入口
    if (!/--search-w:\s*100%/.test(sticky)) throw new Error('窄屏搜索胶囊应回落到整行');
    if (!/\.page-search \{\s*display:\s*none/.test(sticky)) {
      throw new Error('≤720px 搜索框应整块退场，只留放大镜入口');
    }
  });

  // 两栏工具图标同尺寸 + 吸顶不依赖 display:contents（v1.3.10）
  // 手机上顶栏（第一栏）与页面头部（第二栏）上下紧挨着；图标 15 / 16 混用、按钮 33 / 36
  // 混用都会一眼看出来「一大一小」。同时把 --topbar-h 改为量外层 .topbar（含 1px 边线），
  // 否则吸顶条的顶端会被顶栏压住一条缝。
  t('style.css + 顶栏：两栏图标同一尺寸，吸顶偏移量取自外层顶栏', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    if (!/--ico-ctl:\s*1rem/.test(css)) throw new Error('缺 --ico-ctl 令牌（两栏共用的图标尺寸）');
    const icoRule = css.match(/\.topbar-actions \.btn \.ico,[\s\S]{0,220}?\{([^}]*)\}/);
    if (!icoRule) throw new Error('缺「顶栏 + 页面头部」共用的图标尺寸规则');
    if (!/\.page-head \.btn \.ico/.test(icoRule[0])) throw new Error('图标规则必须同时覆盖页面头部（.page-head .btn .ico）');
    if (!/width:\s*var\(--ico-ctl\)/.test(icoRule[1]) || !/font-size:\s*var\(--ico-ctl\)/.test(icoRule[1])) {
      throw new Error('.ico 自带 font-size，只改按钮字号带不动图标，宽高与字号都要钉到 --ico-ctl');
    }
    // 移动档：顶栏按钮外框与头部控件同尺寸。
    // v1.3.11 起这条规则挪到 ≤820px（= 文字收起的同一档）：放在 720 时，
    // 721–820 这段视图切换已经是 32（--head-ctl）而工具按钮还是 34（内边距撑的），并排差 2px。
    // 820 有两段（顶栏降级 / 视图切换），取含这条规则的那一段。
    const seg = css.match(/@media \(max-width: 820px\) \{[\s\S]*?\.topbar-actions \.btn \{[\s\S]{0,700}?\n\}/);
    if (!seg) throw new Error('≤820px 应把顶栏工具按钮拉到与头部控件同尺寸');
    const block = seg[0];
    const bar = block.match(/\.topbar-actions \.btn \{([^}]*)\}/);
    if (!bar || !/width:\s*var\(--head-ctl\)/.test(bar[1]) || !/height:\s*var\(--head-ctl\)/.test(bar[1])) {
      throw new Error('顶栏按钮应直接用 --head-ctl（两栏同一把尺子）');
    }
    if (!/#refreshBtn, #themeBtn, #settingsBtn \{ padding: 0/.test(block)) {
      throw new Error('≤820px 的 padding 规则特异度更高，要同段点名压回 0');
    }
    // 吸顶偏移：外层 .topbar 的实测高度（含 1px 底边线）
    const topbar = fs.readFileSync(path.join(root, 'src', 'shell', 'TopBar.jsx'), 'utf8');
    if (topbar.indexOf("closest('.topbar')") < 0) throw new Error('--topbar-h 应量外层 .topbar，不是内层 .topbar-inner');
    if (!/getBoundingClientRect\(\)\.height/.test(topbar) || !/Math\.ceil/.test(topbar)) {
      throw new Error('--topbar-h 应取整（含小数像素时吸顶会露 1px 缝）');
    }
    // v1.6.0 App Shell：头部在内容区独立滚动容器内 sticky top:0 钉住，不随内容移动
    const head = css.match(/\.page-head,\s*\.reader-head,\s*\.cards-head \{([^}]*)\}/);
    if (!head || !/top:\s*0/.test(head[1])) throw new Error('合并后头部应自己贴顶（top:0）');
    if (!/\.reader-main \{[^}]*overflow-y:\s*auto/.test(css)) throw new Error('.reader-main 应是独立滚动容器');
    if (!/#cardsRoot > main\.wrap \{[^}]*overflow-y:\s*auto/.test(css)) throw new Error('卡片 main 应是独立滚动容器');
  });

  // 窄屏视图切换（v1.3.10）：文字收掉后不能再让两个按钮平分整条宽度 ——
  // 那样就是「一条空胶囊里飘着两个小图标」，比右侧工具按钮显眼得多却什么都没写。
  t('style.css：窄屏视图切换改成图标方块组', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'style.css'), 'utf8');
    // v1.3.11：断点从 560 抬到 820 —— 文字在 820 就被 .btn-label 收掉，
    // 外壳却留到 560 才散，中间 260px 是一条空胶囊。断点必须与文字隐藏同步。
    const blocks = [...css.matchAll(/@media \(max-width: 820px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    const block = blocks.find((b) => /\.viewnav\s*\{/.test(b));
    if (!block) throw new Error('缺 ≤820px 的 .viewnav 规则');
    // 必须排在「组件统一 1)」之后：同特异度靠源顺序取胜，写在前面会被反盖
    const unified = css.indexOf('.seg, .viewnav {');
    const at = css.search(/@media \(max-width: 820px\) \{\s*\.viewnav \{/);
    if (unified < 0 || at < unified) throw new Error('窄屏 .viewnav 必须排在 .seg, .viewnav 之后才生效');
    const nav = block.match(/\.viewnav\s*\{([^}]*)\}/);
    if (/flex:\s*1/.test(nav[1])) throw new Error('视图切换不该再吃满剩余宽度：' + nav[1].trim());
    if (!/margin-right:\s*auto/.test(nav[1])) throw new Error('不再 flex:1 后要靠 margin-right:auto 把工具按钮推到右边');
    if (!/background:\s*none/.test(nav[1]) || !/border:\s*0/.test(nav[1])) throw new Error('窄屏应去掉分段控件的外框');
    if (!/box-shadow:\s*none/.test(nav[1])) throw new Error('外框去掉后拟态内阴影也要撤掉，否则留下一条凹槽');
    const btn = block.match(/\.viewnav-btn\s*\{([^}]*)\}/);
    if (!btn || !/width:\s*var\(--head-ctl\)/.test(btn[1])) {
      throw new Error('视图按钮外框应走 --head-ctl，与右侧工具按钮同一把尺子（旧值 32 与 36 差 4px，并排一眼看得出）');
    }
    if (!/\.viewnav-btn\.active\s*\{[^}]*background:\s*var\(--accent-soft\)/.test(block)) throw new Error('选中项应改用 --accent-soft 打底');
  });

  // 卡片页频道筛选的组头折叠（v1.3.8）：整行可点 + 移动端命中区够大 + 能力默认关
  t('style.css + 视图：分组折叠开关（整行可点、触屏 44px、不传 collapsible 仍是纯标题）', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    const fold = css.match(/\.dd-group-fold\s*\{([^}]*)\}/);
    if (!fold) throw new Error('缺 .dd-group-fold 规则');
    if (fold[1].indexOf('cursor: pointer') < 0) throw new Error('组头不该用默认光标，实际：' + fold[1].trim());
    const touch = css.match(/\.dd-sheet-body \.dd-group-fold\s*\{([^}]*)\}/);
    if (!touch) throw new Error('缺移动端 .dd-sheet-body .dd-group-fold 规则');
    if (touch[1].indexOf('min-height: 44px') < 0) throw new Error('移动端组头命中区应 ≥44px，实际：' + touch[1].trim());
    const dd = fs.readFileSync(path.join(root, 'src', 'views', 'Dropdown.jsx'), 'utf8');
    if (dd.indexOf('<div className="dd-group"') < 0) throw new Error('不传 collapsible 时仍应是纯文本分组标题');
    if (fs.readFileSync(path.join(root, 'src', 'views', 'CardsView.jsx'), 'utf8').indexOf('collapsible') < 0) {
      throw new Error('卡片页频道筛选未开启折叠能力');
    }
  });

  // 卡片页跳文章页的高亮：CSS 动画时长必须与 core 里清除 rdFlashId 的定时器一致，
  // 否则类先消失（看不到高亮）或动画先结束（高亮框一直亮着）
  t('style.css + reader.js：跳转高亮的时长与类名对齐', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    const rule = css.match(/\.art-item\.is-flash\s*\{([^}]*)\}/);
    if (!rule) throw new Error('缺 .art-item.is-flash 规则');
    const anim = css.match(/@keyframes artFlash\s*\{([\s\S]*?)\n\}/);
    if (!anim) throw new Error('缺 @keyframes artFlash');
    const dur = rule[1].match(/animation:\s*artFlash\s+([\d.]+)s/);
    if (!dur) throw new Error('.is-flash 未按秒设 artFlash 时长，实际：' + rule[1].trim());
    const js = fs.readFileSync(path.join(root, 'src', 'core', 'reader.js'), 'utf8');
    const flashMs = js.match(/const FLASH_MS\s*=\s*(\d+)/);
    if (!flashMs) throw new Error('reader.js 缺 FLASH_MS');
    if (Number(dur[1]) * 1000 !== Number(flashMs[1])) {
      throw new Error(`CSS ${dur[1]}s 与 FLASH_MS ${flashMs[1]}ms 不一致`);
    }
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
  t('8 个 tab（管理员）', () => { if (document.querySelectorAll('.tabs .tab').length !== 8) throw new Error('实际 ' + document.querySelectorAll('.tabs .tab').length); });
  t('设置导航含「规则」tab', () => {
    const w = [...document.querySelectorAll('.tabs .tab')].find((x) => x.textContent.trim() === '规则');
    if (!w || w.dataset.tab !== 'watch') throw new Error('规则 tab 缺失或 data-tab 不对');
  });
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
  t('数据源：分组头有按钮语义与展开态', () => {
    const heads = [...document.querySelectorAll('#feedList .feed-group-head')];
    if (!heads.length) return;   // 迷你数据没分组时跳过
    const h = heads[0];
    if (h.getAttribute('role') !== 'button') throw new Error('缺 role=button');
    if (h.getAttribute('tabindex') !== '0') throw new Error('不可聚焦');
    const exp = h.getAttribute('aria-expanded');
    if (exp !== 'true' && exp !== 'false') throw new Error('aria-expanded=' + exp);
  });
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
  releaseCfg({ ok: true, json: () => Promise.resolve({ username: 'tester', role: 'admin', source: Object.assign({}, miniSettingsSource) }) });
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

  // 思考模式：默认关，档位行平时不显示（关着还摆一档 = 让人以为在发）
  const depthRow = () => document.querySelector('#llmDepth').closest('.form-row');
  t('思考默认关 + 档位行隐藏', () => {
    if (!document.querySelector('#llmThinking')) throw new Error('无 #llmThinking');
    if (document.querySelector('#llmThinking').checked !== false) throw new Error('开关应为未勾选');
    if (depthRow().hidden !== true) throw new Error('未关思考时深度行不该可见');
  });
  // 点的是「看得见的那颗滑块」而不是 input：input 本身被 CSS 收成 0×0，
  // 用户手点的其实是 label 命中区（早先这里用 span 包 input，导致开关点不动）
  const thinkSw = document.querySelector('#llmThinking ~ .switch-slider');
  thinkSw.click();
  await sleep(40);
  t('开思考 → 深度行现身，三档可选、默认中档', () => {
    if (depthRow().hidden !== false) throw new Error('深度行未出现');
    const vals = [...document.querySelectorAll('#llmDepth option')].map((o) => o.value);
    if (vals.join() !== 'low,medium,high') throw new Error('档位: ' + vals.join());
    if (document.querySelector('#llmDepth').value !== 'medium') throw new Error('默认档位: ' + document.querySelector('#llmDepth').value);
  });
  t('开思考后：模型名的提示跟着改口（不再宣称内置 /no_think）', () => {
    const tip = [...document.querySelectorAll('#llmModel ~ .form-tip, .form-tip')].map((e) => e.textContent).join(' | ');
    if (tip.indexOf('已开启思考') < 0) throw new Error('提示未跟着变: ' + tip.slice(0, 120));
    if (tip.indexOf('内置 /no_think') >= 0) throw new Error('还挂着「内置 /no_think」的旧说法');
  });

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
    // 思考设置跟着临时覆盖发出去：拨开开关还没保存就该能测出上游认不认
    if (body.llm.thinking !== true) throw new Error('thinking: ' + body.llm.thinking);
    if (body.llm.thinkingDepth !== 'medium') throw new Error('thinkingDepth: ' + body.llm.thinkingDepth);
  });
  t('测试 ok 态', () => { const r = document.querySelector('#llmResult'); if (!r || !r.classList.contains('ok')) throw new Error('类名: ' + (r && r.className)); if (r.textContent.indexOf('模型可用') < 0) throw new Error('文案: ' + r.textContent); });

  // 保存（带 Key）：temperature 数值化、apiKey 仅在填写时传
  setInput('#llmTemp', '0.4');
  setSel('#llmDepth', 'high');
  await sleep(30);
  document.querySelector('#saveLlmBtn').click();
  await sleep(80);
  t('保存：POST /api/prefs（含 Key + 数值温度）', () => {
    if (!postsTo('/api/prefs').length) throw new Error('未 POST');
    const body = lastPostBody('/api/prefs');
    if (body.llm.apiKey !== 'sk-test123') throw new Error('apiKey 未传');
    if (body.llm.temperature !== 0.4 || typeof body.llm.temperature !== 'number') throw new Error('temperature 应数值化: ' + JSON.stringify(body.llm.temperature));
    if (body.llm.baseUrl !== 'https://api.example.com/v1') throw new Error('baseUrl 未传');
    if (body.llm.thinking !== true) throw new Error('thinking 未传: ' + body.llm.thinking);
    if (body.llm.thinkingDepth !== 'high') throw new Error('thinkingDepth 未传: ' + body.llm.thinkingDepth);
  });
  t('保存 ok + toast', () => {
    const r = document.querySelector('#llmResult');
    if (!r || !r.classList.contains('ok')) throw new Error('结果类名: ' + (r && r.className));
    if (r.textContent.indexOf('模型配置与 API Key 已保存') < 0) throw new Error('文案: ' + r.textContent);
    // 表单保存只发内联结果（v1.3.8-test2 起不再重复 toast）
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

  // ============ 日报面板（整组按账号：开关 / 自动生成 / 范围 / 上限 / 风格） ============
  // 造一个「已关掉 + 写过要求 + 自定义范围」的账号态，一次覆盖回填、脏态、开关、保存、清空
  prefsDigestEnabled = false;
  prefsDigest = Object.assign({}, DIGEST_CFG_DEFAULT, {
    auto: true, time: '07:30', mode: 'custom', feeds: [3], style: '侧重新版影视，语气随意些。', lastAuto: '2026-10-25',
  });
  clickTab('日报');
  await sleep(80);
  t('日报面板渲染', () => {
    if (!document.querySelector('.tab-pane[data-pane="digest"]')) throw new Error('无 digest 面板');
    for (const id of ['#digEnable', '#digAuto', '#digTime', '#digMode', '#digMaxPerFeed', '#digMaxTotal', '#digKeepDays', '#digPrompt']) {
      if (!document.querySelector(id)) throw new Error('无 ' + id);
    }
    // input 被 CSS 收成 0×0，能点的其实是包着它的 label；不包就变成「看得见点不着」
    for (const id of ['#digEnable', '#digAuto']) {
      const head = document.querySelector(id).closest('.form-row-head');
      if (!head || head.tagName !== 'LABEL') throw new Error(id + ' 开关行不是 label，整行点不动');
    }
  });
  t('进入即拉 /api/prefs 回填整组配置', () => {
    if (document.querySelector('#digEnable').checked !== false) throw new Error('使用日报应按账号偏好为关');
    if (document.querySelector('#digAuto').checked !== true) throw new Error('auto 未回填');
    if (document.querySelector('#digTime').value !== '07:30') throw new Error('time: ' + document.querySelector('#digTime').value);
    if (document.querySelector('#digMode').value !== 'custom') throw new Error('mode: ' + document.querySelector('#digMode').value);
    if (document.querySelector('#digMaxPerFeed').value !== '20') throw new Error('maxPerFeed: ' + document.querySelector('#digMaxPerFeed').value);
    if (document.querySelector('#digPrompt').value !== '侧重新版影视，语气随意些。') throw new Error('要求未回填: ' + document.querySelector('#digPrompt').value);
    const tip = document.querySelector('#digPrompt ~ .form-tip');
    if (!tip || tip.textContent.indexOf('13 / 2000 字') < 0) throw new Error('字数提示: ' + (tip && tip.textContent));
    // 自定义范围才展开频道勾选清单
    if (!document.querySelector('.feed-pick')) throw new Error('custom 模式未渲染频道清单');
  });
  t('未改动：保存禁用、清空风格可用（已存过要求）', () => {
    if (document.querySelector('#digSaveBtn').disabled !== true) throw new Error('无改动时保存不该可用');
    if (document.querySelector('#digResetBtn').disabled !== false) throw new Error('已有要求时清空该可用');
  });

  document.querySelector('#digEnable ~ .switch-slider').click();
  await sleep(40);
  t('点「使用日报」→ setDigestEnabled(true) + toast（顶栏入口随之回来）', () => {
    const c = lastCall('setDigestEnabled');
    if (!c || c[1] !== true) throw new Error('桥调用: ' + JSON.stringify(c));
    if (shellSnap.digestVisible !== true) throw new Error('顶栏快照未跟着开');
    const tc = lastCall('toast');
    if (!tc || tc[1].indexOf('已开启日报') < 0) throw new Error('toast: ' + JSON.stringify(tc));
  });

  // 关掉自动生成 → 时间/范围行收起（这三项只在开自动时才有意义）
  document.querySelector('#digAuto ~ .switch-slider').click();
  await sleep(30);
  t('关掉自动生成：时间/范围行收起、保存解禁', () => {
    if (document.querySelector('#digTime').closest('.form-row').hidden !== true) throw new Error('时间行未收起');
    if (document.querySelector('#digMode').closest('.form-row').hidden !== true) throw new Error('范围行未收起');
    if (document.querySelector('.feed-pick')) throw new Error('清单未收起');
    if (document.querySelector('#digSaveBtn').disabled !== false) throw new Error('有改动时保存该可用');
  });
  document.querySelector('#digAuto ~ .switch-slider').click();
  await sleep(30);

  setArea('#digPrompt', '侧重新版影视，语气随意些。技术教程只挑有用的。');
  await sleep(30);
  t('改动后：字数提示跟着涨', () => {
    const tip = document.querySelector('#digPrompt ~ .form-tip');
    if (tip.textContent.indexOf('23 / 2000 字') < 0) throw new Error('字数提示: ' + tip.textContent);
  });
  setInput('#digMaxPerFeed', '25');
  setSel('#digMode', 'all');
  await sleep(30);
  document.querySelector('#digSaveBtn').click();
  await sleep(80);
  t('保存：POST /api/prefs 只带 digest 整组', () => {
    const body = lastPostBody('/api/prefs');
    if (Object.keys(body).join() !== 'digest') throw new Error('不该顺带别的键: ' + Object.keys(body).join());
    if (body.digest.style !== '侧重新版影视，语气随意些。技术教程只挑有用的。') throw new Error('style: ' + JSON.stringify(body.digest.style));
    if (body.digest.maxPerFeed !== '25' || body.digest.mode !== 'all') throw new Error('body: ' + JSON.stringify(body.digest));
    // 切回 all 时不该把上一次的自定义频道留着
    if (body.digest.feeds.length !== 0) throw new Error('非 custom 仍带 feeds: ' + JSON.stringify(body.digest.feeds));
    const r = document.querySelector('#digResult');
    if (!r || !r.classList.contains('ok')) throw new Error('结果类名: ' + (r && r.className));
    if (r.textContent.indexOf('日报设置已保存') < 0) throw new Error('文案: ' + r.textContent);
    if (prefsDigest.style !== '侧重新版影视，语气随意些。技术教程只挑有用的。') throw new Error('桩未落库');
    if (prefsDigest.maxPerFeed !== 25 || prefsDigest.mode !== 'all') throw new Error('桩: ' + JSON.stringify(prefsDigest));
  });
  t('lastAuto 是服务端独占字段：客户端提交不改它', () => {
    if (prefsDigest.lastAuto !== '2026-10-25') throw new Error('lastAuto: ' + prefsDigest.lastAuto);
  });
  t('保存后回到干净态（保存禁用）', () => {
    if (document.querySelector('#digSaveBtn').disabled !== true) throw new Error('保存后不该还算脏');
  });

  // 首尾空白不该存进去：服务端会 trim，前端提前 trim 才能让「保存后按钮禁用」成立
  setArea('#digPrompt', '  多给点音乐  ');
  await sleep(30);
  document.querySelector('#digSaveBtn').click();
  await sleep(80);
  t('保存去首尾空白（与服务端 trim 同口径）', () => {
    if (lastPostBody('/api/prefs').digest.style !== '多给点音乐') throw new Error('未 trim: ' + JSON.stringify(lastPostBody('/api/prefs').digest.style));
    if (document.querySelector('#digPrompt').value !== '多给点音乐') throw new Error('输入框未回写去空白后的值');
  });

  // 脏值夹回区间：服务端 clamp 后要用回包重建表单
  setInput('#digMaxPerFeed', '9999');
  await sleep(30);
  document.querySelector('#digSaveBtn').click();
  await sleep(80);
  t('越界值按服务端回包夹回（界面显示真正落库的值）', () => {
    if (prefsDigest.maxPerFeed !== 100) throw new Error('桩 clamp: ' + prefsDigest.maxPerFeed);
    if (document.querySelector('#digMaxPerFeed').value !== '100') throw new Error('界面: ' + document.querySelector('#digMaxPerFeed').value);
    if (document.querySelector('#digSaveBtn').disabled !== true) throw new Error('夹回后不该还算脏');
  });

  document.querySelector('#digResetBtn').click();
  await sleep(30);
  t('清空风格：只清这一项，落库要点保存', () => {
    if (document.querySelector('#digPrompt').value !== '') throw new Error('输入框未清空');
    if (document.querySelector('#digSaveBtn').disabled !== false) throw new Error('清空后该能保存');
  });
  document.querySelector('#digSaveBtn').click();
  await sleep(80);
  t('保存清空后的风格', () => {
    if (prefsDigest.style !== '') throw new Error('桩未清空');
    const r = document.querySelector('#digResult');
    if (r.textContent.indexOf('日报设置已保存') < 0) throw new Error('文案: ' + r.textContent);
  });
  t('默认态：两个按钮都禁用（没要求可清、没改动可存）', () => {
    if (document.querySelector('#digResetBtn').disabled !== true) throw new Error('清空不该可用');
    if (document.querySelector('#digSaveBtn').disabled !== true) throw new Error('保存不该可用');
  });

  prefsPostOk = false;
  setArea('#digPrompt', '写入失败试试');
  await sleep(30);
  document.querySelector('#digSaveBtn').click();
  await sleep(80);
  t('保存失败：err 横幅且不算已保存（保存仍可用）', () => {
    const r = document.querySelector('#digResult');
    if (!r.classList.contains('err')) throw new Error('类名: ' + r.className);
    if (r.textContent.indexOf('炸了') < 0) throw new Error('文案: ' + r.textContent);
    if (document.querySelector('#digSaveBtn').disabled !== false) throw new Error('失败后不该丢掉改动');
  });
  prefsPostOk = true;

  clickTab('外观'); await sleep(40);
  prefsDigestEnabled = true;
  prefsDigest = Object.assign({}, DIGEST_CFG_DEFAULT);
  shellSnap.digestVisible = true;

  // ============ 外观面板 ============
  clickTab('外观');
  await sleep(60);
  t('外观面板渲染', () => { if (!document.querySelector('.appr')) throw new Error('无 .appr'); });
  t('分段控件总数 21', () => { if (document.querySelectorAll('.seg-btn').length !== 21) throw new Error('实际 ' + document.querySelectorAll('.seg-btn').length); });
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
    if (document.querySelectorAll('.seg-btn.active').length !== 7) throw new Error('active seg-btn 应为 7，实际 ' + document.querySelectorAll('.seg-btn.active').length);
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
  t('普通用户无状态 tab', () => { if (tabBtn('状态')) throw new Error('状态 tab 仍渲染'); if (document.querySelectorAll('.tabs .tab').length !== 7) throw new Error('tab 数 ' + document.querySelectorAll('.tabs .tab').length); });
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
  t('setAdminFlag(true) 恢复 8 tab', () => { if (document.querySelectorAll('.tabs .tab').length !== 8) throw new Error('tab 数 ' + document.querySelectorAll('.tabs .tab').length); });
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

  t('AI 视图渲染：单页（无二级导航）', () => {
    if (!Q('.ai-head')) throw new Error('无 ai-head');
    if (QA('#aiNav .ainav-btn').length !== 0) throw new Error('二级导航应已删除');
    if (!Q('[data-ai-pane="digest"]')) throw new Error('无日报子页');
    if (Q('[data-ai-pane="settings"]')) throw new Error('日报设置子页应已搬走');
    if (!countApi('/api/digests')) throw new Error('未 GET /api/digests');
    if (!callsOf('apiFetch').some((c) => c[1].indexOf('/api/digest?') === 0)) throw new Error('未 GET /api/digest');
  });
  t('日报副标题含范围/频道数（范围读本账号 prefs.digest）', () => {
    const sub = Q('#digestSub').textContent;
    if (sub.indexOf('把「采集」开启的频道过去') < 0) throw new Error('subtitle: ' + sub);
    if (sub.indexOf('个频道，采集开启') < 0) throw new Error('subtitle 频道数: ' + sub);
    if (!callsOf('apiFetch').some((c) => c[1] === '/api/prefs' && !c[2])) throw new Error('未 GET /api/prefs 取范围');
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

  // 普通用户与管理员看到的是同一页（日报配置已在「设置 → 日报」，不再分角色）
  aiRoot1.unmount();
  await sleep(30);
  aiEl.innerHTML = '';
  adminFlag = false;
  // 之前 SourcePane 拉过 /api/config，这里只比本次挂载新增的请求
  const cfgCallsBefore = callsOf('apiFetch').filter((c) => c[1] === '/api/config' && !c[2]).length;
  __mountAi(aiEl);
  await sleep(80);
  w.dispatchEvent(new w.CustomEvent('__viewChanged', { detail: 'ai' }));
  await sleep(140);
  t('普通用户：同样只有日报一页，无 /api/config 请求', () => {
    if (Q('[data-ai="settings"]')) throw new Error('不应有日报设置入口');
    if (!Q('[data-ai-pane="digest"]')) throw new Error('无日报子页');
    if (!Q('#genDigestBtn')) throw new Error('无生成按钮');
    const now = callsOf('apiFetch').filter((c) => c[1] === '/api/config' && !c[2]).length;
    if (now !== cfgCallsBefore) throw new Error('AI 页不该再读站点级配置');
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

  t('卡片视图渲染：工具栏 + 卡片', () => {
    if (!C('#searchInput')) throw new Error('无搜索框');
    if (!C('#feedSelect')) throw new Error('无频道下拉');
    if (C('#feedSelect .dd-label').textContent.indexOf('全部频道') < 0) throw new Error('频道触发器文案: ' + C('#feedSelect .dd-label').textContent);
    if (cardIds().join(',') !== 'e1,e2') throw new Error('卡片 ' + cardIds().join(','));
    // v1.6.0：页面顶部标签栏整体移除；视图切换（网格/列表）在右侧 ⋮ 菜单
    if (C('#tagBar')) throw new Error('标签栏应已移除');
    if (!C('.overflow-btn')) throw new Error('缺 ⋮ 菜单入口');
  });

  // v1.7.0（P0 #1）：常驻视图导航。卡片范围分段（全部/收藏）已按用户决定移除——卡片页不需要收藏。
  t('常驻视图导航：卡片工具条内 .viewnav 三视图入口，当前卡片页高亮', () => {
    const nav = C('.view-toolbar .viewnav');
    if (!nav) throw new Error('卡片工具条缺常驻 .viewnav');
    if (CA('.viewnav .viewnav-btn').length !== 3) throw new Error('视图入口应为 3 个');
    const on = CA('.viewnav .viewnav-btn').find((b) => b.classList.contains('active'));
    if (!on || on.getAttribute('data-view') !== 'cards') throw new Error('当前视图未高亮 cards');
    if (CA('.overflow-menu .overflow-item').some((b) => ['文章', '卡片', '日报'].indexOf(b.textContent.trim()) >= 0)) throw new Error('⋮ 菜单不应再含视图项');
    if (document.querySelector('.cards-scope')) throw new Error('.cards-scope 应已移除（卡片页不需要收藏）');
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

  // 频道筛选里的分组折叠（与文章页侧栏共用同一份偏好 layout.rdCollapsedGroups）
  C('#feedSelect').click();
  await sleep(20);
  t('频道下拉：分组标题是整行折叠开关（箭头 + aria-expanded）', () => {
    const g = C('#feedDD .dd-group');
    if (g.tagName !== 'BUTTON') throw new Error('组头应为按钮，实际 ' + g.tagName);
    if (!g.classList.contains('dd-group-fold')) throw new Error('缺 dd-group-fold');
    if (g.getAttribute('aria-expanded') !== 'true') throw new Error('展开态 aria-expanded=' + g.getAttribute('aria-expanded'));
    if (!g.querySelector('.dd-group-caret')) throw new Error('无折叠箭头');
    if (g.querySelector('.dd-group-n')) throw new Error('展开态不该报频道数');
    if (g.textContent.indexOf('科技') < 0) throw new Error('组名: ' + g.textContent);
  });
  C('#feedDD .dd-group').click();
  await sleep(40);
  t('点组头收起：该组频道不再入列，组头改报频道数并写进偏好', () => {
    if (CA('#feedDD .dd-item').length !== 2) throw new Error('收起后选项 ' + CA('#feedDD .dd-item').length);
    const g = C('#feedDD .dd-group');
    if (!g.classList.contains('is-collapsed')) throw new Error('组头未标记收起');
    if (g.getAttribute('aria-expanded') !== 'false') throw new Error('aria-expanded=' + g.getAttribute('aria-expanded'));
    if (g.querySelector('.dd-group-n').textContent !== '1') throw new Error('频道数 ' + g.querySelector('.dd-group-n').textContent);
    if (CA('#feedDD .dd-item').some((el) => el.textContent.indexOf('例子星球') >= 0)) throw new Error('收起的组里频道还在');
    if (!w.feedlore.readerCollapsedGroups().has('科技')) throw new Error('偏好未写入 rdCollapsedGroups');
  });
  const dk = (k) => C('#feedDD').dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  dk('ArrowUp');
  await sleep(20);
  t('键盘 ↑↓ 只在可见频道里走，组头不进遍历', () => {
    const hi = CA('#feedDD .dd-item.hi');
    if (hi.length !== 1) throw new Error('高亮项 ' + hi.length);
    if (hi[0].textContent.indexOf('全部频道') < 0) throw new Error('高亮落在: ' + hi[0].textContent);
    if (C('#feedDD .dd-group.hi')) throw new Error('组头不该进键盘遍历');
  });
  dk('Enter');
  await sleep(40);
  t('Enter 选中高亮频道：弹层收起且筛选没跳走', () => {
    if (C('#feedDD .dd-panel')) throw new Error('Enter 后弹层未收起');
    if (C('#feedSelect .dd-label').textContent.indexOf('全部频道') < 0) throw new Error('触发器文案: ' + C('#feedSelect .dd-label').textContent);
  });
  C('#feedSelect').click();
  await sleep(20);
  C('#feedDD .dd-group').click();
  await sleep(40);
  t('再点组头展开：频道回到 3 项、收起标记与偏好一起清掉', () => {
    if (CA('#feedDD .dd-item').length !== 3) throw new Error('展开后选项 ' + CA('#feedDD .dd-item').length);
    if (C('#feedDD .dd-group').classList.contains('is-collapsed')) throw new Error('组头仍标记收起');
    if (w.feedlore.readerCollapsedGroups().size !== 0) throw new Error('偏好未清空: ' + Array.from(w.feedlore.readerCollapsedGroups()).join(','));
  });
  // 收起的组里藏着当前筛选中的频道 → 那一条得留着，否则触发按钮还写着名字、选项却找不到
  CA('#feedDD .dd-item').find((el) => el.textContent.indexOf('例子星球') >= 0).click();
  await sleep(40);
  C('#feedSelect').click();
  await sleep(20);
  C('#feedDD .dd-group').click();
  await sleep(40);
  t('收起的组里正看着其中一条：那一条不随组收起，且仍高亮', () => {
    const items = CA('#feedDD .dd-item');
    if (!C('#feedDD .dd-group').classList.contains('is-collapsed')) throw new Error('组头未标记收起');
    if (items.length !== 3) throw new Error('应保留当前项，实际 ' + items.length);
    const act = C('#feedDD .dd-item.active');
    if (!act || act.textContent.indexOf('例子星球') < 0) throw new Error('高亮项: ' + (act ? act.textContent : '无'));
  });
  // 还原：展开分组 + 回到全部频道，避免影响后续用例
  C('#feedDD .dd-group').click();
  await sleep(20);
  CA('#feedDD .dd-item')[0].click();
  await sleep(40);
  t('还原：折叠偏好与频道筛选均归零', () => {
    if (w.feedlore.readerCollapsedGroups().size !== 0) throw new Error('折叠偏好未清空');
    if (w.feedlore.state.feedFilter != null) throw new Error('筛选未还原: ' + w.feedlore.state.feedFilter);
    if (C('#feedDD .dd-panel')) throw new Error('弹层未收起');
  });
  // 同一份偏好被两处 UI 共读：侧栏（这里直接走核心的收起动作）改了，下拉不能只在打开时读一次
  C('#feedSelect').click();
  await sleep(20);
  w.feedlore.readerToggleGroupCollapse('科技');
  await sleep(40);
  t('别处改了折叠态：卡片页下拉跟着收起（靠 __cardsTick 重绘，不是打开时读一次）', () => {
    if (CA('#feedDD .dd-item').length !== 2) throw new Error('选项 ' + CA('#feedDD .dd-item').length);
    if (!C('#feedDD .dd-group').classList.contains('is-collapsed')) throw new Error('组头未跟随');
  });
  C('#feedDD .dd-group').click();
  await sleep(20);
  CA('#feedDD .dd-item')[0].click();
  await sleep(40);

  // 移动端（≤720px）：频道下拉改为底部弹窗（v1.1.10）
  const realMM = w.matchMedia;
  w.matchMedia = (q) => ({ matches: String(q).indexOf('max-width: 720px') >= 0, media: String(q),
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  // v1.3.5 下拉关闭手势：合成触摸轨迹。tt 单步派发，便于在 touchend 之前先断言「跟手」
  const tt = (el, type, y) => {
    const ev = new w.Event(type, { bubbles: true, cancelable: true });
    ev.touches = y === null ? [] : [{ clientY: y }];
    el.dispatchEvent(ev);
  };
  const swipe = (el, from, ys) => {
    tt(el, 'touchstart', from);
    for (let i = 0; i < ys.length; i++) tt(el, 'touchmove', ys[i]);
    tt(el, 'touchend', null);
  };
  C('#feedSelect').click();
  await sleep(20);
  t('频道下拉（移动端）：整屏形态（无遮罩留白 / 标题栏 / 大选项 / 手势条）', () => {
    if (!C('#feedDD .dd-mask')) throw new Error('无遮罩');
    if (!C('#feedDD .dd-sheet')) throw new Error('频道选项多，移动端应整屏铺开');
    if (!C('#feedDD .dd-sheet-grip')) throw new Error('整屏也支持往下拖收起，手势条是这枚提示');
    if (!C('#feedDD .dd-sheet-head .dd-sheet-title')) throw new Error('无标题栏');
    if (CA('#feedDD .dd-sheet .dd-item').length !== 3) throw new Error('弹窗选项 ' + CA('#feedDD .dd-sheet .dd-item').length);
    if (!C('#feedDD .dd-sheet .dd-item.active')) throw new Error('当前项未高亮');
  });
  t('下拉手势：位移跟手，写的是面板内联 transform', () => {
    const sheet = C('#feedDD .dd-sheet');
    tt(sheet, 'touchstart', 100);
    tt(sheet, 'touchmove', 104);   // 4px < SLOP，手抖不算拖拽
    if (sheet.style.transform !== '') throw new Error('小于阈值不该动: ' + sheet.style.transform);
    tt(sheet, 'touchmove', 250);
    if (sheet.style.transform !== 'translateY(150px)') throw new Error('位移没跟手: ' + sheet.style.transform);
    if (!C('#feedDD .dd-mask')) throw new Error('拖拽途中不该提前卸载弹层');
  });
  t('下拉手势：往下拖过阈值 → 飞出，松手后收起（筛选未变）', () => {
    const sheet = C('#feedDD .dd-sheet');
    tt(sheet, 'touchend', null);
    if (sheet.style.transform !== 'translateY(100%)') throw new Error('超阈值应整块飞出: ' + sheet.style.transform);
    if (!C('#feedDD .dd-mask')) throw new Error('飞出动画跑完前不该卸载');
  });
  await sleep(240);
  t('下拉手势：飞出动画结束后弹窗关闭', () => {
    if (C('#feedDD .dd-mask')) throw new Error('下拉超阈值后应收起');
    if (C('#feedSelect .dd-label').textContent.indexOf('全部频道') < 0) throw new Error('关闭不该改筛选');
  });
  // 位移不足阈值 → 弹回，不关；且抬手补发的那次 click 要吞掉，否则拖一下就改了频道
  C('#feedSelect').click();
  await sleep(20);
  t('下拉手势：只拖一点点就弹回，弹窗仍开着', () => {
    const sheet = C('#feedDD .dd-sheet');
    swipe(sheet, 100, [120, 135]);
    if (sheet.style.transform !== '') throw new Error('应弹回原位: ' + sheet.style.transform);
    if (!C('#feedDD .dd-mask')) throw new Error('短拖不该关闭');
  });
  t('下拉手势：抬手后浏览器补发的 click 被吞掉（没顺手选中选项）', () => {
    CA('#feedDD .dd-sheet .dd-item')[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    if (!C('#feedDD .dd-mask')) throw new Error('被吞的 click 不该关闭弹窗');
    if (C('#feedSelect .dd-label').textContent.indexOf('全部频道') < 0) throw new Error('补发的 click 把选项点上了');
  });
  // 吞点击的窗口只有一瞬，等它过去才轮到正常的点关闭
  await sleep(320);
  C('#feedDD .dd-sheet-close').click();
  await sleep(20);
  t('频道下拉（移动端）：点关闭收起弹窗', () => {
    if (C('#feedDD .dd-mask')) throw new Error('弹窗未收起');
  });
  // v1.6.0：排序与视图切换已移入右侧 ⋮ 菜单（OverflowMenu），不再走独立下拉 ——
  // 这里删掉原「排序下拉（移动端）」整段；排序/视图切换改由下方 OverflowMenu 断言覆盖。
  // 移动端：整屏弹窗里组头同样是折叠开关，且收起态与文章页侧栏一致（偏好共用一份）
  w.feedlore.readerToggleGroupCollapse('科技');
  await sleep(20);
  C('#feedSelect').click();
  await sleep(20);
  t('频道下拉（移动端）：整屏弹窗延续收起态，少一屏滚动', () => {
    const g = C('#feedDD .dd-sheet-body .dd-group');
    if (!g || g.tagName !== 'BUTTON') throw new Error('组头应是按钮');
    if (!g.classList.contains('is-collapsed')) throw new Error('未延续 rdCollapsedGroups 的收起态');
    if (CA('#feedDD .dd-sheet .dd-item').length !== 2) throw new Error('收起后弹窗选项 ' + CA('#feedDD .dd-sheet .dd-item').length);
  });
  // 点组头展开后弹窗不该顺手关闭（折叠不是选择）
  C('#feedDD .dd-sheet-body .dd-group').click();
  await sleep(20);
  t('频道下拉（移动端）：点组头展开 —— 选项回 3 项且弹窗仍开着', () => {
    if (CA('#feedDD .dd-sheet .dd-item').length !== 3) throw new Error('展开后弹窗选项 ' + CA('#feedDD .dd-sheet .dd-item').length);
    if (!C('#feedDD .dd-mask')) throw new Error('折叠不该关闭弹窗');
    if (w.feedlore.readerCollapsedGroups().size !== 0) throw new Error('偏好未清空');
  });
  C('#feedDD .dd-sheet-close').click();
  await sleep(20);
  // 手势起点落在组头上：拖到底只该关弹窗，不该顺手把分组展开
  w.feedlore.readerToggleGroupCollapse('科技');
  await sleep(20);
  C('#feedSelect').click();
  await sleep(20);
  t('下拉手势：从组头起拖也能飞出', () => {
    const g = C('#feedDD .dd-sheet-body .dd-group');
    if (!g.classList.contains('is-collapsed')) throw new Error('前提：组应处于收起态');
    swipe(g, 100, [180, 240]);
    if (C('#feedDD .dd-sheet').style.transform !== 'translateY(100%)') throw new Error('应整块飞出: ' + C('#feedDD .dd-sheet').style.transform);
  });
  t('下拉手势：抬手补发的 click 落也在组头上同样被吞掉（没顺手展开）', () => {
    const g = C('#feedDD .dd-sheet-body .dd-group');
    g.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    if (!g.classList.contains('is-collapsed')) throw new Error('被吞的 click 把分组展开了');
    if (!C('#feedDD .dd-mask')) throw new Error('飞出动画跑完前不该卸载');
  });
  await sleep(240);
  t('下拉手势：从组头起拖松手后弹窗关闭，折叠态没被误改', () => {
    if (C('#feedDD .dd-mask')) throw new Error('未收起');
    if (!w.feedlore.readerCollapsedGroups().has('科技')) throw new Error('拖拽误改了折叠态');
  });
  // 还原：清空折叠，避免影响后续用例
  w.feedlore.readerToggleGroupCollapse('科技');
  await sleep(20);
  w.matchMedia = realMM;
  t('卡片内容：标题 / 来源短名 / 体积 / 日期（不再展示标签）', () => {
    const c1 = C('#grid .card[data-id="e1"]');
    if (c1.querySelector('.card-title').textContent !== '条目一') throw new Error('标题');
    if (c1.querySelector('.badge-source').textContent !== '例子星球') throw new Error('来源短名: ' + c1.querySelector('.badge-source').textContent);
    if (c1.querySelector('.badge-size').textContent !== '1.2G') throw new Error('体积');
    // v1.6.0：卡面标签移除 —— .mini-tag 只应出现在文章正文 .art-tags 内
    if (c1.querySelector('.mini-tag') || c1.querySelector('.card-tags')) throw new Error('卡面不应再有标签');
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
  t('「在文章页查看」→ jumpToFeed(频道, 条目) 且弹窗关闭', () => {
    if (C('.modal-mask')) throw new Error('弹窗未关闭');
    const hit = callsOf('jumpToFeed').find((c) => c[1] === '1');
    if (!hit) throw new Error('未跳到该频道');
    if (hit[2] !== 'e1') throw new Error('没带上要高亮的那条 id：' + hit[2]);
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

  // 移动端形态：同一组件切整屏弹层
  const realMM2 = w.matchMedia;
  w.matchMedia = (q) => ({ matches: /max-width:\s*720px/.test(q), addEventListener() {}, removeEventListener() {} });
  C('#grid .card[data-id="e1"] .title-btn').click();
  await sleep(60);
  t('移动端形态：详情整屏铺开（.dd-mask > .dd-sheet），带手势条、无标题栏 / 底栏', () => {
    if (!C('.dd-mask > .dd-sheet[role="dialog"]')) throw new Error('未整屏弹出');
    if (C('.modal-mask')) throw new Error('移动端不应再用居中模态');
    if (!C('.dd-sheet-grip')) throw new Error('往下拖就能收起，手势条是这枚提示');
    if (C('.dd-sheet .dd-sheet-head') || C('.dd-sheet .cd-foot')) throw new Error('整屏同样不再有标题栏 / 底栏');
    if (!C('.dd-sheet .cd-close')) throw new Error('整屏没有「点遮罩关闭」，右上角 × 是指针出口');
    if (!C('.dd-sheet .art-actions .btn-fav') || !C('.dd-sheet .art-actions .btn-jump')) throw new Error('动作行缺收藏 / 跳文章页');
  });
  t('下拉手势：正文滚到中部时不接管，不跟手', () => {
    const sc = C('.dd-sheet .dd-sheet-body');
    Object.defineProperty(sc, 'scrollTop', { value: 120, configurable: true });
    swipe(C('.dd-sheet'), 300, [420, 560]);
    if (C('.dd-sheet').style.transform !== '') throw new Error('列表还在滚动就不该抢走手势');
    if (!C('.dd-mask')) throw new Error('滚动中拖拽不该关闭弹窗');
    delete sc.scrollTop;
  });
  C('.dd-sheet .cd-close').click();
  await sleep(40);
  t('移动端：抽屉关闭按钮收起弹窗', () => {
    if (C('.dd-mask')) throw new Error('未关闭');
  });
  C('#grid .card[data-id="e1"] .title-btn').click();
  await sleep(60);
  t('下拉手势：整屏详情往下拖过阈值 → 整块飞出', () => {
    const sheet = C('.dd-sheet');
    swipe(sheet, 60, [200, 260]);
    if (sheet.style.transform !== 'translateY(100%)') throw new Error('超阈值应整块飞出: ' + sheet.style.transform);
    if (!C('.dd-mask')) throw new Error('飞出动画跑完前不该卸载');
  });
  await sleep(240);
  t('下拉手势：详情松手后收起弹窗', () => {
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

  // v1.6.0：顶部标签栏已移除，标签筛选入口下线（标签内容仅保留在文章正文）。

  // 视图切换（v1.6.0：从右侧 ⋮ 菜单切换，网格/列表不再是工具栏上的并排按钮）
  C('.overflow-btn').click();
  await sleep(30);
  t('⋯ 菜单：含视图切换项（网格态下显示「列表视图」）', () => {
    const items = CA('.overflow-menu .overflow-item');
    if (!items.some((b) => b.textContent.indexOf('列表视图') >= 0)) throw new Error('⋮ 菜单缺「列表视图」项');
  });
  CA('.overflow-menu .overflow-item').find((b) => b.textContent.indexOf('列表视图') >= 0).click();
  await sleep(40);
  t('列表视图切换：行渲染', () => {
    if (!C('#grid').classList.contains('list-mode')) throw new Error('未 list-mode');
    if (CA('#grid .row-item').length !== 2) throw new Error('行数 ' + CA('#grid .row-item').length);
  });
  // v1.7.0：列表行的宽度与按钮尺寸（列表视图溢出的两道防线）
  t('列表视图：行不超出容器 + 复制/打开按钮是同尺寸方块', () => {
    const row = C('#grid .row-item');
    const grid = C('#grid');
    const gridRect = grid.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.right > gridRect.right + 1) {
      throw new Error('列表行超出容器：row.right=' + Math.round(rowRect.right) + ' > grid.right=' + Math.round(gridRect.right));
    }
    const copy = row.querySelector('.row-actions .btn-copy');
    const open = row.querySelector('.row-actions .btn-open');
    if (!copy) throw new Error('列表行缺复制按钮');
    const cw = copy.getBoundingClientRect().width;
    const ch = copy.getBoundingClientRect().height;
    if (cw > 40 || ch > 40) throw new Error('复制按钮不是紧凑方块：' + Math.round(cw) + '×' + Math.round(ch));
    if (open) {
      const ow = open.getBoundingClientRect().width;
      if (Math.abs(ow - cw) > 1) throw new Error('复制与打开按钮尺寸不一致：' + Math.round(cw) + ' vs ' + Math.round(ow));
    }
  });
  C('.overflow-btn').click();
  await sleep(30);
  const gridItem = CA('.overflow-menu .overflow-item').find((b) => b.textContent.indexOf('网格视图') >= 0);
  if (gridItem) gridItem.click();
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

  // 自动加载（v1.6.0-test5）：「加载更多」按钮已整体移除，只剩滚动哨兵与加载圆点
  w.feedlore.state.hasMore = true; cardsTick();
  await sleep(30);
  t('自动加载：无手动按钮、哨兵存在', () => {
    if (C('#loadMoreBtn')) throw new Error('「加载更多」按钮残留');
    if (!C('#cardsSentinel')) throw new Error('缺滚动哨兵 #cardsSentinel');
    if (!C('.loadmore-wrap #loadingMore')) throw new Error('缺加载圆点');
  });

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

  // ---- 窄屏频道抽屉（v1.3.10）：卡片页改成与文章页同一套「标题栏 + 抽屉」----
  w.feedlore.state.feedList = [
    { id: '1', title: '例子星球', customTitle: null, cardEnabled: true, enabled: true, entryCount: 12, groupName: '科技' },
    { id: '2', title: 'demo', customTitle: null, cardEnabled: true, enabled: true, entryCount: 4, groupName: '' },
  ];
  w.feedlore.state.feedMeta = { total: 2, enabled: 2, cardEnabled: 2 };
  w.feedlore.state.feedFilter = null;
  w.feedlore.state.entries = miniEntriesAll();
  cardsTick();
  await sleep(40);

  t('标题栏：频道开关 / 标题 / 放大镜三件套齐全', () => {
    if (!C('#cardsMenuBtn')) throw new Error('缺「频道」开关');
    if (!C('#cardsSearchToggle')) throw new Error('缺放大镜');
    if (!C('.cards-title')) throw new Error('缺标题');
    if (!C('.cards-head').contains(C('#cardsMenuBtn'))) throw new Error('「频道」不在标题栏里');
  });

  t('频道抽屉：默认收起，点「频道」打开、再点收起', () => {
    if (!C('#cardsSide')) throw new Error('缺抽屉容器');
    if (w.document.body.classList.contains('cards-drawer-open')) throw new Error('默认就打开了');
    C('#cardsMenuBtn').click();
    if (!w.document.body.classList.contains('cards-drawer-open')) throw new Error('点了没打开');
    C('#cardsMenuBtn').click();
    if (w.document.body.classList.contains('cards-drawer-open')) throw new Error('再点没收起');
  });

  t('频道抽屉：「全部频道」+ 频道行（含分组与条数）', () => {
    const rows = CA('#cardsChannels .rd-ch');
    // 全部 + 2 个启用卡片的频道
    if (rows.length !== 3) throw new Error('行数 ' + rows.length + '：' + rows.map((r) => r.getAttribute('data-feed')).join(','));
    const all = rows.find((r) => r.getAttribute('data-feed') === '');
    if (!all || all.textContent.indexOf('全部频道') < 0) throw new Error('缺「全部频道」入口');
    if (!all.classList.contains('active')) throw new Error('未选中时「全部频道」应高亮');
    if (all.textContent.indexOf('16') < 0) throw new Error('「全部频道」应显示总条数 16：' + all.textContent);
    const f1 = rows.find((r) => r.getAttribute('data-feed') === '1');
    if (!f1) throw new Error('缺频道 1');
    if (f1.textContent.indexOf('12') < 0) throw new Error('频道行应带条数：' + f1.textContent);
    if (!CA('#cardsChannels .rd-ch-group').length) throw new Error('有分组时应画组头');
  });

  t('频道抽屉：点频道 → 按该频道过滤并收起抽屉', () => {
    C('#cardsMenuBtn').click();
    CA('#cardsChannels .rd-ch').find((r) => r.getAttribute('data-feed') === '1').click();
    const fed = w.feedlore.state.feedFilter;
    if (String(fed) !== '1') throw new Error('未按频道过滤：' + fed);
    if (w.document.body.classList.contains('cards-drawer-open')) throw new Error('选完应自动收起');
  });
  await sleep(40);
  w.feedlore.state.feedFilter = null;
  w.feedlore.state.entries = miniEntriesAll();
  cardsTick();
  await sleep(30);

  t('频道抽屉：关闭按钮与遮罩都能收起', () => {
    C('#cardsMenuBtn').click();
    C('#cardsSideClose').click();
    if (w.document.body.classList.contains('cards-drawer-open')) throw new Error('关闭按钮没生效');
    C('#cardsMenuBtn').click();
    C('#cardsMask').click();
    if (w.document.body.classList.contains('cards-drawer-open')) throw new Error('点遮罩没生效');
  });

  t('频道抽屉：添加频道 → 收起并打开数据源设置', () => {
    const before = callsOf('readerOpenSource').length;
    C('#cardsMenuBtn').click();
    C('#cardsChannels .rd-ch-add').click();
    if (w.document.body.classList.contains('cards-drawer-open')) throw new Error('没收起');
    if (callsOf('readerOpenSource').length === before) throw new Error('未打开数据源设置');
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
    if (RA('#readerChannels .rd-ch').length !== 7) throw new Error('频道项 ' + RA('#readerChannels .rd-ch').length);   // 3 范围 + 关注 + 屏蔽 + 2 频道
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
  t('P1 键盘光标：rdCursor 指到的条目带 .kbd-cursor，置空即清除', async () => {
    w.feedlore.state.rdCursor = 'r1'; readerTick(); await sleep(30);
    const cur = R('.art-item.kbd-cursor');
    if (!cur || cur.getAttribute('data-id') !== 'r1') throw new Error('光标类缺失或错位');
    w.feedlore.state.rdCursor = null; readerTick(); await sleep(30);
    if (R('.art-item.kbd-cursor')) throw new Error('光标应随 null 清除');
  });
  t('列表项内容与状态类', () => {
    const it1 = R('#readerList .art-item[data-id="r1"]');
    if (!it1.classList.contains('is-unread')) throw new Error('r1 应未读');
    if (it1.querySelector('.art-title').textContent !== '文章一') throw new Error('标题');
    if (it1.querySelector('.src-pill').textContent !== '例子星球') throw new Error('来源短名: ' + it1.querySelector('.src-pill').textContent);
    const it2 = R('#readerList .art-item[data-id="r2"]');
    if (!it2.classList.contains('is-read') || !it2.classList.contains('is-fav')) throw new Error('r2 状态类不符');
  });

  // 卡片页跳过来的那条：高亮类只跟着 state.rdFlashId 走（React 每帧重写 className）
  t('默认无高亮：列表里没有 is-flash', () => {
    if (document.querySelectorAll('#readerList .art-item.is-flash').length !== 0) throw new Error('不该有高亮');
  });
  w.feedlore.state.rdFlashId = 'r1';
  readerTick();
  await sleep(40);
  t('rdFlashId 只点亮对应文章框', () => {
    const on = [...document.querySelectorAll('#readerList .art-item.is-flash')];
    if (on.length !== 1) throw new Error('高亮项数 ' + on.length);
    if (on[0].getAttribute('data-id') !== 'r1') throw new Error('高亮了 ' + on[0].getAttribute('data-id'));
  });
  w.feedlore.state.rdFlashId = null;
  readerTick();
  await sleep(40);
  t('rdFlashId 清空后高亮消失', () => {
    if (document.querySelectorAll('#readerList .art-item.is-flash').length !== 0) throw new Error('高亮未清除');
  });

  // 搜索框非受控：外部（jumpToFeed 跳过来时）改 rdQ 必须把框刷回去，否则旧关键词还挂在框上
  w.feedlore.state.rdQ = '旧关键词';
  readerTick();
  await sleep(40);
  t('外部改 rdQ → 搜索框跟随、清除键出现', () => {
    if (R('#readerSearch').value !== '旧关键词') throw new Error('框里还是 ' + JSON.stringify(R('#readerSearch').value));
    if (R('.reader-search-clear').hidden) throw new Error('清除键应显示');
  });
  w.feedlore.state.rdQ = '';
  readerTick();
  await sleep(40);
  t('外部清空 rdQ → 搜索框一起清空（跳转过来的路径靠这条）', () => {
    if (R('#readerSearch').value !== '') throw new Error('框里残留 ' + JSON.stringify(R('#readerSearch').value));
    if (!R('.reader-search-clear').hidden) throw new Error('清除键应隐藏');
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

  // 前后篇导航（v1.7.0）：正文底部接续，r1 是第一条 → 只有「下一篇」
  t('前后篇导航：正文底部出现 .art-nav，第一篇只有「下一篇」', () => {
    const nav = R('#readerList .art-item[data-id="r1"] .art-nav');
    if (!nav) throw new Error('缺 .art-nav');
    if (nav.querySelector('.art-nav-btn.is-prev')) throw new Error('第一篇不该有「上一篇」');
    const next = nav.querySelector('.art-nav-btn.is-next');
    if (!next) throw new Error('缺「下一篇」');
    if (next.textContent.indexOf('下一篇') < 0) throw new Error('文案: ' + next.textContent);
  });
  t('点「下一篇」→ readerGotoArt(下一条) + 目标篇展开', async () => {
    const btn = R('#readerList .art-item[data-id="r1"] .art-nav-btn.is-next');
    btn.click();
    await sleep(40);
    if (!callsOf('readerGotoArt').some((c) => c[1] === 'r2')) throw new Error('未跳到 r2');
    if (!R('#readerList .art-item[data-id="r2"]').classList.contains('open')) throw new Error('r2 未展开');
    const nav2 = R('#readerList .art-item[data-id="r2"] .art-nav');
    if (!nav2 || !nav2.querySelector('.art-nav-btn.is-prev')) throw new Error('第二篇应有「上一篇」');
  });

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

  // v1.6.0-test5：关注 / 屏蔽虚拟视图行 —— 关注与范围行同排，屏蔽置底（最后一个 .rd-ch）
  t('频道栏：关注 / 屏蔽虚拟视图行', () => {
    const watchRow = R('#readerChannels .rd-ch[data-watch="watch"]');
    const blockRow = R('#readerChannels .rd-ch[data-watch="block"]');
    if (!watchRow || !blockRow) throw new Error('缺关注/屏蔽行');
    const all = RA('#readerChannels .rd-ch');
    if (all[all.length - 1] !== blockRow) throw new Error('屏蔽行不在底部');
    if (all.indexOf(watchRow) !== 3) throw new Error('关注行应紧跟三个范围行');
  });
  R('#readerChannels .rd-ch[data-watch="watch"]').click();
  await sleep(30);
  t('关注行 → readerSetWatch(watch) + 高亮', () => {
    if (!callsOf('readerSetWatch').some((c) => c[1] === 'watch')) throw new Error('未触发');
    if (!R('#readerChannels .rd-ch[data-watch="watch"]').classList.contains('active')) throw new Error('未高亮');
    if (R('#readerTitle').textContent !== '关注') throw new Error('标题: ' + R('#readerTitle').textContent);
  });
  R('#readerChannels .rd-ch[data-watch="watch"]').click();
  await sleep(30);
  t('再点关注行 → 退出聚合视图', () => {
    if (R('#readerChannels .rd-ch[data-watch="watch"]').classList.contains('active')) throw new Error('仍高亮');
  });

  // 频道切换（按 data-feed 选真频道：前面插了「关注」虚拟行，索引会漂）
  R('#readerChannels .rd-ch[data-feed]').click();
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
  w.feedlore.state.rdScope = 'unread'; w.feedlore.state.rdFeedId = null; w.feedlore.state.rdGroup = null; w.feedlore.state.rdWatch = null;
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

  // ============ 阅读页频道栏：分组折叠 + 拖宽（v1.4.0-test） ============
  w.feedlore.state.rdQ = '';
  w.feedlore.state.rdFeedId = null;
  w.feedlore.state.rdGroup = null;
  w.feedlore.state.rdCollapsedGroups = [];
  w.feedlore.state.readerSideWidth = 232;
  w.feedlore.state.feedList = [
    { id: '1', title: '例子星球', customTitle: null, cardEnabled: true, enabled: true, entryCount: 12, unreadCount: 3, groupName: '科技' },
    { id: '3', title: '科技二手', customTitle: null, cardEnabled: true, enabled: true, entryCount: 5, unreadCount: 2, groupName: '科技' },
    { id: '2', title: 'demo', customTitle: null, cardEnabled: true, enabled: true, entryCount: 4, unreadCount: 0, groupName: '' },
  ];
  w.feedlore.state.rdEntries = READER_ENTRIES();
  readerTick();
  await sleep(50);
  const feedRows = () => RA('#readerChannels .rd-ch[data-feed]');
  // 整行就是折叠开关（.rd-ch-group 带 data-group-fold），筛选让位给右端那枚漏斗
  const foldBtn = (g) => R(`#readerChannels .rd-ch-group[data-group-fold="${g}"]`);
  const filterBtn = (g) => R(`#readerChannels .rd-ch-filter[data-group-filter="${g}"]`);

  t('频道栏基线：两个分组 3 个频道全展开', () => {
    if (feedRows().length !== 3) throw new Error('频道行 ' + feedRows().length);
    if (RA('#readerChannels .rd-ch-group').length !== 2) throw new Error('组行 ' + RA('#readerChannels .rd-ch-group').length);
    if (RA('#readerChannels .rd-ch-filter').length !== 2) throw new Error('漏斗 ' + RA('#readerChannels .rd-ch-filter').length);
  });

  foldBtn('科技').click();
  await sleep(40);
  t('点组头整行：只收起该组的频道行，且不触发筛选', () => {
    if (!callsOf('readerToggleGroupCollapse').some((c) => c[1] === '科技')) throw new Error('未调用桥');
    if (callsOf('readerSetGroup').length) throw new Error('点组名连带触发了筛选');
    const ids = feedRows().map((el) => el.getAttribute('data-feed'));
    if (ids.join(',') !== '2') throw new Error('剩余频道行: ' + ids.join(','));
    if (!R('#readerChannels .rd-ch-group-row.is-collapsed')) throw new Error('组行缺 is-collapsed');
    if (foldBtn('科技').getAttribute('aria-expanded') !== 'false') throw new Error('aria-expanded 未跟上');
  });
  t('折叠态组头仍汇总未读数（收起不等于没新东西）', () => {
    const badge = R('#readerChannels .rd-ch-group[data-group="科技"] .rd-ch-n.hot');
    if (!badge) throw new Error('折叠后未读徽标消失');
    if (badge.textContent !== '5') throw new Error('未读汇总: ' + badge.textContent);
  });
  foldBtn('科技').click();
  await sleep(40);
  t('再点折叠键：该组频道行回来', () => {
    if (feedRows().length !== 3) throw new Error('频道行 ' + feedRows().length);
    if (R('#readerChannels .rd-ch-group-row.is-collapsed')) throw new Error('仍是折叠态');
  });

  // 全已读的组收起后，徽标位改报频道数（没有未读可报时也要有信息）
  w.feedlore.state.rdCollapsedGroups = [''];
  readerTick();
  await sleep(40);
  t('全已读组折叠时显示组内频道数', () => {
    const n = R('#readerChannels .rd-ch-group[data-group=""] .rd-ch-group-n');
    if (!n) throw new Error('无 .rd-ch-group-n');
    if (n.textContent !== '1') throw new Error('频道数: ' + n.textContent);
  });
  w.feedlore.state.rdCollapsedGroups = [];
  readerTick();
  await sleep(40);

  R('#readerFoldAll').click();
  await sleep(40);
  t('「收起全部分组」：频道行全消失 + 按钮换成展开态图标', () => {
    if (!callsOf('readerToggleAllGroups').length) throw new Error('未调用桥');
    if (feedRows().length !== 0) throw new Error('仍有 ' + feedRows().length + ' 行');
    const b = R('#readerFoldAll');
    if (b.title !== '展开全部分组') throw new Error('title: ' + b.title);
    if (b.querySelector('use').getAttribute('href') !== '#i-chevrons-down') throw new Error('图标未切换');
  });
  R('#readerFoldAll').click();
  await sleep(40);
  t('再点「展开全部分组」：频道行全回来', () => {
    if (feedRows().length !== 3) throw new Error('频道行 ' + feedRows().length);
    if (R('#readerFoldAll').querySelector('use').getAttribute('href') !== '#i-chevrons-up') throw new Error('图标未回切');
  });

  // 筛选让位给右端漏斗：点漏斗才筛选，两者互不牵连
  filterBtn('科技').click();
  await sleep(40);
  t('点漏斗：只看该组，且频道行不因筛选而收起', () => {
    if (!callsOf('readerSetGroup').some((c) => c[1] === '科技')) throw new Error('未调用筛选桥');
    if (w.feedlore.state.rdGroup !== '科技') throw new Error('rdGroup: ' + w.feedlore.state.rdGroup);
    if (!R('#readerChannels .rd-ch-group-row.is-filtered')) throw new Error('组行缺 is-filtered');
    if (filterBtn('科技').getAttribute('aria-pressed') !== 'true') throw new Error('aria-pressed 未跟上');
    if (feedRows().length !== 3) throw new Error('筛选把频道行收掉了: ' + feedRows().length);
  });
  filterBtn('科技').click();
  await sleep(40);
  t('再点同一个漏斗：取消筛选（漏斗是开关，不是单向）', () => {
    if (w.feedlore.state.rdGroup !== null) throw new Error('仍锁在 ' + w.feedlore.state.rdGroup);
    if (R('#readerChannels .rd-ch-group-row.is-filtered')) throw new Error('仍挂着 is-filtered');
    if (filterBtn('科技').getAttribute('aria-pressed') !== 'false') throw new Error('aria-pressed 未回到 false');
  });

  // 收起的组里若正看着其中一条，那一条必须还在（否则「我在读哪个频道」从界面上消失）
  w.feedlore.state.rdFeedId = 1;
  w.feedlore.state.rdCollapsedGroups = ['科技'];
  readerTick();
  await sleep(40);
  t('折叠组含当前频道：只留那一条，同组其它仍收起', () => {
    const ids = feedRows().map((el) => el.getAttribute('data-feed'));
    // 科技组收起后只露出正在看的 1；同组的 3 仍隐藏；未折叠的 '' 组照常显示 2
    if (ids.join(',') !== '1,2') throw new Error('频道行: ' + ids.join(','));
    if (!R('#readerChannels .rd-ch[data-feed="1"].active')) throw new Error('当前频道未高亮');
  });
  w.feedlore.state.rdFeedId = null;
  w.feedlore.state.rdCollapsedGroups = [];
  readerTick();
  await sleep(40);

  // ---- 拖宽分隔条 ----
  const side = R('#readerSide');
  side.getBoundingClientRect = () => ({ width: 232, height: 300, top: 0, left: 0, right: 232, bottom: 300, x: 0, y: 0 });
  const rail = R('#readerResize');
  t('分隔条存在且可聚焦（键盘也能调宽）', () => {
    if (!rail) throw new Error('无 #readerResize');
    if (rail.getAttribute('role') !== 'separator') throw new Error('role: ' + rail.getAttribute('role'));
    if (rail.getAttribute('tabindex') !== '0') throw new Error('不可聚焦');
  });
  rail.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 240, clientY: 100 }));
  w.dispatchEvent(new w.MouseEvent('pointermove', { bubbles: true, clientX: 266, clientY: 100 }));
  t('拖拽跟手：CSS 变量随移动实时更新（不走 React 重渲染）', () => {
    // 起始宽度 232（测得）+ dx (266-240) = 258
    if (document.documentElement.style.getPropertyValue('--reader-side-w') !== '258px') {
      throw new Error('当前值: ' + document.documentElement.style.getPropertyValue('--reader-side-w'));
    }
  });
  t('拖拽中不落偏好：只有松手才写一次', () => {
    if (callsOf('setReaderSideWidth').length) throw new Error('拖拽途中就落了宽度');
  });
  w.dispatchEvent(new w.MouseEvent('pointermove', { bubbles: true, clientX: 290, clientY: 100 }));
  w.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, clientX: 290, clientY: 100 }));
  await sleep(40);
  t('松手才落一次宽度：232 + 50 = 282', () => {
    const set = callsOf('setReaderSideWidth');
    if (!set.length) throw new Error('未落宽度');
    if (set[set.length - 1][1] !== 282) throw new Error('值: ' + set[set.length - 1][1]);
  });
  rail.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 100 }));
  w.dispatchEvent(new w.MouseEvent('pointermove', { bubbles: true, clientX: 4000, clientY: 100 }));
  w.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, clientX: 4000, clientY: 100 }));
  await sleep(40);
  t('往右拖过头：收到自适应上限（40vw 与 400px 取小）', () => {
    const want = Math.max(180, Math.min(400, Math.floor((w.innerWidth || 1024) * 0.4)));
    const got = document.documentElement.style.getPropertyValue('--reader-side-w');
    if (got !== want + 'px') throw new Error('实际 ' + got + '，期望 ' + want + 'px');
  });
  rail.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 900, clientY: 100 }));
  w.dispatchEvent(new w.MouseEvent('pointermove', { bubbles: true, clientX: -900, clientY: 100 }));
  w.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, clientX: -900, clientY: 100 }));
  await sleep(40);
  t('往左拖过头：收在下限 180px，不会把频道名挤没', () => {
    if (document.documentElement.style.getPropertyValue('--reader-side-w') !== '180px') {
      throw new Error('实际 ' + document.documentElement.style.getPropertyValue('--reader-side-w'));
    }
  });
  rail.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await sleep(40);
  t('双击分隔条：复位默认 232 并提示', () => {
    const set = callsOf('setReaderSideWidth');
    if (set[set.length - 1][1] !== 232) throw new Error('值: ' + set[set.length - 1][1]);
    if (document.documentElement.style.getPropertyValue('--reader-side-w') !== '232px') throw new Error('CSS 变量未复位');
    if (!callsOf('toast').some((c) => String(c[1]).indexOf('频道栏宽度已恢复默认') === 0)) throw new Error('无 toast');
  });
  rail.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
  await sleep(40);
  t('方向键调宽：→ 加一档 16px', () => {
    const set = callsOf('setReaderSideWidth');
    if (set[set.length - 1][1] !== 248) throw new Error('值: ' + set[set.length - 1][1]);
  });
  rail.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'Home' }));
  await sleep(40);
  t('Home 键回到默认宽度', () => {
    const set = callsOf('setReaderSideWidth');
    if (set[set.length - 1][1] !== 232) throw new Error('值: ' + set[set.length - 1][1]);
  });

  // ---- 性能改动的静态守卫（改了实现就要保住这些约束） ----
  t('源码守卫：列表项全部 memo 化，回调不再是行内箭头函数', () => {
    const root = path.join(__dirname, '..', '..');
    const rv = fs.readFileSync(path.join(root, 'src', 'views', 'ReaderView.jsx'), 'utf8');
    if (rv.indexOf('const ArtItem = memo(') < 0) throw new Error('ArtItem 未 memo');
    if (/onToggle=\{\(id\)/.test(rv) || /onFav=\{\(id\)/.test(rv)) throw new Error('条目回调仍是行内函数，memo 会失效');
    if (rv.indexOf('useCallback((id)') < 0) throw new Error('回调未 useCallback 化');
    const cv = fs.readFileSync(path.join(root, 'src', 'views', 'CardsView.jsx'), 'utf8');
    if (cv.indexOf('const Card = memo(') < 0 || cv.indexOf('const Row = memo(') < 0) throw new Error('卡片 / 行未 memo');
    if (/onOpen=\{\(x\)/.test(cv)) throw new Error('卡片回调仍是行内函数');
  });
  t('源码守卫：条目状态一律换新对象（原地改字段会让 memo 漏掉更新）', () => {
    const root = path.join(__dirname, '..', '..');
    const rd = fs.readFileSync(path.join(root, 'src', 'core', 'reader.js'), 'utf8');
    const fn = rd.match(/function applyEntryFlag\([\s\S]*?\n\}/);
    if (!fn) throw new Error('找不到 applyEntryFlag');
    if (/e\.isRead = |e\.isFavorite = /.test(fn[0])) throw new Error('applyEntryFlag 仍在原地改条目字段');
    if (rd.indexOf('state.rdEntries = replaceEntry(') < 0) throw new Error('阅读页条目未换新对象');
    const ui = fs.readFileSync(path.join(root, 'src', 'core', 'ui.js'), 'utf8');
    if (ui.indexOf('Object.assign(e, patch)') >= 0) throw new Error('卡片条目仍在原地改对象');
  });
  // 两套 sanitizer 必须同构：漏一边的键，刷新后会被另一边的默认值悄悄抹掉
  // （digestEnabled 就是这样——服务端不认这个键，关一次等于没关）
  t('源码守卫：布局偏好默认键服务端与前端一致', () => {
    const root = path.join(__dirname, '..', '..');
    const keysOf = (file, marker) => {
      const src = fs.readFileSync(path.join(root, file), 'utf8');
      const at = src.indexOf(marker);
      if (at < 0) throw new Error(file + ' 找不到 ' + marker);
      const body = src.slice(at + marker.length, src.indexOf('};', at));
      return [...body.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]).sort().join();
    };
    const server = keysOf(path.join('lib', 'prefs.js'), 'LAYOUT_DEFAULTS = {');
    const client = keysOf(path.join('src', 'core', 'state.js'), 'LAYOUT_DEFAULTS = {');
    if (server !== client) throw new Error('服务端 ' + server + ' / 前端 ' + client);
    if (server.indexOf('digestEnabled') < 0) throw new Error('两边都缺 digestEnabled？');
  });
  t('style.css：栏宽走 --reader-side-w，列表视图也跳过离屏渲染', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    const m = css.match(/\.reader\s*>\s*#readerRoot\s*\{([^}]*)\}/);
    if (!m) throw new Error('缺 .reader > #readerRoot 规则');
    if (m[1].indexOf('var(--reader-side-w)') < 0) throw new Error('#readerRoot 未引用栏宽变量：' + m[1].trim());
    if (/grid-template-columns:\s*232px/.test(css)) throw new Error('仍有写死的 232px 列宽');
    if (!/^\s*--reader-side-w:/m.test(css)) throw new Error(':root 缺 --reader-side-w 初值');
    const row = css.match(/\.row-item\s*\{([^}]*)\}/);
    if (!row || row[1].indexOf('content-visibility') < 0) throw new Error('.row-item 未做离屏跳过');
    const resize = css.match(/\.reader-resize\s*\{([^}]*)\}/);
    if (!resize) throw new Error('缺 .reader-resize 规则');
    if (resize[1].indexOf('col-resize') < 0) throw new Error('分隔条应有 col-resize 光标');
  });
  // 目录树层级：组头贴左，频道行缩进到组名起线（折叠键 18 + 间隙 4 = 22px）。
  // 层级只靠这条起线表达，所以组名左侧那条 3px 色块不能长回来，
  // 且缩进只能落在 data-feed 上 —— 顶部三个固定入口不属于任何分组。
  t('style.css：频道栏目录树层级（组头贴左 + 频道缩进 22px）', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    const feed = css.match(/\.rd-ch\[data-feed\]\s*\{([^}]*)\}/);
    if (!feed) throw new Error('缺 .rd-ch[data-feed] 缩进规则');
    if (!/padding-left:\s*22px/.test(feed[1])) throw new Error('频道未缩进 22px：' + feed[1].trim());
    const grp = css.match(/\.rd-ch-group\s*\{([^}]*)\}/);
    if (!grp) throw new Error('缺 .rd-ch-group 规则');
    if (/padding:\s*var\(--sp-3\)\s+var\(--sp-2\)/.test(grp[1])) throw new Error('组头仍有左内边距，没贴左');
    if (/\.rd-ch-group::before/.test(css)) throw new Error('组名左侧的 3px 色块又长回来了（层级已由缩进表达）');
    if (/has-unread/.test(css)) throw new Error('.has-unread 已无样式，别再留在 CSS 里');
    const jsx = fs.readFileSync(path.join(root, 'src', 'views', 'ReaderView.jsx'), 'utf8');
    if (/has-unread/.test(jsx)) throw new Error('ReaderView 仍渲染死类 has-unread');
  });
  // 折叠的命中区是整行，漏斗只在悬停 / 键盘聚焦时现身；触屏没有 hover，必须常显。
  // 这三条都是「看不见就等于坏掉」的规则，写死在测试里防止后续改动悄悄退化。
  t('style.css：整行折叠 + 悬停浮现漏斗（触屏常显）', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    if (/\.rd-ch-fold\b/.test(css)) throw new Error('.rd-ch-fold 已被整行折叠取代，别再留死类');
    const row = css.match(/\.rd-ch-group-row\s*\{([^}]*)\}/);
    if (!row || row[1].indexOf('position: relative') < 0) throw new Error('组行要 relative，漏斗才有定位父');
    if (!/\.rd-ch-group-row:hover\s*\{[^}]*var\(--hover\)/.test(css)) throw new Error('整行悬停没有底色，看不出可点');
    const f = css.match(/\.rd-ch-filter\s*\{([^}]*)\}/);
    if (!f) throw new Error('缺 .rd-ch-filter 规则');
    if (f[1].indexOf('opacity: 0') < 0) throw new Error('漏斗默认应隐身，别常年占着右端');
    if (!/\.rd-ch-group-row:is\(:hover, :focus-within\)\s*\.rd-ch-filter\s*\{[^}]*opacity: 1/.test(css)) {
      throw new Error('悬停 / 键盘聚焦没让漏斗现身（键盘用户点不到「只看这组」）');
    }
    if (!/@media \(hover: none\)[\s\S]*?\.rd-ch-filter\s*\{[^}]*opacity: 1/.test(css)) {
      throw new Error('触屏没有 hover，漏斗必须常显');
    }
  });

  // 吸顶与动作行对齐都是「一眼看得出没对上，但代码改回去没人会发现」的规则，
  // 所以钉在这里：吸顶必须在基础规则里（桌面也要吸顶，只剩移动端那份等于没做），
  // 动作行右对齐必须带一份窄屏回退（移动端复制键独占一行，右对齐反而更别扭）。
  t('style.css：阅读页头部整条吸顶写在基础规则里（桌面也生效）', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    const head = css.match(/\.reader-head\s*\{([^}]*)\}/);
    if (!head) throw new Error('缺 .reader-head 基础规则');
    if (head[1].indexOf('position: sticky') < 0) throw new Error('头部基础规则没吸顶（桌面端标题会跟着文章滚走）');
    // v1.6.0：合并后这一行就是最顶层吸顶条，贴 top:0（自身高度写进 --topbar-h 供 Row2 用）
    if (!/top:\s*0/.test(head[1])) throw new Error('合并后头部应自己贴顶（top:0）');
    if (head[1].indexOf('background: var(--bg)') < 0) throw new Error('吸顶底色必须不透明，否则文章从头部底下透出来');
    const dup = [...css.matchAll(/\.reader-head\s*\{([^}]*)\}/g)];
    if (dup.length > 1 && dup.slice(1).some((m) => /position:\s*sticky/.test(m[1]))) {
      throw new Error('.reader-head 的吸顶在别处又写了一份（基础规则已负责，两处会漂）');
    }
    if (dup.length < 2) throw new Error('窄屏那份 .reader-head 内边距覆盖不见了');
  });

  t('style.css：正文动作行靠右下（桌面与窄屏同一套）', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    const acts = css.match(/\.art-actions\s*\{([^}]*)\}/);
    if (!acts) throw new Error('缺 .art-actions 基础规则');
    if (acts[1].indexOf('justify-content: flex-end') < 0) throw new Error('动作键没靠右（读完正文视线落在末尾，按钮应在落点）');
    // 窄屏不再回退靠左：移动端读正文一样是「读完 → 视线落在末尾」
    if (/\.art-actions\s*\{[^}]*justify-content: flex-start/.test(css)) {
      throw new Error('窄屏把动作键拉回靠左了（移动端也要靠右下）');
    }
    // 卡片详情复用同一族 .art-* 样式：不该再另造一个动作行类名
    const cd = fs.readFileSync(path.join(root, 'src', 'views', 'CardDetail.jsx'), 'utf8');
    if (cd.indexOf('className="art-actions"') < 0) throw new Error('卡片详情没复用 .art-actions，两处动作行会各改一半');
  });

  // ============ App Shell 顶栏（P4a React 化） ============
  __mountTopBar(document.getElementById('topbarRoot'));
  await sleep(40);
  const S = (sel) => document.querySelector(sel);
  const navBtns = () => [...document.querySelectorAll('#viewNav .viewnav-btn')];

  t('顶栏渲染：品牌 / 三个导航 / 按钮', () => {
    if (!S('#topbarRoot .topbar-inner')) throw new Error('无 .topbar-inner');
    if (!S('#topbarRoot .brand-logo')) throw new Error('无 logo');
    if (navBtns().length !== 3) throw new Error('导航按钮 ' + navBtns().length);
    if (S('#subtitle').textContent !== '拾取值得读的 · 采集 2/3 个频道') throw new Error('subtitle: ' + S('#subtitle').textContent);
    for (const id of ['refreshBtn', 'themeBtn', 'settingsBtn']) if (!S('#' + id)) throw new Error('缺 #' + id);
  });
  t('导航高亮跟随 view（reader）', () => {
    const a = navBtns().filter((b) => b.classList.contains('active')).map((b) => b.getAttribute('data-view'));
    if (a.join() !== 'reader') throw new Error('active: ' + a.join());
  });
  t('顶栏不再渲染「条资源」统计', () => {
    if (S('#stat') || S('#topbarRoot .stat')) throw new Error('条资源统计应已移除');
  });

  // 日报开关（账号级）：入口整枚消失，不是灰着 —— 留着只会让人以为点坏了
  shellSnap.digestVisible = false;
  shellTick();
  await sleep(20);
  t('日报关闭：顶栏不渲染「日报」入口（不是 disabled）', () => {
    const ids = navBtns().map((b) => b.getAttribute('data-view'));
    if (ids.length !== 2) throw new Error('导航按钮: ' + ids.join());
    if (ids.indexOf('ai') >= 0) throw new Error('日报入口仍在');
    if (navBtns().some((b) => b.disabled)) throw new Error('不该出现禁用态');
  });
  shellSnap.digestVisible = true;
  shellTick();
  await sleep(20);
  t('日报重新开启：入口回来', () => {
    const ids = navBtns().map((b) => b.getAttribute('data-view'));
    if (ids.indexOf('ai') < 0) throw new Error('导航按钮: ' + ids.join());
  });

  navBtns()[1].click();
  await sleep(20);
  t('点「卡片」→ switchView(cards)', () => {
    if (!callsOf('switchView').some((c) => c[1] === 'cards')) throw new Error('未触发');
  });
  t('切卡片后：卡片高亮', () => {
    if (!navBtns()[1].classList.contains('active')) throw new Error('卡片未高亮');
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
  t('toast：失败态带 .err 且无 .ok', () => {
    const el = O('.toast');
    if (el.className !== 'toast show err') throw new Error('class: ' + el.className);
    if (!O('.toast .toast-ico.err')) throw new Error('失败态应换成警示图标');
    if (el.getAttribute('role') !== 'status' || el.getAttribute('aria-live') !== 'polite') throw new Error('缺 aria-live 播报');
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

  // v1.6.0-test4：同一篇正文多图时给 ← → 与序号；点翻页不能把灯箱关掉（stopPropagation）
  overlayState.box = { src: 'https://example.com/b.png', show: true,
    list: ['https://example.com/a.png', 'https://example.com/b.png', 'https://example.com/c.png'], index: 1 };
  overlaysTick();
  await sleep(20);
  t('灯箱：多图渲染翻页控件与序号', () => {
    const prev = O('.lightbox-nav.is-prev'); const next = O('.lightbox-nav.is-next');
    if (!prev || !next) throw new Error('缺翻页按钮');
    if ((prev.getAttribute('aria-label') || '') !== '上一张') throw new Error('上一张 aria-label 不对');
    const cnt = O('.lightbox-count');
    if (!cnt || cnt.textContent.replace(/\s+/g, '') !== '2/3') throw new Error('序号不对：' + (cnt && cnt.textContent));
    if (O('.lightbox').getAttribute('aria-label').indexOf('第 2 张') < 0) throw new Error('对话框名未带序号');
  });
  const closeBeforeStep = callsOf('closeLightbox').length;
  O('.lightbox-nav.is-next').click();
  await sleep(10);
  t('灯箱：点翻页触发 stepLightbox(1) 且不关闭', () => {
    const st = callsOf('stepLightbox');
    if (!st.length || st[st.length - 1][1] !== 1) throw new Error('未触发 stepLightbox(1)');
    if (callsOf('closeLightbox').length !== closeBeforeStep) throw new Error('翻页把灯箱关掉了（缺 stopPropagation）');
  });
  overlayState.box = { src: 'https://example.com/a.png', show: true, list: ['https://example.com/a.png'], index: 0 };
  overlaysTick();
  await sleep(20);
  t('灯箱：单图不渲染翻页控件', () => { if (O('.lightbox-nav')) throw new Error('单图不该有翻页'); });

  // 统一确认框（v1.3.8-test2：替代原生 confirm / prompt）
  t('确认框：默认不渲染', () => { if (O('.confirm')) throw new Error('不应存在'); });
  overlayState.confirm = { open: true, title: '删除订阅「例子」？', desc: '该频道已抓取的条目会一并删除。', confirmText: '删除订阅', cancelText: '取消', danger: true, input: null };
  overlaysTick();
  await sleep(20);
  t('确认框：alertdialog + 危险样式 + 文案', () => {
    const box = O('.confirm');
    if (!box) throw new Error('无 .confirm');
    if (box.getAttribute('role') !== 'alertdialog') throw new Error('role 不对');
    if (box.className.indexOf('is-danger') < 0) throw new Error('class: ' + box.className);
    const title = O('#confirmTitle');
    if (!title || title.textContent !== '删除订阅「例子」？') throw new Error('标题不符');
    if (!O('#confirmDesc')) throw new Error('缺说明');
    const btns = [...box.querySelectorAll('.confirm-foot button')].map((b) => b.textContent);
    if (btns.join('|') !== '取消|删除订阅') throw new Error('按钮: ' + btns.join('|'));
    if (!O('.confirm-foot .btn-danger-solid')) throw new Error('确认按钮应是实心危险色');
  });
  O('.confirm-foot .btn-danger-solid').click();
  await sleep(20);
  t('确认框：确认 → settleConfirm(true)', () => {
    const c = callsOf('settleConfirm');
    if (!c.length || c[c.length - 1][1] !== true) throw new Error('未结算');
  });

  overlayState.confirm = { open: true, title: '设置新密码', desc: '', confirmText: '设置密码', cancelText: '取消', danger: false, input: { label: '新密码', type: 'password', required: true } };
  overlaysTick();
  await sleep(20);
  t('确认框：输入模式渲染密码框', () => {
    const i = O('#confirmInput');
    if (!i) throw new Error('无输入框');
    if (i.type !== 'password') throw new Error('type: ' + i.type);
  });
  {
    const inp = O('#confirmInput');
    const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, 'abc123');
    inp.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(20);
    O('.confirm-foot .btn-primary').click();
    await sleep(20);
    t('确认框：输入值随确认返回', () => {
      const c = callsOf('settleConfirm');
      if (c[c.length - 1][2] !== 'abc123') throw new Error('值: ' + c[c.length - 1][2]);
    });
  }
  overlayState.confirm = Object.assign({}, overlayState.confirm, { open: false });
  overlaysTick();
  await sleep(10);

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
        'readerSetScope', 'readerSetFeed', 'readerSetGroup', 'readerSetWatch', 'readerOpenSource', 'readerSearch',
        'readerToggleArt', 'readerCollapseAll', 'readerReadAll', 'readerToggleFav', 'readerTagToCards',
        'readerToggleAccordion', 'readerAccordionOn', 'readerToggleDrawer', 'readerCloseDrawer', 'fmtFull',
        'readerCursorMove', 'readerCursorToggle', 'readerCursorFav', 'readerCursorToggleRead',
        'getKbdHelpState', 'toggleKbdHelp',
        'readerCollapsedGroups', 'readerToggleGroupCollapse', 'readerToggleAllGroups',
        'getReaderSideWidth', 'setReaderSideWidth', 'applyReaderSideWidth', 'readerSideCap',
        'cardsSearch', 'cardsFilterFeed', 'cardsSort', 'cardsView', 'cardsTag',
        'cardsLoadMore', 'cardsSetFlag', 'cardsDetailRead', 'filterEntries', 'promptInstall',
        'cardsToggleDrawer', 'cardsCloseDrawer',
        'openSettings', 'toast', 'apiFetch', 'isAdmin', 'exportOpml', 'bindSections', 'groupFeeds',
        'getToastState', 'getNewPillState', 'getLightboxState', 'applyPendingFresh',
        'getConfirmState', 'confirm', 'settleConfirm', 'cancelConfirm',
        'closeLightbox',
        'digestIsEnabled', 'setDigestEnabled',
      ];
      for (const k of need) if (c2[k] === undefined) throw new Error('core 缺 ' + k);
    });
    // 关掉日报后，所有入口都靠 switchView 这一道守卫回落（#digest 深链、命令面板遗留项
    // 走的都是它）；假 core 桩测的是组件，这里验真实 core 的判定本身。
    t('冒烟：P1 键盘 —— j/k 移动光标并展开、? 呼出/关闭帮助、输入框内不拦截', () => {
      const c2 = sw.__coreForTest;
      c2.state.rdEntries = [{ id: 'a1', isRead: false, isFavorite: false }, { id: 'a2', isRead: false, isFavorite: false }];
      const press = (key) => sw.document.dispatchEvent(new sw.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      press('j');
      if (String(c2.state.rdCursor) !== 'a1') throw new Error('j 未定位第一条: ' + c2.state.rdCursor);
      if (!c2.state.rdExpanded.has('a1')) throw new Error('j 未展开当前条目');
      press('j');
      if (String(c2.state.rdCursor) !== 'a2') throw new Error('j 未前进: ' + c2.state.rdCursor);
      press('k');
      if (String(c2.state.rdCursor) !== 'a1') throw new Error('k 未后退: ' + c2.state.rdCursor);
      press('?');
      if (!c2.getKbdHelpState().show) throw new Error('? 未呼出帮助');
      press('?');
      if (c2.getKbdHelpState().show) throw new Error('? 未关闭帮助');
      // 输入框内打字不拦截
      const inp = sw.document.createElement('input');
      sw.document.body.appendChild(inp);
      inp.focus();
      c2.state.rdCursor = null;
      inp.dispatchEvent(new sw.KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
      if (c2.state.rdCursor != null) throw new Error('输入框内 j 不应触发导航');
      inp.remove();
    });
    t('冒烟：日报关掉时 switchView(ai) 回落文章页，重开后能进', () => {
      const c2 = sw.__coreForTest;
      c2.setLayout('digestEnabled', false);
      if (c2.digestIsEnabled() !== false) throw new Error('digestIsEnabled 未反映关闭态');
      c2.switchView('ai');
      if (c2.state.tab !== 'reader') throw new Error('关闭后仍进了 ai：' + c2.state.tab);
      c2.setLayout('digestEnabled', true);
      c2.switchView('ai');
      if (c2.state.tab !== 'ai') throw new Error('重开后仍进不去 ai：' + c2.state.tab);
      c2.switchView('reader');
    });
    t('冒烟：setDigestEnabled(false) 关掉时把停在日报页的人带回文章页', () => {
      const c2 = sw.__coreForTest;
      c2.setDigestEnabled(false);
      if (c2.state.tab !== 'reader') throw new Error('未回落：' + c2.state.tab);
      c2.setDigestEnabled(true);
      if (c2.digestIsEnabled() !== true) throw new Error('未能重新开启');
    });
    // 侧滑手势已抽到 drawer.js（v1.3.10）：文章页 / 卡片页共用一套。
    // 这里在真实 core 上验「按 state.tab 选对抽屉」——选错的表现是右滑什么都拉不出来。
    t('冒烟：卡片页右滑拉出频道抽屉（手势按当前页面选抽屉）', () => {
      const c2 = sw.__coreForTest;
      const doc = sw.document;
      for (const id of ['cardsSide', 'cardsMask']) {
        const el = doc.createElement('aside');
        el.id = id;
        doc.body.appendChild(el);
      }
      Object.defineProperty(sw, 'innerWidth', { value: 390, configurable: true });
      c2.state.tab = 'cards';
      doc.body.classList.remove('cards-drawer-open');
      const touch = (type, x, y) => {
        const ev = new sw.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] });
        if (type === 'touchend') Object.defineProperty(ev, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
        doc.dispatchEvent(ev);
      };
      touch('touchstart', 40, 400);
      touch('touchmove', 110, 402);
      touch('touchmove', 200, 404);
      const side = doc.getElementById('cardsSide');
      if (!side.style.transform || side.style.transform === 'translateX(-104%)') {
        throw new Error('跟手阶段抽屉没位移：' + (side.style.transform || '(空)'));
      }
      touch('touchend', 260, 404);
      if (!doc.body.classList.contains('cards-drawer-open')) throw new Error('右滑够距应打开抽屉');
      c2.cardsCloseDrawer();
      if (doc.body.classList.contains('cards-drawer-open')) throw new Error('卡片页抽屉关不上');
      // 文章页没有被这次右滑误开（同一套手势，各归各的类）
      if (doc.body.classList.contains('reader-drawer-open')) throw new Error('误开了文章页抽屉');

      // 换到文章页，同一套手势应作用于它自己的抽屉（重构后不能只顾新页面）
      for (const id of ['readerSide', 'readerMask']) {
        const el = doc.createElement('aside');
        el.id = id;
        doc.body.appendChild(el);
      }
      doc.body.removeAttribute('style');
      doc.body.classList.remove('reader-drawer-open');
      c2.state.tab = 'reader';
      touch('touchstart', 40, 400);
      touch('touchmove', 110, 402);
      touch('touchmove', 200, 404);
      touch('touchend', 260, 404);
      if (!doc.body.classList.contains('reader-drawer-open')) throw new Error('文章页抽屉没拉出来');
      if (doc.body.classList.contains('cards-drawer-open')) throw new Error('文章页也开了卡片页抽屉');
      c2.readerCloseDrawer();
    });

    // ---- 「再次点击同一频道 → 回到该频道最新信息」 ----
    // 背景：卡片页一直是这个行为（cardsFilterFeed 每次都 loadPage(true)），
    // 文章页此前对同一频道直接 return，点第二下毫无反应 —— 两页行为不一致。
    // 这里在真实 core 上验：再点同一频道必须重新拉列表 + 滚回顶部，且不能早退。
    t('冒烟：文章页再次点击同一频道 → 重载该频道最新列表（不再早退）', async () => {
      const c2 = sw.__coreForTest;
      const doc = sw.document;
      // 装一个可控的 fetch：记录 /api/entries 的调用次数与参数
      const calls = [];
      const origFetch = sw.fetch;
      sw.fetch = (url, opts) => {
        calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ entries: [], hasMore: false, total: 0 }),
        });
      };
      try {
        c2.state.tab = 'reader';
        c2.state.feedList = [{ id: 7, groupName: '科技' }];
        c2.state.rdScope = 'all';
        c2.state.rdGroup = null;
        c2.state.rdFeedId = 7;
        c2.state.rdEntries = [];
        await sleep(0);

        // 第一次点：重新拉取
        c2.readerSetFeed(7);
        await sleep(60);
        const first = calls.filter((c) => c.url.indexOf('/api/entries?') === 0);
        if (first.length !== 1) throw new Error('首次点击未触发列表拉取：' + first.length);

        // 第二次点同一频道：必须再拉一次（此前是直接 return，点了没反应）
        calls.length = 0;
        c2.readerSetFeed(7);
        await sleep(60);
        const second = calls.filter((c) => c.url.indexOf('/api/entries?') === 0);
        if (second.length !== 1) throw new Error('再次点击同一频道没有重新拉取（应与卡片页一致）');
        // 再点一次必须仍然带着同一个频道的筛选条件
        if (second[0].url.indexOf('feeds=7') < 0) throw new Error('重载丢了频道筛选：' + second[0].url);
      } finally {
        sw.fetch = origFetch;
      }
    });

    t('冒烟：文章页再点同一频道时保持频道筛选（不清掉分组条件）', async () => {
      const c2 = sw.__coreForTest;
      // 处于分组筛选状态时，再点一个频道 —— 走的是「切换」分支，必须切到该频道
      c2.state.rdGroup = '科技';
      c2.state.rdFeedId = null;
      c2.state.feedList = [{ id: 7, groupName: '科技' }];
      c2.readerSetFeed(7);
      await sleep(20);
      if (c2.state.rdFeedId !== 7) throw new Error('未切到该频道');
      if (c2.state.rdGroup !== null) throw new Error('切频道时应清掉分组筛选');
      // 此时 rdFeedId===7 且 rdGroup===null —— 再点一次应走「重载」分支，
      // 保持 rdFeedId 不变，而不是把它清成 null
      c2.readerSetFeed(7);
      await sleep(20);
      if (c2.state.rdFeedId !== 7) throw new Error('再点同一频道后频道被清掉了：' + c2.state.rdFeedId);
    });

    sw.close();
  }

  /* ---------- v1.3.11 全面重构守门 ---------- */

  // 频道树只有一份实现：两页各写一遍是「改一处另一处不跟」的根源
  t('组件复用：频道树只有 ChannelList 一份，两页都用它', () => {
    const root = path.join(__dirname, '..', '..');
    const list = path.join(root, 'src', 'views', 'ChannelList.jsx');
    if (!fs.existsSync(list)) throw new Error('缺 src/views/ChannelList.jsx');
    const src = fs.readFileSync(list, 'utf8');
    if (src.indexOf("variant = 'reader'") < 0) throw new Error('ChannelList 应支持 reader / cards 两种形态');
    for (const f of ['ReaderView.jsx', 'CardsView.jsx']) {
      const v = fs.readFileSync(path.join(root, 'src', 'views', f), 'utf8');
      if (v.indexOf("from './ChannelList.jsx'") < 0) throw new Error(f + ' 未使用共享频道树');
      if (/function (ReaderChannels|CardsChannels)/.test(v)) throw new Error(f + ' 里还留着旧频道树实现');
      if (/className=\{?'?rd-ch/.test(v.replace(/ChannelList[\s\S]*$/, ''))) throw new Error(f + ' 仍在手写 .rd-ch 行');
    }
  });

  // 无文字按钮的可访问名：.btn-label 被 display:none 后，名字只能靠 aria-label
  t('可访问性：视图切换在窄屏仍有可访问名与选中态', () => {
    const top = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shell', 'TopBar.jsx'), 'utf8');
    const nav = top.slice(top.indexOf('viewnav'), top.indexOf('viewnav-actions') < 0 ? undefined : undefined);
    if (!/aria-label=\{v\.label\}/.test(top)) {
      throw new Error('视图切换按钮缺 aria-label —— 窄屏 .btn-label 被 display:none 后按钮就无名了');
    }
    if (!/aria-current=\{active \? 'page' : undefined\}/.test(top)) throw new Error('当前视图应用 aria-current 表达，而不是只有 .active 类');
    if (nav.indexOf('aria-hidden="true">{v.label}') < 0) throw new Error('视觉文字重复朗读，应给 .btn-label 加 aria-hidden');
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'style.css'), 'utf8');
    if (!/@media \(max-width: 820px\)[\s\S]{0,900}?\.viewnav-btn \{/.test(css)) {
      throw new Error('视图切换的图标化断点必须与 .btn-label 隐藏同步（820），否则 561–820 是一条空胶囊');
    }
  });

  // v1.6.0：顶部标签栏整体移除 —— 不再有 TagBar 组件 / .tag-chip 样式；标签仅保留在文章正文 .art-tags
  t('标签栏移除：无 TagBar 组件与 .tagbar / .tag-chip 样式', () => {
    const root = path.join(__dirname, '..', '..');
    if (fs.existsSync(path.join(root, 'src', 'ui', 'TagBar.jsx'))) throw new Error('TagBar.jsx 应已删除');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    if (/\.tagbar\b/.test(css)) throw new Error('.tagbar 样式应已移除');
    if (/\.tag-chip\b/.test(css)) throw new Error('.tag-chip 样式应已移除');
    const cards = fs.readFileSync(path.join(root, 'src', 'views', 'CardsView.jsx'), 'utf8');
    const reader = fs.readFileSync(path.join(root, 'src', 'views', 'ReaderView.jsx'), 'utf8');
    for (const [n, src] of [['CardsView', cards], ['ReaderView', reader]]) {
      if (src.indexOf('<TagBar') >= 0) throw new Error(n + ' 不应再渲染 <TagBar>');
    }
  });

  // 卡片页「下拉即标题」：同一信息只出现一次
  t('卡片页头部：桌面由筛选下拉充当标题，窄屏才用文字标题', () => {
    const root = path.join(__dirname, '..', '..');
    const v = fs.readFileSync(path.join(root, 'src', 'views', 'CardsView.jsx'), 'utf8');
    const head = v.slice(v.indexOf('wrap cards-head'), v.indexOf('<main className="wrap">'));
    if (head.indexOf('wrapId="feedDD"') < 0) throw new Error('#feedDD 应在 .cards-head 里（标题位）');
    const tools = head.slice(head.indexOf('head-right'));
    if (tools.indexOf('wrapId="feedDD"') >= 0) throw new Error('#feedDD 仍在工具组里 —— 标题与筛选会重复');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    const mw = css.match(/@media \(min-width: 1081px\) \{([\s\S]*?)\n\}/);
    if (!mw) throw new Error('缺 ≥1081px 段');
    if (!/\.cards-head > \.cards-title \{ display: none/.test(mw[1])) {
      throw new Error('桌面应隐藏文字标题（下拉即标题）；这条必须写在 min-width 里，否则窄屏标题也被藏掉');
    }
    if (!/\.cards-head > #feedDD \{/.test(mw[1])) throw new Error('下拉的标题样式应只作用于 ≥1081px');
  });

  // 吸顶条的滚动边界 + 卡片浮动按钮的悬停门控
  t('视觉：滚动边界与卡片动作的显隐策略', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    if (!/body\.is-scrolled \.page-head,[\s\S]{0,80}?box-shadow: 0 1px 0 0 var\(--border\)/.test(css)) {
      throw new Error('缺 body.is-scrolled 的吸顶边界（滚动后内容从条下穿过，需要一条 1px 说明）');
    }
    const top = fs.readFileSync(path.join(root, 'src', 'shell', 'TopBar.jsx'), 'utf8');
    if (top.indexOf("classList.toggle('is-scrolled'") < 0) throw new Error('TopBar 未维护 body.is-scrolled');
    if (!/@media \(hover: hover\) and \(pointer: fine\)[\s\S]{0,240}?\.card-media-actions/.test(css)) {
      throw new Error('卡片浮动按钮应有 hover 门控（触屏那档必须继续常显）');
    }
    if (!/\.card:focus-within \.card-media-actions \{ opacity: 1/.test(css)) {
      throw new Error('悬停显形的同时要照顾键盘：:focus-within 也要显形');
    }
    // 禁止 transition: all（会把布局属性一起动画）
    const chip = css.match(/^\.tag-chip \{([\s\S]*?)\n\}/m);
    if (chip && /transition:\s*all/.test(chip[1])) throw new Error('.tag-chip 不该用 transition: all');
  });

  // 拟态浮起感守门：UI 评审 #9「降阴影」曾把 --neu-shadow 从 7/18 降到 4/12，
  // 实测 Windows 150% 下拟态浮起深度从 12 掉到 6、阴影过渡带从 21 设备像素缩到 7，
  // 卡片从「浮起来」退化成「贴在背景上」——用户感知为「界面发飘、层次感弱」。
  // offset 主导浮起深度、blur 决定过渡带宽度；两者都不能再降回 4/12 那一档。
  t('视觉：拟态阴影保持浮起感（三主题 offset ≥ 5px / blur ≥ 14px）', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
    const decls = css.match(/--neu-shadow:\s*([^;]+);/g) || [];
    if (decls.length < 3) throw new Error('应有三套主题的 --neu-shadow，实际 ' + decls.length);
    for (const d of decls) {
      const off = d.match(/(\d+)px\s+\d+px\s+\d+px\s+var\(--neu-lo\)/);
      if (!off) throw new Error('拟态阴影写法变了，需同步更新本断言：' + d);
      const o = Number(off[1]);
      if (o < 5) throw new Error('拟态阴影 offset 降到 ' + o + 'px，浮起感会塌（需 ≥ 5px）：' + d);
      const blur = Number(d.match(/\d+px\s+\d+px\s+(\d+)px\s+var\(--neu-lo\)/)[1]);
      if (blur < 14) throw new Error('拟态阴影 blur 降到 ' + blur + 'px，阴影过渡带会过窄发硬（需 ≥ 14px）：' + d);
    }
    // 图标描边：15px 图标上 stroke-width 1.85 只有 1.156 设备像素，落在分数像素上会被摊开发虚
    const ico = css.match(/^\.ico,\n[\s\S]{0,400}?\n\}/m);
    if (ico) {
      const sw = ico[0].match(/stroke-width:\s*([\d.]+);/);
      if (sw && Number(sw[1]) < 2) throw new Error('图标描边回到 ' + sw[1] + '，15px 图标上会发虚（需 ≥ 2）');
    }
  });

  // CDN 版本错配守门（v1.5.0）：
  // 2026-10-27 线上事故 —— 移动端在 Cloudflare CDN 外网环境下抽屉顶部出现
  // 一个 106×106 的黑色实心圆、搜索框被压成窄条。根因链条：
  //   public/style.css 是固定文件名、无内容哈希 → CDN 边缘缓存 1~4 小时；
  //   /index.html 是 no-cache，永远最新 → 新 HTML + 旧 CSS 错配；
  //   v1.3.9 的 CSS 里没有 .rd-ch-search 规则（该功能是 1.4.0 新增）→
  //   搜索框内的 <svg> 按 SVG 默认规则撑成 300×150，<use href="#i-search">
  //   渲染成一个 106×106 的黑圆。
  // 修复：样式表移入 src/ 由 Vite 打包 → 产物带内容哈希，HTML 引的永远是配套那一版。
  // 以下断言钉住这个前提不被回退。
  t('CDN：样式表已移入 src/，public/ 下不得再有 style.css / login.css', () => {
    const root = path.join(__dirname, '..', '..');
    if (!fs.existsSync(path.join(root, 'src', 'style.css'))) throw new Error('src/style.css 不存在 —— 样式表必须由 Vite 打包');
    if (!fs.existsSync(path.join(root, 'src', 'login.css'))) throw new Error('src/login.css 不存在');
    if (fs.existsSync(path.join(root, 'public', 'style.css'))) {
      throw new Error('public/style.css 复活了 —— 固定路径会被 CDN 缓存，与 HTML 错配（移动端元素丢失的根因）');
    }
    if (fs.existsSync(path.join(root, 'public', 'login.css'))) {
      throw new Error('public/login.css 复活了 —— 同上，登录页样式会与 HTML 错配');
    }
  });

  t('CDN：入口 HTML 不得手写固定路径的样式表 <link>', () => {
    const root = path.join(__dirname, '..', '..');
    for (const f of ['index.html', 'login.html']) {
      const html = fs.readFileSync(path.join(root, f), 'utf8');
      if (/<link[^>]+rel=["']?stylesheet["']?[^>]+href=["']\/(style|login)\.css/.test(html)) {
        throw new Error(f + ' 仍手写 <link href="/style.css"> —— 固定路径会被 CDN 缓存 1~4 小时');
      }
    }
    // 样式表必须由入口 JS import 引入（Vite 由此打出带哈希的 CSS 并自动注入 link）
    const main = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8');
    if (!/import\s+['"]\.\/style\.css['"]/.test(main)) throw new Error('src/main.jsx 未 import ./style.css');
    const lmain = fs.readFileSync(path.join(root, 'src', 'login-main.js'), 'utf8');
    if (!/import\s+['"]\.\/login\.css['"]/.test(lmain)) throw new Error('src/login-main.js 未 import ./login.css');
  });

  t('CDN：构建产物带内容哈希，且服务器按哈希分档设缓存', () => {
    const root = path.join(__dirname, '..', '..');
    const vite = fs.readFileSync(path.join(root, 'vite.config.mjs'), 'utf8');
    if (!/assetFileNames:\s*'assets\/\[name\]-\[hash\]/.test(vite)) {
      throw new Error('vite 的 assetFileNames 必须带 [hash]，否则 CSS 又是固定路径');
    }
    if (!/chunkFileNames:\s*'assets\/\[name\]-\[hash\]/.test(vite)) {
      throw new Error('vite 的 chunkFileNames 必须带 [hash]');
    }
    const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    if (!/immutable/.test(srv)) throw new Error('服务器未对带哈希资源设 immutable 长缓存');
    if (!/no-cache, must-revalidate/.test(srv)) throw new Error('服务器未对 HTML / 无哈希资源设 no-cache, must-revalidate');
    // SW 的双策略：带哈希 → 缓存优先；其余 → 网络优先
    const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
    if (!/HASHED/.test(sw)) throw new Error('sw.js 缺少按哈希判定的双策略');
    if (!/VERSION = 'feedlore-v2'/.test(sw)) throw new Error('sw.js 版本未升到 feedlore-v2（旧 SW 会继续用旧缓存）');
  });

  t('CDN：Service Worker 预缓存清单不得含无哈希的样式表', () => {
    const root = path.join(__dirname, '..', '..');
    const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
    if (/'\/style\.css'/.test(sw) || /'\/login\.css'/.test(sw)) {
      throw new Error('预缓存含无哈希样式表 —— 文件名带 hash 后预缓存具体路径没有意义，反而可能缓存到旧版');
    }
  });

  t('性能：服务器对文本类响应启用 gzip，且不压图片', () => {
    const root = path.join(__dirname, '..', '..');
    const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    if (!/gzipSync/.test(srv)) throw new Error('server.js 未启用 gzip —— 108KB CSS 原样传输，弱网下 FCP 超过 3.5 秒');
    if (!/GZIP_TYPES/.test(srv)) throw new Error('缺 GZIP_TYPES 白名单');
    if (!/png|jpe?g|webp|gif|ico/.test(srv)) throw new Error('gzip 未排除图片（图片本身已压缩，再压是浪费 CPU）');
  });

  // 图标基类守门：所有 sprite 图标类（<svg> + <use href="#i-xxx">）都必须落在基础组内。
  // 漏进去会有两种后果：
  //  1) 缺 width/height 约束 → <svg> 按 SVG 默认规则撑成 300×150（本次事故的放大版）；
  //  2) 缺 fill:none / stroke:currentColor → 路径被填成实心黑块
  //     （.rd-ch-search-ico 实测：搜索框里的放大镜圆圈变成一颗黑点）。
  t('图标：sprite 图标类必须在基础组内（含 fill:none / stroke:currentColor）', () => {
    const root = path.join(__dirname, '..', '..');
    // 归一化换行：仓库 style.css 在 Windows 工作区是 CRLF，但 CI(Linux) 检出为 LF，
    // 只用 \r\n 拼接 group 会在 Linux 上 indexOf 失败。统一转 LF 再比，跨平台稳定。
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // 取基础组（.ico 开头的那条选择器）
    const base = css.match(/^\.ico,\n([\s\S]{0,400}?)\{/m);
    if (!base) throw new Error('找不到图标基础组（.ico, … {）');
    const group = '.ico,\n' + base[1];
    const gi = css.indexOf(group);
    if (gi < 0) throw new Error('图标基础组定位失败');
    // 基础组正文必须含 fill:none 与 stroke:currentColor
    const ruleBody = css.slice(gi + group.length).slice(0, 600).split('}')[0];
    if (!/fill:\s*none/.test(ruleBody)) throw new Error('图标基础组缺 fill:none —— 路径会被填成实心黑块');
    if (!/stroke:\s*currentColor/.test(ruleBody)) throw new Error('图标基础组缺 stroke:currentColor —— 图标不会跟随文字颜色');
    // 扫源码：<svg className="X"> 且含 <use href="#i-… 的类，必须在基础组里
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(jsx|js)$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(root, 'src'));
    const svgCls = new Set();
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const re = /<svg className="([^"]+)"[^>]*>\s*<use\s+href=['"]\{?['"]?#i-/g;
      let m;
      while ((m = re.exec(src))) {
        // 只取图标主类（第一个不是 .ico 的 token）；后面的 token 多是状态修饰（err / spin）
        const main = m[1].split(/\s+/).find((c) => c && c !== 'ico');
        if (main) svgCls.add(main);
      }
    }
    const missing = [...svgCls].filter((c) => !new RegExp('\\.' + c + '(?![a-z0-9_-])', 'i').test(group));
    if (missing.length) {
      throw new Error('这些 sprite 图标类不在图标基础组内（会缺尺寸/描边约束）：' + missing.join(', '));
    }
  });

  // ============ v1.6.0 合并头部 + App Shell；顶部标签栏移除 ============
  // 守门：三视图各自渲染合并后的 Row1（≡频道 / 标题 / 搜索 / ⋮）；内容区独立滚动、顶栏钉住；
  // 顶部标签栏（TagBar）整体移除（仅文章正文 .art-tags 保留）；品牌 logo 落在频道栏顶部。
  t('v1.6.0：各视图 Row1 合并 + App Shell 独立滚动；标签栏移除', () => {
    const root = path.join(__dirname, '..', '..');
    const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
    const cards = read('src/views/CardsView.jsx');
    const reader = read('src/views/ReaderView.jsx');
    const ai = read('src/ai/AiView.jsx');
    for (const [name, src] of [['CardsView', cards], ['ReaderView', reader], ['AiView', ai]]) {
      if (src.indexOf('<OverflowMenu') < 0) throw new Error(name + ' 未渲染 ⋮ 溢出菜单');
      if (!/useTopbarHeight\(headRef\)/.test(src)) throw new Error(name + ' 未调用 useTopbarHeight(headRef)');
    }
    if (cards.indexOf('cardControls') < 0) throw new Error('卡片页 ⋮ 应传 cardControls（排序 / 视图切换）');
    // 标签栏移除：不再有 <TagBar>；文章正文 .art-tags 必须保留
    for (const [n, src] of [['CardsView', cards], ['ReaderView', reader]]) {
      if (src.indexOf('<TagBar') >= 0) throw new Error(n + ' 不应再渲染 <TagBar>');
    }
    if (reader.indexOf('art-tags') < 0) throw new Error('文章正文标签 .art-tags 应保留');
    // 品牌 logo 移到频道栏顶部
    if (reader.indexOf('<BrandLogo') < 0 || cards.indexOf('<BrandLogo') < 0) throw new Error('频道栏顶部应有品牌 logo');
    const css = read('src/style.css');
    const head = css.match(/\.page-head,\s*\.reader-head,\s*\.cards-head \{([^}]*)\}/);
    if (!head || !/top:\s*0/.test(head[1])) throw new Error('Row1 应贴顶（top:0）');
    // App Shell：内容区独立滚动，顶栏在滚动容器内 sticky 钉住
    if (!/\.reader-main \{[^}]*overflow-y:\s*auto/.test(css)) throw new Error('.reader-main 应独立滚动');
    if (!/#cardsRoot > main\.wrap \{[^}]*overflow-y:\s*auto/.test(css)) throw new Error('卡片 main 应独立滚动');
    if (!/#aiView \{[^}]*overflow-y:\s*auto/.test(css)) throw new Error('#aiView 应独立滚动');
    if (/\.tagbar\b/.test(css) || /\.tag-chip\b/.test(css)) throw new Error('标签栏样式应已移除');
    const hr = css.match(/\.head-right\s*\{([^}]*)\}/);
    if (!hr || !/margin-left:\s*auto/.test(hr[1])) throw new Error('.head-right 应 margin-left:auto 靠右');
    const hook = read('src/shell/useTopbarHeight.js');
    if (hook.indexOf('--topbar-h') < 0) throw new Error('useTopbarHeight 未写 --topbar-h');
    if (!/getBoundingClientRect\(\)\.height/.test(hook) || !/Math\.ceil/.test(hook)) {
      throw new Error('--topbar-h 应取整（小数像素会露 1px 缝）');
    }
    if (!/getClientRects\(\)\.length === 0/.test(hook)) throw new Error('隐藏视图（display:none）测得 0 高时不应覆盖 --topbar-h');
  });

  t('v1.7.0：⋮ 菜单不再承载三视图（已提升为常驻 ViewNav），仍承载 刷新 / 主题 / 设置 / 排序 / 视图切换', () => {
    const root = path.join(__dirname, '..', '..');
    const m = fs.readFileSync(path.join(root, 'src', 'ui', 'OverflowMenu.jsx'), 'utf8');
    // 三视图切换已常驻到 ViewNav，溢出菜单不应再内联视图项
    for (const id of ["'reader'", "'cards'", "'ai'"]) {
      if (m.indexOf(id) >= 0) throw new Error('⋮ 菜单不应再含视图项 ' + id + '（应常驻到 ViewNav）');
    }
    for (const fn of ['refresh', 'cycleTheme', 'openSettings']) {
      if (m.indexOf(fn) < 0) throw new Error('⋮ 菜单缺 ' + fn);
    }
    for (const s of ["'new'", "'old'", "'name'"]) {
      if (m.indexOf(s) < 0) throw new Error('排序档位缺 ' + s);
    }
    if (m.indexOf("'hot'") >= 0 || m.indexOf("'unread'") >= 0) throw new Error('排序档位含卡片页不支持的 hot/unread');
    if (m.indexOf('cardsSort') < 0 || m.indexOf('cardsView') < 0) throw new Error('排序 / 视图切换应经 cardsSort / cardsView');
    if (m.indexOf('role="menu"') < 0 || m.indexOf('role="menuitemradio"') < 0) throw new Error('⋮ 菜单缺 menu 语义');

    // 常驻视图导航应在独立组件里承载三视图切换
    const v = fs.readFileSync(path.join(root, 'src', 'ui', 'ViewNav.jsx'), 'utf8');
    for (const id of ["'reader'", "'cards'", "'ai'"]) {
      if (v.indexOf(id) < 0) throw new Error('ViewNav 缺视图项 ' + id);
    }
    if (v.indexOf('switchView') < 0) throw new Error('ViewNav 应调用 switchView 切换视图');
    if (v.indexOf('viewnav-btn') < 0) throw new Error('ViewNav 应使用 .viewnav-btn 结构');
    if (v.indexOf('__viewChanged') < 0) throw new Error('ViewNav 应订阅 __viewChanged 高亮当前视图');
  });

  t('P1 动效：cardIn keyframes + 卡片错峰 + 弹层/遮罩沿用基础层 popIn/fadeIn + reduce-motion 局部关闭', () => {    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
    if (!/@keyframes cardIn\s*\{/.test(css)) throw new Error('缺 cardIn keyframes');
    if (!/\.grid > \.card,\s*\.grid > \.row-item\s*\{[^}]*animation:\s*cardIn/.test(css)) throw new Error('卡片/列表行未接入 cardIn');
    if (!/\.grid > :nth-child\(2\)\s*\{\s*animation-delay/.test(css)) throw new Error('缺首屏错峰 delay');
    if (!/animation:\s*popIn/.test(css) || !/animation:\s*fadeIn/.test(css)) throw new Error('弹层 popIn / 遮罩 fadeIn 应存在（沿用基础层）');
    if (/@keyframes (modalIn|maskIn)/.test(css)) throw new Error('modalIn/maskIn 与已有 popIn/fadeIn 重复，应删除');
    if (!/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.grid > \.card[\s\S]{0,140}?animation:\s*none/.test(css)) throw new Error('reduce-motion 未局部关闭入场动画');
  });

  // ============ 窄屏导航栏：频道名单行 + 省略号（v1.7.0） ============
  // 背景：≤720 段标题写的是 `flex: 1 1 auto` —— flex 基准取 auto 等于取**内容宽度**，
  // 而 flex 换行是按「假设主尺寸」（= flex-basis，被 min/max 夹住）分行的，
  // 于是长频道名（如「奥斯卡4K蓝光(精品)影视磁力站🍟」）的假设尺寸直接撑爆整行：
  // 标题独占第一行、右簇工具被挤到第二行，导航栏变成两行（实测 375px 下
  // .reader-head 高度 44 → 88）。基准取 0 后假设尺寸只剩 min-width 的 60px，
  // 整行不再被撑破，标题在剩余空间里伸展、长名按 nowrap + 省略号单行截断。
  t('窄屏标题的 flex 基准必须是 0，不能退回 auto（长频道名会把导航栏撑成两行）', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
    // 定位 ≤720 媒体段里的标题规则
    // （style.css 里有多个 ≤720 段，标题规则在末尾那个「工具栏令牌层」里，
    //   所以要把所有 ≤720 段拼起来一起搜，不能只取第一个）
    const segs = css.match(/@media \(max-width: 720px\)[\s\S]*?\n\}\n/g) || [];
    if (!segs.length) throw new Error('缺 ≤720 媒体段');
    const block = segs.join('\n');
    const m = block.match(/\.page-title,\s*\.cards-head > \.page-title\s*\{([^}]*)\}/);
    if (!m) throw new Error('≤720 段缺标题 flex 规则');
    if (!/flex:\s*1 1 0\b/.test(m[1])) throw new Error('≤720 标题 flex 基准应为 0（现为 ' + (m[1].match(/flex:[^;]*/) || ['?'])[0] + '）');
    if (!/max-width:\s*none/.test(m[1])) throw new Error('≤720 标题应解除 40% 上限');
    const rt = block.match(/\.reader-head-text\s*\{([^}]*)\}/);
    if (!rt) throw new Error('≤720 段缺 .reader-head-text 规则');
    if (!/flex:\s*1 1 0\b/.test(rt[1])) throw new Error('≤720 .reader-head-text flex 基准应为 0');
    // 标题自身必须单行 + 省略号（基础层已有，别被改掉）
    const base = css.match(/^\.page-title,[\s\S]{0,200}?\{([^}]*)\}/m);
    if (!base) throw new Error('缺 .page-title 基础规则');
    if (!/white-space:\s*nowrap/.test(base[1])) throw new Error('.page-title 缺 white-space:nowrap（会换行成两行）');
    if (!/text-overflow:\s*ellipsis/.test(base[1])) throw new Error('.page-title 缺 text-overflow:ellipsis（长名不截断）');
    if (!/overflow:\s*hidden/.test(base[1])) throw new Error('.page-title 缺 overflow:hidden');
    if (!/min-width:\s*60px/.test(base[1])) throw new Error('.page-title 应保留 min-width:60px（不缩成「全…」）');
  });

  // ============ 卡片页列表视图：宽度自适应 + 复制按钮紧凑（v1.7.0） ============  // 背景：① 卡片页 .wrap 作为 #cardsRoot 的 flex 子项时不写 min-width:0，会被内容
  // 最小宽度撑开（实测 1280 视口下 .wrap 宽 1600px、375 视口下 698px），超出部分
  // 被 #cardsView{overflow:hidden} 裁掉 —— 列表元素溢出/错位、右侧内容看不见。
  // ② 复制按钮基础层曾是整宽文字按钮（flex:1），窄屏段还有 flex:1 0 100%，
  // 在列表行里被拉成 591px 宽的巨型蓝条。现在统一收成图标方块。
  t('卡片页列表：容器宽度必须跟着视口走（.wrap min-width:0 + width:100%）', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
    const m = css.match(/#cardsRoot\s*>\s*main\.wrap\s*\{([^}]*)\}/);
    if (!m) throw new Error('缺 #cardsRoot > main.wrap 规则');
    if (!/min-width:\s*0/.test(m[1])) throw new Error('.wrap 未设 min-width:0（会被内容最小宽度撑开 → 溢出视口）');
    if (!/width:\s*100%/.test(m[1])) throw new Error('.wrap 未设 width:100%（不占满可用宽度）');
    const listMode = css.match(/\.grid\.list-mode\s*\{([^}]*)\}/);
    if (!listMode || !/min-width:\s*0/.test(listMode[1])) throw new Error('.grid.list-mode 未设 min-width:0');
    const rowItem = css.match(/\.row-item\s*\{([^}]*)\}/);
    if (!rowItem || !/min-width:\s*0/.test(rowItem[1])) throw new Error('.row-item 未设 min-width:0');
  });

  t('复制按钮必须是紧凑图标方块，不得回退成整宽文字按钮', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css', ''), 'utf8').replace(/\r\n/g, '\n');
    // 基础规则（行首 .btn-copy）——上下文覆写（.card-media-actions / .row-actions / .art-actions）
    // 另有各条，这里只看基础层，避免匹配到上下文的窄选择器
    const m = css.match(/^\.btn-copy\s*\{([^}]*)\}/m);
    if (!m) throw new Error('缺 .btn-copy 基础规则');
    if (!/width:\s*32px/.test(m[1]) || !/height:\s*32px/.test(m[1])) throw new Error('.btn-copy 未定死为 32×32 方块');
    if (!/flex:\s*0 0 auto/.test(m[1])) throw new Error('.btn-copy 未固定尺寸（flex:0 0 auto），会被拉成巨型按钮');
    // 窄屏段不得再有把复制按钮拉成整行的规则
    // （先剥掉注释：注释里会引用旧写法，如「曾有 .btn-copy{flex:1 0 100%}」）
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\.btn-copy\s*\{[^}]*flex:\s*1 0 100%/.test(rules)) throw new Error('仍有 .btn-copy{flex:1 0 100%}（窄屏巨型按钮）');
    if (/\.row-actions\s+\.btn-copy\s*\{[^}]*flex:\s*1\b/.test(rules)) throw new Error('仍有 .row-actions .btn-copy{flex:1}（窄屏巨型按钮）');
    if (!/\.btn-copy\s+\.btn-label\s*\{[^}]*display:\s*none/.test(css)) throw new Error('.btn-copy 未隐藏「已复制」文字（会溢出方块）');
  });

  // ============ 文章页：进入即置顶 + 条目深链 + 窄屏收纳（v1.7.0） ============
  t('滚动策略：进入一篇文章置顶（block:start），不再保留「点哪停哪」的锚点补偿', () => {
    const root = path.join(__dirname, '..', '..');
    const r = fs.readFileSync(path.join(root, 'src', 'core', 'reader.js'), 'utf8');
    if (!/scrollIntoView\(\{\s*block:\s*'start'/.test(r)) throw new Error('展开文章未置顶（block:start）');
    if (/anchorTop/.test(r)) throw new Error('旧的锚点补偿仍在（与「进入即置顶」互斥）');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
    if (!/\.art-item\s*\{[^}]*scroll-margin-top/.test(css)) throw new Error('.art-item 缺 scroll-margin-top（置顶会被吸顶条盖住）');
  });
  t('深链：条目级 hash 只 replaceState 不进历史，刷新/返回据此恢复并置顶', () => {
    const root = path.join(__dirname, '..', '..');
    const u = fs.readFileSync(path.join(root, 'src', 'core', 'util.js'), 'utf8');
    if (!/export function writeHash/.test(u) || !/export function parseHash/.test(u)) throw new Error('util 缺 writeHash / parseHash');
    if (!/history\.replaceState/.test(u)) throw new Error('应只用 replaceState（不把文章写进浏览器历史）');
    if (/history\.pushState/.test(u)) throw new Error('不得 pushState（后退会在文章之间逐条回退）');
    const r = fs.readFileSync(path.join(root, 'src', 'core', 'reader.js'), 'utf8');
    if (!/writeHash\('#reader\/art\/'/.test(r)) throw new Error('展开文章未写条目级 hash');
    if (!/export async function restoreReaderArt/.test(r)) throw new Error('缺 restoreReaderArt（深链恢复）');
    const b = fs.readFileSync(path.join(root, 'src', 'core', 'bootstrap.js'), 'utf8');
    if (!/#reader\/art\//.test(b)) throw new Error('bootstrap 未解析条目级深链');
  });
  t('窄屏收纳：≤720 段把文章页三枚动作按钮收进 ⋮（.is-narrow-only）', () => {
    const root = path.join(__dirname, '..', '..');
    const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
    if (!/\.reader-head-tools \.vt-action\s*\{\s*display:\s*none/.test(css)) throw new Error('≤720 未隐藏动作按钮');
    if (!/\.overflow-item\.is-narrow-only[^{]*\{\s*display:\s*none/.test(css)) throw new Error('窄屏专属菜单项应在基础层默认隐藏');
    if (!/\.overflow-item\.is-narrow-only\s*\{\s*display:\s*flex/.test(css)) throw new Error('窄屏未放出 .is-narrow-only 菜单项');
    const o = fs.readFileSync(path.join(root, 'src', 'ui', 'OverflowMenu.jsx'), 'utf8');
    if (!/readerControls/.test(o)) throw new Error('OverflowMenu 未接 readerControls');
    const rv = fs.readFileSync(path.join(root, 'src', 'views', 'ReaderView.jsx'), 'utf8');
    if (!/readerControls/.test(rv)) throw new Error('ReaderView 未传 readerControls');
  });

  let fail = 0;  results.forEach(([s, n]) => { if (s === 'FAIL') fail++; console.log(s, n); });
  console.log(`\n共 ${results.length} 项，通过 ${results.length - fail}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
