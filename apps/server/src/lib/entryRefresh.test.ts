import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CurrentEntryRow } from './entryRefresh';
import { mergeEntryRefreshContent } from './entryRefresh';
import type { NormalizedItem } from './rss';

const row: CurrentEntryRow = {
  id: 1,
  feedId: 2,
  guid: 'g-1',
  feedUrl: 'https://feed.example.com/rss',
  feedSiteUrl: null,
  fullText: false,
  link: 'https://old.example.com/a',
  pwd: 'abcd',
  description: '旧摘要',
  content: '旧正文',
  size: '12 MB',
  tags: ['老标签'],
  image: 'https://old.example.com/1.jpg',
  images: ['https://old.example.com/1.jpg'],
  bodyJson: '[{"t":"p"}]',
  bodyVersion: 2,
  links: ['https://old.example.com/a'],
  sourceUrl: 'https://feed.example.com/item/1',
};

const fresh = (): NormalizedItem => ({
  guid: 'g-1',
  title: '新标题',
  link: 'https://new.example.com/a',
  pwd: 'efgh',
  description: '新摘要',
  content: '新正文',
  size: '34 MB',
  tags: ['新标签'],
  image: 'https://new.example.com/1.jpg',
  images: ['https://new.example.com/1.jpg', 'https://new.example.com/2.jpg'],
  links: ['https://new.example.com/a', 'https://new.example.com/b'],
  sourceUrl: 'https://feed.example.com/item/1',
  publishedAt: new Date('2026-11-28T00:00:00Z'),
  bodyJson: '[{"t":"p","v":[]}]',
  bodyVersion: 2,
});

test('单篇刷新：内容字段更新，标题/发布时间/标记不在写回集合内', () => {
  const { merged, changed } = mergeEntryRefreshContent(row, fresh());
  assert.equal(changed, true);
  assert.equal(merged.description, '新摘要');
  assert.equal(merged.content, '新正文');
  assert.equal(merged.images.length, 2);
  assert.equal(merged.bodyVersion, 2);
  assert.deepEqual(merged.tags, ['新标签']);
  // merge 的输出只包含内容字段，不含 title / publishedAt / isRead 等列
  assert.equal('title' in merged, false);
  assert.equal('publishedAt' in merged, false);
  assert.equal('isRead' in merged, false);
  assert.equal('isFavorite' in merged, false);
  assert.equal('watchState' in merged, false);
});

test('单篇刷新：抓取结果为空时不覆盖旧正文 / 配图', () => {
  const empty = {
    ...fresh(),
    link: row.link,
    pwd: row.pwd,
    description: row.description,
    size: row.size,
    tags: row.tags,
    links: row.links ?? [],
    sourceUrl: row.sourceUrl,
    content: '',
    bodyJson: null,
    images: [],
    image: null,
  };
  const { merged, changed } = mergeEntryRefreshContent(row, empty);
  assert.equal(changed, false);
  assert.equal(merged.content, '旧正文');
  assert.equal(merged.bodyJson, '[{"t":"p"}]');
  assert.deepEqual(merged.images, ['https://old.example.com/1.jpg']);
});

test('单篇刷新：完全相同的内容不再写库', () => {
  const same = {
    ...fresh(),
    link: row.link,
    pwd: row.pwd,
    description: row.description,
    content: row.content,
    size: row.size,
    tags: row.tags,
    image: row.image,
    images: row.images ?? [],
    links: row.links ?? [],
    bodyJson: row.bodyJson,
  };
  assert.equal(mergeEntryRefreshContent(row, same).changed, false);
});
