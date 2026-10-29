'use strict';

/**
 * 笺川 · 关注 / 屏蔽规则引擎（v21）
 *
 * 纯函数、无副作用，node:test 直接覆盖。规则来自 users.prefs.watchRules：
 *   { id, name, keywords: string[], act: 'watch' | 'block', notify: boolean, on: boolean }
 *
 * 设计取舍：
 * - 匹配是**子串 + 大小写不敏感**，不是正则 —— 设置页给的是一个多行文本框，
 *   普通用户写的 `C++`、`A.I.` 当正则会报错或被特殊字符坑到。
 * - **屏蔽优先**：一句话同时命中关注与屏蔽规则时按屏蔽处理。用户屏蔽某主题的
 *   意图通常比关注更强，反过来会让人怀疑「我明明屏蔽了怎么还在关注里」。
 * - 规则停用（on=false）直接跳过，但保留在列表里，随时能再打开。
 */

/** 条目用于匹配的文本：标题 + 描述 + 正文，拼一次、统一小写 */
function entryText(e) {
  return [e && e.title, e && e.description, e && e.content]
    .filter((x) => typeof x === 'string' && x)
    .join('\n')
    .toLowerCase();
}

/** 单条规则是否命中（任一关键字子串出现即算） */
function matchRule(rule, text) {
  const kws = (rule && rule.keywords) || [];
  for (let i = 0; i < kws.length; i++) {
    const k = kws[i];
    if (!k) continue;
    if (text.indexOf(String(k).toLowerCase()) >= 0) return true;
  }
  return false;
}

/**
 * 判定一条条目归属。
 * @returns {{state:'watch'|'block', rule:string}|null} 未命中任何规则返回 null
 */
function decide(rules, text) {
  let watch = null;
  const list = rules || [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || r.on === false) continue;
    if (!matchRule(r, text)) continue;
    if (r.act === 'block') return { state: 'block', rule: r.id };   // 屏蔽直接定案
    if (!watch) watch = { state: 'watch', rule: r.id };
  }
  return watch;
}

/** 便捷封装：一次算出「这批条目各自该打什么标记」 */
function classify(rules, entries) {
  const out = [];
  for (const e of entries || []) {
    const hit = decide(rules, entryText(e));
    if (hit) out.push({ id: e.id, state: hit.state, rule: hit.rule });
  }
  return out;
}

/** 有 notify=true 的关注规则时，通知文案要带上规则名：返回 id → name 映射 */
function notifyRuleNames(rules) {
  const map = {};
  for (const r of rules || []) {
    if (r && r.act === 'watch' && r.notify === true && r.on !== false) map[r.id] = r.name || '关注规则';
  }
  return map;
}

module.exports = { entryText, matchRule, decide, classify, notifyRuleNames };
