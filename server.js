'use strict';

/**
 * 笺川（FeedLore）· RSS 驱动的资源卡片站
 * 数据源：直接抓取 RSS / Atom（不再依赖 CommaFeed）
 * 存储：PostgreSQL（设置 / 账号 / 频道 / 条目 / 日报 全部落库）
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const createDb = require('./db');
const rss = require('./rss');
const { getDispatcher: getProxyDispatcher } = require('./proxy');
const createDigest = require('./digest');
const pkg = require('./package.json');
// 纯函数已抽到 lib/（v2.2.0）：无副作用、可直接单测，见 tests/server/
const { int, bool, clampInt, normUrl, compareVersion, isPrivateHost, groupsOf, imageCacheKey, groupByUrl } = require('./lib/util');
const { compressImage, MAX_BYTES: IMG_MAX_BYTES } = require('./lib/image');
const { parseOpml } = require('./lib/opml');
const { sanitizeAppearance, userAppearance, sanitizeLayout, userLayout, sanitizeFilters, userFilters,
  sanitizeDigest, userDigest, DIGEST_DEFAULTS, DIGEST_MODES } = require('./lib/prefs');
const { applyFilters } = require('./lib/filter');
const { toCard, toFeedDto } = require('./lib/dto');
const { hashPassword, safeEqual } = require('./lib/crypto');
const { userLlmForStore, userLlmForView, userLlm, llmComplete, thinkingBudget } = require('./lib/llm');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
// 静态根目录：dist 是 Vite 构建产物（前端入口 / React 源码构建结果），运行前必须先 npm run build；
// 没构建时退回 public/（只有 style.css 等裸静态资源），至少不抛 ENOENT。
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'dist'))
  ? path.join(__dirname, 'dist')
  : path.join(__dirname, 'public');

const DATABASE_URL = process.env.DATABASE_URL
  || `postgres://${process.env.PG_USER || 'feedlore'}:${process.env.PG_PASSWORD || 'feedlore'}`
  + `@${process.env.PG_HOST || 'postgres'}:${process.env.PG_PORT || 5432}/${process.env.PG_DB || 'feedlore'}`;

const SESSION_TTL = 7 * 24 * 3600 * 1000;
const COOKIE_NAME = 'feedlore_sid';
const LOGIN_MAX_FAILS = 6;
const LOGIN_LOCK_MS = 60 * 1000;

const log = (...a) => console.log(...a);
const logErr = (...a) => console.error(...a);

/* ============================================================
 * 数据库
 * ============================================================ */
const db = createDb({ connectionString: DATABASE_URL, log });

/* ============================================================
 * 设置（落库，进程内缓存一份）
 * ============================================================ */
/* ============================================================
 * 敏感字段加密（模型 API Key 落库前加密）
 * 主密钥由 cryptoSecret 经 scrypt 派生，AES-256-GCM 加密。
 * 说清楚边界：cryptoSecret 本身也在库里，所以这**不是**用来防「拿到库的人」——
 * 它防的是「备份 / 日志 / 截图 / 误导出被拖走」时直接读到一枚可用的凭据，
 * 同时让接口不再回吐明文（前端只看到掩码）。
 * ============================================================ */
/* ============================================================
 * 模型与日报：都只认「这个账号自己那份」（prefs.llm / prefs.digest）
 * 站点级 settings.llm / settings.digest 已整层退场：普通用户不该被别人的模型和
 * 调度时间绑架，管理员也不该替所有人决定。库里残留的这两组旧值不再被读取。
 * ============================================================ */

function defaults() {
  const env = process.env;
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    auth: {
      username: env.ADMIN_USER || 'admin',
      salt,
      // 默认 admin / admin；可用 ADMIN_USER / ADMIN_PASS 覆盖（仅首次初始化时生效）
      passwordHash: hashPassword(env.ADMIN_PASS || 'admin', salt),
    },
    source: {
      refreshMinutes: clampInt(env.REFRESH_MINUTES, 20, 5, 1440),
      keepPerFeed: clampInt(env.KEEP_PER_FEED, 300, 20, 5000),
      // 按时间保留：0 = 不限（只按 keepPerFeed 的条数上限）
      keepDays: clampInt(env.KEEP_DAYS, 0, 0, 3650),
      timeoutSeconds: clampInt(env.RSS_TIMEOUT_SECONDS, 25, 5, 120),
      concurrency: clampInt(env.REFRESH_CONCURRENCY, 3, 1, 10),
      // 连续抓取失败达到此次数 → 自动停用该频道的采集（状态页可一键恢复）
      feedFailLimit: int(env.FEED_FAIL_LIMIT, 5),
      // 网页自动刷新：前端按这个间隔重新拉列表，0 = 关闭
      autoRefreshMinutes: clampInt(env.AUTO_REFRESH_MINUTES, 0, 0, 1440),
      // 出网代理：空 = 直连；http(s):// 或 socks5://
      proxyUrl: '',
      /* 图片缓存（v2.4.0 起可在「采集参数」里调；env 只作为首次落库的部署级默认值，
       * 之后以库里 / 界面保存的值为准） */
      // 回源窗口（stale-while-revalidate）：超过这个天数仍先返回旧图、后台静默回源刷新
      imgTtlDays: int(env.IMG_TTL_DAYS, int(env.IMG_CACHE_TTL_DAYS, 7)),
      // 保留天数：缓存图片在库里保留多久，超期由每日清理任务删除
      imgKeepDays: int(env.IMG_KEEP_DAYS, int(env.IMG_CACHE_TTL_DAYS, 90)),
      imgMaxDim: int(env.IMG_MAX_DIM, 1280),
      imgQuality: int(env.IMG_WEBP_QUALITY, 78),
    },
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    // 敏感字段（模型 API Key）的加密主密钥，与 sessionSecret 分开：
    // 将来轮换会话密钥不会把已经存好的 Key 弄丢
    cryptoSecret: crypto.randomBytes(32).toString('hex'),
  };
}

/** 把一组设置里的数值/枚举夹回合法区间（读库后和保存前都要过一遍） */
function normalizeSettings(s) {
  s.source.refreshMinutes = clampInt(s.source.refreshMinutes, 20, 5, 1440);
  // 0 = 不限（只按 keepDays 的时长上限清理）
  s.source.keepPerFeed = clampInt(s.source.keepPerFeed, 300, 0, 5000);
  s.source.keepDays = clampInt(s.source.keepDays, 0, 0, 3650);
  s.source.timeoutSeconds = clampInt(s.source.timeoutSeconds, 25, 5, 120);
  s.source.concurrency = clampInt(s.source.concurrency, 3, 1, 10);
  s.source.feedFailLimit = clampInt(s.source.feedFailLimit, 5, 2, 20);
  s.source.autoRefreshMinutes = clampInt(s.source.autoRefreshMinutes, 0, 0, 1440);
  // 代理：剥空白 + 长度上限 + 不接受非标准协议（前端做提示，服务端做兜底校验）
  s.source.proxyUrl = String(s.source.proxyUrl || '').trim().slice(0, 500);
  // 图片缓存四参数：老库里没有这些键时 defaults() 已补；手改库 / 表单脏值一律夹回区间
  s.source.imgTtlDays = clampInt(s.source.imgTtlDays, 7, 1, 365);
  s.source.imgKeepDays = clampInt(s.source.imgKeepDays, 90, 1, 3650);
  s.source.imgMaxDim = clampInt(s.source.imgMaxDim, 1280, 320, 4096);
  s.source.imgQuality = clampInt(s.source.imgQuality, 78, 30, 100);
  return s;
}

let settings = null;

async function loadSettings() {
  const def = defaults();
  const stored = await db.getSettings();

  const merged = normalizeSettings({
    auth: Object.assign({}, def.auth, stored.auth || {}),
    source: Object.assign({}, def.source, stored.source || {}),
    sessionSecret: stored.sessionSecret || def.sessionSecret,
    cryptoSecret: stored.cryptoSecret || def.cryptoSecret,
  });
  if (!merged.auth.salt || !merged.auth.passwordHash) {
    merged.auth.salt = def.auth.salt;
    merged.auth.passwordHash = def.auth.passwordHash;
  }
  settings = merged;

  // 回写缺失的键，保证库里是完整的
  const patch = {};
  for (const k of ['auth', 'source']) {
    if (!stored[k]) patch[k] = merged[k];
  }
  if (!stored.sessionSecret) patch.sessionSecret = merged.sessionSecret;
  if (!stored.cryptoSecret) patch.cryptoSecret = merged.cryptoSecret;
  if (Object.keys(patch).length) await db.setSettings(patch);

  return merged;
}

async function saveSettings(patch) {
  Object.assign(settings, patch);
  await db.setSettings(patch);
}

/* ============================================================
 * 会话：HMAC 签名 Cookie（无状态）
 * ============================================================ */
