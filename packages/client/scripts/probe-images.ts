/**
 * 批量探测图片代理 —— 排障用。
 *
 * 场景：卡片上只有一部分封面显示出来。到底是**代理挂了**，还是**图片在视口外
 * 没触发懒加载**？看截图分不清这两件事，这里一次问清。
 *
 *   API_BASE=http://172.26.1.2:3211 ADMIN_PASS=xxx pnpm --filter @feedlore/client probe:images
 *   # 可选：LIMIT=60（默认 30）、CONCURRENCY=4（默认 4）
 *
 * 走的是公开 API（/api/entries 拿已改写好的代理地址），不需要连库，
 * 因此本地也能对着远端跑。判据是「HTTP 200 + image/* + 非空字节」，
 * 任一不满足就算失败并把状态码打出来（403/404 要能一眼看出是源站的问题）。
 */

import { createApiClient } from '../src/index';
import { createCookieJarFetch } from '../src/node';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3211';
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASS ?? '';
const LIMIT = Math.max(1, Number(process.env.LIMIT) || 30);
const CONCURRENCY = Math.min(10, Math.max(1, Number(process.env.CONCURRENCY) || 4));

if (!PASS) {
  console.error('缺少 ADMIN_PASS');
  process.exit(2);
}

const jar = createCookieJarFetch();
const api = createApiClient(BASE, { fetch: jar.fetch, credentials: 'omit' });

await api.login({ username: USER, password: PASS });

const { entries } = await api.entries.list({ limit: String(Math.min(200, LIMIT)) });
const urls = entries.map((e) => e.image).filter((u): u is string => typeof u === 'string' && u.length > 0);

if (!urls.length) {
  console.log(`共 ${entries.length} 条，没有一条带封面 —— 不是代理的问题，是抓取时没取到图。`);
  process.exit(0);
}

interface Result {
  url: string;
  status: number | string;
  bytes: number;
  ms: number;
  type: string;
}

const results: Result[] = [];

async function probe(url: string): Promise<void> {
  const t0 = Date.now();
  try {
    const r = await jar.fetch(`${BASE}${url}`);
    const buf = Buffer.from(await r.arrayBuffer());
    results.push({
      url,
      status: r.status,
      bytes: buf.length,
      ms: Date.now() - t0,
      type: r.headers.get('content-type') ?? '',
    });
  } catch (e) {
    results.push({ url, status: (e as Error).message.slice(0, 20), bytes: 0, ms: Date.now() - t0, type: '' });
  }
}

console.log(`[probe] ${BASE} — ${urls.length} 张封面，并发 ${CONCURRENCY}\n`);

// 简单工作池：同时最多 CONCURRENCY 个在飞，避免把测试站打满
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      if (url) await probe(url);
    }
  }),
);

results.sort((a, b) => a.ms - b.ms);
for (const r of results) {
  const target = decodeURIComponent(r.url.split('u=')[1] ?? r.url);
  const okMark = r.status === 200 && r.bytes > 0 && /^image\//.test(r.type) ? '✓' : '✗';
  console.log(
    `  ${okMark} ${String(r.status).padEnd(6)} ${(r.bytes / 1024).toFixed(1).padStart(8)}KB ` +
      `${String(r.ms).padStart(5)}ms  ${r.type || '-'}  ${target.slice(0, 72)}`,
  );
}

const good = results.filter((r) => r.status === 200 && r.bytes > 0 && /^image\//.test(r.type)).length;
const byStatus = new Map<string, number>();
for (const r of results) byStatus.set(String(r.status), (byStatus.get(String(r.status)) ?? 0) + 1);

console.log(
  `\n成功 ${good}/${results.length}` +
    ` · 状态 ${[...byStatus].map(([k, v]) => `${k}×${v}`).join(' ')}` +
    ` · 中位耗时 ${results[Math.floor(results.length / 2)]?.ms ?? 0}ms`,
);
process.exitCode = good === results.length ? 0 : 1;
