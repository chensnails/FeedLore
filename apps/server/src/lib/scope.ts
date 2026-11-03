/**
 * 规则的适用范围（分组 / 频道）。
 *
 * 三种状态：
 *  - **缺省**（老规则没有 scope 字段）：全部频道。升级前保存的规则不能突然失效。
 *  - `{ all: true }`：全部频道。分组 / 频道列表被清空。
 *  - `{ all: false, groups, feeds }`：只在这两类里匹配；两个列表都空 = 规则不生效
 *    （用户明确要求「默认全不选」的严格语义，不把空选偷偷当成全部）。
 *
 * 分组按名称动态匹配：勾了「科技」，之后加进科技分组的频道会自动纳入。
 */

export interface RuleScope {
  all: boolean;
  groups: string[];
  feeds: number[];
}

export const SCOPE_MAX_GROUPS = 200;
export const SCOPE_MAX_FEEDS = 500;
const GROUP_NAME_MAX = 40;

export function normalizeScope(raw: unknown): RuleScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { all: true, groups: [], feeds: [] };
  }
  const r = raw as Record<string, unknown>;
  if (r.all === true) return { all: true, groups: [], feeds: [] };

  const groups: string[] = [];
  for (const g of Array.isArray(r.groups) ? r.groups.slice(0, SCOPE_MAX_GROUPS) : []) {
    if (typeof g !== 'string') continue;
    // 未分组就是空名字，必须保留；用户手输的分组名才 trim / 截断
    const name = g === '' ? '' : g.trim().slice(0, GROUP_NAME_MAX);
    if (!name && g !== '') continue;
    if (!groups.includes(name)) groups.push(name);
  }

  const feeds: number[] = [];
  for (const f of Array.isArray(r.feeds) ? r.feeds.slice(0, SCOPE_MAX_FEEDS) : []) {
    const n = typeof f === 'number' ? f : Number(f);
    if (Number.isInteger(n) && n > 0 && !feeds.includes(n)) feeds.push(n);
  }

  return { all: false, groups, feeds };
}

export interface ScopeFeed {
  id: number;
  groupName?: string | null;
}

/** 这条规则是否覆盖该频道。scope 缺省 = 全部（老规则兼容）。 */
export function scopeAllows(scope: RuleScope | undefined | null, feed: ScopeFeed): boolean {
  if (!scope) return true;
  if (scope.all) return true;
  const group = feed.groupName == null ? '' : String(feed.groupName);
  if (scope.groups.includes(group)) return true;
  return scope.feeds.includes(Number(feed.id));
}