function signSession(user) {
  // uid 是账号主键；u 只是给人看的名字（改用户名后旧 Cookie 里的名字会过期，但 uid 仍有效）
  const payload = Buffer.from(JSON.stringify({ uid: user.id, u: user.username, exp: Date.now() + SESSION_TTL })).toString('base64url');
  const sig = crypto.createHmac('sha256', settings.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifySession(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const idx = token.lastIndexOf('.');
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', settings.sessionSecret).update(payload).digest('base64url');
  if (sig.length !== expect.length || !safeEqual(sig, expect)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch (_) { return null; }
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const getSession = (req) => verifySession(parseCookies(req)[COOKIE_NAME]);

/* 账号内存注册表：id -> { id, username, role, prefs }。
 * 会话只带 uid，每次请求从这张表解析出当前用户；账号增删改后重新 loadUsers() 即可，
 * 于是「改了角色 / 删了用户」立刻生效（不用等 Cookie 过期）。
 * 注意：pg 会把 BIGINT 当字符串返回，这里统一转成 Number，否则 uid === user.id 之类的
 * 严格比较会静默失败（例如「不能删除自己」的守卫）。 */
let usersById = new Map();
const numId = (v) => (v == null ? null : Number(v));
async function loadUsers() {
  const rows = await db.listUsers();
  usersById = new Map(rows.map((u) => [numId(u.id), Object.assign({}, u, { id: numId(u.id) })]));
}
/** 从会话解析当前用户；账号已被删除则视为未登录 */
const userOf = (session) => (session ? usersById.get(numId(session.uid)) || null : null);
const isAdmin = (user) => !!user && user.role === 'admin';

function setSession(res, user) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${signSession(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

const loginFails = new Map();
function loginLocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return rec.lockedUntil - Date.now();
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) loginFails.delete(ip);
  return 0;
}
function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { n: 0, lockedUntil: 0 };
  rec.n += 1;
  if (rec.n >= LOGIN_MAX_FAILS) { rec.lockedUntil = Date.now() + LOGIN_LOCK_MS; rec.n = 0; }
  loginFails.set(ip, rec);
}

/* ============================================================
 * 抓取
 * ============================================================ */
// 状态页要展示的最近一次抓取快照；results 是逐个频道的结果明细
let lastRefresh = {
  at: 0, startedAt: 0, durationMs: 0,
  results: [], added: 0, pruned: 0, skipped: 0, failed: 0,
};
let lastImagePrune = 0;   // 上次清理图片缓存的时间戳（限频每天一次）

/** 抓取去重 / 节流。
 *
 * 两层去重：
 *  1. inFlightUrl：同一 URL **正在抓**的请求合并成同一个 Promise（跨用户 / 跨「手动+定时」并发去重）
 *  2. recentFetchMs：同一 URL **刚抓完 < 5s** 的请求直接跳过（防连点"刷新全部"打爆源站）
 *
 * 多用户订阅同一频道 → 归到同一组，只回源一次，结果写回组内每个 feed 行
 * （entries 仍按 feed 各存一份，用户隔离性不变）。抓取失败由 rss 内部指数退避重试 3 次。
 */
const recentFetchMs = new Map();   // url(归一化) -> 上次抓取完成时间
const inFlightUrl = new Map();     // url(归一化) -> 进行中的抓取 Promise（并发合并）
const REFRESH_MIN_INTERVAL_MS = 5000;

/** 抓一组「订阅了同一 URL」的频道：只回源一次，结果写回组内每个 feed 行 */
async function refreshGroup(key, members) {
  const existing = inFlightUrl.get(key);
  if (existing) return existing;                       // 并发合并：复用正在进行的那次抓取
  const p = doRefreshGroup(key, members).finally(() => inFlightUrl.delete(key));
  inFlightUrl.set(key, p);
  return p;
}

/** 连续失败自动停用的阈值（settings 优先；normalizeSettings 已夹过，这里再兜一手） */
function feedFailLimit() {
  return clampInt(settings && settings.source && settings.source.feedFailLimit, 5, 2, 20);
}

async function doRefreshGroup(key, members) {
  // 5s 内刚抓过这个 URL → 跳过（防连点刷新打爆源站）
  const last = recentFetchMs.get(key);
  if (last && Date.now() - last < REFRESH_MIN_INTERVAL_MS) {
    return { url: key, skipped: 'too-recent', feeds: members.length };
  }
  // 用「最近抓过」的那个成员的 etag/last_modified 打条件请求（命中 304 概率最高）
  const src = members
    .filter((m) => m.etag || m.last_modified)
    .sort((a, b) => new Date(b.last_fetched_at || 0) - new Date(a.last_fetched_at || 0))[0] || members[0];
  const fetchUrl = members[0].url;   // 用原始 URL 抓，避免小写路径在某些源站 404
  try {
    const r = await rss.loadFeed(fetchUrl, {
      etag: src.etag,
      lastModified: src.last_modified,
      timeoutMs: settings.source.timeoutSeconds * 1000,
      proxyUrl: settings.source.proxyUrl,
    });

    if (r.notModified) {
      await Promise.all(members.map((m) => db.saveFeedMeta(m.id, { status: 'ok', error: null, failStreak: 0 }).catch(() => {})));
      return { url: key, notModified: true, added: 0, total: 0, feeds: members.length };
    }

    // 同一份解析结果写回组内每个 feed（只读 items，可安全复用）
    let added = 0;
    let filtered = 0;
    await Promise.all(members.map(async (m) => {
      // v2.7.0：条目过滤规则按成员 owner 逐人生效（同一 URL 多用户订阅时各过各的）
      const rules = userFilters(usersById.get(numId(m.owner_id)));
      const items = applyFilters(r.items, rules);
      filtered += r.items.length - items.length;
      added += await db.upsertEntries(m.id, items);
      await db.saveFeedMeta(m.id, {
        title: r.title, siteUrl: r.siteUrl, description: r.description, iconUrl: r.iconUrl,
        etag: r.etag, lastModified: r.lastModified, status: 'ok', error: null, failStreak: 0,
      }).catch(() => {});
    }));
    return { url: key, notModified: false, added, total: r.items.length, filtered, feeds: members.length };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    const limit = feedFailLimit();
    const autoOff = [];
    await Promise.all(members.map(async (m) => {
      await db.saveFeedMeta(m.id, { status: 'error', error: msg }).catch(() => {});
      const streak = await db.bumpFeedFailStreak(m.id).catch(() => 0);
      // 达到上限且还在采集 → 自动停用（订阅与已抓条目保留，状态页可一键恢复）
      if (streak >= limit && m.enabled) autoOff.push({ id: m.id, title: m.title || m.url, streak });
    }));
    for (const f of autoOff) {
      await db.setFeedEnabled(f.id, false).catch(() => {});
      log(`[rss] 频道连续失败 ${f.streak} 次，已自动停用采集：${f.title}`);
    }
    return { url: key, error: msg, feeds: members.length, autoDisabled: autoOff.length };
  } finally {
    recentFetchMs.set(key, Date.now());   // 无论成败都记时间，避免源站被连点打爆
  }
}

/** 抓单个频道（供路由手动刷新单个用）；与批量刷新共享按 URL 的去重 */
async function refreshFeed(feed) {
  return refreshGroup(normUrl(feed.url), [feed]);
}

/** 这个频道该隔多久抓一次：频道自己设了就用它，否则跟随全局设置 */
function feedIntervalMs(f) {
  const own = Number(f && f.refresh_minutes);
  const mins = Number.isFinite(own) && own > 0
    ? own
    : (settings ? settings.source.refreshMinutes : 30);
  return mins * 60000;
}

/** 距上次抓取已超过自己间隔的频道（从没抓过的一律算到期） */
function dueFeeds(all, now = Date.now()) {
  return (all || []).filter((f) => {
    if (!f.enabled) return false;
    const last = f.last_fetched_at ? new Date(f.last_fetched_at).getTime() : 0;
    return !last || now - last >= feedIntervalMs(f);
  });
}

/**
 * 并发抓一批频道，抓完做清理并记下快照。
 * 「手动刷新全部」和「定时 tick」都走这里，区别只在传入的 feeds 不同。
 * 内部先按 URL 分组：同一 URL 的多个订阅（跨用户）合并成一次回源。
 */
async function refreshFeeds(feeds, { concurrency, total, startedAt = Date.now(), label = '抓取' } = {}) {
  const groups = groupByUrl(feeds);          // Map<url, feed[]>
  const entries = [...groups.entries()];
  const limit = clampInt(concurrency, settings.source.concurrency, 1, 10);
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const [key, members] = entries[cursor++];
      results.push(await refreshGroup(key, members));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, entries.length || 1) }, worker));

  // 两个上限是「并且」关系：条数上限 + 时间上限（keepDays = 0 表示不限时间）
  const prunedByCount = await db.pruneEntries(settings.source.keepPerFeed).catch(() => 0);
  const prunedByAge = await db.pruneEntriesByAge(settings.source.keepDays).catch(() => 0);
  // 图片缓存日常清理（默认保留 90 天，管理员可在「采集参数」调整），限频为每天至多一次
  let prunedImg = 0;
  if (Date.now() - lastImagePrune > 24 * 3600 * 1000) {
    lastImagePrune = Date.now();
    prunedImg = await db.pruneImageCache(imgCfg().keepDays).catch(() => 0);
  }
  const added = results.reduce((n, r) => n + (r.added || 0), 0);
  const failed = results.filter((r) => r.error).length;
  const autoDisabled = results.reduce((n, r) => n + (r.autoDisabled || 0), 0);
  const filtered = results.reduce((n, r) => n + (r.filtered || 0), 0);
  const skipped = total == null ? 0 : Math.max(0, total - feeds.length);
  lastRefresh = {
    at: Date.now(), startedAt, durationMs: Date.now() - startedAt,
    results, added, pruned: prunedByCount + prunedByAge + prunedImg, prunedByAge, prunedImg, skipped, failed, autoDisabled, filtered,
  };
  log(`[rss] ${label}完成：${entries.length} 个 URL 组 / ${feeds.length} 个订阅，新增 ${added} 条`
    + (skipped ? `，跳过 ${skipped} 个（未开启采集或未到期）` : '')
    + (failed ? `，失败 ${failed} 个` : '')
    + (autoDisabled ? `，连续失败自动停用 ${autoDisabled} 个` : '')
    + (filtered ? `，按过滤规则丢弃 ${filtered} 条` : '')
    + (prunedByCount ? `，按条数清理 ${prunedByCount} 条` : '')
    + (prunedByAge ? `，按时间清理 ${prunedByAge} 条` : '')
    + (prunedImg ? `，图片缓存清理 ${prunedImg} 张` : ''));
  return {
    at: lastRefresh.at, results, added, failed, skipped, autoDisabled, filtered,
    pruned: lastRefresh.pruned, prunedByAge, prunedImg,
  };
}

/** 手动「刷新全部」：不看到期与否，把所有用户开启采集的频道都抓一遍 */
async function refreshAll({ concurrency } = {}) {
  const all = await db.allEnabledFeeds();
  return refreshFeeds(all, { concurrency, total: all.length });
}

/** 定时 tick：只抓「到期」的频道（跨用户）。每个频道按自己的频率，没设的跟随全局 */
async function refreshDue() {
  const all = await db.allEnabledFeeds();
  const feeds = dueFeeds(all);
  if (!feeds.length) return null;
  return refreshFeeds(feeds, { total: all.length, label: '定时抓取' });
}

