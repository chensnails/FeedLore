import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  invalidateTagCounts,
  tagCountsCacheGet,
  tagCountsCacheKey,
  tagCountsCacheSet,
} from './tagCountsCache';

test('标签云缓存：10 秒内命中、过期回落、显式失效', () => {
  const key = tagCountsCacheKey('u1', [1, 2]);
  invalidateTagCounts();
  assert.equal(tagCountsCacheGet(key, 0), undefined);
  tagCountsCacheSet(key, [{ tag: '科幻', n: 3 }], 1_000);
  assert.deepEqual(tagCountsCacheGet(key, 10_999), [{ tag: '科幻', n: 3 }]);
  assert.equal(tagCountsCacheGet(key, 11_000), undefined);
  tagCountsCacheSet(key, [{ tag: '科幻', n: 4 }], 12_000);
  invalidateTagCounts();
  assert.equal(tagCountsCacheGet(key, 12_001), undefined);
});

test('会话缓存与查询索引配置齐全', () => {
  const auth = readFileSync(
    new URL('../../../../packages/auth/src/index.ts', import.meta.url),
    'utf8',
  );
  assert.match(auth, /cookieCache:\s*\{\s*enabled:\s*true/);
  assert.match(auth, /prefs:\s*\{\s*type:\s*'json'/);
  const journal = readFileSync(
    new URL('../../../../packages/db/drizzle/meta/_journal.json', import.meta.url),
    'utf8',
  );
  assert.match(journal, /0020_query_indexes/);
  const migration = readFileSync(
    new URL('../../../../packages/db/drizzle/0020_query_indexes.sql', import.meta.url),
    'utf8',
  );
  for (const idx of [
    'entries_unread_pub_idx',
    'entries_guid_idx',
    'ai_jobs_user_status_idx',
    'sessions_user_updated_idx',
  ]) {
    assert.ok(migration.includes(idx), `缺索引 ${idx}`);
  }
  // 搜索用的重型 trigram GIN 已整体移除：构建开销远超收益。
});
