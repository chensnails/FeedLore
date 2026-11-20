/* 关注 / 屏蔽面板的纯函数与常量：从 WatchPane.tsx 抽出，行为逐字等价。 */

import { core } from '@core';
import type { FilterRule, WatchRule } from '@feedlore/contract';
import type * as React from 'react';
import { emptyScope, normalizeScope, scopeSummary } from './RuleScopePicker.tsx';
import type { FilterDraft, RuleAct, RuleDraft } from './WatchPane.types.ts';

export const S = () => core;

let uidSeq = 0;
const newId = () => 'w' + Date.now().toString(36) + (++uidSeq).toString(36);

export const jsonPost = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const parseKeywords = (text: unknown): string[] =>
  String(text || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

export const blankRule = (): RuleDraft => ({
  id: newId(),
  name: '',
  keywords: '',
  act: 'watch',
  notify: false,
  on: true,
  scope: emptyScope(),
});

export const blankFilter = (id?: string): FilterDraft => ({
  id: id || newId(),
  on: true,
  act: 'block',
  field: 'title',
  kind: 'kw',
  pattern: '',
  scope: emptyScope(),
});

export const ruleName = (r: RuleDraft) => r.name || parseKeywords(r.keywords)[0] || '未命名规则';
export const actText = (act: RuleAct) => (act === 'block' ? '屏蔽' : '关注');
export const filterActText = (act: FilterRule['act']) => (act === 'allow' ? '只收' : '丢弃');
const FIELD_LABEL: Record<string, string> = {
  title: '标题',
  desc: '摘要',
  content: '正文',
  all: '全部',
};
const fieldText = (field: FilterRule['field']) => FIELD_LABEL[field] || '标题';
const kindText = (kind: FilterRule['kind']) => (kind === 're' ? '正则' : '关键词');

export const ruleSummary = (r: RuleDraft) => {
  const n = parseKeywords(r.keywords).length;
  return [actText(r.act), scopeSummary(r.scope), n ? `${n} 个关键词` : '没有关键词']
    .concat(r.act === 'watch' && r.notify ? ['推送 Webhook'] : [])
    .join(' · ');
};

export const filterSummary = (f: FilterDraft) =>
  [filterActText(f.act), fieldText(f.field), kindText(f.kind), scopeSummary(f.scope)].join(' · ');

/* 服务端数组 → 表单（keywords 摊成多行文本，便于直接编辑） */
export function fromServer(list: unknown): RuleDraft[] {
  return (Array.isArray(list) ? (list as WatchRule[]) : []).map((r) => ({
    id: r.id,
    name: r.name || '',
    keywords: (r.keywords || []).join('\n'),
    act: r.act === 'block' ? 'block' : 'watch',
    notify: r.notify === true,
    on: r.on !== false,
    scope: normalizeScope(r.scope),
  }));
}

/* 表单 → 服务端（keywords 还原成数组；空行 / 重复由服务端再清一遍） */
export function toServer(rules: RuleDraft[]): WatchRule[] {
  return rules.map((r) => ({
    id: r.id,
    name: r.name.trim(),
    keywords: parseKeywords(r.keywords),
    act: r.act,
    notify: r.notify,
    on: r.on,
    scope: r.scope,
  }));
}

export const filtersFromServer = (list: unknown): FilterDraft[] =>
  (Array.isArray(list) ? (list as FilterRule[]) : []).map((f) =>
    Object.assign({}, f, { scope: normalizeScope(f.scope) }),
  );

export const sameRule = (a: RuleDraft, b: RuleDraft) =>
  a.name === b.name &&
  a.keywords === b.keywords &&
  a.act === b.act &&
  a.notify === b.notify &&
  a.on === b.on &&
  JSON.stringify(a.scope) === JSON.stringify(b.scope);

export const sameFilter = (a: FilterDraft, b: FilterDraft) =>
  a.on === b.on &&
  a.act === b.act &&
  a.field === b.field &&
  a.kind === b.kind &&
  a.pattern === b.pattern &&
  JSON.stringify(a.scope) === JSON.stringify(b.scope);

export const blurOnEnter = (ev: React.KeyboardEvent<HTMLElement>) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    ev.currentTarget.blur();
  }
};

export const normalizeDays = (raw: unknown) => {
  const n = String(raw).trim() === '' ? 90 : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(3650, Math.round(n))) : 90;
};