/**
 * 调度：改成每分钟 tick 一次，自己判断哪些频道到期。
 * 老实现是「全局 setInterval 到点全抓」，无法支持每频道不同频率；
 * 现在是「到期的才抓」，效果上每个频道仍然是各自间隔一次，只是更平滑。
 */
const REFRESH_TICK_MS = 60000;
let refreshTimer = null;

function scheduleRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  refreshTimer = setInterval(() => {
    refreshDue().catch((e) => logErr('[rss] 定时抓取失败：' + ((e && e.message) || e)));
  }, REFRESH_TICK_MS);
  log(`[rss] 调度就绪：全局 ${settings.source.refreshMinutes} 分钟，每分钟检查一次到期频道`
    + (settings.source.keepDays
      ? `；条目保留 ${settings.source.keepDays} 天`
      : `；条目仅按每频道 ${settings.source.keepPerFeed} 条保留`));
}

/* ============================================================
 * 图片代理（RSS 里的图直接由后端取，绕开防盗链与混合内容）
 * ============================================================ */
// 图片永久缓存（L1 内存 + L2 数据库 image_cache 表）：
//   - L1：内存 Map，加速热图（重启即失，仅作缓存层）
//   - L2：落库，和文章一样持久化；首请求回源→压缩→存库，之后命中直接出，不再碰上游
//   - 过期回源（stale-while-revalidate，默认 7 天）：超过窗口仍先返回旧图，后台静默刷新，
//     兼顾「避免重复请求」与「头像/配图换了别永远陈旧」
// ⚠️ imgCache 是 proxyImage 闭包持有的运行时状态（非纯函数），留在 server.js。
// 生效值一律现算（管理员改了设置要立刻见效，不用重启）：ttl 天 → 毫秒
function imgCfg() {
  const s = (settings && settings.source) || {};
  return {
    ttlMs: (clampInt(s.imgTtlDays, 7, 1, 365)) * 86400000,
    keepDays: clampInt(s.imgKeepDays, 90, 1, 3650),
    maxDim: clampInt(s.imgMaxDim, 1280, 320, 4096),
    quality: clampInt(s.imgQuality, 78, 30, 100),
  };
}
const IMG_L1_MAX = 500;
const imgCache = new Map();

function serveImage(res, type, buf) {
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(buf);
}
function cacheL1(key, type, buf) {
  imgCache.set(key, { type, buf });
  if (imgCache.size > IMG_L1_MAX) imgCache.delete(imgCache.keys().next().value);
}

/** 回源抓取 + 压缩 + 落库（L2）+ 写 L1，返回 { type, buf }；失败抛带 status 的错误 */
async function fetchAndCache(key, url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FeedLore/2.8)' },
      signal: ctl.signal,
      redirect: 'follow',
      dispatcher: getProxyDispatcher(settings && settings.source && settings.source.proxyUrl) || undefined,
    });
    // 上游明确应答了 4xx/5xx → 透传状态码，别伪装成 502 网关错误。
    // 否则排查时看到 502 会误以为是代理/缓存坏了（v2.2.1 的教训），其实只是图片源自己 404/403。
    if (!resp.ok) throw Object.assign(new Error('upstream ' + resp.status), { status: resp.status });
    const type = resp.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(type)) throw Object.assign(new Error('not an image'), { status: 502 });
    const raw = Buffer.from(await resp.arrayBuffer());
    if (raw.length > IMG_MAX_BYTES) throw Object.assign(new Error('image too large'), { status: 502 });

    // 压缩：栅格图→WebP；svg/ico 或不降反增的小图→原样存
    // 参数现取（imgCfg），管理员在「采集参数」改完下次抓取即生效
    const ic = imgCfg();
    const comp = await compressImage(raw, type, { maxDim: ic.maxDim, quality: ic.quality });
    const finalType = comp ? comp.contentType : type;
    const finalBuf = comp ? comp.buf : raw;
    try {
      await db.setImageCache({
        key, contentType: finalType, data: finalBuf,
        width: comp ? comp.width : null, height: comp ? comp.height : null, origSize: raw.length,
      });
    } catch (_) { /* 落库失败不致命，L1 已可用 */ }
    cacheL1(key, finalType, finalBuf);
    return { type: finalType, buf: finalBuf };
  } finally {
    clearTimeout(timer);
  }
}

async function proxyImage(rawUrl, res) {
  let target;
  try {
    let s = String(rawUrl || '').trim();
    // 个别源把图标写成 https:https://... 这种重复协议头，先归一化，否则 new URL 解析出的
    // 主机名是 "https:"，抓取必败（v2.2.5）。
    s = s.replace(/^(https?):\1:\/\//i, '$1://');
    if (/^data:/i.test(s)) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('data uri not proxied'); return; }
    target = new URL(s);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad url');
    return;
  }
  if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('url not allowed');
    return;
  }

  const key = imageCacheKey(target.toString());

  // L1 内存命中：直接出
  const l1 = imgCache.get(key);
  if (l1) { serveImage(res, l1.type, l1.buf); return; }

  // L2 数据库命中
  let l2 = null;
  try { l2 = await db.getImageCache(key); } catch (_) { /* 库不可用时不致命 */ }
  if (l2) {
    cacheL1(key, l2.contentType, l2.data);
    if (Date.now() - new Date(l2.createdAt).getTime() < imgCfg().ttlMs) {
      serveImage(res, l2.contentType, l2.data);   // 新鲜：直接出
      return;
    }
    // 过期：先返回旧图（stale），后台静默回源刷新
    serveImage(res, l2.contentType, l2.data);
    fetchAndCache(key, target.toString()).catch(() => {});
    return;
  }

  // 未命中：同步回源 + 压缩 + 落库
  try {
    const r = await fetchAndCache(key, target.toString());
    serveImage(res, r.type, r.buf);
  } catch (e) {
    const st = e && e.status ? e.status : 504;
    res.writeHead(st, { 'Content-Type': 'text/plain' }).end(st === 504 ? 'image fetch failed' : 'upstream ' + st);
  }
}

/* ============================================================
 * HTTP 基础设施
 * ============================================================ */
function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > maxBytes) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

/* ============================================================
 * OPML 解析（无依赖）：从订阅管理软件导出的 opml 里抽出订阅源与分组
 * ============================================================ */
const json = (res, code, obj) => {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(obj));
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(pathname, res, user) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
    let body = buf;
    // 已登录访问首页：把该账号的外观配置注入 <head>，首屏即生效，无需本机存储
    if (rel === '/index.html' && user && user.prefs) {
      const anchor = '<meta name="theme-color" content="#ffffff">';
      const s = buf.toString('utf8');
      const idx = s.indexOf(anchor);
      if (idx >= 0) {
        const inj = '<script>window.__APPEARANCE__=' + JSON.stringify(userAppearance(user))
          + ';window.__LAYOUT__=' + JSON.stringify(userLayout(user)) + ';</script>';
        body = Buffer.from(s.slice(0, idx + anchor.length) + '\n' + inj + s.slice(idx + anchor.length));
      }
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  });
}

/* ============================================================
 * 路由
 * ============================================================ */
const dbRequired = (res) => {
  const st = db.status();
  if (st.ready) return false;
  json(res, 503, { error: '数据库未就绪，请稍后重试', detail: st.error || null });
  return true;
};

/* ---------- 关于 / 版本检测 ----------
 * 当前版本取自 package.json；「检查更新」向 GitHub 查最新 Release，
 * 没有发布 Release 时退回 tags 列表；结果全站缓存 10 分钟，避免频繁命中
 * GitHub 未认证限流（每小时 60 次/IP）。不需要数据库，放在登录闸门之后单独处理。 */
const GITHUB_REPO = process.env.GITHUB_REPO || 'chensnails/feedlore';
const VERSION_CHECK_TTL = 10 * 60 * 1000;
let versionCheckCache = { at: 0, data: null };

