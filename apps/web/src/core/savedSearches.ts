/* 保存的搜索词（纯本机）。
 *
 * 与外观偏好同性质：换设备不必同步，且不进账号 prefs —— 搜索词可能含私人信息，
 * 也不该让同事登录同一账号就看到我上次的检索。
 * 存储只认字符串数组，脏 JSON / 隐私模式 / 配额满全部安全回落；
 * 模块内缓存快照，useSyncExternalStore 才能拿到稳定引用（每次读都 new 数组会死循环）。
 */

export const SAVED_SEARCH_KEY = 'feedlore.savedSearches.v1';
export const SAVED_SEARCH_LIMIT = 20;

export interface SavedSearch {
  q: string;
  savedAt: number;
}

const EMPTY: readonly SavedSearch[] = [];
let cache: SavedSearch[] | null = null;
const listeners = new Set<() => void>();

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch (_) {
    return null; // 隐私模式：访问 localStorage 本身就会抛
  }
}

function parse(raw: string | null): SavedSearch[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const seen = new Set<string>();
    const out: SavedSearch[] = [];
    for (const item of data) {
      const q =
        typeof item === 'string'
          ? item
          : item && typeof item === 'object' && typeof (item as SavedSearch).q === 'string'
            ? (item as SavedSearch).q
            : '';
      const word = q.trim().slice(0, 100);
      if (!word || seen.has(word.toLowerCase())) continue;
      seen.add(word.toLowerCase());
      const at =
        item && typeof item === 'object' && Number.isFinite((item as SavedSearch).savedAt)
          ? Number((item as SavedSearch).savedAt)
          : 0;
      out.push({ q: word, savedAt: at });
      if (out.length >= SAVED_SEARCH_LIMIT) break;
    }
    return out;
  } catch (_) {
    return [];
  }
}

/** 稳定引用：首次读一次，之后只在写 / 跨标签页 storage 事件时换快照。 */
export function listSavedSearches(): readonly SavedSearch[] {
  if (cache) return cache;
  cache = parse(store()?.getItem(SAVED_SEARCH_KEY) ?? null);
  return cache;
}

export function getSavedSearchesServerSnapshot(): readonly SavedSearch[] {
  return EMPTY;
}

function commit(next: SavedSearch[]): void {
  cache = next;
  try {
    store()?.setItem(SAVED_SEARCH_KEY, JSON.stringify(next));
  } catch (_) {
    /* 配额满：本次会话仍可用内存快照 */
  }
  for (const fn of listeners) fn();
}

/** 去重忽略大小写；重复词只把旧项从数组里抹掉，不重复占位。 */
export function addSavedSearch(raw: string): readonly SavedSearch[] {
  const q = String(raw ?? '')
    .trim()
    .slice(0, 100);
  if (!q) return listSavedSearches();
  const cur = listSavedSearches();
  const lower = q.toLowerCase();
  if (cur.some((s) => s.q.toLowerCase() === lower)) return cur;
  commit([{ q, savedAt: Date.now() }, ...cur].slice(0, SAVED_SEARCH_LIMIT));
  return cache!;
}

export function removeSavedSearch(raw: string): readonly SavedSearch[] {
  const q = String(raw ?? '').trim();
  const cur = listSavedSearches();
  const next = cur.filter((s) => s.q !== q);
  if (next.length === cur.length) return cur;
  commit(next);
  return cache!;
}

export function subscribeSavedSearches(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/* 另一个标签页改了同一把钥匙：丢缓存并通知订阅者，避免两份列表各说各话。 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== SAVED_SEARCH_KEY) return;
    cache = null;
    for (const fn of listeners) fn();
  });
}
