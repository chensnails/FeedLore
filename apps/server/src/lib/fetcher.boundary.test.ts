/**
 * 回源链路边界测试（本地假源站，不依赖外网、不烧真实额度）。
 *
 * 覆盖 P1 回源优化里只有纯逻辑单测、没有端到端验证的部分：
 *  - 单源重试总预算（此前实测 25s×3 + 退避 = 77.8s 长尾）
 *  - 4xx 永久错误不重试 / 5xx 重试成功
 *  - 304 条件命中
 *  - 条件头被忽略 → 连续命中后降频
 *  - dueFeeds 应用降频倍数
 *
 * 网络用例需要 ALLOW_PRIVATE_HOSTS=1（本地 127.0.0.1 源站）；未设置时自动跳过网络部分，
 * 纯逻辑部分（dueFeeds）照常运行，保证本地 pnpm test 不失败也不挂住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { fetchFeedRaw, dueFeeds, feedIntervalMs, type FeedRow } from './fetcher';
import { apiErrorKey } from './apiError';
import { condFactor, condHost, noteCond, resetCondForTest, COND_MISS_LIMIT } from './feedCond';

const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><link>http://x</link><description>d</description></channel></rss>';

type Mode = 'ok' | 'hang' | 'unauth' | 'flaky503' | 'notmod' | 'ignoreCond';
const state: { mode: Mode; hits: number } = { mode: 'ok', hits: 0 };

function makeServer(): Promise<{ srv: Server; url: string }> {
  const srv = createServer((req, res) => {
    state.hits += 1;
    if (state.mode === 'hang') return; // 永不响应，制造单次超时
    if (state.mode === 'unauth') {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('nope');
    }
    if (state.mode === 'flaky503' && state.hits < 3) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('busy');
    }
    if (state.mode === 'notmod') {
      res.writeHead(304);
      return res.end();
    }
    if (state.mode === 'ignoreCond') {
      // 不管客户端带什么条件头，都回 200 + 同一个 etag（= 忽略条件请求）
      res.writeHead(200, { 'Content-Type': 'application/rss+xml', ETag: '"fixed"' });
      return res.end(RSS);
    }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(RSS);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ srv, url: `http://127.0.0.1:${addr.port}/feed.xml` });
    });
  });
}

const netOk = process.env.ALLOW_PRIVATE_HOSTS === '1';

test('fetcher 边界（本地假源站）', async (t) => {
  if (!netOk) {
    t.skip('ALLOW_PRIVATE_HOSTS!=1，跳过本地源站用例');
    return;
  }
  const { srv, url } = await makeServer();
  const host = condHost(url);
  t.after(() => srv.close());

  await t.test('慢源：总预算兜住，不会 25s×3 + 退避拖到 78s', async () => {
    resetCondForTest();
    state.mode = 'hang';
    state.hits = 0;
    const t0 = Date.now();
    let code = '';
    try {
      await fetchFeedRaw(url, { timeoutMs: 400 });
    } catch (e) {
      code = apiErrorKey(e);
    }
    const elapsed = Date.now() - t0;
    // timeoutMs=400 + RETRY_EXTRA_MS=8000 → 总预算 ~8.4s；留 1.5s 抖动余量
    assert.ok(elapsed < 9_900, `总耗时应被预算兜住，实际 ${elapsed}ms`);
    assert.match(code, /E_FETCH_TIMEOUT/, `应为超时码，实际 ${code}`);
    assert.ok(state.hits <= 3, `重试不应超过 3 次，实际 ${state.hits}`);
    console.log(`[慢源] 耗时 ${elapsed}ms / 请求 ${state.hits} 次 / ${code}`);
  });

  await t.test('4xx 永久错误不重试（401 只打一次）', async () => {
    state.mode = 'unauth';
    state.hits = 0;
    let code = '';
    try {
      await fetchFeedRaw(url, { timeoutMs: 1000 });
    } catch (e) {
      code = apiErrorKey(e);
    }
    assert.match(code, /E_FETCH_HTTP_STATUS:401/, `实际 ${code}`);
    assert.equal(state.hits, 1, `永久错误不应重试，实际请求 ${state.hits} 次`);
  });

  await t.test('5xx 重试：前两次 503、第三次 200 成功', async () => {
    state.mode = 'flaky503';
    state.hits = 0;
    const r = await fetchFeedRaw(url, { timeoutMs: 1000 });
    assert.equal(r.notModified, false);
    assert.ok(r.body?.includes('<rss'), '应拿到 RSS 正文');
    assert.equal(state.hits, 3, `应重试到第三次，实际 ${state.hits}`);
  });

  await t.test('304 条件命中：notModified，且不触发降频', async () => {
    resetCondForTest();
    state.mode = 'notmod';
    state.hits = 0;
    const r = await fetchFeedRaw(url, { etag: '"fixed"', timeoutMs: 1000 });
    assert.equal(r.notModified, true);
    assert.equal(condFactor(host), 1);
    assert.equal(state.hits, 1);
  });

  await t.test('条件头被忽略：连续 N 次同 etag 后该 host 降频', async () => {
    resetCondForTest();
    state.mode = 'ignoreCond';
    state.hits = 0;
    for (let i = 0; i < COND_MISS_LIMIT; i += 1) {
      await fetchFeedRaw(url, { etag: '"fixed"', timeoutMs: 1000 });
    }
    assert.equal(condFactor(host), 2, `连续 ${COND_MISS_LIMIT} 次忽略后应翻倍，实际 ${condFactor(host)}`);
  });
});

/* ---------------- 纯逻辑：降频倍数应用到到期判断（无需网络，总是运行） ---------------- */