async function fetchGithubLatest() {
  const headers = { 'User-Agent': 'feedlore-version-check', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const relRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { headers, signal: ctrl.signal });
    if (relRes.ok) {
      const rel = await relRes.json();
      if (rel && rel.tag_name) {
        return {
          latest: String(rel.tag_name).replace(/^v/i, ''),
          releaseUrl: rel.html_url || null,
          name: rel.name || null,
          publishedAt: rel.published_at || null,
          source: 'release',
        };
      }
    }
    const tagRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/tags`, { headers, signal: ctrl.signal });
    if (tagRes.ok) {
      const tags = await tagRes.json();
      if (Array.isArray(tags) && tags.length && tags[0].name) {
        const latest = String(tags[0].name).replace(/^v/i, '');
        return {
          latest,
          releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/v${latest}`,
          name: null,
          publishedAt: null,
          source: 'tag',
        };
      }
    }
    throw new Error('GitHub 上还没有任何发布');
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = req.socket.remoteAddress || 'unknown';
  const session = settings ? getSession(req) : null;
  const user = userOf(session);

  try {
    /* ---------- 公开接口 ---------- */
    if (pathname === '/api/health') {
      const st = db.status();
      json(res, st.ready ? 200 : 503, { ok: st.ready, authed: !!user, db: st });
      return;
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      json(res, 200, {
        authenticated: !!user,
        username: user ? user.username : null,
        role: user ? user.role : null,
        id: user ? String(user.id) : null,
        dbReady: db.status().ready,
      });
      return;
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      if (dbRequired(res)) return;
      const lock = loginLocked(ip);
      if (lock > 0) { json(res, 429, { error: `尝试次数过多，请 ${Math.ceil(lock / 1000)} 秒后再试` }); return; }
      const body = await readBody(req);
      const row = await db.getUserByName(body.username);
      // 用户名不存在时也走一次哈希，避免「响应快慢」暴露某个用户名是否存在
      const salt = row ? row.salt : 'feedlore.dummy.salt';
      const okPass = row ? safeEqual(hashPassword(body.password || '', salt), row.password_hash) : false;
      if (!row || !okPass) { noteLoginFail(ip); json(res, 401, { error: '用户名或密码错误' }); return; }
      loginFails.delete(ip);
      const acct = usersById.get(numId(row.id)) || { id: numId(row.id), username: row.username, role: row.role };
      setSession(res, acct);
      json(res, 200, { ok: true, username: row.username, role: row.role });
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      clearSession(res);
      json(res, 200, { ok: true });
      return;
    }

    /* ---------- 状态页（仅管理员）----------
     * 故意放在下面那道 dbRequired 闸门之前：数据库连不上正是这个页面要报的事，
     * 被 503 挡掉就什么诊断信息都看不到了。所以这里自己校验登录态与角色。 */
    if (pathname === '/api/status' && req.method === 'GET') {
      if (!user) { json(res, 401, { error: 'unauthorized' }); return; }
      if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
      json(res, 200, await buildStatus());
      return;
    }

    /* ---------- 关于 / 版本（所有登录用户，不依赖数据库）---------- */
    if (pathname === '/api/version' && req.method === 'GET') {
      if (!user) { json(res, 401, { error: 'unauthorized' }); return; }
      json(res, 200, { version: pkg.version, repo: GITHUB_REPO, updateEnabled: !!(process.env.UPDATE_WEBHOOK_URL && process.env.UPDATE_WEBHOOK_TOKEN) });
      return;
    }

    if (pathname === '/api/version/check' && req.method === 'POST') {
      if (!user) { json(res, 401, { error: 'unauthorized' }); return; }
      const now = Date.now();
      if (versionCheckCache.data && now - versionCheckCache.at < VERSION_CHECK_TTL) {
        json(res, 200, versionCheckCache.data);
        return;
      }
      try {
        const info = await fetchGithubLatest();
        const result = {
          ok: true,
          current: pkg.version,
          latest: info.latest,
          hasUpdate: compareVersion(info.latest, pkg.version) > 0,
          releaseUrl: info.releaseUrl,
          name: info.name || null,
          publishedAt: info.publishedAt || null,
          source: info.source,
        };
        versionCheckCache = { at: now, data: result };
        json(res, 200, result);
      } catch (e) {
        json(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
      return;
    }

    /* ---------- 一键更新（镜像 + Watchtower 模式，v1.1.0） ----------
     * app 容器不碰宿主机：只 POST 同网络的 watchtower 容器 HTTP API，
     * 让它立即检查并拉取新镜像重启（拉取与重启由 watchtower 完成）。
     * 未配置 UPDATE_WEBHOOK_URL / _TOKEN（如源码部署模式）时返回 501。 */
    if (pathname === '/api/update' && req.method === 'POST') {
      if (!user) { json(res, 401, { error: 'unauthorized' }); return; }
      if (!isAdmin(user)) { json(res, 403, { error: 'forbidden' }); return; }
      const hookUrl = process.env.UPDATE_WEBHOOK_URL || '';
      const hookToken = process.env.UPDATE_WEBHOOK_TOKEN || '';
      if (!hookUrl || !hookToken) {
        json(res, 501, { error: '未配置更新通道（UPDATE_WEBHOOK_URL / UPDATE_WEBHOOK_TOKEN），当前部署可能不是镜像模式' });
        return;
      }
      try {
        const resp = await fetch(hookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + hookToken },
          body: '{}',
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) throw new Error('watchtower HTTP ' + resp.status);
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 502, { ok: false, error: '触发更新失败：' + String((e && e.message) || e) });
      }
      return;
    }

    /* ---------- 静态资源 ---------- */
    if (pathname === '/login.html') { serveStatic(pathname, res); return; }
    if (pathname === '/favicon.ico' || pathname === '/favicon.svg'
      || pathname === '/manifest.json' || /^\/icon-/.test(pathname)
      || pathname === '/apple-touch-icon.png' || pathname === '/favicon-32.png') {
      serveStatic(pathname, res);
      return;
    }

    if (!user && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(302, { Location: '/login.html' });
      res.end();
      return;
    }
    if (user && pathname === '/login.html') {
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    /* ---------- 以下均需登录 ---------- */
    if (pathname.startsWith('/api/')) {
      if (!user) { json(res, 401, { error: 'unauthorized' }); return; }
      if (dbRequired(res)) return;

      /* ---- 图片代理 ---- */
      if (pathname === '/api/img') { await proxyImage(searchParams.get('u'), res); return; }

      /* ---- 频道（RSS 订阅） ---- */
      if (pathname === '/api/feeds' && req.method === 'GET') {
        const rows = await db.listFeeds(user.id);
        const feeds = rows.map((r) => toFeedDto(r, settings.source.refreshMinutes));
        // 侧栏「全部 / 未读 / 收藏」三个固定入口的计数（只算当前用户的）
        const flags = await db.entryFlagCounts(user.id).catch(() => ({ total: 0, unread: 0, favorite: 0 }));
        // 下一次抓取 = 所有开启采集的频道里最早到期的那个时刻
        const nextAt = feeds
          .filter((f) => f.enabled)
          .map((f) => (f.nextRefreshAt ? new Date(f.nextRefreshAt).getTime() : Date.now()))
          .reduce((min, t) => (min === null || t < min ? t : min), null);
        json(res, 200, {
          feeds,
          total: feeds.length,
          enabled: feeds.filter((f) => f.enabled).length,          // 采集开关打开数
          cardEnabled: feeds.filter((f) => f.cardEnabled).length,  // 卡片开关打开数
          groups: groupsOf(feeds),
          groupOrder: (user.prefs && user.prefs.groupOrder) || [],
          flags,
          lastRefreshAt: lastRefresh.at || null,
          nextRefreshAt: nextAt ? new Date(nextAt).toISOString() : null,
          refreshMinutes: settings.source.refreshMinutes,
          keepDays: settings.source.keepDays,
          autoRefreshMinutes: settings.source.autoRefreshMinutes,
        });
        return;
      }

      if (pathname === '/api/feeds/reorder' && req.method === 'POST') {
        const body = await readBody(req);
        const items = Array.isArray(body && body.feeds) ? body.feeds
          : (Array.isArray(body) ? body : []);
        const n = await db.reorderFeeds(user.id, items);
        json(res, 200, { ok: true, updated: n });
        return;
      }

      if (pathname === '/api/feeds' && req.method === 'POST') {
        const body = await readBody(req);
        let url;
        try { url = rss.assertFeedUrl(body.url); }
        catch (e) { json(res, 400, { error: String(e.message || e) }); return; }

        const existed = (await db.listFeeds(user.id)).find((f) => f.url === url);
        const feed = await db.addFeed(user.id, url, {
          enabled: body.enabled !== false,
          cardEnabled: body.cardEnabled !== false,
          groupName: body.groupName ? String(body.groupName).trim().slice(0, 40) : null,
        });
        const result = await refreshFeed(feed);

        if (result.error && !result.skipped) {
          // 首次抓取就失败：不留半成品，回滚掉
          if (!existed) await db.deleteFeed(feed.id, user.id);
          json(res, 400, { error: '抓取失败：' + result.error });
          return;
        }
        json(res, 200, {
          ok: true,
          existed: !!existed,
          feed: toFeedDto(await db.getFeed(feed.id, user.id), settings.source.refreshMinutes),
          added: result.added || 0,
        });
        return;
      }

      if (pathname === '/api/feeds/refresh' && req.method === 'POST') {
        // 只刷新「当前用户自己」的频道（别人的频道由各自的刷新/定时 tick 负责）
        const mine = (await db.listFeeds(user.id)).filter((f) => f.enabled);
        const r = await refreshFeeds(mine, { total: mine.length, label: '手动刷新' });
        json(res, 200, {
          ok: true, at: r.at, added: r.added, skipped: r.skipped || 0,
          failed: r.results.filter((x) => x.error).map((x) => ({ url: x.url, error: x.error })),
        });
        return;
      }

      /* ---- OPML 导入（订阅源 + 分组，去重） ---- */
      if (pathname === '/api/feeds/import' && req.method === 'POST') {
        const body = await readBody(req, 8 * 1024 * 1024);
        const text = String(body.opml || '');
        if (!text.trim()) { json(res, 400, { error: '未收到 OPML 内容' }); return; }
        let parsed;
        try { parsed = parseOpml(text); }
        catch (e) { json(res, 400, { error: 'OPML 解析失败：' + (e.message || e) }); return; }
        if (!parsed.length) { json(res, 400, { error: '文件中没有找到任何订阅源（xmlUrl）' }); return; }

        const existing = await db.listFeeds(user.id);
        const existingUrls = new Set(existing.map((f) => normUrl(f.url)));
        const seen = new Set();
        const toAdd = [];
        const groupSet = new Set();
        for (const it of parsed) {
          const nu = normUrl(it.url);
          if (!nu) continue;
          if (seen.has(nu)) continue;          // 文件内去重
          seen.add(nu);
          if (existingUrls.has(nu)) continue;   // 与现有库去重
          toAdd.push(it);
          if (it.group) groupSet.add(it.group);
        }

        const added = [];
        for (const it of toAdd) {
          const feed = await db.addFeed(user.id, it.url, {
            groupName: it.group ? it.group.split(' / ').pop().slice(0, 40) : null,
            customTitle: it.title ? it.title.slice(0, 200) : null,
          });
          added.push(feed);
        }

        // 后台刷新新导入的频道（不阻塞响应）；抓取结果会落到状态页
        if (added.length) {
          refreshFeeds(added, { concurrency: settings.source.concurrency, label: '导入刷新' })
            .catch((e) => log('[opml] 导入后刷新失败：' + (e && e.message || e)));
        }

        json(res, 200, {
          ok: true,
          added: added.length,
          duplicated: parsed.length - added.length,
          groups: [...groupSet],
          feeds: added.map((r) => toFeedDto(r, settings.source.refreshMinutes)),
        });
        return;
      }

      const feedRoute = pathname.match(/^\/api\/feeds\/(\d+)(\/refresh)?$/);
      if (feedRoute) {
        const id = Number(feedRoute[1]);
        const feed = await db.getFeed(id, user.id);
        if (!feed) { json(res, 404, { error: '频道不存在' }); return; }

        if (feedRoute[2] && req.method === 'POST') {
          const wasEnabled = feed.enabled;
          const r = await refreshFeed(feed);
          // 「因连续失败被自动停用」的频道重试成功 → 顺手恢复采集并清零失败计数
          //（坏源恢复了不用人工再去开开关；用户手动停用的不受影响）
          if (!r.error && !wasEnabled && Number(feed.fail_streak || 0) >= feedFailLimit()) {
            await db.resetFeedFailStreak(id, user.id).catch(() => {});
            await db.setFeedEnabled(id, true).catch(() => {});
          }
          json(res, 200, { ok: !r.error, result: r, feed: toFeedDto(await db.getFeed(id, user.id), settings.source.refreshMinutes) });
          return;
        }
        if (req.method === 'PATCH' || req.method === 'POST') {
          const body = await readBody(req);
          const patch = {};
          if (body.enabled !== undefined) patch.enabled = !!body.enabled;           // 采集开关
          if (body.cardEnabled !== undefined) patch.cardEnabled = !!body.cardEnabled; // 卡片开关
          if (body.groupName !== undefined) patch.groupName = String(body.groupName).trim().slice(0, 40) || null;
          // 自定义频道名：写 custom_title，不被抓取刷新覆盖（刷新只更新 title 字段）
          if (body.title !== undefined) patch.customTitle = String(body.title).trim().slice(0, 200) || null;
          if (body.sortOrder !== undefined) patch.sortOrder = int(body.sortOrder, 0);
          // 抓取频率：空 / 0 / 'global' 都表示「跟随全局」→ 存 NULL
          if (body.refreshMinutes !== undefined) {
            const raw = body.refreshMinutes;
            const n = Number(raw);
            patch.refreshMinutes = (raw === null || raw === '' || raw === 'global'
              || !Number.isFinite(n) || n <= 0)
              ? null : clampInt(n, null, 5, 1440);
          }
          /* 订阅地址：与新增走同一套校验（协议 / 主机名 / 归一化）。
           * 同用户内 URL 唯一（feeds_owner_id_url_key），撞了就明确报给用户，不让它默默变成重复频道。 */
          let urlChanged = false;
          if (body.url !== undefined) {
            let nextUrl;
            try { nextUrl = rss.assertFeedUrl(body.url); }
            catch (e) { json(res, 400, { error: String(e.message || e) }); return; }
            if (nextUrl !== feed.url) {
              const dup = (await db.listFeeds(user.id)).find((x) => x.url === nextUrl && String(x.id) !== String(id));
              if (dup) {
                json(res, 409, { error: '这个地址已经是你的另一个频道：' + (dup.custom_title || dup.title || nextUrl) });
                return;
              }
              patch.url = nextUrl;
              urlChanged = true;
            }
          }
          // 换地址 = 新源，条件请求的游标要一起清掉，否则新地址命中旧 ETag 会被当成「无更新」
          if (urlChanged) Object.assign(patch, {
            etag: null, lastModified: null, lastStatus: null, lastError: null, lastFetchedAt: null, failStreak: 0,
          });
          await db.updateFeed(id, patch, user.id);
          // 手动重新打开采集 = 用户确认「这源我想再试试」：失败计数清零，给足一整轮观察期
          if (patch.enabled === true) await db.resetFeedFailStreak(id, user.id);
          // 改完地址立刻按新地址试抓一次，当场告诉用户成不成（失败也保留新地址：
          // 用户往往正是因为旧地址坏了才改，回滚会把他的修改吞掉）
          let probe = null;
          if (urlChanged) {
            const r = await refreshFeed(await db.getFeed(id, user.id));
            probe = r.error ? { ok: false, error: r.error } : { ok: true, added: r.added || 0 };
          }
          json(res, 200, {
            ok: true, urlChanged: urlChanged || undefined, probe: probe || undefined,
            feed: toFeedDto(await db.getFeed(id, user.id), settings.source.refreshMinutes),
          });
          return;
        }
        if (req.method === 'DELETE') {
          await db.deleteFeed(id, user.id);
          json(res, 200, { ok: true });
          return;
        }
      }

      /* ---- 条目 ---- */
      if (pathname === '/api/entries' && req.method === 'GET') {
        const limit = Math.min(Math.max(int(searchParams.get('limit'), 50), 1), 200);
        const offset = Math.max(int(searchParams.get('offset'), 0), 0);
        const kw = (searchParams.get('q') || '').trim().slice(0, 100);
        const tag = (searchParams.get('tag') || '').trim().slice(0, 60) || null;
        // 未读 / 收藏是在频道范围之上再收窄一层，可叠加
        const unread = searchParams.get('unread') === '1';
        const favorite = searchParams.get('fav') === '1';
        // 收藏列表默认按「收藏时刻」倒序（最近收藏的在前），其余按发布时间
        const sort = searchParams.get('sort') === 'old' ? 'old' : 'new';
        const order = favorite ? 'fav' : sort;

        /* feedIds = null 表示「不加频道过滤，取全部条目」。
         * - 传了 feeds=1,2 → 就用这几个频道（显式指定，优先）
         * - 否则看 scope：
         *     cards（默认）→ 只取「卡片开关」打开的频道（卡片页）
         *     all          → 不过滤（文章页的「全部频道」） */
        let feedIds = null;
        const feedsParam = searchParams.get('feeds');
        if (feedsParam !== null) {
          const ids = feedsParam.split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
          if (!ids.length) { json(res, 200, { entries: [], hasMore: false, total: 0, tags: [] }); return; }
          feedIds = ids;
        } else {
          const scope = searchParams.get('scope') === 'all' ? 'all' : 'cards';
          feedIds = scope === 'all' ? null : await db.cardFeedIds(user.id);
        }

        const [page, total, tags] = await Promise.all([
          db.queryEntries({ ownerId: user.id, feedIds, q: kw, tag, unread, favorite, order, limit, offset }),
          db.countEntries({ ownerId: user.id, feedIds, q: kw, tag, unread, favorite }),
          db.tagCounts(user.id, feedIds),
        ]);

        json(res, 200, {
          entries: page.rows.map(toCard),
          hasMore: page.hasMore,
          total,
          offset,
          limit,
          tags: tags.map((t) => ({ tag: t.tag, n: Number(t.n) })),
        });
        return;
      }

      /* ---- 侧栏徽标：全部 / 未读 / 收藏 ---- */
      if (pathname === '/api/entries/flags' && req.method === 'GET') {
        json(res, 200, await db.entryFlagCounts(user.id));
        return;
      }

      /* ---- 批量标为已读：条件与列表查询一致，所以「看到的」就是「被标掉的」 ---- */
      if (pathname === '/api/entries/read-all' && req.method === 'POST') {
        const body = await readBody(req);
        // feeds 不传 = 全部频道；传了空数组 = 什么都不标（交给 db 的 FALSE 分支）
        const feedIds = Array.isArray(body.feeds)
          ? body.feeds.map(Number).filter(Number.isFinite)
          : null;
        const updated = await db.markEntriesRead({
          ownerId: user.id,
          feedIds,
          q: String(body.q || '').trim().slice(0, 100),
          tag: String(body.tag || '').trim().slice(0, 60) || null,
          unread: true,
        });
        json(res, 200, { ok: true, updated });
        return;
      }

      /* ---- 单条条目（阅读页展开全文时才取，正文不跟着列表一起传） ---- */
      const entryRoute = pathname.match(/^\/api\/entries\/(\d+)$/);
      if (entryRoute && req.method === 'GET') {
        const row = await db.getEntry(Number(entryRoute[1]), user.id);
        if (!row) { json(res, 404, { error: '条目不存在' }); return; }
        json(res, 200, { ...toCard(row), content: row.content || '' });
        return;
      }

      /* ---- 单条标记：已读 / 未读 / 收藏，只改传进来的字段 ---- */
      if (entryRoute && req.method === 'PATCH') {
        const body = await readBody(req);
        const patch = {};
        if (body.isRead !== undefined) patch.isRead = !!body.isRead;
        if (body.isFavorite !== undefined) patch.isFavorite = !!body.isFavorite;
        if (!Object.keys(patch).length) { json(res, 400, { error: '没有要修改的标记' }); return; }
        const row = await db.setEntryFlags(Number(entryRoute[1]), patch, user.id);
        if (!row) { json(res, 404, { error: '条目不存在' }); return; }
        json(res, 200, {
          ok: true,
          id: String(row.id),
          isRead: !!row.is_read,
          isFavorite: !!row.is_favorite,
          favoritedAt: row.favorited_at ? new Date(row.favorited_at).toISOString() : null,
        });
        return;
      }

      /* ---- 站点级设置（采集参数）—— 仅管理员 ----
       * 模型与日报不在这张表里：它们已经整层改为用户级（/api/prefs）。 */
      if (pathname === '/api/config' && req.method === 'GET') {
        if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
        json(res, 200, {
          username: user.username,
          role: user.role,
          source: {
            refreshMinutes: settings.source.refreshMinutes,
            keepPerFeed: settings.source.keepPerFeed,
            keepDays: settings.source.keepDays,
            timeoutSeconds: settings.source.timeoutSeconds,
            concurrency: settings.source.concurrency,
            // v2.5.0：连续失败达到此次数自动停用该频道采集（状态页可一键恢复）
            feedFailLimit: settings.source.feedFailLimit,
            autoRefreshMinutes: settings.source.autoRefreshMinutes,
            // v1.5.0 修复：原来漏返该字段，前端「出网代理」输入框重开面板后是空的，
            // 用户再点保存会把我置成空——GET 与 POST 的字段集必须一致
            proxyUrl: settings.source.proxyUrl,
            // v2.4.0：图片缓存参数（压缩尺寸 / 质量 / 回源窗口 / 保留天数）
            imgTtlDays: settings.source.imgTtlDays,
            imgKeepDays: settings.source.imgKeepDays,
            imgMaxDim: settings.source.imgMaxDim,
            imgQuality: settings.source.imgQuality,
          },
        });
        return;
      }

      if (pathname === '/api/config' && req.method === 'POST') {
        if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
        const body = await readBody(req);
        const patch = {};

        if (body.source) {
          const s = body.source;
          const next = Object.assign({}, settings.source);
          if (s.refreshMinutes !== undefined) next.refreshMinutes = clampInt(s.refreshMinutes, 20, 5, 1440);
          if (s.keepPerFeed !== undefined) next.keepPerFeed = clampInt(s.keepPerFeed, 300, 0, 5000);
          // 0 = 不限（只按条数上限保留）
          if (s.keepDays !== undefined) next.keepDays = clampInt(s.keepDays, 0, 0, 3650);
          if (s.timeoutSeconds !== undefined) next.timeoutSeconds = clampInt(s.timeoutSeconds, 25, 5, 120);
          if (s.concurrency !== undefined) next.concurrency = clampInt(s.concurrency, 3, 1, 10);
          if (s.feedFailLimit !== undefined) next.feedFailLimit = clampInt(s.feedFailLimit, 5, 2, 20);
          if (s.autoRefreshMinutes !== undefined) next.autoRefreshMinutes = clampInt(s.autoRefreshMinutes, 0, 0, 1440);
          if (s.proxyUrl !== undefined) next.proxyUrl = String(s.proxyUrl || '').trim().slice(0, 500);
          // v2.4.0：图片缓存。前端传的是字符串，clampInt 会 parseInt；脏值夹回区间而不是报错
          if (s.imgTtlDays !== undefined) next.imgTtlDays = clampInt(s.imgTtlDays, 7, 1, 365);
          if (s.imgKeepDays !== undefined) next.imgKeepDays = clampInt(s.imgKeepDays, 90, 1, 3650);
          if (s.imgMaxDim !== undefined) next.imgMaxDim = clampInt(s.imgMaxDim, 1280, 320, 4096);
          if (s.imgQuality !== undefined) next.imgQuality = clampInt(s.imgQuality, 78, 30, 100);
          patch.source = next;
        }

        if (!Object.keys(patch).length) { json(res, 400, { error: '没有可保存的字段' }); return; }
        await saveSettings(patch);
        if (patch.source) scheduleRefresh();
        json(res, 200, { ok: true });
        return;
      }

      /* ---- 图片缓存统计 / 手动清空 —— 仅管理员 ---- */
      if (pathname === '/api/image-cache' && req.method === 'GET') {
        if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
        try {
          const s = await db.imageCacheStats();
          json(res, 200, { ok: true, count: s.count, bytes: s.bytes });
        } catch (e) {
          json(res, 500, { error: String((e && e.message) || e) });
        }
        return;
      }
      if (pathname === '/api/image-cache/clear' && req.method === 'POST') {
        if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
        try {
          const removed = await db.clearImageCache();
          imgCache.clear();   // L1 一并清掉，否则刚删的图还会从内存里命中
          log(`[img] 图片缓存已手动清空：${removed} 条`);
          json(res, 200, { ok: true, removed });
        } catch (e) {
          json(res, 500, { error: String((e && e.message) || e) });
        }
        return;
      }

      /* ---- 每用户偏好（分组顺序 + 外观配置 + 布局偏好）—— 所有登录用户 ---- */
      if (pathname === '/api/prefs' && req.method === 'GET') {
        json(res, 200, {
          groupOrder: (user.prefs && user.prefs.groupOrder) || [],
          appearance: userAppearance(user),
          layout: userLayout(user),
          filters: userFilters(user),
          digest: userDigest(user),
          llm: userLlmForView(user.prefs, settings.cryptoSecret),
        });
        return;
      }
      if (pathname === '/api/prefs' && req.method === 'POST') {
        const body = await readBody(req);
        const prefs = Object.assign({}, user.prefs || {});
        if (Array.isArray(body.groupOrder)) {
          prefs.groupOrder = body.groupOrder
            .filter((g) => typeof g === 'string')
            .map((g) => g.trim().slice(0, 40))
            .filter(Boolean);
        }
        // 外观配置按账号保存（主题 / 主色 / 字号 / 阅读字体 / 行高 / 阅读宽度）
        if (body.appearance && typeof body.appearance === 'object') {
          prefs.appearance = sanitizeAppearance(body.appearance);
        }
        // 布局偏好按账号保存（视图模式 / 当前页面 / 分组折叠 / 手风琴 / AI 子页 / 设置分组开合）
        if (body.layout && typeof body.layout === 'object') {
          prefs.layout = sanitizeLayout(body.layout);
        }
        // 条目过滤规则（v2.7.0）：整组替换。只在抓取写库前对新条目生效，
        // 已入库的历史条目不动；保存即重新清洗（非法规则被丢弃而不是报错）
        if (Array.isArray(body.filters)) {
          prefs.filters = sanitizeFilters(body.filters);
        }
        /* 日报配置（自动生成 / 时间 / 范围 / 条数与保留 / 风格要求）按账号保存。
         * 与已有配置合并：lastAuto 是服务端调度器独占写入的字段，
         * 客户端提交的同名字段一律被忽略，否则用户每改一次别的选项就会把「今天已跑过」抹掉、
         * 导致调度器在同一个时间点反复重跑。 */
        if (body.digest && typeof body.digest === 'object') {
          const prev = (user.prefs && user.prefs.digest) || {};
          const next = sanitizeDigest(Object.assign({}, prev, body.digest));
          next.lastAuto = prev.lastAuto || '';
          prefs.digest = next;
        }
        // 模型配置按账号保存：与已有配置合并（只覆盖传入字段，避免未改的 Key 被清空）；
        // apiKey 仅在填写时加密成文，clearApiKey 则清空
        if (body.llm && typeof body.llm === 'object') {
          const prev = (user.prefs && user.prefs.llm) || {};
          prefs.llm = userLlmForStore(Object.assign({}, prev, body.llm), settings.cryptoSecret);
        }
        await db.setUserPrefs(user.id, prefs);
        await loadUsers();
        json(res, 200, {
          ok: true,
          groupOrder: prefs.groupOrder || [],
          appearance: sanitizeAppearance(prefs.appearance),
          layout: sanitizeLayout(prefs.layout),
          filters: sanitizeFilters(prefs.filters),
          digest: sanitizeDigest(prefs.digest),
        });
        return;
      }

      /* ---- 用户管理（仅管理员）---- */
      if (pathname === '/api/users' && req.method === 'GET') {
        if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
        const rows = await db.listUsers();
        const list = await Promise.all(rows.map(async (u) => ({
          id: String(u.id), username: u.username, role: u.role,
          createdAt: u.created_at ? new Date(u.created_at).toISOString() : null,
          feedCount: (await db.listFeeds(numId(u.id))).length,
          isSelf: numId(u.id) === user.id,
        })));
        json(res, 200, { users: list });
        return;
      }

      if (pathname === '/api/users' && req.method === 'POST') {
        if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
        const body = await readBody(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const role = body.role === 'admin' ? 'admin' : 'user';
        if (!/^[\w.\-@]{1,40}$/.test(username)) { json(res, 400, { error: '用户名只能包含字母、数字、. _ - @，且不超过 40 位' }); return; }
        if (password.length < 4) { json(res, 400, { error: '密码至少 4 位' }); return; }
        if (await db.getUserByName(username)) { json(res, 409, { error: '用户名已存在' }); return; }
        const salt = crypto.randomBytes(16).toString('hex');
        const created = await db.createUser({ username, salt, passwordHash: hashPassword(password, salt), role });
        await loadUsers();
        json(res, 200, { ok: true, user: { id: String(created.id), username: created.username, role: created.role } });
        return;
      }

      const userRoute = pathname.match(/^\/api\/users\/(\d+)$/);
      if (userRoute) {
        if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
        const uid = Number(userRoute[1]);
        const target = await db.getUserById(uid);
        if (!target) { json(res, 404, { error: '用户不存在' }); return; }
        const adminCount = async () => (await db.listUsers()).filter((u) => u.role === 'admin').length;

        if (req.method === 'PATCH') {
          const body = await readBody(req);
          if (body.role !== undefined) {
            const role = body.role === 'admin' ? 'admin' : 'user';
            if (target.role === 'admin' && role !== 'admin' && (await adminCount()) <= 1) {
              json(res, 400, { error: '至少要保留一个管理员' }); return;
            }
            await db.setUserRole(uid, role);
          }
          if (typeof body.password === 'string' && body.password) {
            if (body.password.length < 4) { json(res, 400, { error: '密码至少 4 位' }); return; }
            const salt = crypto.randomBytes(16).toString('hex');
            await db.setUserPassword(uid, salt, hashPassword(body.password, salt));
          }
          await loadUsers();
          const fresh = await db.getUserById(uid);
          json(res, 200, { ok: true, user: { id: String(fresh.id), username: fresh.username, role: fresh.role } });
          return;
        }
        if (req.method === 'DELETE') {
          if (uid === user.id) { json(res, 400, { error: '不能删除当前登录的账号' }); return; }
          if (target.role === 'admin' && (await adminCount()) <= 1) {
            json(res, 400, { error: '至少要保留一个管理员' }); return;
          }
          await db.deleteUser(uid);
          await loadUsers();
          json(res, 200, { ok: true });
          return;
        }
      }

      /* ---- 账号：改「自己」的密码 / 用户名 ---- */
      if (pathname === '/api/account' && req.method === 'POST') {
        const body = await readBody(req);
        const me = await db.getUserByName(user.username);
        if (!me || !safeEqual(hashPassword(body.currentPassword || '', me.salt), me.password_hash)) {
          json(res, 400, { error: '当前密码不正确' });
          return;
        }
        const newUser = String(body.username || '').trim();
        const newPass = String(body.newPassword || '');
        if (newPass && newPass.length < 4) { json(res, 400, { error: '新密码至少 4 位' }); return; }
        if (!newUser && !newPass) { json(res, 400, { error: '用户名和新密码至少填一项' }); return; }

        if (newPass) {
          const salt = crypto.randomBytes(16).toString('hex');
          await db.setUserPassword(user.id, salt, hashPassword(newPass, salt));
        }
        if (newUser && newUser !== me.username) {
          if (!/^[\w.\-@]{1,40}$/.test(newUser)) { json(res, 400, { error: '用户名只能包含字母、数字、. _ - @，且不超过 40 位' }); return; }
          if (await db.getUserByName(newUser)) { json(res, 400, { error: '用户名已被占用' }); return; }
          await db.setUsername(user.id, newUser);
        }
        await loadUsers();
        const fresh = usersById.get(user.id);
        setSession(res, fresh);
        json(res, 200, { ok: true, username: fresh.username, role: fresh.role });
        return;
      }

      /* ---- 摘要：测试模型（所有登录用户，只用自己的配置，不再回落站点默认）---- */
      if (pathname === '/api/digest/test-llm' && req.method === 'POST') {
        const body = await readBody(req);
        const llm = userLlm(user, settings.cryptoSecret);
        // 允许前端临时覆盖（填了就用填的，留空沿用本账号已保存的配置）
        if (body.llm) {
          if (body.llm.baseUrl !== undefined && body.llm.baseUrl.trim()) llm.baseUrl = body.llm.baseUrl.trim().replace(/\/+$/, '');
          if (body.llm.model !== undefined && body.llm.model.trim()) llm.model = body.llm.model.trim();
          if (typeof body.llm.apiKey === 'string' && body.llm.apiKey.trim()) llm.apiKey = body.llm.apiKey.trim();
          // 思考设置也接受临时覆盖：刚在面板里把开关拨开、还没保存，就该能试出上游认不认
          if (typeof body.llm.thinking === 'boolean') {
            llm.thinking = body.llm.thinking;
            llm.thinkingBudget = thinkingBudget(body.llm.thinkingDepth || llm.thinkingDepth);
          }
        }
        if (!llmComplete(llm)) {
          json(res, 200, { ok: false, error: '模型未配置完整：地址、API Key、模型名都要在本账号填写后才能测试' });
          return;
        }
        try { json(res, 200, await digest.testLlm(llm)); }
        catch (e) { json(res, 200, { ok: false, error: String((e && e.message) || e) }); }
        return;
      }

      if (pathname === '/api/digests' && req.method === 'GET') {
        json(res, 200, { dates: await db.listDigestDates(user.id) });
        return;
      }

      if (pathname === '/api/digest' && req.method === 'GET') {
        const date = searchParams.get('date') || shanghaiDateStr();
        json(res, 200, { date, digest: await db.readDigest(user.id, date) });
        return;
      }

      if (pathname === '/api/digest/generate' && req.method === 'POST') {
        // 账号自己关掉了日报：手动生成也一并挡掉，别留一条绕过开关烧额度的路
        if (userLayout(user).digestEnabled === false) {
          json(res, 400, { error: '日报已在本账号关闭。要在「设置 · 日报」里重新开启才能生成。' });
          return;
        }
        const body = await readBody(req);
        const date = String(body.date || '').trim() || shanghaiDateStr();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { json(res, 400, { error: '日期格式应为 YYYY-MM-DD' }); return; }
        const cfg = userDigest(user);
        // 未显式指定频道时，按本账号的「摘要范围」决定采集哪些频道
        const feeds = await digestFeedsFor(user.id, Array.isArray(body.feeds) ? body.feeds : null, cfg);
        try {
          const r = await digest.generate({
            ownerId: user.id, feeds, date, force: !!body.force,
            llm: userLlm(user, settings.cryptoSecret),
            style: cfg.style,
            limits: { maxPerFeed: cfg.maxPerFeed, maxTotal: cfg.maxTotal, keepDays: cfg.keepDays },
          });
          json(res, 200, { ok: true, cached: r.cached, digest: r.digest });
        } catch (e) {
          json(res, 502, { error: String((e && e.message) || e) });
        }
        return;
      }

      json(res, 404, { error: 'not found' });
      return;
    }

    serveStatic(pathname, res, user);
  } catch (err) {
    logErr('[http] ' + (err && err.stack || err));
    if (!res.headersSent) json(res, 502, { error: String((err && err.message) || err) });
    else res.end();
  }
});

