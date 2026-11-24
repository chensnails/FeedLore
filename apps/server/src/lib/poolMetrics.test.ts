import assert from 'node:assert/strict';
import test from 'node:test';
import { createPool, getPoolMetrics } from '@feedlore/db';

test('pool metrics: 记录连接、获取、归还、移除与空闲连接错误', async (t) => {
  t.mock.method(console, 'error', () => {});
  const pool = createPool('postgres://unused:unused@127.0.0.1:1/unused');
  try {
    assert.deepEqual(getPoolMetrics(pool), {
      connectionsCreated: 0,
      idleConnectionErrors: 0,
      acquisitions: 0,
      releases: 0,
      removed: 0,
    });
    pool.emit('connect');
    pool.emit('acquire');
    pool.emit('release');
    pool.emit('remove');
    pool.emit('error', new Error('idle failure'));
    assert.deepEqual(getPoolMetrics(pool), {
      connectionsCreated: 1,
      idleConnectionErrors: 1,
      acquisitions: 1,
      releases: 1,
      removed: 1,
    });
    const snapshot = getPoolMetrics(pool);
    assert.ok(snapshot);
    snapshot.acquisitions = 99;
    assert.equal(getPoolMetrics(pool)?.acquisitions, 1);
  } finally {
    await pool.end();
  }
});

test('pool metrics: 未初始化时返回 null', () => {
  assert.equal(getPoolMetrics(null), null);
});
