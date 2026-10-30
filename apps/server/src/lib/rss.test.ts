import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBlocks, decodeEntities, parseFeed, plainText } from './rss';

/**
 * RSS 解析与正文结构化。
 *
 * `buildBlocks` 是阅读页能不能好好排版的前提：它把源站那段乱七八糟的 HTML
 * 拆成「有序图文块」存进 `entries.body_json`。前端的 `ArticleBody` 完全信任
 * 这个结构 —— 这里少一个图、段落粘成一坨，阅读页就直接塌。
 */

test('实体解码：数字实体、十六进制、nbsp', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&#39;quoted&#39;'), "'quoted'");
  assert.equal(decodeEntities('&#x27;x&#x27;'), "'x'");
  // nbsp 解出来是不换行空格（U+00A0），不是普通空格 —— 排版上要保留这个区别
  assert.equal(decodeEntities('a&nbsp;b'), 'a b');
  assert.equal(decodeEntities(null), '');
});

test('buildBlocks：段落与图片保持原文顺序', () => {
  const blocks = buildBlocks('<p>第一段</p><img src="https://a.com/1.jpg"><p>第二段</p>');
  assert.deepEqual(blocks, [
    { t: 'p', text: '第一段' },
    { t: 'img', src: 'https://a.com/1.jpg' },
    { t: 'p', text: '第二段' },
  ]);
});

test('buildBlocks：懒加载图片（data-src）也能取到', () => {
  const blocks = buildBlocks('<p>x</p><img data-src="https://a.com/lazy.jpg">');
  assert.deepEqual(blocks[1], { t: 'img', src: 'https://a.com/lazy.jpg' });
});

test('buildBlocks：只收 http(s)、去重、内联标签压平成文字', () => {
  const blocks = buildBlocks(
    '<p>看 <a href="https://x.com">这里</a> <b>加粗</b></p>' +
      '<img src="data:image/png;base64,AAA">' +
      '<img src="https://a.com/same.jpg">' +
      '<img src="https://a.com/same.jpg">',
  );
  // 段落里的标签被压平，文字还在
  assert.deepEqual(blocks[0], { t: 'p', text: '看 这里 加粗' });
  // data: 被丢、重复图只留一张
  assert.deepEqual(
    blocks.filter((b) => b.t === 'img'),
    [{ t: 'img', src: 'https://a.com/same.jpg' }],
  );
});

test('buildBlocks：图片上限 12 张（防超长图集把库撑爆）', () => {
  const html = Array.from({ length: 20 }, (_, i) => `<img src="https://a.com/${i}.jpg">`).join('');
  const imgs = buildBlocks(html).filter((b) => b.t === 'img');
  assert.equal(imgs.length, 12);
});

test('buildBlocks：空正文返回空数组（前端据此走兜底分层）', () => {
  assert.deepEqual(buildBlocks(''), []);
  assert.deepEqual(buildBlocks('<div>   </div>'), []);
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
