/**
 * 用户偏好清洗与读取（对齐 apps/legacy/lib/prefs.js）。
 *
 * 立场与 legacy 完全一致：**偏好来自浏览器，等同不可信输入**，非法值逐键回落默认，
 * 而不是整体报错——一次脏请求不该让用户丢掉整份外观/布局设置。
 *
 * ⚠️ 这里的默认值与取值表必须和 packages/contract 的 Appearance/Layout schema 同步。
 * 契约负责「拒绝不符合契约的响应」，本文件负责「把脏数据洗成符合契约的形状」。
 */

export const APPEARANCE_DEFAULTS = {
  theme: 'auto',
  accent: 'blue',
  fontSize: 'm',
  density: 'cozy',
  readerFont: 'sans',
  readerLh: 'm',
  readerFs: 'm',
  readerWidth: 'm',
} as const;

const APPEARANCE_KEYS: Record<keyof typeof APPEARANCE_DEFAULTS, readonly string[]> = {
  theme: ['auto', 'light', 'dark', 'github'],
  accent: ['blue', 'violet', 'teal', 'green', 'amber', 'rose'],
  fontSize: ['s', 'm', 'l'],
  density: ['cozy', 'compact'],
  readerFont: ['sans', 'serif'],
  readerLh: ['s', 'm', 'l'],
  readerFs: ['s', 'm', 'l'],
  readerWidth: ['s', 'm', 'l', 'full'],
};

export type Appearance = { -readonly [K in keyof typeof APPEARANCE_DEFAULTS]: string };

export function sanitizeAppearance(raw: unknown): Appearance {
  const out: Appearance = { ...APPEARANCE_DEFAULTS };
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    for (const k of Object.keys(APPEARANCE_DEFAULTS) as (keyof Appearance)[]) {
      const v = r[k];
      if (typeof v === 'string' && APPEARANCE_KEYS[k].includes(v)) out[k] = v;
    }
  }
  return out;
}

/* ---------------- 布局 ---------------- */

export const LAYOUT_DEFAULTS = {
  view: 'grid',
  tab: 'reader',
  collapsedGroups: [] as string[],
  accordion: true,
  sections: {} as Record<string, boolean>,
  sort: 'new',
  rdScope: 'all',
  rdCollapsedGroups: [] as string[],
  readerSideWidth: 232,
  digestEnabled: true,
};

const LAYOUT_VALUES = {
  view: ['grid', 'list'],
  tab: ['reader', 'cards', 'ai'],
  sort: ['new', 'old', 'name'],
  rdScope: ['all', 'unread', 'favorite'],
};

export const READER_SIDE_MIN = 180;
export const READER_SIDE_MAX = 400;
export const READER_SIDE_DEFAULT = 232;

/** 频道栏宽度：按屏幕改来改去会让用户换设备就丢选择，故持久化值一律夹到硬边界内。 */
export function clampReaderSide(px: unknown): number {
  const n = Math.round(Number(px));
  if (!Number.isFinite(n) || n <= 0) return READER_SIDE_DEFAULT;
  return Math.min(READER_SIDE_MAX, Math.max(READER_SIDE_MIN, n));
}

function groupList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter((g): g is string => typeof g === 'string').map((g) => g.slice(0, 40));
}

export type Layout = typeof LAYOUT_DEFAULTS;

