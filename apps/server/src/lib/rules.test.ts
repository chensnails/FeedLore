import assert from 'node:assert/strict';
import test from 'node:test';
import { type Rule, sanitizeRules } from './prefs';
import { mergeRuleEffects, ruleMatches } from './rules';

const feed = { id: 10, groupName: '科技' };
const otherFeed = { id: 99, groupName: '其它' };

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    name: '锂电',
    on: true,
    when: {
      scope: { all: true, groups: [], feeds: [] },
      keywords: ['锂电'],
      match: 'any',
      tag: '',
    },
    then: { addTags: ['新能源'], favorite: false, markRead: false, notify: false },
    ...over,
  };
}

test('ruleMatches: 关键词（any）命中', () => {
  assert.equal(ruleMatches(rule(), { guid: 'g', title: '锂电行业展望' }, feed), true);
});

test('ruleMatches: 关键词不命中', () => {
  assert.equal(ruleMatches(rule(), { guid: 'g', title: '光伏行业展望' }, feed), false);
});

test('ruleMatches: match=all 需要全部关键词', () => {
  const r = rule({
    when: {
      scope: { all: true, groups: [], feeds: [] },
      keywords: ['锂电', '财报'],
      match: 'all',
      tag: '',
    },
  });
  assert.equal(ruleMatches(r, { guid: 'g', title: '锂电财报' }, feed), true);
  assert.equal(ruleMatches(r, { guid: 'g', title: '锂电新闻' }, feed), false);
});

test('ruleMatches: 标签条件', () => {
  const r = rule({
    when: { scope: { all: true, groups: [], feeds: [] }, keywords: [], match: 'any', tag: 'AI' },
  });
  assert.equal(ruleMatches(r, { guid: 'g', title: 'x', tags: ['ai'] }, feed), true);
  assert.equal(ruleMatches(r, { guid: 'g', title: 'x', tags: ['财经'] }, feed), false);
});

test('ruleMatches: on=false 不命中', () => {
  assert.equal(ruleMatches(rule({ on: false }), { guid: 'g', title: '锂电' }, feed), false);
});

test('ruleMatches: scope 限定频道', () => {
  const r = rule({
    when: {
      scope: { all: false, groups: [], feeds: [999] },
      keywords: ['锂电'],
      match: 'any',
      tag: '',
    },
  });
  assert.equal(ruleMatches(r, { guid: 'g', title: '锂电' }, feed), false);
  assert.equal(ruleMatches(r, { guid: 'g', title: '锂电' }, otherFeed), false);
});

test('mergeRuleEffects: 合并标签/收藏/通知', () => {
  const rules = [
    rule({ id: 'a', then: { addTags: ['新能源'], favorite: true, markRead: false, notify: true } }),
    rule({
      id: 'b',
      name: '行业',
      then: { addTags: ['科技'], favorite: false, markRead: true, notify: true },
    }),
  ];
  const eff = mergeRuleEffects(rules, { guid: 'g', title: '锂电行业' }, feed);
  assert.ok(eff);
  assert.deepEqual([...eff!.tags].sort(), ['新能源', '科技'].sort());
  assert.equal(eff!.favorite, true);
  assert.equal(eff!.markRead, true);
  assert.deepEqual(eff!.notifyRules.sort(), ['锂电', '行业'].sort());
});

test('mergeRuleEffects: 无命中返回 null', () => {
  assert.equal(mergeRuleEffects([rule()], { guid: 'g', title: '光伏' }, feed), null);
});

test('sanitizeRules: 丢弃无条件规则', () => {
  assert.equal(
    sanitizeRules([{ when: { keywords: [], tag: '' }, then: { favorite: true } }]).length,
    0,
  );
});

test('sanitizeRules: 丢弃无动作规则', () => {
  assert.equal(sanitizeRules([{ when: { keywords: ['x'], tag: '' }, then: {} }]).length, 0);
});

test('sanitizeRules: 合法规则保留并补 id/name', () => {
  const out = sanitizeRules([
    { when: { keywords: '锂电\n新能源', tag: '' }, then: { addTags: '新能源', favorite: true } },
  ]);
  assert.equal(out.length, 1);
  const r0 = out[0];
  assert.ok(r0);
  assert.ok(r0.id);
  assert.deepEqual(r0.when.keywords, ['锂电', '新能源']);
  assert.deepEqual(r0.then.addTags, ['新能源']);
  assert.equal(r0.then.favorite, true);
});
