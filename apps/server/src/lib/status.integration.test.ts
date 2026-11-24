import assert from 'node:assert/strict';
import test from 'node:test';
import { aiJobs, createDb, getPool, users } from '@feedlore/db';
import { buildStatus } from './status';

test('status: 返回调度运行指标、AI 积压与连接池健康信息', async () => {
  const db = createDb();
  try {
    await db.insert(users).values({
      id: 'status-metrics-user',
      email: 'status-metrics@example.test',
      role: 'admin',
    });
    await db.insert(aiJobs).values([
      {
        id: 'status-queued',
        userId: 'status-metrics-user',
        kind: 'entry_ai',
        status: 'queued',
        createdAt: new Date(Date.now() - 5_000),
      },
      {
        id: 'status-running',
        userId: 'status-metrics-user',
        kind: 'entry_ai',
        status: 'running',
        startedAt: new Date(),
      },
      {
        id: 'status-failed',
        userId: 'status-metrics-user',
        kind: 'entry_ai',
        status: 'failed',
        error: 'E_TEST',
        finishedAt: new Date(),
      },
    ]);

    const status = await buildStatus(db);
    assert.equal(status.db.ready, true);
    assert.ok(status.db.pool);
    assert.ok(status.db.pool.acquisitions > 0);
    assert.equal(typeof status.db.pool.longestQueryMs, 'number');
    assert.equal(typeof status.db.pool.healthy, 'boolean');
    assert.equal(status.operations.aiJobs.queued, 1);
    assert.equal(status.operations.aiJobs.running, 1);
    assert.equal(status.operations.aiJobs.failed24h, 1);
    assert.ok(status.operations.aiJobs.oldestQueuedMs >= 4_000);
    for (const scheduler of [
      status.operations.rss,
      status.operations.aiTags,
      status.operations.digest,
    ]) {
      assert.equal(typeof scheduler.runs, 'number');
      assert.equal(typeof scheduler.failed, 'number');
      assert.equal(typeof scheduler.skipped, 'number');
      assert.equal(typeof scheduler.maxDurationMs, 'number');
    }
  } finally {
    await getPool()?.end();
  }
});
