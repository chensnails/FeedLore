import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createPool, type Db, feeds, schema, settings, users } from '@feedlore/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { closeFetchCoordinator, RSS_SCHEDULER_LOCK_KEY, tryFetchLock } from './fetchCoordinator';
import { refreshOneFeed } from './fetcher';
import { tickRefresh } from './fetchScheduler';
import { reloadSource, saveSource } from './settings';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const RSS =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><link>http://x</link><description>d</description></channel></rss>';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('跨实例抓取与调度协调：真 PostgreSQL advisory lock', { skip: !DATABASE_URL }, async (t) => {
  const previousPrivateHosts = process.env.ALLOW_PRIVATE_HOSTS;
  process.env.ALLOW_PRIVATE_HOSTS = '1';
  const poolA = createPool(DATABASE_URL);
  const poolB = createPool(DATABASE_URL);
  const dbA: Db = drizzle(poolA, { schema });
  const dbB: Db = drizzle(poolB, { schema });
  const ownerId = `fetch-lock-${process.pid}`;
  const previousSource = await dbA
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'source'))
    .limit(1);

  t.after(async () => {
    if (previousSource[0]) {
      await dbA
        .insert(settings)
        .values({ key: 'source', value: previousSource[0].value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: previousSource[0].value, updatedAt: new Date() },
        });
    } else {
      await dbA.delete(settings).where(eq(settings.key, 'source'));
    }
    await reloadSource(dbA);
    await dbA
      .delete(users)
      .where(eq(users.id, ownerId))
      .catch(() => {});
    await closeFetchCoordinator(dbA);
    await closeFetchCoordinator(dbB);
    await poolA.end();
    await poolB.end();
    if (previousPrivateHosts === undefined) delete process.env.ALLOW_PRIVATE_HOSTS;
    else process.env.ALLOW_PRIVATE_HOSTS = previousPrivateHosts;
  });

  await saveSource(dbA, { proxyUrl: '', timeoutSeconds: 5 });

  await t.test('两个独立连接池只回源一次，随后共享 5 秒冷却', async () => {
    await dbA.insert(users).values({ id: ownerId, email: `${ownerId}@example.test`, role: 'user' });
    const requested = deferred();
    const release = deferred();
    let hits = 0;
    const server = createServer(async (_req, res) => {
      hits += 1;
      requested.resolve();
      await release.promise;
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(RSS);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      release.resolve();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const address = server.address() as { port: number };
    const [feed] = await dbA
      .insert(feeds)
      .values({
        ownerId,
        url: `http://127.0.0.1:${address.port}/feed.xml`,
        title: 'Locked feed',
      })
      .returning();

    const first = refreshOneFeed(dbA, feed!);
    await requested.promise;
    const second = await refreshOneFeed(dbB, feed!);
    assert.equal(second.skipped, 'in-flight');
    assert.equal(hits, 1, '第二个实例不得在第一个实例回源时重复请求');

    release.resolve();
    const result = await first;
    assert.equal(result.error, undefined);
    assert.equal(result.feeds, 1);

    const recent = await refreshOneFeed(dbB, feed!);
    assert.equal(recent.skipped, 'too-recent', '跨实例应立即共享数据库中的抓取冷却');
    assert.equal(hits, 1);
  });

  await t.test('同一连接的重入由本地集合拦截，异常后锁仍会释放', async () => {
    const key = 'reentrant-and-throw';
    const outer = await tryFetchLock(dbA, key, async () => {
      const nested = await tryFetchLock(dbA, key, async () => 'nested');
      assert.equal(nested.acquired, false);
      throw new Error('expected');
    }).catch((e: Error) => e);
    assert.equal((outer as Error).message, 'expected');

    const next = await tryFetchLock(dbB, key, async () => 'released');
    assert.equal(next.acquired, true);
    if (next.acquired) assert.equal(next.value, 'released');
  });

  await t.test('调度锁被另一实例持有时，本实例跳过整轮', async () => {
    const held = deferred();
    const release = deferred();
    const claim = tryFetchLock(dbA, RSS_SCHEDULER_LOCK_KEY, async () => {
      held.resolve();
      await release.promise;
      return 'held';
    });
    await held.promise;
    try {
      assert.equal(await tickRefresh(dbB), null);
    } finally {
      release.resolve();
      assert.equal((await claim).acquired, true);
    }
  });
});
