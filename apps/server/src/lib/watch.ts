/**
 * 关注 / 屏蔽规则引擎（移植自 apps/legacy/lib/watch.js，v21）
 *
 * 规则来自 `users.prefs.watchRules`：`{ id, name, keywords[], act, notify, on }`。
 *
 * 两个刻意的设计取舍（沿用 legacy）：
 *  - 匹配是**子串 + 大小写不敏感**，不是正则：设置页给的是多行文本框，普通用户写的
 *    `C++`、`A.I.` 当正则会报错或被特殊字符坑到。
 *  - **屏蔽优先**：一句话同时命中关注与屏蔽规则时按屏蔽处理。用户屏蔽某主题的意图
 *    通常比关注更强，反过来会让人怀疑「我明明屏蔽了怎么还在关注里」。
 *
 * 纯函数。抓取器在**条目入库后**只对新条目跑一遍（老条目上一轮已判过）。
 */

import type { WatchRule } from './prefs';

export interface WatchTarget {
  guid: string;
  title?: string | null;
  description?: string | null;
  content?: string | null;
}

/** 条目用于匹配的文本：标题 + 描述 + 正文，拼一次、统一小写 */
export function entryText(e: WatchTarget): string {
  return [e.title, e.description, e.content]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .join('\n')
    .toLowerCase();
}

export interface WatchVerdict {
  guid: string;
  state: 'watch' | 'block';
  rule: string;
}

/** 判定一条条目归属；未命中任何规则返回 null。 */
export function decide(rules: WatchRule[], text: string): { state: 'watch' | 'block'; rule: string } | null {
  let watch: { state: 'watch'; rule: string } | null = null;
  for (const r of rules) {
    if (!r || r.on === false) continue;
    const hit = r.keywords.some((k) => k && text.includes(k.toLowerCase()));
    if (!hit) continue;
    if (r.act === 'block') return { state: 'block', rule: r.id }; // 屏蔽直接定案
    if (!watch) watch = { state: 'watch', rule: r.id };
  }
  return watch;
}

/** 一次算出「这批条目各自该打什么标记」 */
export function classify(rules: WatchRule[], entries: WatchTarget[]): WatchVerdict[] {
  const out: WatchVerdict[] = [];
  for (const e of entries) {
    const hit = decide(rules, entryText(e));
    if (hit) out.push({ guid: e.guid, state: hit.state, rule: hit.rule });
  }
  return out;
}

/** 有 notify=true 的关注规则时，通知文案要带规则名：返回 id → name 映射 */
export function notifyRuleNames(rules: WatchRule[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of rules) {
    if (r && r.act === 'watch' && r.notify && r.on !== false) map[r.id] = r.name || '关注规则';
  }
  return map;
}
