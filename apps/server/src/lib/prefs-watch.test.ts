import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeWatchExpireDays, userWatchExpireDays } from './prefs';

test('关注保留天数：缺省 90 天、0 = 永不、越界收敛', () => {
  assert.equal(sanitizeWatchExpireDays(undefined), 90);
  assert.equal(sanitizeWatchExpireDays(null), 90);
  assert.equal(sanitizeWatchExpireDays(''), 90);
  assert.equal(sanitizeWatchExpireDays('abc'), 90);
  assert.equal(sanitizeWatchExpireDays(0), 0);
  assert.equal(sanitizeWatchExpireDays('30'), 30);
  assert.equal(sanitizeWatchExpireDays(12.6), 13);
  assert.equal(sanitizeWatchExpireDays(-5), 0);
  assert.equal(sanitizeWatchExpireDays(99999), 3650);
  assert.equal(userWatchExpireDays({ watchExpireDays: 7 }), 7);
  assert.equal(userWatchExpireDays({}), 90);
});