/* ============================================================
 * 每日 AI 摘要：调度
 * ============================================================ */
function shanghaiDateStr(d) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d || new Date());
}

function msUntilNext(timeStr) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(timeStr || '08:00'));
  const hh = m ? Number(m[1]) : 8;
  const mm = m ? Number(m[2]) : 0;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  const cur = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
  const target = hh * 3600 + mm * 60;
  let delta = target - cur;
  if (delta <= 0) delta += 86400;
  return delta * 1000;
}

let digestTimer = null;

/** 按本账号的「摘要范围」解析本次日报要采集的频道 id 列表。
 *  - override（手动生成时前端传的 body.feeds）优先，且裁剪到该用户本人拥有的频道内；
 *  - 否则按 cfg.mode 解析：
 *      all     → null（表示该用户全部频道）
 *      enabled → 仅「采集」开启的频道
 *      custom  → cfg.feeds 与本人频道的交集
 * 返回 null 表示「全部频道」；返回数组（可能为空）表示限定范围。 */
async function digestFeedsFor(userId, override, cfg) {
  const d = cfg || DIGEST_DEFAULTS;
  const owned = await db.userFeedIds(userId);
  const ownedSet = new Set(owned);
  if (Array.isArray(override) && override.length) {
    return override.map(Number).filter((id) => ownedSet.has(id));
  }
  const mode = DIGEST_MODES.indexOf(d.mode) >= 0 ? d.mode : 'enabled';
  if (mode === 'all') return null;
  if (mode === 'enabled') return await db.enabledFeedIds(userId);
  return (d.feeds || []).map(Number).filter((id) => ownedSet.has(id));
}

