import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeByGuid } from './fetchStore';
import type { NormalizedItem } from './rss';

const item = (guid: string, title = guid): NormalizedItem => ({
  guid,
  title,
  link: 'https://example.com/' + guid,
  pwd: null,
  description: null,
  content: null,
  size: null,
  tags: [],
  image: null,
  images: [],
  links: [],
  sourceUrl: null,
  bodyJson: null,
  bodyVersion: 1,
  publishedAt: new Date('2026-01-01T00:00:00Z'),
});

test('dedupeByGuid：重复 guid 只保留最后一条，避免 ON CONFLICT 双行报错', () => {
  const out = dedupeByGuid([item('a', '旧'), item('b'), item('a', '新')]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((x) => x.guid).sort(), ['a', 'b']);
  assert.equal(out.find((x) => x.guid === 'a')!.title, '新');
});

test('dedupeByGuid：没有重复时原样返回（不复制数组）', () => {
  const list = [item('a'), item('b')];
  assert.equal(dedupeByGuid(list), list);
});

test('dedupeByGuid：空数组与单条不受影响', () => {
  assert.deepEqual(dedupeByGuid([]), []);
  assert.equal(dedupeByGuid([item('x')]).length, 1);
});
