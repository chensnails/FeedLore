import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FilterRule } from '@feedlore/contract';
import { applyFilters, ruleHit } from './filter';

/**
 * 条目过滤规则（抓取写库前的那道闸门）。
 *
 * 为什么先测这一块：它决定「哪些条目根本不会进数据库」。写错一个字符，
 * 用户丢的是数据而不是界面 —— 而且丢得无声无息（列表里少几条，没人会去数）。
 */

function rule(p: Partial<FilterRule>): FilterRule {
  return {
    id: 'r1',
    on: true,
    act: 'block',
    field: 'all',
    kind: 'kw',
    pattern: '',
    ...p,
  };
}

const item = { title: 'iPhone 17 发布', description: '新一代旗舰', content: '正文正文' };

test('关键词命中不区分大小写', () => {
  assert.equal(ruleHit(rule({ pattern: 'iphone' }), item), true);
  assert.equal(ruleHit(rule({ pattern: 'IPHONE' }), item), true);
  assert.equal(ruleHit(rule({ pattern: 'android' }), item), false);
});

test('匹配范围按 field 收窄', () => {
  // 只匹配标题时，描述里的词不该命中
  assert.equal(ruleHit(rule({ pattern: '旗舰', field: 'title' }), item), false);
  assert.equal(ruleHit(rule({ pattern: '旗舰', field: 'desc' }), item), true);
  assert.equal(ruleHit(rule({ pattern: '正文', field: 'content' }), item), true);
  // 默认 all = 标题 + 摘要 + 正文
  assert.equal(ruleHit(rule({ pattern: '正文', field: 'all' }), item), true);
});

test('正则规则：命中 / 不命中 / 非法正则视为不命中', () => {
  assert.equal(ruleHit(rule({ kind: 're', pattern: 'iP(hone)?\\s*17' }), item), true);
  assert.equal(ruleHit(rule({ kind: 're', pattern: '^安卓' }), item), false);
  // sanitizeFilters 会丢非法正则，但兜底路径也不能抛（每轮抓取都会调用它）
  assert.equal(ruleHit(rule({ kind: 're', pattern: '([a-z' }), item), false);
});

test('空 pattern 不命中，也不会把空标题误判', () => {
  assert.equal(ruleHit(rule({ pattern: '' }), item), false);
  assert.equal(ruleHit(rule({ pattern: 'x' }), { title: '', description: null, content: null }), false);
});

test('屏蔽与只收同时存在：先拉黑，再拉白', () => {
  const items = [
    { title: '广告：买一送一' },
    { title: '招聘：后端工程师' },
    { title: '闲聊' },
  ];
  const rules = [
    rule({ id: 'b', act: 'block', pattern: '广告' }),
    rule({ id: 'a', act: 'allow', pattern: '招聘' }),
  ];
  // 只收生效 → 只剩「招聘」；屏蔽同时生效 → 即便命中只收，含「广告」的也要被丢掉
  const kept = applyFilters(items, rules);
  assert.deepEqual(
    kept.map((x) => x.title),
    ['招聘：后端工程师'],
  );

  const both = applyFilters(
    [{ title: '广告招聘' }, { title: '招聘' }],
    rules,
  );
  assert.deepEqual(both.map((x) => x.title), ['招聘']);
});

test('停用的规则（on:false）不参与过滤', () => {
  const items = [{ title: '广告' }, { title: '正片' }];
  const off = applyFilters(items, [rule({ act: 'block', pattern: '广告', on: false })]);
  assert.equal(off.length, 2);
});

test('没有规则时**返回原数组**（不是副本）：这是热路径，不该每轮都复制', () => {
  const items = [{ title: 'a' }];
  assert.equal(applyFilters(items, []), items);
  assert.equal(applyFilters([], [rule({ pattern: 'a' })]).length, 0);
});
