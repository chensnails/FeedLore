import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyFullText, extractArticleFromHtml, isThinContent, shouldApplyFullText } from './fulltext';
import type { NormalizedItem } from './rss';

/**
 * 全文抽取（P2）。
 *
 * 这里守两件事：
 *  1. Readability 抽完仍是「我们的块格式」，相对链接 / 图片必须补成绝对地址；
 *  2. 失败（登录墙 / 纯 JS 页 / 太短）必须返回 null 让调用方回退订阅正文，
 *     绝不能把空内容或导航栏当正文写进条目。
 */

const LONG = '这是一段用来凑足正文长度的测试文字，包含中文标点、数字 123 和英文 words，'
  + '模拟真实文章段落的长度，确保 Readability 的正文评分能选中它。';

const PAGE = `<!doctype html>
<html><head><title>一篇测试文章 - 示例站</title></head>
<body>
  <header><nav><a href="/">首页</a> <a href="/about">关于我们</a></nav></header>
  <main>
    <article>
      <h1>一篇测试文章</h1>
      <p>${LONG}${LONG}</p>
      <p>${LONG}正文里的<a href="/rel">相对链接</a>也要补全。</p>
      <figure>
        <img src="/img/a.jpg" alt="配图">
        <figcaption>图注：一张配图</figcaption>
      </figure>
      <p>${LONG}${LONG}</p>
    </article>
  </main>
  <aside><h3>热门推荐</h3><p>侧栏广告文字</p></aside>
  <footer>版权所有 示例站</footer>
</body></html>`;

test('抽取正文：保留文章内容，丢掉导航与侧栏', () => {
  const got = extractArticleFromHtml(PAGE, { url: 'https://news.example.com/post/1' });
  assert.ok(got);
  assert.ok(got.title?.includes('测试文章'));
  assert.ok(got.text.includes('模拟真实文章段落'));
  assert.ok(!got.text.includes('侧栏广告文字'));
  assert.ok(!got.text.includes('关于我们'));

  const blocks = JSON.parse(got.bodyJson ?? 'null') as Array<{ t: string }>;
  assert.ok(Array.isArray(blocks) && blocks.length > 0);
  assert.ok(blocks.some((b) => b.t === 'p'));
});

test('抽取正文：相对链接与图片补成绝对地址', () => {
  const got = extractArticleFromHtml(PAGE, { url: 'https://news.example.com/post/1' });
  assert.ok(got);
  assert.ok(got.images.includes('https://news.example.com/img/a.jpg'));
  const json = got.bodyJson ?? '';
  assert.ok(json.includes('https://news.example.com/rel'));
  assert.ok(!json.includes('"/rel"'));
});

test('抽取正文：纯 JS 页面 / 太短 / 空 HTML 返回 null', () => {
  assert.equal(extractArticleFromHtml(''), null);
  assert.equal(extractArticleFromHtml('<html><body><div id="app"></div></body></html>'), null);
  assert.equal(extractArticleFromHtml('<html><body><p>太短</p></body></html>'), null);
});

test('替换判定：只有明显更长才覆盖订阅正文', () => {
  assert.equal(shouldApplyFullText('x'.repeat(500), 'y'.repeat(600)), false);
  assert.equal(shouldApplyFullText('x'.repeat(500), 'y'.repeat(1200)), true);
  assert.equal(shouldApplyFullText('', 'y'.repeat(120)), false);
});

test('摘要判定：短于 1200 字符算摘要', () => {
  assert.equal(isThinContent({ content: 'x'.repeat(200) }), true);
  assert.equal(isThinContent({ content: 'x'.repeat(2000) }), false);
});

test('应用全文：复用条目其他字段，图片去重并置顶', () => {
  const item: NormalizedItem = {
    guid: 'g1',
    title: '标题',
    link: 'https://news.example.com/post/1',
    pwd: null,
    description: '摘要',
    content: 'x'.repeat(100),
    bodyJson: null,
    bodyVersion: 1,
    size: null,
    tags: ['a'],
    image: null,
    images: [],
    links: [],
    sourceUrl: 'https://news.example.com/post/1',
    publishedAt: new Date('2026-10-01'),
  };
  const out = applyFullText(item, 'y'.repeat(4000), '[]', ['https://cdn.example.com/a.jpg']);
  assert.equal(out.title, '标题');
  assert.equal(out.description, '摘要');
  assert.equal(out.content?.length, 4000);
  assert.equal(out.bodyVersion, 2);
  assert.deepEqual(out.images, ['https://cdn.example.com/a.jpg']);
  assert.equal(out.image, 'https://cdn.example.com/a.jpg');
});
