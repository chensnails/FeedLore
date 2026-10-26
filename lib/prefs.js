'use strict';

/**
 * 笺川 · 用户偏好清洗（外观 / 布局 / 过滤规则 / 日报配置）
 *
 * 这两组偏好直接来自浏览器请求体，等同于不可信输入：非法值一律回落默认，
 * 而不是报错 —— 一次脏请求不该让用户丢掉整个外观设置。
 * 与前端的 src/core/state.js sanitizeAppearanceLocal / sanitizeLayoutLocal 是同一套取值表，
 * 两端必须保持一致（改一处记得改另一处）。
 * v2.2.0 起抽出到 lib/ 由 node:test 覆盖。
 */

const { clampInt } = require('./util');

/* ---------------- 外观（主题 / 主色 / 字号 / 阅读排版） ---------------- */

const APPEARANCE_DEFAULTS = {
  theme: 'auto', accent: 'blue', fontSize: 'm',
  readerFont: 'sans', readerLh: 'm', readerFs: 'm', readerWidth: 'm',
};
const APPEARANCE_KEYS = {
  theme: ['auto', 'light', 'dark', 'github'],
  accent: ['blue', 'violet', 'teal', 'green', 'amber', 'rose'],
  fontSize: ['s', 'm', 'l'],
  readerFont: ['sans', 'serif'],
  readerLh: ['s', 'm', 'l'],
  readerFs: ['s', 'm', 'l'],
  readerWidth: ['s', 'm', 'l', 'full'],
};

/** 逐键白名单过滤；未列出的键被丢弃，非法值回落默认 */
function sanitizeAppearance(raw) {
  const out = Object.assign({}, APPEARANCE_DEFAULTS);
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(APPEARANCE_DEFAULTS)) {
      if (APPEARANCE_KEYS[k].indexOf(raw[k]) >= 0) out[k] = raw[k];
    }
  }
  return out;
}

const userAppearance = (u) => sanitizeAppearance((u && u.prefs && u.prefs.appearance) || {});

/* ---------------- 布局（视图模式 / 页面 / 折叠 / 手风琴） ---------------- */

const LAYOUT_DEFAULTS = {
  view: 'grid', tab: 'reader', collapsedGroups: [], accordion: true,
  sections: {}, sort: 'new', rdScope: 'all',
  rdCollapsedGroups: [], readerSideWidth: 232, digestEnabled: true,
};
const LAYOUT_VALUES = {
  view: ['grid', 'list'],
  tab: ['reader', 'cards', 'ai'],
  sort: ['new', 'old', 'name'],
  rdScope: ['all', 'unread', 'favorite'],
};

// 频道栏宽度的硬边界（与前端 state.js 的 READER_SIDE_MIN/MAX/DEFAULT 同源）：
// 自适应上限（40vw）只在渲染时收，持久化值按屏幕改来改去会让用户换个设备就丢了选择。
const READER_SIDE_MIN = 180;
const READER_SIDE_MAX = 400;
const READER_SIDE_DEFAULT = 232;

function clampReaderSide(px) {
  const n = Math.round(Number(px));
  if (!Number.isFinite(n) || n <= 0) return READER_SIDE_DEFAULT;
  return Math.min(READER_SIDE_MAX, Math.max(READER_SIDE_MIN, n));
}

/** 分组名数组的清洗：只留字符串、截断到 40 字符（这些串要进 DOM id） */
function sanitizeGroupList(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.filter((g) => typeof g === 'string').map((g) => g.slice(0, 40));
}