/* 调度改成「每分钟 tick 一次，逐个账号看它自己的时间到没到」：
 * 站点级只有一个时间，任何用户改时间都要重算定时器；每人一份配置时这样最简单，
 * 而且容器夜里重启也不会漏掉某个账号的那一次（tick 以「今天的日期」判断，不依赖进程连续运行）。 */
const DIGEST_TICK_MS = 60 * 1000;

function scheduleDigest() {
  if (digestTimer) { clearInterval(digestTimer); digestTimer = null; }
  digestTimer = setInterval(() => { runDigestTick().catch((e) => logErr('[digest] 定时检查失败：' + ((e && e.message) || e))); }, DIGEST_TICK_MS);
  digestTimer.unref?.();
  log('[digest] 自动生成按账号调度中：每分钟检查一次各自的开关与时间');
}

/** 到点的那一批账号：每个账号自己决定开不开、几点跑、跑过没有 */
async function runDigestTick(now = new Date()) {
  const today = shanghaiDateStr(now);
  // 服务端时区固定是上海，这里同样按上海钟点比较，避免「服务器 UTC + 用户 08:00」差八小时
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(now);
  // 用内存注册表而不是每分钟查库：账号表本来就是内存态（改偏好后 loadUsers 刷新），
  // 每小时 60 次 × 每人一次 SELECT 在无人使用的夜里纯属浪费
  let touched = false;
  for (const u of usersById.values()) {
    try {
      // 关掉了日报入口的账号，定时也不该替他烧额度
      if (userLayout(u).digestEnabled === false) continue;
      const d = userDigest(u);
      if (!d.auto || d.time !== hhmm || d.lastAuto === today) continue;
      // 先落「今天已处理」再干活：宁可少跑一次，也不能让失败/降级的账号每分钟重跑
      await db.setUserPrefs(u.id, Object.assign({}, u.prefs || {}, {
        digest: Object.assign({}, d, { lastAuto: today }),
      }));
      touched = true;
      const llm = userLlm(u, settings.cryptoSecret);
      if (!llmComplete(llm)) {
        log(`[digest] 用户#${u.id} 到点但模型没配齐，跳过（今天不再重试）`);
        continue;
      }
      const feeds = await digestFeedsFor(u.id, null, d);
      const r = await digest.generate({
        ownerId: u.id, feeds, force: true, llm,
        style: d.style,
        limits: { maxPerFeed: d.maxPerFeed, maxTotal: d.maxTotal, keepDays: d.keepDays },
      });
      log(`[digest] 用户#${u.id} 已生成 ${r.digest.date} 摘要：`
        + `${r.digest.stats.kept}/${r.digest.stats.collected} 条，${r.digest.stats.feeds} 个频道`
        + (r.digest.fallback ? '（规则降级）' : `（${r.digest.model}）`));
    } catch (e) {
      logErr(`[digest] 用户#${u.id} 自动生成失败：` + ((e && e.message) || e));
    }
  }
  if (touched) await loadUsers();
}