export function sanitizeLayout(raw: unknown): Layout {
  const out: Layout = { ...LAYOUT_DEFAULTS, collapsedGroups: [], sections: {}, rdCollapsedGroups: [] };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;

  if (typeof r.view === 'string' && LAYOUT_VALUES.view.includes(r.view)) out.view = r.view;
  if (typeof r.tab === 'string' && LAYOUT_VALUES.tab.includes(r.tab)) out.tab = r.tab;

  const cg = groupList(r.collapsedGroups);
  if (cg) out.collapsedGroups = cg;

  // 只有显式 false 才关：undefined 不该把用户设置清掉
  out.accordion = r.accordion === false ? false : true;

  if (r.sections && typeof r.sections === 'object') {
    const sec: Record<string, boolean> = {};
    for (const k of Object.keys(r.sections as Record<string, unknown>)) {
      sec[k] = (r.sections as Record<string, unknown>)[k] === true;
    }
    out.sections = sec;
  }

  if (typeof r.sort === 'string' && LAYOUT_VALUES.sort.includes(r.sort)) out.sort = r.sort;
  if (typeof r.rdScope === 'string' && LAYOUT_VALUES.rdScope.includes(r.rdScope)) out.rdScope = r.rdScope;

  const rcg = groupList(r.rdCollapsedGroups);
  if (rcg) out.rdCollapsedGroups = rcg;

  out.readerSideWidth = clampReaderSide(r.readerSideWidth);
  out.digestEnabled = r.digestEnabled === false ? false : true;
  return out;
}

/* ---------------- 过滤规则 ---------------- */

const FILTER_MAX_RULES = 50;
const FILTER_FIELDS = ['title', 'desc', 'content', 'all'];
const FILTER_ACTS = ['block', 'allow'];

export interface FilterRule {
  id: string;
  on: boolean;
  act: string;
  field: string;
  kind: 'kw' | 're';
  pattern: string;
}

export function sanitizeFilters(raw: unknown, maxPattern = 200): FilterRule[] {
  const out: FilterRule[] = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set<string>();
  for (const item of raw.slice(0, FILTER_MAX_RULES)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const act = typeof r.act === 'string' && FILTER_ACTS.includes(r.act) ? r.act : 'block';
    const field = typeof r.field === 'string' && FILTER_FIELDS.includes(r.field) ? r.field : 'all';
    const kind: 'kw' | 're' = r.kind === 're' ? 're' : 'kw';
    const pattern = typeof r.pattern === 'string' ? r.pattern.trim() : '';
    if (!pattern || pattern.length > maxPattern) continue;
    if (kind === 're') {
      try {
        new RegExp(pattern);
      } catch {
        continue; // 非法正则直接丢，别让它每轮抓取都抛一次
      }
    }
    let id = typeof r.id === 'string' ? r.id.trim().slice(0, 40) : '';
    if (!id || seen.has(id)) id = 'f' + (out.length + 1);
    seen.add(id);
    out.push({ id, on: r.on !== false, act, field, kind, pattern });
  }
  return out;
}

/* ---------------- 关注 / 屏蔽规则 ---------------- */

const WATCH_MAX_RULES = 30;
const WATCH_MAX_KEYWORDS = 50;
const WATCH_KEYWORD_MAX = 60;
const WATCH_NAME_MAX = 40;
const WATCH_ACTS = ['watch', 'block'];

export interface WatchRule {
  id: string;
  name: string;
  keywords: string[];
  act: string;
  notify: boolean;
  on: boolean;
}

function normalizeKeywords(raw: unknown): string[] {
  let list: unknown[] = [];
  if (typeof raw === 'string') list = raw.split(/\r?\n/);
  else if (Array.isArray(raw)) list = raw;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of list) {
    if (typeof k !== 'string') continue;
    const v = k.trim().slice(0, WATCH_KEYWORD_MAX);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= WATCH_MAX_KEYWORDS) break;
  }
  return out;
}

export function sanitizeWatchRules(raw: unknown): WatchRule[] {
  const out: WatchRule[] = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set<string>();
  for (const item of raw.slice(0, WATCH_MAX_RULES)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const keywords = normalizeKeywords(r.keywords);
    if (!keywords.length) continue;

    const act = typeof r.act === 'string' && WATCH_ACTS.includes(r.act) ? r.act : 'watch';
    let id = typeof r.id === 'string' ? r.id.trim().slice(0, 40) : '';
    if (!id || seen.has(id)) id = 'w' + (out.length + 1);
    seen.add(id);

    const name = (typeof r.name === 'string' ? r.name.trim() : '').slice(0, WATCH_NAME_MAX);
    out.push({
      id,
      name: name || (act === 'block' ? '屏蔽规则 ' : '关注规则 ') + (out.length + 1),
      keywords,
      act,
      // notify 只对 watch 有意义：「这条被屏蔽了」不值得通知
      notify: act === 'watch' && r.notify === true,
      on: r.on !== false,
    });
  }
  return out;
}

