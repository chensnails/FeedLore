import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEntities, normalizeItem, parseFeed, plainText } from './rss';

/**
 * RSS 解析与条目归一化。
 *
 * 正文结构化本身在 article.test.ts 里测；这里守的是「条目字段」：
 * 标题 / 链接 / 抓取码 / 图片列表 / bodyVersion 的落库口径。
 */

test('实体解码：数字实体、十六进制、nbsp', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&#39;quoted&#39;'), "'quoted'");
  assert.equal(decodeEntities('&#x27;x&#x27;'), "'x'");
  // nbsp 解出来是不换行空格（U+00A0），不是普通空格 —— 排版上要保留这个区别
  assert.equal(decodeEntities('a&nbsp;b'), 'a b');
  assert.equal(decodeEntities(null), '');
});

test('normalizeItem：产出 v2 正文块，图片按正文顺序且相对地址补全', () => {
  const it = normalizeItem(
    {
      guid: 'g-1',
      title: '一篇',
      url: 'https://example.com/p/1',
      content: '<p>第一段</p><img src="/a.jpg"><p>第二段</p>',
      enclosure: null,
      dateStr: 'Wed, 29 Oct 2026 10:00:00 GMT',
    },
    '源',
    { siteUrl: 'https://example.com' },
  );
  assert.equal(it.bodyVersion, 2);
  assert.deepEqual(it.images, ['https://example.com/a.jpg']);
  const blocks = JSON.parse(it.bodyJson ?? '[]');
  assert.deepEqual(blocks.map((b: { t: string }) => b.t), ['p', 'img', 'p']);
  assert.equal(blocks[1].src, 'https://example.com/a.jpg');
});

test('normalizeItem：纯文本帖子的换行仍是独立段落', () => {
  const it = normalizeItem(
    {
      guid: 'g-2',
      title: '资源',
      url: 'https://example.com/p/2',
      content: '名称：资源\n描述：说明\n链接：https://pan.baidu.com/s/abc',
      enclosure: null,
      dateStr: '',
    },
    '源',
  );
  const blocks = JSON.parse(it.bodyJson ?? '[]');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].v[0].v, '名称：资源');
});

test('plainText：<br> 变换行，其余标签去掉', () => {
  assert.equal(plainText('a<br>b<br/>c'), 'a\nb\nc');
  assert.equal(plainText('<p>只有文字</p>'), '只有文字');
});

test('parseFeed：RSS 2.0 的标题 / 站点 / 条目都能取到', () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>测试源</title>
  <link>https://example.com</link>
  <description>描述</description>
  <item>
    <title>第一篇</title>
    <link>https://example.com/1</link>
    <guid>g-1</guid>
    <description>摘要一</description>
    <pubDate>Wed, 29 Oct 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;
  const f = parseFeed(xml);
  assert.equal(f.title, '测试源');
  assert.equal(f.siteUrl, 'https://example.com');
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0]?.title, '第一篇');
  assert.equal(f.items[0]?.url, 'https://example.com/1');
});

test('parseFeed：Atom 的 entry / link[rel=alternate] 也能读', () => {
  const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 源</title>
  <link rel="alternate" href="https://atom.example.com/" />
  <entry>
    <title>Atom 一条</title>
    <link rel="alternate" href="https://atom.example.com/p/1" />
    <id>tag:1</id>
    <updated>2026-10-29T10:00:00Z</updated>
    <summary>摘要</summary>
  </entry>
</feed>`;
  const f = parseFeed(xml);
  assert.equal(f.title, 'Atom 源');
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0]?.url, 'https://atom.example.com/p/1');
});
