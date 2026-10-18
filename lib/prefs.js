'use strict';

/**
 * 笺川 · 用户偏好清洗（外观 / 布局）
 *
 * 这两组偏好直接来自浏览器请求体，等同于不可信输入：非法值一律回落默认，
 * 而不是报错 —— 一次脏请求不该让用户丢掉整个外观设置。
 * 与前端的 src/core/state.js sanitizeAppearanceLocal / sanitizeLayoutLocal 是同一套取值表，
 * 两端必须保持一致（改一处记得改另一处）。
 * v2.2.0 起抽出到 lib/ 由 node:test 覆盖。
 */

/* ---------------- 外观（主题 / 主色 / 字号 / 阅读排版） ---------------- */

const APPEARANCE_DEFAULTS = {
  theme: 'auto', accent: 'blue', fontSize: 'm',
  readerFont: 'sans', readerLh: 'm', readerWidth: 'm',
};
const APPEARANCE_KEYS = {
  theme: ['auto', 'light', 'dark', 'github'],
  accent: ['blue', 'violet', 'teal', 'green', 'amber', 'rose'],
  fontSize: ['s', 'm', 'l'],
  readerFont: ['sans', 'serif'],
  readerLh: ['s', 'm', 'l'],
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

/* ---------------- 布局（视图模式 / 页面 / 折叠 / 手风琴 / AI 子页） ---------------- */

const LAYOUT_DEFAULTS = {
  view: 'grid', tab: 'reader', collapsedGroups: [], accordion: true,
  aiPage: 'digest', sections: {}, sort: 'new', rdScope: 'all',
};
const LAYOUT_VALUES = {
  view: ['grid', 'list'],
  tab: ['reader', 'cards', 'ai'],
  aiPage: ['digest', 'settings'],
  sort: ['new', 'old', 'name'],
  rdScope: ['all', 'unread', 'favorite'],
};

function sanitizeLayout(raw) {
  const out = Object.assign({}, LAYOUT_DEFAULTS);
  if (raw && typeof raw === 'object') {
    if (LAYOUT_VALUES.view.indexOf(raw.view) >= 0) out.view = raw.view;
    if (LAYOUT_VALUES.tab.indexOf(raw.tab) >= 0) out.tab = raw.tab;
    if (Array.isArray(raw.collapsedGroups)) {
      // 分组名截断到 40 字符：这是要进 DOM id 的，别让请求体塞超长串
      out.collapsedGroups = raw.collapsedGroups.filter((g) => typeof g === 'string').map((g) => g.slice(0, 40));
    }
    // 只有显式 false 才关（undefined 不该把用户的设置清掉）
    out.accordion = raw.accordion === false ? false : true;
    if (LAYOUT_VALUES.aiPage.indexOf(raw.aiPage) >= 0) out.aiPage = raw.aiPage;
    if (raw.sections && typeof raw.sections === 'object') {
      const sec = {};
      Object.keys(raw.sections).forEach((k) => { sec[k] = raw.sections[k] === true; });
      out.sections = sec;
    }
    // 阅读页排序方式（最新 / 最早 / 名称）与默认范围（全部 / 未读 / 收藏）
    if (LAYOUT_VALUES.sort.indexOf(raw.sort) >= 0) out.sort = raw.sort;
    if (LAYOUT_VALUES.rdScope.indexOf(raw.rdScope) >= 0) out.rdScope = raw.rdScope;
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

module.exports = {
  APPEARANCE_DEFAULTS, APPEARANCE_KEYS, sanitizeAppearance, userAppearance,
  LAYOUT_DEFAULTS, LAYOUT_VALUES, sanitizeLayout, userLayout,
  FILTER_MAX_RULES, FILTER_FIELDS, FILTER_ACTS, sanitizeFilters, userFilters,
};
