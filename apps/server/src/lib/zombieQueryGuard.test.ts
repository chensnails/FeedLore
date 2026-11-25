import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { statementTimeoutMs } from '@feedlore/db';

/**
 * 僵尸查询防复发的源码契约守卫（2026-11-24）。
 *
 * 根因回顾：entries 的 pg_class.reltuples 损坏成 Infinity → 优化器选出
 * cost=Infinity 的笛卡尔计划 → 单条查询挂数小时占死连接池 → 所有 API 8s 超时。
 * 四层防御：① statement_timeout 兜底 ② 打标签查询改 NOT EXISTS
 * ③ 搜索不建重型 trigram GIN（构建开销与查询收益不匹配） ④ status 暴露慢查询/统计健康度。
 * 这些改动都依赖「具体写法」，行为测试覆盖不到，用源码守卫钉住。
 */

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (p: string) => readFileSync(repo + p, 'utf8');

test('statementTimeoutMs: 默认 60s，环境变量可覆盖，非法值回落', () => {
  assert.equal(statementTimeoutMs({}), 60_000);
  assert.equal(statementTimeoutMs({ PG_STATEMENT_TIMEOUT_MS: '' }), 60_000);
  assert.equal(statementTimeoutMs({ PG_STATEMENT_TIMEOUT_MS: '120000' }), 120_000);
  assert.equal(statementTimeoutMs({ PG_STATEMENT_TIMEOUT_MS: '0' }), 60_000);
  assert.equal(statementTimeoutMs({ PG_STATEMENT_TIMEOUT_MS: '-1' }), 60_000);
  assert.equal(statementTimeoutMs({ PG_STATEMENT_TIMEOUT_MS: 'abc' }), 60_000);
});

test('createPool: 下发 statement_timeout 到连接池', () => {
  const src = read('packages/db/src/index.ts');
  assert.match(
    src,
    /statement_timeout:\s*statementTimeoutMs\(\)/,
    '连接池必须设置服务端单条 SQL 超时',
  );
});

test('长事务豁免：导入与整站还原放宽到有限值，不是无限', () => {
  const src = read('apps/server/src/lib/importData.ts');
  const hits = src.match(/SET LOCAL statement_timeout/g) ?? [];
  assert.ok(hits.length >= 2, '账号导入与整站还原两个事务都要有豁免');
  assert.match(src, /SET LOCAL statement_timeout = '300s'/, '豁免要有上限，不能设为无限');
});

test('findUntaggedEntries: 用 not exists + 本人频道子查询，不用 LEFT JOIN IS NULL', () => {
  const src = read('apps/server/src/lib/aiTag.ts');
  const fn = src.slice(
    src.indexOf('export async function findUntaggedEntries'),
    src.indexOf('/** 为单篇生成'),
  );
  assert.match(fn, /not exists/, '必须走 anti-join 的 NOT EXISTS 形态');
  assert.match(fn, /inArray\(/, 'owner 隔离用本人频道 id 子查询');
  assert.match(fn, /eq\(feeds\.ownerId, uid\)/, '频道子查询必须限定 owner');
  assert.match(fn, /entryAiTags\.userId/, '标签子查询必须限定本人 userId');
  assert.doesNotMatch(fn, /leftJoin/, '不能再退化成 LEFT JOIN ... IS NULL');
  assert.doesNotMatch(fn, /isNull/, '不能再使用 isNull 判断');
});

test('owner 过滤：= ANY(ARRAY(...)) 一次 InitPlan，避免逐行 join', () => {
  const src = read('apps/server/src/lib/entriesQuery.ts');
  assert.match(src, /ANY\(ARRAY\(SELECT/);
  assert.doesNotMatch(src, /inArray\(\s*entries\.feedId,\s*db\.select/, '不能退回 IN (subquery)');
});

test('搜索索引：不建重型 trigram GIN，启动迁移保持轻量', () => {
  const m20 = read('packages/db/drizzle/0020_query_indexes.sql');
  assert.doesNotMatch(m20, /USING gin/i, '0020 不建 GIN 索引');
  const m21 = read('packages/db/drizzle/0021_search_trgm_expr.sql');
  assert.doesNotMatch(m21, /^\s*CREATE INDEX/im, '0021 不能阻塞启动');
  assert.doesNotMatch(
    read('apps/server/src/index.ts'),
    /startPerfIndexBuilder/,
    '启动链路不能再触发后台建索引',
  );

  const journal = JSON.parse(read('packages/db/drizzle/meta/_journal.json'));
  assert.ok(journal.entries.some((e: { tag: string }) => e.tag === '0021_search_trgm_expr'));
});

test('status: 暴露慢查询计数与 reltuples 健康度，且契约同步', () => {
  const src = read('apps/server/src/lib/status.ts');
  assert.match(src, /longQueries/, 'status 要暴露超时活跃查询数');
  assert.match(src, /longestQueryMs/, 'status 要暴露最长活跃查询耗时');
  assert.match(src, /statsHealthy/, 'status 要暴露 reltuples 健康度');
  assert.match(src, /statementTimeoutMs\(\)/, '慢查询阈值必须跟随 statement_timeout');
  assert.doesNotMatch(src, /interval '60 seconds'/, '不能再把慢查询阈值硬编码成 60 秒');
  assert.match(src, /'entries'::regclass/, '必须查 entries 表的 reltuples');
  const contract = read('packages/contract/src/endpoints.ts');
  assert.match(
    contract,
    /longQueries:\s*z\.number\(\)/,
    '契约要声明 longQueries，否则被 assertResponse 剥掉',
  );
  assert.match(contract, /longestQueryMs:\s*z\.number\(\)/);
  assert.match(contract, /statsHealthy:\s*z\.boolean\(\)/, '契约要声明 statsHealthy');
  assert.match(contract, /healthy:\s*z\.boolean\(\)/);
  assert.match(contract, /connectionsCreated:\s*z\.number\(\)/);
  assert.match(contract, /operations:\s*z\.object\(/);
  assert.match(contract, /oldestQueuedMs:\s*z\.number\(\)/);
});
