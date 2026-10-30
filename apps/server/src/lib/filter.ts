/**
 * 条目过滤规则（移植自 apps/legacy/lib/filter.js，v2.7.0 语义）
 *
 * 每个用户一套规则（`users.prefs.filters`），在**写库之前**按成员 owner 逐人生效：
 * 同一 URL 被多个用户订阅时，各自副本按各自规则过滤，互不影响。只对新抓的条目生效。
 *
 * 组合语义（block 优先，allow 在白名单 survivors 上裁）：
 *   命中任一「屏蔽」→ 丢弃；存在「只收」规则时必须命中至少一条才保留；否则保留。
 *   即：只配屏蔽 = 黑名单；只配只收 = 白名单；两者同存 = 先拉黑、再拉白。
 *
 * 纯函数：不读模块级状态、不碰 db/网络。
 */

import type { FilterRule } from './prefs';

/** 规则匹配的文本域 */
function fieldText(rule: FilterRule, item: Matchable): string {
  const title = String(item.title ?? '');
  const desc = String(item.description ?? '');
  const content = String(item.content ?? '');
  switch (rule.field) {
    case 'title':
      return title;
    case 'desc':
      return desc;
    case 'content':
      return content;
    default:
      return title + '\n' + desc + '\n' + content;
  }
}

export interface Matchable {
  title?: string | null;
  description?: string | null;
  content?: string | null;
}

/** 单条规则是否命中 */
export function ruleHit(rule: FilterRule, item: Matchable): boolean {
  const text = fieldText(rule, item);
  if (!text) return false;
  if (rule.kind === 're') {
    try {
      return new RegExp(rule.pattern, 'i').test(text);
    } catch {
      return false; // 非法正则（sanitizeFilters 已拦）视为不命中
    }
  }
  return text.toLowerCase().includes(String(rule.pattern).toLowerCase());
}

/** 按规则过滤 items，返回保留的新数组（不改入参）。 */
export function applyFilters<T extends Matchable>(items: T[], rules: FilterRule[]): T[] {
  if (!items.length) return items;
  const active = rules.filter((r) => r && r.on !== false && r.pattern);
  if (!active.length) return items;

  const allow = active.filter((r) => r.act === 'allow');
  const block = active.filter((r) => r.act !== 'allow');

  return items.filter((it) => {
    if (block.length && block.some((r) => ruleHit(r, it))) return false;
    if (allow.length && !allow.some((r) => ruleHit(r, it))) return false;
    return true;
  });
}
