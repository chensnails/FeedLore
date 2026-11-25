import assert from 'node:assert/strict';
import test from 'node:test';
import { createDb, type Db, entries, entryAiTags, feeds, getPool } from '@feedlore/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { CARD_COLUMNS, type EntryFilter, entryWhere } from './entriesQuery';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Join Type'?: string;
  'Total Cost'?: number;
  Plans?: PlanNode[];
}

interface ExplainPlan {
  'Execution Time': number;
  Planning?: { 'Total Cost'?: number };
  Plan: PlanNode;
}

interface QueryShape {
  sql: string;
  params: unknown[];
}

function walkPlan(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walkPlan(child, visit);
}

function planIndexes(plan: PlanNode, label: string): Set<string> {
  const indexes = new Set<string>();
  walkPlan(plan, (node) => {
    if (node['Index Name']) indexes.add(node['Index Name']);
    assert.notEqual(node['Join Type'], 'Cartesian', `${label} 出现笛卡尔计划`);
    assert.ok(
      node['Total Cost'] === undefined || Number.isFinite(node['Total Cost']),
      `${label} 出现非有限 cost`,
    );
  });
  return indexes;
}

async function explain(client: PoolClient, query: QueryShape): Promise<ExplainPlan> {
  const result = await client.query(
    `explain (analyze, buffers, format json) ${query.sql}`,
    query.params,
  );
  return result.rows[0]['QUERY PLAN'][0] as ExplainPlan;
}

async function expectPlan(
  client: PoolClient,
  label: string,
  query: QueryShape,
  budgetMs: number,
  requiredIndex?: string | string[],
): Promise<void> {
  const explained = await explain(client, query);
  const executionMs = explained['Execution Time'];
  const indexes = planIndexes(explained.Plan, label);
  assert.ok(
    executionMs <= budgetMs,
    `${label} 耗时 ${executionMs.toFixed(1)}ms 超过 ${budgetMs}ms 预算`,
  );

  if (requiredIndex) {
    const required = Array.isArray(requiredIndex) ? requiredIndex : [requiredIndex];
    await client.query('begin');
    try {
      // 正常计划负责耗时预算；关闭顺序扫描只用于验证关键索引仍存在且可被规划器使用。
      await client.query('set local enable_seqscan = off');
      const forced = await explain(client, query);
      const forcedIndexes = planIndexes(forced.Plan, `${label}（索引守门）`);
      assert.ok(
        required.some((index) => forcedIndexes.has(index)),
        `${label} 未使用 ${required.join(' / ')}，实际索引：${[...forcedIndexes].join(', ') || '无'}`,
      );
    } finally {
      await client.query('rollback');
    }
  }
  console.log(
    `[query-plan] ${label}: ${executionMs.toFixed(1)}ms / ${budgetMs}ms; indexes=${[...indexes].join(',') || 'none'}${requiredIndex ? `; required=${requiredIndex}` : ''}`,
  );
}

const ownerId = 'query-plan-owner';
const feedIds = Array.from({ length: 15 }, (_, i) => i + 1);

function listQuery(
  db: Db,
  filter: Omit<EntryFilter, 'feedIds'>,
  favoriteOrder = false,
): QueryShape {
  return db
    .select(CARD_COLUMNS)
    .from(entries)
    .innerJoin(feeds, eq(feeds.id, entries.feedId))
    .where(entryWhere(ownerId, { feedIds, ...filter }))
    .orderBy(
      favoriteOrder
        ? sql`${entries.favoritedAt} desc nulls last`
        : sql`${entries.publishedAt} desc nulls last`,
      desc(entries.id),
    )
    .limit(51)
    .toSQL();
}

