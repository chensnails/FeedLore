/**
 * 抓一个源，把「解析成什么」打出来 —— 排查订阅源质量用。
 *
 *   pnpm --filter @feedlore/server exec tsx scripts/inspect-feed.ts <URL 或本地 .xml 路径>
 *
 * 会走与线上完全相同的链路（safeFetch → parseFeed → normalizeItem），
 * 所以「这里看着对、线上不对」不会发生。
 */

import { readFileSync } from 'node:fs';
import { parseFeed, normalizeItem } from '../src/lib/rss';
import { fetchFeedRaw } from '../src/lib/fetcher';

const target = process.argv[2];
if (!target) {
  console.error('用法：tsx scripts/inspect-feed.ts <URL 或 .xml 路径>');
  process.exit(1);
}

const isUrl = /^https?:\/\//i.test(target);
const xml = isUrl
  ? await (async () => {
      const t0 = Date.now();
      const res = await fetchFeedRaw(target);
      console.log(`HTTP ${res.status ?? '?'} · ${Date.now() - t0}ms · ${(res.body ?? '').length} 字节`);
      return res.body ?? '';
    })()
  : readFileSync(target, 'utf8');

const parsed = parseFeed(xml);
console.log(`\n频道：${parsed.title || '(无标题)'}`);
console.log(`站点：${parsed.siteUrl ?? '-'}`);
console.log(`图标：${parsed.iconUrl ?? '-'}`);
console.log(`条目：${parsed.items.length} 条\n`);

const items = parsed.items.slice(0, 5).map((it) => normalizeItem(it, parsed.title));
for (const [i, it] of items.entries()) {
  console.log(`── #${i + 1} ${it.title}`);
  console.log(`   guid    ${it.guid.slice(0, 90)}`);
  console.log(`   link    ${it.link ?? '-'}`);
  console.log(`   pwd     ${it.pwd ?? '-'}   size ${it.size || '-'}   tags ${it.tags.join(',') || '-'}`);
  console.log(`   images  ${it.images.length} 张   links ${it.links.length} 条`);
  console.log(`   正文    ${it.content ? it.content.length : 0} 字   ${it.content?.slice(0, 80).replace(/\n/g, ' ⏎ ') ?? '-'}`);
  console.log(`   时间    ${it.publishedAt.toISOString()}`);
}
