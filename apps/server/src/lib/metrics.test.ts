import assert from 'node:assert/strict';
import test from 'node:test';
import { createSchedulerMetrics } from './metrics';

test('scheduler metrics: 累计成功、失败、跳轮、耗时与积压', () => {
  const metrics = createSchedulerMetrics();
  assert.deepEqual(metrics.snapshot(), {
    runs: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastDurationMs: null,
    maxDurationMs: 0,
    backlog: null,
  });

  metrics.finish(metrics.start(), 'success', 7);
  metrics.finish(metrics.start(), 'failure', 0);
  metrics.skipped();
  const snapshot = metrics.snapshot();

  assert.equal(snapshot.runs, 2);
  assert.equal(snapshot.succeeded, 1);
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.skipped, 1);
  assert.equal(snapshot.backlog, 0);
  assert.ok(snapshot.lastStartedAt);
  assert.ok(snapshot.lastFinishedAt);
  assert.ok((snapshot.lastDurationMs ?? -1) >= 0);
  assert.ok(snapshot.maxDurationMs >= (snapshot.lastDurationMs ?? 0));
});

test('scheduler metrics: 快照不暴露可变内部状态', () => {
  const metrics = createSchedulerMetrics();
  metrics.finish(metrics.start(), 'success', 3);
  const first = metrics.snapshot();
  first.runs = 99;
  first.backlog = 99;
  assert.equal(metrics.snapshot().runs, 1);
  assert.equal(metrics.snapshot().backlog, 3);
});
