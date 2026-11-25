import assert from 'node:assert/strict';
import test from 'node:test';
import { ensurePerfIndexes, PERF_INDEXES } from './perfIndexes';

type Row = Record<string, unknown>;
interface Call {
  sql: string;
  params?: unknown[];
}

function makeDb(handler: (call: Call) => { rows: Row[] }) {
  const calls: Call[] = [];
  return {
    calls,
    db: {
      async query(sql: string, params?: unknown[]) {
        const call = { sql, params };
        calls.push(call);
        return handler(call);
      },
    },
  };
}

const isLock = (sql: string) => sql.includes('pg_try_advisory_lock');
const isUnlock = (sql: string) => sql.includes('pg_advisory_unlock');
const isLookup = (sql: string) => sql.includes('from pg_index');

test('索引后台构建：拿不到 advisory lock 时直接跳过', async () => {
  const { calls, db } = makeDb((c) => ({ rows: isLock(c.sql) ? [{ ok: false }] : [] }));
  const r = await ensurePerfIndexes(db);
  assert.equal(r.locked, true);
  assert.deepEqual(r.created, []);
  assert.equal(calls.length, 1, '锁没拿到就不该查索引或建索引');
});

test('索引后台构建：已存在的有效索引全部跳过', async () => {
  const { calls, db } = makeDb((c) => {
    if (isLock(c.sql)) return { rows: [{ ok: true }] };
    if (isLookup(c.sql)) return { rows: [{ indisvalid: true }] };
    return { rows: [] };
  });
  const r = await ensurePerfIndexes(db);
  assert.equal(r.locked, false);
  assert.deepEqual(r.created, []);
  assert.deepEqual(
    r.kept,
    PERF_INDEXES.map((i) => i.name),
  );
  assert.equal(calls.filter((c) => c.sql.includes('CREATE INDEX')).length, 0);
  assert.equal(calls.filter((c) => isUnlock(c.sql)).length, 1);
});

test('索引后台构建：有效索引保留，缺失/无效的并发重建', async () => {
  let lookups = 0;
  const { calls, db } = makeDb((c) => {
    if (isLock(c.sql)) return { rows: [{ ok: true }] };
    if (isLookup(c.sql)) {
      lookups += 1;
      // 第一只：上次中断留下的无效索引；其余：不存在
      return { rows: lookups === 1 ? [{ indisvalid: false }] : [] };
    }
    return { rows: [] };
  });
  const r = await ensurePerfIndexes(db);
  assert.equal(r.locked, false);
  assert.deepEqual(
    r.created,
    PERF_INDEXES.map((i) => i.name),
  );
  assert.deepEqual(r.kept, []);
  assert.equal(calls.filter((c) => c.sql.startsWith('drop index concurrently')).length, 1);
  assert.ok(calls.every((c) => !c.sql.includes('CREATE INDEX') || c.sql.includes('CONCURRENTLY')));
  assert.equal(calls.filter((c) => isUnlock(c.sql)).length, 1);
});

test('索引后台构建：中途失败也会释放 advisory lock', async () => {
  const { calls, db } = makeDb((c) => {
    if (isLock(c.sql)) return { rows: [{ ok: true }] };
    if (isLookup(c.sql)) throw new Error('lookup boom');
    return { rows: [] };
  });
  await assert.rejects(() => ensurePerfIndexes(db), /lookup boom/);
  assert.equal(calls.filter((c) => isUnlock(c.sql)).length, 1);
});