test('核心查询：EXPLAIN 执行计划与耗时预算', async () => {
  const db = createDb();
  const pool = getPool()!;
  const client = await pool.connect();
  try {
    await client.query(`
      insert into users (id, email, role)
      values ('${ownerId}', 'query-plan@example.test', 'admin'),
             ('query-plan-other', 'query-plan-other@example.test', 'user');

      insert into feeds (owner_id, url, title, enabled, card_enabled)
      select case when g <= 15 then '${ownerId}' else 'query-plan-other' end,
             'https://example.test/feed/' || g,
             'Feed ' || g,
             true,
             true
      from generate_series(1, 30) g;

      insert into entries (
        feed_id, guid, title, description, content, tags, published_at,
        is_read, is_favorite, favorited_at, watch_state, watch_tagged_at
      )
      select ((g - 1) % 30) + 1,
             'guid-' || g,
             case when g % 20 = 0 then 'Needle entry ' || g else 'Performance entry ' || g end,
             'Summary for entry ' || g,
             'Body text for entry ' || g,
             ARRAY[]::text[]
               || case when g % 10000 = 0 then ARRAY['rare-tag'] else ARRAY[]::text[] end
               || case when g % 10 = 0 then ARRAY['common-tag'] else ARRAY[]::text[] end,
             now() - (g % 240) * interval '1 hour',
             g % 2 = 0,
             g % 100 = 0,
             case when g % 100 = 0 then now() - (g % 48) * interval '1 hour' end,
             case when g % 2000 = 0 then 'watch' when g % 3000 = 0 then 'block' end,
             case when g % 2000 = 0 then now() end
      from generate_series(1, 30000) g;

      insert into entry_ai_tags (id, user_id, entry_id, tags, status)
      select 'tag-' || g,
             case when g <= 15 then '${ownerId}' else 'query-plan-other' end,
             g,
             ARRAY['ai-existing'],
             'done'
      from generate_series(1, 500) g;

      analyze feeds;
      analyze entries;
      analyze entry_ai_tags;
    `);

    const stats = await client.query<{ n: string }>(
      "select reltuples::text as n from pg_class where oid = 'entries'::regclass",
    );
    assert.ok(Number(stats.rows[0]?.n) >= 25_000, 'entries 统计信息未反映出种子数据');

    await expectPlan(client, '默认卡片列表', listQuery(db, {}), 500, 'entries_pub_idx');

    await expectPlan(
      client,
      '列表总数',
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(entries)
        .innerJoin(feeds, eq(feeds.id, entries.feedId))
        .where(entryWhere(ownerId, { feedIds }))
        .toSQL(),
      500,
    );

    await expectPlan(client, '未读列表', listQuery(db, { unread: true }), 500);
    await expectPlan(
      client,
      '收藏列表',
      listQuery(db, { fav: true }, true),
      500,
      'entries_fav_idx',
    );
    await expectPlan(
      client,
      '稀有标签筛选',
      listQuery(db, { tag: 'rare-tag' }),
      500,
      'entries_tags_idx',
    );
    await expectPlan(
      client,
      '关注筛选',
      listQuery(db, { watch: 'watch' }),
      500,
      'entries_watch_idx',
    );
    await expectPlan(client, '全文关键词搜索', listQuery(db, { q: 'needle' }), 1_000);

    await expectPlan(
      client,
      'AI 未打标批次',
      db
        .select({ id: entries.id, title: entries.title, content: entries.content })
        .from(entries)
        .where(
          and(
            inArray(
              entries.feedId,
              db.select({ id: feeds.id }).from(feeds).where(eq(feeds.ownerId, ownerId)),
            ),
            sql`not exists (
              select 1 from ${entryAiTags}
              where ${entryAiTags.entryId} = ${entries.id}
                and ${entryAiTags.userId} = ${ownerId}
            )`,
          ),
        )
        .orderBy(sql`${entries.publishedAt} desc nulls last`, desc(entries.id))
        .limit(20)
        .toSQL(),
      500,
      'entries_pub_idx',
    );

    await expectPlan(
      client,
      '日报最近 24 小时采集',
      db
        .select({ id: entries.id, title: entries.title })
        .from(entries)
        .innerJoin(feeds, eq(feeds.id, entries.feedId))
        .where(
          and(
            eq(feeds.ownerId, ownerId),
            sql`${entries.publishedAt} > now() - interval '24 hours'`,
          ),
        )
        .orderBy(sql`${entries.publishedAt} desc nulls last`, desc(entries.id))
        .limit(3_000)
        .toSQL(),
      750,
      'entries_pub_idx',
    );

    await expectPlan(
      client,
      '抓取 guid 点查',
      db
        .select({ guid: entries.guid })
        .from(entries)
        .where(and(eq(entries.feedId, 1), eq(entries.guid, 'guid-1')))
        .toSQL(),
      100,
      ['entries_feed_id_guid_key', 'entries_guid_idx'],
    );
  } finally {
    client.release();
    await pool.end();
  }
});