function row(over: Partial<FeedRow> = {}): FeedRow {
  return {
    id: 'r1', ownerId: 'u1', url: 'http://ignored.example/feed', title: 't', siteUrl: null,
    description: null, iconUrl: null, enabled: true, refreshMinutes: 10,
    lastFetchedAt: new Date(Date.now() - 15 * 60_000), // 15 分钟前，超过 10 分钟间隔
    lastStatus: '200', lastError: null, failCount: 0, feedCreatedAt: null,
    sortOrder: 0, createdAt: new Date(), bodyHash: null, ...over,
  } as FeedRow;
}

test('dueFeeds：正常间隔到期；host 被降频后 4 倍间隔内不再到期', () => {
  resetCondForTest();
  const feed = row({ url: 'https://penalized.example/feed' });
  const host = condHost(feed.url);
  // 15 分钟前抓过、10 分钟间隔 → 正常应到期
  assert.ok(dueFeeds([feed]).length === 1, '未降频时应到期');
  // 把该 host 顶到 4 倍（间隔 40 分钟），15 分钟前抓过 → 不应到期
  noteCond(host, 'ignored'); noteCond(host, 'ignored'); noteCond(host, 'ignored');
  noteCond(host, 'ignored'); noteCond(host, 'ignored'); noteCond(host, 'ignored');
  assert.equal(condFactor(host), 4);
  assert.ok(dueFeeds([feed]).length === 0, '降频 4 倍后 15 分钟内不应到期');
  // 恢复后重新到期
  noteCond(host, 'hit');
  assert.ok(dueFeeds([feed]).length === 1, '恢复后应重新到期');
});

test('feedIntervalMs：per-feed 覆盖全局，非法值回退全局', () => {
  const global = 60;
  assert.equal(feedIntervalMs({ refreshMinutes: 15 } as FeedRow, global), 15 * 60_000);
  assert.equal(feedIntervalMs({ refreshMinutes: 0 } as FeedRow, global), global * 60_000);
  assert.equal(feedIntervalMs({ refreshMinutes: -5 } as FeedRow, global), global * 60_000);
  assert.equal(feedIntervalMs({ refreshMinutes: 1e9 } as FeedRow, global), 1e9 * 60_000);
});
