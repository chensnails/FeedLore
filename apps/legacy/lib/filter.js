'use strict';

/**
 * 笺川 · 条目过滤规则（v2.7.0）
 *
 * 每个用户一套规则（users.prefs.filters），在抓取写库**之前**按成员 owner 逐人生效：
 * 同一 URL 被多个用户订阅时，各组副本按各自的规则过滤，互不影响。
 * 只对新抓取的条目生效，已入库的历史条目不动。
 *
 * 规则语义（单条规则）：
 *   { id, on, act: 'block'|'allow', field: 'title'|'desc'|'content'|'all',
 *     kind: 'kw'|'re', pattern }
 *   - kw：不区分大小写的子串匹配；re：正则（大小写不敏感）
 *   - field=all：标题 + 摘要 + 正文一起匹配
 *
 * 组合语义（block 优先，allow 在白名单 survivors 上裁）：
 *   命中任一「屏蔽」→ 丢弃（黑名单是硬约束）；
 *   存在「只收」规则时，必须命中至少一条「只收」才保留（白名单裁剪）；
 *   否则保留。
 *   即：只配屏蔽 = 黑名单；只配只收 = 白名单；两者同存 = 先拉黑、再拉白。
 *
 * 这里是纯函数：不读模块级状态、不碰 db/网络，由调用方把规则数组传进来
 * （与 lib/ 其它模块同一纪律，v2.2.0 起）。
 */

/** 规则匹配的文本域 */
function fieldText(rule, item) {
  const title = String((item && item.title) || '');
  const desc = String((item && item.description) || '');
  const content = String((item && item.content) || '');
  switch (rule.field) {
    case 'title': return title;
    case 'desc': return desc;
    case 'content': return content;
    default: return title + '\n' + desc + '\n' + content;   // all
  }
}

/** 单条规则是否命中该条目 */
function ruleHit(rule, item) {
  const text = fieldText(rule, item);
  if (!text) return false;
  if (rule.kind === 're') {
    try {
      return new RegExp(rule.pattern, 'i').test(text);
    } catch (_) {
      return false;   // 非法正则（理论上被 sanitizeFilters 拦过）视为不命中
    }
  }
  return text.toLowerCase().includes(String(rule.pattern).toLowerCase());
}

/**
 * 按规则过滤 items，返回保留的新数组（不改入参）。
 * rules 未清洗时内部按同样口径兜一遍（server.js 与清洗函数共用同一份语义）。
 */
function applyFilters(items, rules) {
  if (!Array.isArray(items) || !items.length) return items || [];
  const active = (Array.isArray(rules) ? rules : []).filter((r) => r && r.on !== false && r.pattern);
  if (!active.length) return items;
  const allow = active.filter((r) => r.act === 'allow');
  const block = active.filter((r) => r.act !== 'allow');
  return items.filter((it) => {
    if (block.length && block.some((r) => ruleHit(r, it))) return false;
    if (allow.length && !allow.some((r) => ruleHit(r, it))) return false;
    return true;
  });
}

module.exports = { applyFilters, ruleHit };
