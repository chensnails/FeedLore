/**
 * 自动化规则引擎（Phase 2 · T-C）——「when → then」，入库时对新条目执行。
 *
 * 与既有 filter / watch 的分工：
 * - filter：**入库前**丢弃（block）；
 * - watch：给条目打 watch/block 标记；
 * - rules：对**已入库的新条目**做动作（加标签 / 收藏 / 标记已读 / 触发 webhook）。
 *
 * 纯函数（匹配 / 合并效果）集中在这里便于单测；落库在 `applyRulesToFresh`。
 * 所有条件都为空或所有动作都为空的规则会被 sanitize 丢弃（见 lib/prefs.ts），
 * 避免「无条件规则命中一切」把全库刷成收藏。
 */

import { type Db, entries } from '@feedlore/db';
import { and, eq } from 'drizzle-orm';
import type { Rule } from './prefs';
import { scopeAllows } from './scope';
import { entryText } from './watch';

// Rule / RuleWhen / RuleThen 定义在 lib/prefs.ts（与 WatchRule 同处，sanitize 也在那），
// 这里用 type-only import 避免运行时环依赖。

/** 规则匹配所需的最小条目形态（NormalizedItem 满足它）。 */
export interface RuleEntry {
  guid: string;
  title?: string | null;
  description?: string | null;
  content?: string | null;
  tags?: string[] | null;
  link?: string | null;
  publishedAt?: Date | null;
}

/** 规则适用范围所需的频道信息。 */
export interface RuleFeed {
  id: number;
  groupName: string | null;
}

export interface RuleEffect {
  tags: string[];
  favorite: boolean;
  markRead: boolean;
  notifyRules: string[];
}

/** 单条规则是否命中。 */
export function ruleMatches(rule: Rule, entry: RuleEntry, feed: RuleFeed): boolean {
  if (rule.on === false) return false;
  if (!scopeAllows(rule.when.scope, feed)) return false;

  if (rule.when.tag) {
    const want = rule.when.tag.toLowerCase();
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    if (!tags.some((t) => String(t).toLowerCase() === want)) return false;
  }

  const kws = rule.when.keywords;
  if (kws.length) {
    const text = entryText(entry);
    const hit = kws.map((k) => text.includes(k.toLowerCase()));
    const ok = rule.when.match === 'all' ? hit.every(Boolean) : hit.some(Boolean);
    if (!ok) return false;
  }

  return true;
}

/** 合并所有命中规则的动作；没有任何规则命中返回 null。 */
export function mergeRuleEffects(
  rules: Rule[],
  entry: RuleEntry,
  feed: RuleFeed,
): RuleEffect | null {
  const tags = new Set<string>();
  const notifyRules: string[] = [];
  let favorite = false;
  let markRead = false;
  let hit = false;

  for (const rule of rules) {
    if (!ruleMatches(rule, entry, feed)) continue;
    hit = true;
    for (const t of rule.then.addTags) tags.add(t);
    if (rule.then.favorite) favorite = true;
    if (rule.then.markRead) markRead = true;
    if (rule.then.notify) notifyRules.push(rule.name || rule.id);
  }

  if (!hit) return null;
  return { tags: [...tags], favorite, markRead, notifyRules };
}

export interface RuleNotifyHit {
  ruleName: string;
  title: string;
  link: string | null;
  publishedAt: Date | null;
}

/**
 * 对新入库条目执行规则：按命中效果更新条目（标签 / 收藏 / 已读），并返回需要通知的命中。
 * 通知由调用方攒批（与 watch 通知共用 webhook 推送）。
 */
export async function applyRulesToFresh(
  db: Db,
  feedId: number,
  feed: RuleFeed,
  fresh: RuleEntry[],
  rules: Rule[],
): Promise<RuleNotifyHit[]> {
  const hits: RuleNotifyHit[] = [];

  for (const it of fresh) {
    const eff = mergeRuleEffects(rules, it, feed);
    if (!eff) continue;

    const set: Partial<{
      tags: string[];
      isFavorite: boolean;
      favoritedAt: Date;
      isRead: boolean;
      readAt: Date;
    }> = {};
    if (eff.tags.length) {
      const merged = [...new Set([...(Array.isArray(it.tags) ? it.tags : []), ...eff.tags])].slice(
        0,
        24,
      );
      set.tags = merged;
    }
    if (eff.favorite) {
      set.isFavorite = true;
      set.favoritedAt = new Date();
    }
    if (eff.markRead) {
      set.isRead = true;
      set.readAt = new Date();
    }

    if (Object.keys(set).length) {
      await db
        .update(entries)
        .set(set)
        .where(and(eq(entries.feedId, feedId), eq(entries.guid, it.guid)));
    }

    for (const name of eff.notifyRules) {
      hits.push({
        ruleName: name,
        title: it.title ?? '',
        link: it.link ?? null,
        publishedAt: it.publishedAt ?? null,
      });
    }
  }

  return hits;
}
