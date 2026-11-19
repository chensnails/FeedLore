/**
 * 一次性口令的回归：加密落库形状、24h 查询窗口、过期/密钥变更拒读。
 * 全是纯函数测试，不给 DATABASE_URL 也能跑。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  QUERY_WINDOW_MS,
  decodeInitialAdmin,
  formatRemaining,
  newOneTimePassword,
  setRandomSourceForTest,
} from './lib/initialPassword';
import { decryptSecret, encryptSecret } from '@feedlore/ai';

const SECRET = 'test-crypto-secret';
const T0 = Date.parse('2026-11-19T09:00:00.000Z');

test('口令是 16 字符 base64url，两次不重复', () => {
  const a = newOneTimePassword();
  const b = newOneTimePassword();
  assert.match(a, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(a, b);
  setRandomSourceForTest(() => new Uint8Array(12).fill(7));
  assert.equal(newOneTimePassword(), 'BwcHBwcHBwcHBwcH');
  setRandomSourceForTest(null);
});

test('加密落库形状：明文不进 value，24h 后可读', () => {
  const value = {
    username: 'admin',
    encrypted: encryptSecret('s3cret-pass', SECRET),
    generatedAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + QUERY_WINDOW_MS).toISOString(),
  };
  assert.ok(!JSON.stringify(value).includes('s3cret-pass'), '明文口令不得落库');
  const got = decodeInitialAdmin(value, SECRET, T0 + 1000);
  assert.equal(got?.password, 's3cret-pass');
  assert.equal(got?.username, 'admin');
});

test('查询窗口边界：满 24h 即拒读', () => {
  const value = {
    username: 'admin',
    encrypted: encryptSecret('s3cret-pass', SECRET),
    generatedAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + QUERY_WINDOW_MS).toISOString(),
  };
  assert.equal(decodeInitialAdmin(value, SECRET, T0 + QUERY_WINDOW_MS - 1)?.password, 's3cret-pass');
  assert.equal(decodeInitialAdmin(value, SECRET, T0 + QUERY_WINDOW_MS), null);
  assert.equal(decodeInitialAdmin(value, SECRET, T0 + QUERY_WINDOW_MS + 1), null);
});

test('密钥变更 / 形状错误 / 空值都按「不可查」处理', () => {
  const value = {
    username: 'admin',
    encrypted: encryptSecret('s3cret-pass', SECRET),
    generatedAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + QUERY_WINDOW_MS).toISOString(),
  };
  assert.equal(decodeInitialAdmin(value, 'another-secret', T0), null);
  assert.equal(decodeInitialAdmin({ ...value, encrypted: 'plain-password' }, SECRET, T0), null);
  assert.equal(decodeInitialAdmin({ ...value, expiresAt: 'not-a-date' }, SECRET, T0), null);
  assert.equal(decodeInitialAdmin(null, SECRET, T0), null);
});

test('剩余时间文案：分钟 / 小时 / 已过期', () => {
  const later = new Date(T0 + QUERY_WINDOW_MS).toISOString();
  assert.equal(formatRemaining(later, T0 + 5 * 60_000), '23 小时 55 分钟');
  assert.equal(formatRemaining(later, T0 + 23 * 3600_000), '1 小时');
  assert.equal(formatRemaining(later, T0 + QUERY_WINDOW_MS), '已过期');
  assert.equal(decryptSecret(encryptSecret('x', SECRET), SECRET), 'x');
});
