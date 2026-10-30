import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOpml, parseOpml, parseOpmlAttrs } from './opml';

/**
 * OPML 导入 / 导出。
 *
 * 这块的价值在**往返**：导出的文件必须能被自己原样导回（换服务器的唯一迁移路径）。
 * 单测两头是不够的 —— 只有 `parse(build(x)) === x` 才能保证「导出再导入不丢分组」。
 */

test('属性解析：大小写不敏感、支持单双引号里的内容', () => {
  const a = parseOpmlAttrs('text="笺川 &amp; 派" xmlUrl="https://a.com/feed"');
  assert.equal(a.text, '笺川 &amp; 派');
  assert.equal(a.xmlurl, 'https://a.com/feed');
});

test('解析：嵌套分组会写进 groupName，扁平源没有分组', () => {
  const xml = `<?xml version="1.0"?>
<opml version="2.0">
  <body>
    <outline text="科技">
      <outline text="少数派" type="rss" xmlUrl="https://sspai.com/feed" />
      <outline text="IT之家" type="rss" xmlUrl="https://www.ithome.com/rss/" />
    </outline>
    <outline text="独立源" type="rss" xmlUrl="https://example.com/feed.xml" />
  </body>
</opml>`;
  const feeds = parseOpml(xml);
  assert.equal(feeds.length, 3);
  const sspai = feeds.find((f) => f.url === 'https://sspai.com/feed');
  assert.ok(sspai);
  assert.equal(sspai.group, '科技');
  const solo = feeds.find((f) => f.url === 'https://example.com/feed.xml');
  assert.ok(solo);
  // 无分组是 null（不是空串）：导入侧据此区分「顶层源」和「空名字的分组」
  assert.equal(solo.group, null);
});

test('解析：自闭合的空文件夹不会污染后面的订阅', () => {
  const xml = `<opml><body>
    <outline text="空分组" />
    <outline text="源" type="rss" xmlUrl="https://a.com/f" />
  </body></opml>`;
  const feeds = parseOpml(xml);
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0]?.group, null);
});

test('解析：没有 xmlUrl 的 outline 不当成订阅源', () => {
  const xml = `<opml><body><outline text="只有标题" /></body></opml>`;
  assert.equal(parseOpml(xml).length, 0);
});

test('导出会对 & < > " 转义（标题里出现这些字符是常事）', () => {
  const out = buildOpml([
    { title: 'A & B <tag> "q"', url: 'https://a.com/f?x=1&y=2', siteUrl: null, groupName: '' },
  ]);
  assert.match(out, /text="A &amp; B &lt;tag&gt; &quot;q&quot;"/);
  assert.match(out, /xmlUrl="https:\/\/a\.com\/f\?x=1&amp;y=2"/);
  // 转义做对了，XML 才是可解析的
  assert.equal(parseOpml(out).length, 1);
});

test('往返：导出再导入，URL / 标题 / 分组三者都不变', () => {
  const src = [
    { title: '少数派', url: 'https://sspai.com/feed', siteUrl: 'https://sspai.com', groupName: '科技' },
    { title: 'IT之家', url: 'https://www.ithome.com/rss/', siteUrl: null, groupName: '科技' },
    { title: '独立博客', url: 'https://blog.example.com/atom.xml', siteUrl: null, groupName: '' },
  ];
  const back = parseOpml(buildOpml(src));
  assert.equal(back.length, 3);
  for (const s of src) {
    const b = back.find((f) => f.url === s.url);
    assert.ok(b, `往返后丢了 ${s.url}`);
    assert.equal(b.title, s.title);
    assert.equal(b.group, s.groupName || null);
  }
});

test('导出按分组嵌套：同组的 outline 在同一个父节点下', () => {
  const out = buildOpml([
    { title: 'a', url: 'https://a.com/f', siteUrl: null, groupName: 'G1' },
    { title: 'b', url: 'https://b.com/f', siteUrl: null, groupName: 'G1' },
  ]);
  // 分组节点只出现一次
  assert.equal((out.match(/text="G1"/g) ?? []).length, 1);
  assert.match(out, /<opml version="2.0">/);
});
