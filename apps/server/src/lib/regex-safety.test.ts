import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFilters } from './prefs';
import { ruleHit } from './filter';
import { isSafeRegex } from './regex-safety';

test('正则安全：普通规则放行，嵌套量词与反向引用判为危险', () => {
  assert.equal(isSafeRegex('v\\d+\\.\\d+'), true);
  // 小范围有限次的交替组不是指数回溯，不该误伤
  assert.equal(isSafeRegex('(foo|bar){2}'), true);
  assert.equal(isSafeRegex('(a+)+$'), false);
  assert.equal(isSafeRegex('(a|aa)+$'), false);
  assert.equal(isSafeRegex('(a|aa){1000}'), false);
  assert.equal(isSafeRegex('(\\w+)\\1+'), false);
  assert.equal(isSafeRegex('['), false);
});

test('保存过滤规则时丢掉有灾难性回溯风险的写法', () => {
  const rules = sanitizeFilters([
    { id: 'ok', kind: 're', pattern: 'v\\d+' },
    { id: 'bad', kind: 're', pattern: '(a+)+$' },
    { id: 'kw', kind: 'kw', pattern: '(a+)+$' },
  ]);
  assert.deepEqual(rules.map((r) => r.id), ['ok', 'kw']);
});

test('匹配层兜底：存量不安全规则视为不命中，不执行正则', () => {
  const rule = {
    id: 'old',
    on: true,
    act: 'block',
    field: 'all',
    kind: 're' as const,
    pattern: '(a+)+$',
  };
  // 若真执行这条正则，长串 a 会卡住整个进程；这里必须立即返回 false
  assert.equal(ruleHit(rule, { title: 'a'.repeat(5000) + '!' }), false);
});