/* ============================================================
 * 状态页：把散落在各处的运行指标聚成一次快照
 * ============================================================ */

const readCgroupFile = (file) => {
  try { return String(fs.readFileSync(file, 'utf8')).trim(); } catch (_) { return null; }
};

/** 正整数字节数；cgroup v2 未设限额时内容是 "max" → NaN，正好被挡掉 */
function cgroupBytes(raw, { cap = 2 ** 40 } = {}) {
  const n = Number(raw);
  // 上限 1 TiB（注意必须写 2 ** 40：JS 的位运算只有 32 位，1 << 40 会变成 256）
  // v1 的「无限制」是个接近 2^63 的巨数，超过这个量级一律当作未设限
  return Number.isFinite(n) && n > 0 && n < cap ? n : null;
}

/** 容器内存。v2 优先、v1 兜底；即使没设限额，memory.current 也是有意义的真实占用 */
function readCgroupMemory() {
  const v2Used = cgroupBytes(readCgroupFile('/sys/fs/cgroup/memory.current'));
  if (v2Used !== null) {
    return { used: v2Used, limit: cgroupBytes(readCgroupFile('/sys/fs/cgroup/memory.max')) };
  }
  const v1Used = cgroupBytes(readCgroupFile('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  if (v1Used !== null) {
    return { used: v1Used, limit: cgroupBytes(readCgroupFile('/sys/fs/cgroup/memory/memory.limit_in_bytes')) };
  }
  return null;
}

// 容器 CPU 是累计值，只有两次采样相减才有意义；状态页每 30s 拉一次，正好当采样点
let lastCpuSample = null;
/** 容器 CPU 占用（%，相对单核；多核可超过 100）。首次请求没有基准，返回 null */
function readCgroupCpu() {
  let usec = null;
  const v2 = /^usage_usec\s+(\d+)/m.exec(readCgroupFile('/sys/fs/cgroup/cpu.stat') || '');
  if (v2) usec = Number(v2[1]) / 1000;                                  // v2 单位是微秒
  else {
    const v1 = readCgroupFile('/sys/fs/cgroup/cpuacct/cpuacct.usage');
    if (v1) usec = Number(v1) / 1000;                                   // v1 单位是纳秒
  }
  if (!Number.isFinite(usec)) return null;

  const at = Date.now();
  const prev = lastCpuSample;
  lastCpuSample = { usec, at };
  if (!prev) return null;                                               // 第一次只记基准
  const dtMs = at - prev.at;
  if (dtMs < 1000) return null;
  const cpuMs = usec - prev.usec;
  if (!Number.isFinite(cpuMs) || cpuMs < 0) return null;                // 容器重启过，重新记基准
  return Math.round((cpuMs / dtMs) * 10000) / 100;
}

async function buildStatus() {
  const now = Date.now();
  const mem = process.memoryUsage();
  const st = db.status();

  /* ---- 数据库 ---- */
  const dbInfo = { ready: st.ready, error: st.error || null, latencyMs: null, pool: null, tables: null, sizeBytes: null };
  if (st.ready) {
    try {
      const [latencyMs, tables, sizeBytes] = await Promise.all([db.ping(), db.tableCounts(), db.pgDatabaseSize()]);
      dbInfo.latencyMs = latencyMs;
      dbInfo.tables = tables;
      dbInfo.sizeBytes = sizeBytes;
    } catch (e) {
      dbInfo.error = String((e && e.message) || e);
    }
    const p = db.pool;
    dbInfo.pool = {
      total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount,
      max: (p.options && p.options.max) || Number(process.env.PG_POOL_MAX || 10),
    };
  }

  /* ---- RSS ---- */
  let feedStats = { total: 0, enabled: 0, cardEnabled: 0, error: 0, neverFetched: 0, perFeedInterval: 0, autoDisabled: 0 };
  let problems = [];
  let dueCount = 0;
  let nextRefreshAt = null;
  const entryInfo = { total: 0, unread: 0, favorite: 0, added24h: 0, oldest: null, newest: null };
  if (st.ready) {
    try {
      const feeds = (await db.allFeeds()).map((r) => toFeedDto(r, settings.source.refreshMinutes));
      feedStats = {
        total: feeds.length,
        enabled: feeds.filter((f) => f.enabled).length,
        cardEnabled: feeds.filter((f) => f.cardEnabled).length,
        error: feeds.filter((f) => f.status === 'error').length,
        neverFetched: feeds.filter((f) => !f.lastFetchedAt).length,
        // 有多少个频道用了自己的抓取频率（其余跟随全局）
        perFeedInterval: feeds.filter((f) => f.refreshMinutes != null).length,
        // 因连续失败被自动停用的频道数（重试成功会自动恢复）
        autoDisabled: feeds.filter((f) => !f.enabled && f.failStreak >= feedFailLimit()).length,
      };
      problems = feeds.filter((f) => f.status === 'error').map((f) => ({
        feedId: f.id, title: f.title, error: f.error || '抓取失败',
        lastFetchedAt: f.lastFetchedAt, groupName: f.groupName,
        enabled: f.enabled, failStreak: f.failStreak,
      }));
      // 「下次抓取」= 已开启采集的频道里最早到期的那个；已经过了的时刻算「现在就该抓」
      let earliest = null;
      for (const f of feeds) {
        if (!f.enabled) continue;
        const at = f.nextRefreshAt ? new Date(f.nextRefreshAt).getTime() : now;
        if (at <= now) dueCount += 1;
        if (earliest === null || at < earliest) earliest = at;
      }
      nextRefreshAt = earliest === null ? null : new Date(Math.max(earliest, now)).toISOString();
      Object.assign(entryInfo, await db.entryWindow());
      const flags = await db.entryFlagCounts(null).catch(() => null);
      if (flags) { entryInfo.unread = flags.unread; entryInfo.favorite = flags.favorite; }
    } catch (_) { /* 上面的错误已记录在 dbInfo.error，这里不重复报 */ }
  }
  if (dbInfo.tables) entryInfo.total = dbInfo.tables.entries;

  /* ---- 日报 ----
   * 配置已按账号走（prefs.digest），站点级不再有一份；
   * 状态页是管理员视角，只报「有多少账号开了自动生成」+ 最近一份日报的事实。 */
  const digestInfo = {
    autoUsers: 0, totalUsers: 0,
    nextRunAt: null, count: 0, oldestDate: null, latest: null,
  };
  if (st.ready) {
    try {
      const list = await db.listUsers();
      digestInfo.totalUsers = list.length;
      let earliest = null;
      for (const u of list) {
        const d = userDigest(u);
        if (!d.auto || userLayout(u).digestEnabled === false) continue;
        digestInfo.autoUsers += 1;
        const at = Date.now() + msUntilNext(d.time);
        if (earliest === null || at < earliest) earliest = at;
      }
      if (earliest !== null) digestInfo.nextRunAt = new Date(earliest).toISOString();
    } catch (_) { /* 静默：日报不是关键路径 */ }
    try {
      const ds = await db.digestStatsAll();
      digestInfo.count = (dbInfo.tables && dbInfo.tables.digests) || ds.count;
      digestInfo.oldestDate = ds.oldestDate;
      const d = ds.latest;
      if (d) {
        digestInfo.latest = {
          date: d.date, generatedAt: d.generatedAt || null, model: d.model || '',
          fallback: !!d.fallback, error: d.error || null,
          usedMapReduce: !!d.usedMapReduce, stats: d.stats || null,
        };
      }
    } catch (_) { /* 静默：日报不是关键路径 */ }
  }

  // 容器指标拿不到（非 Docker 环境 / 权限不足）不该影响整页，所以单独兜一层
  let container = null;
  try {
    const cgMem = readCgroupMemory();
    const cgCpu = readCgroupCpu();
    if (cgMem || cgCpu !== null) {
      container = {
        memoryUsed: cgMem ? cgMem.used : null,
        memoryLimit: cgMem ? cgMem.limit : null,
        cpuPercent: cgCpu,
      };
    }
  } catch (_) { /* 忽略：下面其余指标照常返回 */ }

  return {
    app: {
      version: pkg.version, node: process.version, pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      startedAt: new Date(now - process.uptime() * 1000).toISOString(),
      timezone: 'Asia/Shanghai',
      now: new Date(now).toISOString(),
      today: shanghaiDateStr(new Date(now)),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
      container,
      loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      cpuCount: os.cpus().length,
    },
    db: dbInfo,
    rss: {
      refreshMinutes: settings ? settings.source.refreshMinutes : 30,
      keepPerFeed: settings ? settings.source.keepPerFeed : 300,
      keepDays: settings ? settings.source.keepDays : 0,
      autoRefreshMinutes: settings ? settings.source.autoRefreshMinutes : 0,
      concurrency: settings ? settings.source.concurrency : 3,
      timeoutSeconds: settings ? settings.source.timeoutSeconds : 25,
      feedFailLimit: feedFailLimit(),
      proxyUrl: settings ? settings.source.proxyUrl : '',
      lastRefreshAt: lastRefresh.at || null,
      nextRefreshAt,
      dueCount,
      inFlight: inFlightUrl.size,
      lastResult: lastRefresh.at ? {
        added: lastRefresh.added, pruned: lastRefresh.pruned,
        skipped: lastRefresh.skipped, failed: lastRefresh.failed, autoDisabled: lastRefresh.autoDisabled || 0,
        filtered: lastRefresh.filtered || 0,
        durationMs: lastRefresh.durationMs,
      } : null,
      feeds: feedStats,
      entries: entryInfo,
      problems,
    },
    digest: digestInfo,
  };
}

/* ============================================================
 * 启动
 * ============================================================ */
let digest = null;

/** 首次部署时用 SEED_FEEDS 播种几个 RSS 地址（逗号分隔），挂到首个管理员名下 */
async function seedFeeds() {
  const raw = String(process.env.SEED_FEEDS || '').trim();
  if (!raw) return;
  const admin = (await db.listUsers()).find((u) => u.role === 'admin');
  if (!admin) return;
  const existing = await db.listFeeds(admin.id);
  if (existing.length) return;
  for (const u of raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)) {
    try {
      const url = rss.assertFeedUrl(u);
      const feed = await db.addFeed(admin.id, url);
      const r = await refreshFeed(feed);
      log(`[seed] 已添加 ${url} → ${r.error ? '失败：' + r.error : `新增 ${r.added} 条`}`);
    } catch (e) {
      logErr(`[seed] 跳过 ${u}：${(e && e.message) || e}`);
    }
  }
}