/* ---------------- webhook ---------------- */

export function sanitizeWebhook(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v || v.length > 500) return '';
  return /^https?:\/\//i.test(v) ? v : '';
}

/* ---------------- 日报配置 ---------------- */

const DIGEST_MODES = ['enabled', 'all', 'custom'];
const DIGEST_PROMPT_MAX = 2000;
const DIGEST_FEEDS_MAX = 200;

export const DIGEST_DEFAULTS = {
  auto: false,
  time: '08:00',
  mode: 'enabled',
  feeds: [] as number[],
  maxPerFeed: 20,
  maxTotal: 150,
  keepDays: 30,
  style: '',
  lastAuto: '',
};

function clampInt(raw: unknown, d: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function sanitizeDigestTime(raw: unknown): string {
  const t = typeof raw === 'string' ? raw.trim() : '';
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : DIGEST_DEFAULTS.time;
}

export function sanitizeDigestPrompt(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    // 这段会原样拼进 prompt，控制字符进去就是往上游塞垃圾
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim()
    .slice(0, DIGEST_PROMPT_MAX);
}

export type DigestConfig = typeof DIGEST_DEFAULTS;

export function sanitizeDigest(raw: unknown): DigestConfig {
  const out: DigestConfig = { ...DIGEST_DEFAULTS, feeds: [] };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;

  out.auto = r.auto === true;
  out.time = sanitizeDigestTime(r.time);
  if (typeof r.mode === 'string' && DIGEST_MODES.includes(r.mode)) out.mode = r.mode;

  if (Array.isArray(r.feeds)) {
    const seen = new Set<number>();
    for (const n of r.feeds) {
      const id = Number(n);
      if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      if (out.feeds.length < DIGEST_FEEDS_MAX) out.feeds.push(Math.trunc(id));
    }
  }

  out.maxPerFeed = clampInt(r.maxPerFeed, DIGEST_DEFAULTS.maxPerFeed, 1, 100);
  out.maxTotal = clampInt(r.maxTotal, DIGEST_DEFAULTS.maxTotal, 10, 500);
  out.keepDays = clampInt(r.keepDays, DIGEST_DEFAULTS.keepDays, 1, 365);
  out.style = sanitizeDigestPrompt(r.style !== undefined ? r.style : r.digestPrompt);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(r.lastAuto ?? ''))) out.lastAuto = String(r.lastAuto);
  return out;
}

/* ---------------- 从 users.prefs 读出契约形状 ---------------- */

type PrefsBag = Record<string, unknown> | null | undefined;

const bag = (prefs: PrefsBag, key: string): unknown => (prefs && typeof prefs === 'object' ? prefs[key] : undefined);

export const userAppearance = (prefs: PrefsBag) => sanitizeAppearance(bag(prefs, 'appearance'));
export const userLayout = (prefs: PrefsBag) => sanitizeLayout(bag(prefs, 'layout'));
export const userFilters = (prefs: PrefsBag) => sanitizeFilters(bag(prefs, 'filters'));
export const userWatchRules = (prefs: PrefsBag) => sanitizeWatchRules(bag(prefs, 'watchRules'));
export const userWebhook = (prefs: PrefsBag) => sanitizeWebhook(bag(prefs, 'webhookUrl'));
export const userDigest = (prefs: PrefsBag) => sanitizeDigest(bag(prefs, 'digest'));

export function userGroupOrder(prefs: PrefsBag): string[] {
  const raw = bag(prefs, 'groupOrder');
  if (!Array.isArray(raw)) return [];
  return raw.filter((g): g is string => typeof g === 'string').map((g) => g.trim().slice(0, 40)).filter(Boolean);
}
