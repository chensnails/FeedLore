import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRole } from './roles';

test('角色归一化：admin / readonly 原样保留', () => {
  assert.equal(normalizeRole('admin'), 'admin');
  assert.equal(normalizeRole('readonly'), 'readonly');
  assert.equal(normalizeRole('user'), 'user');
});

test('角色归一化：空值与未知值一律按普通用户', () => {
  for (const v of [undefined, null, '', 'root', 'Admin', 'READONLY']) {
    assert.equal(normalizeRole(v), 'user', String(v));
  }
});
