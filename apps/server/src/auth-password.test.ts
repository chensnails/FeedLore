/**
 * v1 → v2 密码无损迁移的回归测试。
 *
 * legacy 用 `scryptSync(pwd, salt, 64)`（Node 默认 N=16384,r=8,p=1），better-auth 默认 r=16。
 * 迁移脚本把 legacy 的 salt/hash 写成 `legacy$<salt>$<hash>`，@feedlore/auth 的 verify
 * 必须能按 v1 参数校验；非 legacy 哈希仍交给 better-auth 默认实现。
 */

import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import test from 'node:test';
import { formatLegacyPasswordHash, isLegacyPasswordHash, verifyPasswordHash } from '@feedlore/auth';
import { hashPassword } from 'better-auth/crypto';

const SALT = '0123456789abcdef0123456789abcdef';

test('legacy 哈希：v1 原密码在 v2 仍可登录，错密码/畸形标记被拒', async () => {
  const legacyHash = scryptSync('原密码-1234', SALT, 64).toString('hex');
  const stored = formatLegacyPasswordHash(SALT, legacyHash);

  assert.equal(isLegacyPasswordHash(stored), true);
  assert.equal(await verifyPasswordHash({ hash: stored, password: '原密码-1234' }), true);
  assert.equal(await verifyPasswordHash({ hash: stored, password: '原密码-1235' }), false);

  for (const malformed of [
    'legacy$' + SALT,
    'legacy$$' + legacyHash,
    'legacy$' + SALT + '$zz',
    'legacy$' + SALT + '$' + '0'.repeat(64),
  ]) {
    assert.equal(await verifyPasswordHash({ hash: malformed, password: '原密码-1234' }), false, malformed);
  }
});

test('非 legacy 哈希：仍走 better-auth 默认 scrypt(r=16)', async () => {
  const stored = await hashPassword('better-auth-pass');
  assert.equal(isLegacyPasswordHash(stored), false);
  assert.equal(await verifyPasswordHash({ hash: stored, password: 'better-auth-pass' }), true);
  assert.equal(await verifyPasswordHash({ hash: stored, password: 'wrong' }), false);
});
