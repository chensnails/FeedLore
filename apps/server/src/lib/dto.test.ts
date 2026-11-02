import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bodyJsonUrl, toCard, type CardRow } from './dto';

/**
 * DTO 层最容易出的两个错：
 *  1. v2 的图片藏在 quote/list 里，只改写顶层 img 会让那几个位置的图走直连（防盗链 → 白块）；
 *  2. bodyVersion 没带出去，前端把 v2 块按 v1 渲染（整篇变成一个空 div）。
 */

test('bodyJsonUrl：引用 / 列表 / 图注里的图片也改写成代理地址', () => {
  const json = JSON.stringify([
    { t: 'p', v: [{ t: 'text', v: '正文' }] },
    { t: 'quote', blocks: [{ t: 'img', src: 'https://a.com/q.jpg' }] },
    { t: 'list', ordered: false, items: [[{ t: 'img', src: 'https://a.com/l.jpg' }]] },
    { t: 'figure', img: { src: 'https://a.com/f.jpg' }, caption: [{ t: 'text', v: '图注' }] },
  ]);
  const out = JSON.parse(bodyJsonUrl(json) ?? '[]');
  const proxied = (u: string) => '/api/img?u=' + encodeURIComponent(u);
  assert.equal(out[1].blocks[0].src, proxied('https://a.com/q.jpg'));
  assert.equal(out[2].items[0][0].src, proxied('https://a.com/l.jpg'));
  assert.equal(out[3].img.src, proxied('https://a.com/f.jpg'));
  assert.deepEqual(out[3].caption, [{ t: 'text', v: '图注' }]);
});

test('bodyJsonUrl：没有可改写图片时原样返回（省一次序列化）', () => {
  const v1 = JSON.stringify([{ t: 'p', text: '老数据' }]);
  assert.equal(bodyJsonUrl(v1), v1);
  assert.equal(bodyJsonUrl(null), null);
  assert.equal(bodyJsonUrl('not json'), 'not json');
});

const row = (over: Partial<CardRow> = {}): CardRow => ({
  id: 1,
  feedId: 2,
  title: '标题',
  link: 'https://example.com/p/1',
  pwd: null,
  description: null,
  size: null,
  tags: [],
  image: null,
  images: [],
  links: [],
  sourceUrl: null,
  publishedAt: null,
  isRead: false,
  isFavorite: false,
  favoritedAt: null,
  bodyJson: null,
  bodyVersion: 1,
  feedName: '源',
  ...over,
});

test('toCard：bodyVersion 2 原样带出，null / 其它值按 v1 兜底', () => {
  assert.equal(toCard(row({ bodyVersion: 2 })).bodyVersion, 2);
  assert.equal(toCard(row({ bodyVersion: 1 })).bodyVersion, 1);
  assert.equal(toCard(row({ bodyVersion: null })).bodyVersion, 1);
});