function sanitizeLayout(raw) {
  const out = Object.assign({}, LAYOUT_DEFAULTS);
  if (raw && typeof raw === 'object') {
    if (LAYOUT_VALUES.view.indexOf(raw.view) >= 0) out.view = raw.view;
    if (LAYOUT_VALUES.tab.indexOf(raw.tab) >= 0) out.tab = raw.tab;
    const cg = sanitizeGroupList(raw.collapsedGroups);
    if (cg) out.collapsedGroups = cg;
    // 只有显式 false 才关（undefined 不该把用户的设置清掉）
    out.accordion = raw.accordion === false ? false : true;
    if (raw.sections && typeof raw.sections === 'object') {
      const sec = {};
      Object.keys(raw.sections).forEach((k) => { sec[k] = raw.sections[k] === true; });
      out.sections = sec;
    }
    // 阅读页排序方式（最新 / 最早 / 名称）与默认范围（全部 / 未读 / 收藏）
    if (LAYOUT_VALUES.sort.indexOf(raw.sort) >= 0) out.sort = raw.sort;
    if (LAYOUT_VALUES.rdScope.indexOf(raw.rdScope) >= 0) out.rdScope = raw.rdScope;
    // 阅读页频道栏：分组折叠 + 栏宽（v1.4.0-test）
    const rcg = sanitizeGroupList(raw.rdCollapsedGroups);
    if (rcg) out.rdCollapsedGroups = rcg;
    out.readerSideWidth = clampReaderSide(raw.readerSideWidth);
    // 日报是否对本账号开启（关掉 = 顶栏不再有入口，定时生成也跳过）
    out.digestEnabled = raw.digestEnabled === false ? false : true;
  }
  return out;
}

const userLayout = (u) => sanitizeLayout((u && u.prefs && u.prefs.layout) || {});

/* ---------------- 条目过滤规则（v2.7.0） ---------------- */

// 每人最多 50 条：再多说明在滥用，且每轮抓取都要逐条跑一遍
const FILTER_MAX_RULES = 50;
const FILTER_FIELDS = ['title', 'desc', 'content', 'all'];
const FILTER_ACTS = ['block', 'allow'];

/**
 * 清洗用户提交的过滤规则。非法值一律丢弃该条而不是报错——
 * 与外观/布局同一立场：一次脏请求不该让用户丢掉整套规则。
 * 非法正则直接丢（提交时就该被前端拦下，这里是服务端兜底）。
 */
function sanitizeFilters(raw, { MAX_PATTERN } = {}) {
  const maxLen = Number(MAX_PATTERN) > 0 ? Number(MAX_PATTERN) : 200;
  const out = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set();
  for (const r of raw.slice(0, FILTER_MAX_RULES)) {
    if (!r || typeof r !== 'object') continue;
    const act = FILTER_ACTS.indexOf(r.act) >= 0 ? r.act : 'block';
    const field = FILTER_FIELDS.indexOf(r.field) >= 0 ? r.field : 'all';
    const kind = r.kind === 're' ? 're' : 'kw';
    const pattern = typeof r.pattern === 'string' ? r.pattern.trim() : '';
    if (!pattern || pattern.length > maxLen) continue;
    if (kind === 're') {
      try { new RegExp(pattern); } catch (_) { continue; }
    }
    // id 由前端生成；缺失或撞车时用序号兜底（保证同一条规则在同一请求内可辨识）
    let id = typeof r.id === 'string' ? r.id.trim().slice(0, 40) : '';
    if (!id || seen.has(id)) id = 'f' + (out.length + 1);
    seen.add(id);
    out.push({ id, on: r.on !== false, act, field, kind, pattern });
  }
  return out;
}

const userFilters = (u, opts) => sanitizeFilters((u && u.prefs && u.prefs.filters) || [], opts);

/* ---------------- 日报配置（整组跟随账号，不再是管理员的站点设置） ---------------- */

/* 上限 2000 字：这段文字每轮模型调用都要占一份 prompt 预算，
 * 再长就会挤掉条目列表本身（日报输入动辄上百行）。 */
const DIGEST_PROMPT_MAX = 2000;

const DIGEST_MODES = ['enabled', 'all', 'custom'];
const DIGEST_DEFAULTS = {
  /* 自动生成默认关：日报是真金白银调模型的，「没人开口就在烧额度」是最坏的情况。
   * 站点级那层总闸（settings.digest.enabled）连同管理员门控一起退场了。 */
  auto: false,
  time: '08:00',
  mode: 'enabled',
  feeds: [],
  maxPerFeed: 20,
  maxTotal: 150,
  keepDays: 30,
  style: '',
  // 只由服务端写（调度器用它判断「今天这一轮已经跑过了」），客户端提交一律忽略
  lastAuto: '',
};
// 自定义范围最多勾 200 个频道：单人订阅量级用不满，纯粹防一个脏请求塞进十万个 id
const DIGEST_FEEDS_MAX = 200;

