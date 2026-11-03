import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScope, scopeAllows } from './scope';

test('规则范围：缺省 = 全部，all=true 清空列表', () => {
  assert.deepEqual(normalizeScope(undefined), { all: true, groups: [], feeds: [] });
  assert.deepEqual(normalizeScope(null), { all: true, groups: [], feeds: [] });
  assert.deepEqual(normalizeScope('x'), { all: true, groups: [], feeds: [] });
  assert.deepEqual(normalizeScope({ all: true, groups: ['科技'], feeds: [3] }), { all: true, groups: [], feeds: [] });
});

test('规则范围：分组名去重截断，未分组（空名）保留，频道 id 只收正整数', () => {
  const s = normalizeScope({
    all: false,
    groups: [' 科技 ', '科技', '', ' '.repeat(2), 'x'.repeat(60)],
    feeds: [3, '4', 3, -1, 0, 'abc', 2.5],
  });
  assert.equal(s.all, false);
  assert.deepEqual(s.groups, ['科技', '', 'x'.repeat(40)]);
  assert.deepEqual(s.feeds, [3, 4]);
});

test('规则范围：空选 = 不生效，老规则（无 scope）= 全部', () => {
  const empty = normalizeScope({ all: false, groups: [], feeds: [] });
  assert.equal(scopeAllows(undefined, { id: 1, groupName: '科技' }), true);
  assert.equal(scopeAllows(null, { id: 1, groupName: '科技' }), true);
  assert.equal(scopeAllows(empty, { id: 1, groupName: '科技' }), false);
  assert.equal(scopeAllows(empty, { id: 2, groupName: '' }), false);
});

test('规则范围：分组按名称动态匹配（含未分组），频道按 id 匹配', () => {
  const byGroup = normalizeScope({ all: false, groups: ['科技'], feeds: [] });
  assert.equal(scopeAllows(byGroup, { id: 9, groupName: '科技' }), true);
  assert.equal(scopeAllows(byGroup, { id: 9, groupName: '生活' }), false);
  assert.equal(scopeAllows(byGroup, { id: 9, groupName: null }), false);

  const ungrouped = normalizeScope({ all: false, groups: [''], feeds: [] });
  assert.equal(scopeAllows(ungrouped, { id: 9, groupName: '' }), true);
  assert.equal(scopeAllows(ungrouped, { id: 9, groupName: null }), true);
  assert.equal(scopeAllows(ungrouped, { id: 9, groupName: '科技' }), false);

  const byFeed = normalizeScope({ all: false, groups: [], feeds: [7] });
  assert.equal(scopeAllows(byFeed, { id: 7, groupName: '科技' }), true);
  assert.equal(scopeAllows(byFeed, { id: 8, groupName: '科技' }), false);
});