/**
 * 首次启动 / 老库升级：把 settings.auth 里原有的单账号迁成第一个管理员。
 * 已存在用户时什么都不做（幂等）。
 */
async function ensureAdmin() {
  if ((await db.countUsers()) > 0) return;
  const a = settings.auth || {};
  const username = String(a.username || 'admin').trim() || 'admin';
  const salt = a.salt || crypto.randomBytes(16).toString('hex');
  const passwordHash = a.passwordHash || hashPassword('admin', salt);
  await db.createUser({ username, salt, passwordHash, role: 'admin' });
  log(`[app] 已创建首个管理员账号：${username}（原单账号已迁移，密码不变）`);
}

db.onReady(async () => {
  await loadSettings();
  await ensureAdmin();
  await db.bootstrapOwnership();   // 把没有归属的老 feeds / digests 归给首个管理员
  await loadUsers();
  const names = [...usersById.values()].map((u) => `${u.username}(${u.role})`).join(', ');
  log(`[app] 设置已载入 | 用户: ${names || '（无）'} | 库: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
  digest = createDigest({ db, log });
  scheduleDigest();
  scheduleRefresh();
  await seedFeeds().catch((e) => logErr('[seed] 失败：' + ((e && e.message) || e)));
  // 启动后稍等再抓一轮，避免和容器健康检查抢资源
  setTimeout(() => refreshAll().catch((e) => logErr('[rss] 首次抓取失败：' + ((e && e.message) || e))), 3000);
});

db.start();

server.listen(PORT, HOST, () => {
  log(`笺川（FeedLore）已启动: http://${HOST}:${PORT}`);
  log(`数据库: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
});

/* 优雅退出 */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    log(`收到 ${sig}，正在退出…`);
    server.close();
    if (digestTimer) clearTimeout(digestTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    await db.close();
    process.exit(0);
  });
}