/** 'HH:MM'（24 小时、零填充）。前端是 <input type=time>，这里是服务端兜底。
 *  逐位卡范围而不是 'x' < '24:00' 那种字符串比较：'07:60' 也能过后者，但那不是个时间点。 */
function sanitizeDigestTime(raw) {
  const t = typeof raw === 'string' ? raw.trim() : '';
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : DIGEST_DEFAULTS.time;
}

/**
 * 清洗用户写的「日报风格要求」。只收纯文本：换行归一成 \n、剥掉控制字符
 * （这段要原样拼进发给模型的 prompt，留下 ESC / NUL 之类就是往上游塞垃圾）、截到上限。
 * 非字符串 / 全空白一律当「没写」，回落内置风格。
 */
function sanitizeDigestPrompt(raw) {
  if (typeof raw !== 'string') return '';
  const t = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, DIGEST_PROMPT_MAX);
  return t;
}

/** 整组日报配置的清洗：一次脏请求不该让人丢掉整套设置，逐字段回落默认。 */
function sanitizeDigest(raw) {
  const out = Object.assign({}, DIGEST_DEFAULTS, { feeds: [] });
  if (!raw || typeof raw !== 'object') return out;
  // 与 layout.digestEnabled 相反：这个开关只有显式 true 才开（默认不自动生成）
  out.auto = raw.auto === true;
  out.time = sanitizeDigestTime(raw.time);
  if (DIGEST_MODES.indexOf(raw.mode) >= 0) out.mode = raw.mode;
  if (Array.isArray(raw.feeds)) {
    const seen = new Set();
    for (const n of raw.feeds) {
      const id = Number(n);
      if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      if (out.feeds.length < DIGEST_FEEDS_MAX) out.feeds.push(Math.trunc(id));
    }
  }
  out.maxPerFeed = clampInt(raw.maxPerFeed, DIGEST_DEFAULTS.maxPerFeed, 1, 100);
  out.maxTotal = clampInt(raw.maxTotal, DIGEST_DEFAULTS.maxTotal, 10, 500);
  out.keepDays = clampInt(raw.keepDays, DIGEST_DEFAULTS.keepDays, 1, 365);
  // style 是这版的键；digestPrompt 是它刚从顶层 prefs 搬进来时的旧名，读的时候认一下
  out.style = sanitizeDigestPrompt(raw.style !== undefined ? raw.style : raw.digestPrompt);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(raw.lastAuto || ''))) out.lastAuto = String(raw.lastAuto);
  return out;
}

const userDigest = (u) => sanitizeDigest((u && u.prefs && u.prefs.digest) || {});

/** 取本账号的日报风格要求。
 *  升级前这段文字存在 prefs 顶层（digestPrompt），现在在 prefs.digest.style；
 *  老账号没重新保存过一次之前读的仍是顶层那份。 */
function userDigestPrompt(u) {
  const p = (u && u.prefs) || {};
  if (p.digest && p.digest.style !== undefined) return userDigest(u).style;
  return sanitizeDigestPrompt(p.digestPrompt);
}

module.exports = {
  APPEARANCE_DEFAULTS, APPEARANCE_KEYS, sanitizeAppearance, userAppearance,
  LAYOUT_DEFAULTS, LAYOUT_VALUES, sanitizeLayout, userLayout, clampReaderSide,
  READER_SIDE_MIN, READER_SIDE_MAX, READER_SIDE_DEFAULT,
  FILTER_MAX_RULES, FILTER_FIELDS, FILTER_ACTS, sanitizeFilters, userFilters,
  DIGEST_PROMPT_MAX, sanitizeDigestPrompt,
  DIGEST_MODES, DIGEST_DEFAULTS, DIGEST_FEEDS_MAX,
  sanitizeDigestTime, sanitizeDigest, userDigest, userDigestPrompt,
};
