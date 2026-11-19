/**
 * 抓一个源，把「解析成什么」打出来 —— 排查订阅源质量用。
 *
 *   pnpm --filter @feedlore/server exec tsx scripts/inspect-feed.ts <URL 或本地 .xml 路径>
 *
 * 会走与线上完全相同的链路（safeFetch → parseFeed → normalizeItem），
 * 所以「这里看着对、线上不对」不会发生。
 */

import { readFileSync } from 'node:fs';
import { fetchFeedRaw } from '../src/lib/fetcher';
import { log } from '../src/lib/logger';
import { normalizeItem, parseFeed } from '../src/lib/rss';

const target = process.argv[2];
if (!target) {
  log.error('Usage: tsx scripts/inspect-feed.ts <URL or .xml path>');
  process.exit(1);
}

const isUrl = /^https?:\/\//i.test(target);
const xml = isUrl
  ? await (async () => {
      const t0 = Date.now();
      const res = await fetchFeedRaw(target);
      log.info(
        `HTTP ${res.status ?? '?'} · ${Date.now() - t0}ms · ${(res.body ?? '').length} bytes`,
      );
      return res.body ?? '';
    })()
  : readFileSync(target, 'utf8');

const parsed = parseFeed(xml);
log.info(`\nFeed: ${parsed.title || '(untitled)'}`);
log.info(`Site: ${parsed.siteUrl ?? '-'}`);
log.info(`Icon: ${parsed.iconUrl ?? '-'}`);
log.info(`Entries: ${parsed.items.length}\n`);

const items = parsed.items
  .slice(0, 5)
  .map((it) => normalizeItem(it, parsed.title, { siteUrl: parsed.siteUrl }));
for (const [i, it] of items.entries()) {
  log.info(`── #${i + 1} ${it.title}`);
  log.info(`   guid    ${it.guid.slice(0, 90)}`);
  log.info(`   link    ${it.link ?? '-'}`);
  log.info(
    `   pwd     ${it.pwd ?? '-'}   size ${it.size || '-'}   tags ${it.tags.join(',') || '-'}`,
  );
  log.info(`   images  ${it.images.length}   links ${it.links.length}`);
  log.info(
    `   body    v${it.bodyVersion}  ${it.content ? it.content.length : 0} chars   ${it.content?.slice(0, 80).replace(/\n/g, ' ⏎ ') ?? '-'}`,
  );
  log.info(`   time    ${it.publishedAt.toISOString()}`);
}
