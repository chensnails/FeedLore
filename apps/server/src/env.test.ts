/**
 * env.ts 启动期配置校验单测（V3.0）。
 *
 * validateConfig 是纯函数：只读传入快照、不连库、不写 process.env。
 * 这里覆盖「配错会导致运行期诡异行为」的边界，确保 fail-fast 既不误报也不漏报。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig } from './env';

test('validateConfig: 空环境（全部可选变量缺失）无任何问题', () => {
  assert.deepEqual(validateConfig({}), []);
});

test('validateConfig: 合法配置无问题', () => {
  const issues = validateConfig({
    PORT: '3210',
    DATABASE_URL: 'postgres://feedlore:secret@db:5432/feedlore_v2',
    REFRESH_MINUTES: '30',
    PG_POOL_MAX: '10',
    STRICT_BOOT: '1',
    ALLOW_SIGNUP: '0',
  });
  assert.deepEqual(issues, []);
});

test('validateConfig: postgresql:// 协议同样合法', () => {
  assert.deepEqual(validateConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db' }), []);
});

test('validateConfig: PORT 非法（非整数 / 越界）逐条报错', () => {
  const a = validateConfig({ PORT: '0' });
  assert.equal(
    a.some((i) => i.key === 'PORT'),
    true,
  );
  const b = validateConfig({ PORT: '65536' });
  assert.equal(
    b.some((i) => i.key === 'PORT'),
    true,
  );
  const c = validateConfig({ PORT: 'abc' });
  assert.equal(
    c.some((i) => i.key === 'PORT'),
    true,
  );
});

test('validateConfig: DATABASE_URL 协议错误 / 非法 URL 报错', () => {
  assert.equal(validateConfig({ DATABASE_URL: 'mysql://u@p/db' })[0]?.key, 'DATABASE_URL');
  assert.equal(validateConfig({ DATABASE_URL: 'not-a-url' })[0]?.key, 'DATABASE_URL');
});

test('validateConfig: 数值配置越界报错，留空不报', () => {
  assert.equal(validateConfig({ REFRESH_MINUTES: '0' })[0]?.key, 'REFRESH_MINUTES');
  assert.equal(validateConfig({ KEEP_PER_FEED: '-1' })[0]?.key, 'KEEP_PER_FEED');
  assert.equal(validateConfig({ PG_POOL_MAX: '9999' })[0]?.key, 'PG_POOL_MAX');
  assert.deepEqual(validateConfig({ REFRESH_MINUTES: '' }), []);
});

test('validateConfig: 布尔开关只认 0/1', () => {
  assert.equal(validateConfig({ ALLOW_SIGNUP: 'yes' })[0]?.key, 'ALLOW_SIGNUP');
  assert.equal(validateConfig({ STRICT_BOOT: 'true' })[0]?.key, 'STRICT_BOOT');
  assert.deepEqual(validateConfig({ STRICT_BOOT: '0', ALLOW_SIGNUP: '1' }), []);
});

test('validateConfig: 多项错误一次性全部返回', () => {
  const issues = validateConfig({ PORT: '99999', DATABASE_URL: 'ftp://x', ALLOW_SIGNUP: 'on' });
  const keys = issues.map((i) => i.key).sort();
  assert.deepEqual(keys, ['ALLOW_SIGNUP', 'DATABASE_URL', 'PORT']);
});
