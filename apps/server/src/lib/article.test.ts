import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArticleBlock, ArticleInline } from '@feedlore/contract';
import { parseArticleHtml } from './article';

/**
 * 正文结构化解析。
 *
 * 这里守的是阅读页排版的地基：标题 / 列表 / 引用 / 代码 / 链接 / 图片一旦形状漂了，
 * 前端 ArtBody 不会报错，只会把整篇渲染成一坨，或者更糟 —— 把源站脚本当链接放出去。
 * 所以除了结构，还专门测 XSS 与 URL 清洗。
 */

const B = (html: string, opts = {}): ArticleBlock[] => parseArticleHtml(html, opts).blocks;
const text = (nodes: ArticleInline[]): string => nodes.map((n) => (
  n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? '\n' : 'v' in n ? text(n.v) : ''
)).join('');

test('标题：h1/h2 归为 2 级，h3-h6 归为 3 级', () => {
  const blocks = B('<h1>大标题</h1><h2>二</h2><h3>三</h3><h4>四</h4><h6>六</h6>');
  assert.deepEqual(blocks.map((b) => (b.t === 'h' ? b.level : b.t)), [2, 2, 3, 3, 3]);
});

test('段落与行内语义：链接 / 加粗 / 斜体 / 行内代码 / 删除线 / 换行都保留', () => {
  const [p] = B(
    '<p>看 <a href="https://x.com/a">这里</a> <strong>粗</strong> <em>斜</em> '
      + '<code>a&lt;b</code> <del>删</del><br>下一行</p>',
  );
  assert.equal(p?.t, 'p');
  if (p?.t !== 'p') return;
  assert.equal(text(p.v), '看 这里 粗 斜 a<b 删\n下一行');
  const link = p.v.find((n) => n.t === 'a');
  assert.deepEqual(link, { t: 'a', href: 'https://x.com/a', v: [{ t: 'text', v: '这里' }] });
  assert.equal(p.v.filter((n) => n.t === 'strong').length, 1);
  assert.equal(p.v.filter((n) => n.t === 'em').length, 1);
  assert.deepEqual(p.v.find((n) => n.t === 'code'), { t: 'code', v: 'a<b' });
  assert.equal(p.v.filter((n) => n.t === 'del').length, 1);
});

test('列表：有序 / 无序，嵌套列表留在列表项里', () => {
  const [ul] = B('<ul><li>甲</li><li><p>乙</p><ul><li>丙</li></ul></li></ul>');
  assert.equal(ul?.t, 'list');
  if (ul?.t !== 'list') return;
  assert.equal(ul.ordered, false);
  assert.equal(ul.items.length, 2);
  assert.equal(ul.items[0]?.[0]?.t, 'p');
  const nested = ul.items[1]?.find((b) => b.t === 'list');
  assert.ok(nested && nested.t === 'list');
  assert.equal(nested.items.length, 1);

  const [ol] = B('<ol><li>一</li></ol>');
  assert.ok(ol?.t === 'list' && ol.ordered === true);
});

test('引用与代码块：嵌套块 / 语言标记 / 缩进原样保留', () => {
  const blocks = B(
    '<blockquote><p>引用一</p><p>引用二</p></blockquote>'
      + '<pre><code class="language-ts">if (a) {\n  b();\n}</code></pre>',
  );
  assert.equal(blocks[0]?.t, 'quote');
  if (blocks[0]?.t === 'quote') {
    assert.equal(blocks[0].blocks.length, 2);
    assert.equal(blocks[0].blocks[0]?.t, 'p');
  }
  assert.deepEqual(blocks[1], { t: 'pre', code: 'if (a) {\n  b();\n}', lang: 'ts' });
});

test('相对 URL：按条目落地页补全；非法协议只留文字', () => {
  const blocks = B(
    '<p><a href="/next">下一</a> <a href="javascript:alert(1)">坏</a></p>'
      + '<img src="pic.png" alt="图" width="640" height="480">',
    { baseUrl: 'https://example.com/posts/1' },
  );
  const p = blocks[0];
  assert.ok(p?.t === 'p');
  if (p?.t === 'p') {
    const links = p.v.filter((n) => n.t === 'a');
    assert.equal(links.length, 1);
    assert.equal(links[0]?.t === 'a' ? links[0].href : '', 'https://example.com/next');
    assert.ok(!JSON.stringify(p).includes('javascript:'));
  }
  assert.deepEqual(blocks[1], {
    t: 'img',
    src: 'https://example.com/posts/pic.png',
    alt: '图',
    w: 640,
    h: 480,
  });
});

test('图片：data-src 优先、srcset 取最大、tracking pixel 丢弃', () => {
  const blocks = B(
    '<img src="/placeholder.png" data-src="/real.jpg">'
      + '<img src="data:image/gif;base64,AAA" srcset="https://a.com/s-320.jpg 320w, https://a.com/s-800.jpg 800w">'
      + '<img src="https://a.com/px.gif" width="1" height="1">',
    { baseUrl: 'https://example.com/p/1' },
  );
  assert.deepEqual(blocks, [
    { t: 'img', src: 'https://example.com/real.jpg' },
    { t: 'img', src: 'https://a.com/s-800.jpg' },
  ]);
});

test('XSS：脚本 / 样式 / iframe / 事件属性都不会进入块', () => {
  const blocks = B(
    '<p>前<script>alert(1)</script>后</p>'
      + '<style>body{display:none}</style>'
      + '<iframe src="https://evil.example"><p>内嵌</p></iframe>'
      + '<img src="https://a.com/ok.jpg" onerror="alert(1)">'
      + '<p><a href="vbscript:msgbox(1)">点我</a><img src="javascript:alert(1)"></p>',
  );
  const json = JSON.stringify(blocks);
  for (const bad of ['script', 'iframe', 'onerror', 'javascript:', 'vbscript:', 'display:none']) {
    assert.ok(!json.includes(bad), `不应出现 ${bad}: ${json}`);
  }
  // 被剥掉标签后的文字仍然保留（不是整段吞掉）
  assert.ok(json.includes('前后'));
  assert.ok(json.includes('点我'));
  assert.deepEqual(
    blocks.filter((b) => b.t === 'img').map((b) => b.t === 'img' && b.src),
    ['https://a.com/ok.jpg'],
  );
});

test('纯文本：换行拆成独立段落，单行内空白折叠', () => {
  const blocks = B('名称：资源\n\n描述：   多个空格\n链接：https://pan.baidu.com/s/abc');
  assert.equal(blocks.length, 3);
  assert.ok(blocks.every((b) => b.t === 'p'));
  assert.equal(text((blocks[1] as { t: 'p'; v: ArticleInline[] }).v), '描述： 多个空格');
});

test('容器透明：div/section/figure 展开，figcaption 暂不收', () => {
  const blocks = B(
    '<div><section><p>一</p><figure><img src="https://a.com/1.jpg"><figcaption>图注</figcaption></figure>'
      + '<p>二</p></section></div>',
  );
  assert.deepEqual(blocks.map((b) => b.t), ['p', 'img', 'p']);
  assert.ok(!JSON.stringify(blocks).includes('图注'));
});

test('上限：图片最多 20 张，块最多 300，超出后仍是合法 JSON', () => {
  const imgs = B(Array.from({ length: 40 }, (_, i) => `<img src="https://a.com/${i}.jpg">`).join(''));
  assert.equal(imgs.filter((b) => b.t === 'img').length, 20);

  const many = B(Array.from({ length: 400 }, (_, i) => `<p>段落 ${i}</p>`).join(''));
  assert.equal(many.length, 300);

  const long = Array.from({ length: 300 }, (_, i) => `<p>${'长'.repeat(300)}${i}</p>`).join('');
  const out = parseArticleHtml(long);
  assert.ok(out.bodyJson);
  assert.ok(out.bodyJson.length <= 64 * 1024);
  assert.doesNotThrow(() => JSON.parse(out.bodyJson ?? ''));
});

test('空正文 / 只有空白：没有块，bodyJson 为 null', () => {
  assert.deepEqual(parseArticleHtml(''), { blocks: [], images: [], bodyJson: null });
  assert.deepEqual(parseArticleHtml('<div>   </div>').blocks, []);
  assert.equal(parseArticleHtml('<p>&nbsp;</p>').bodyJson, null);
});

test('畸形 HTML 不抛错（未闭合标签 / 未转义 &）', () => {
  const blocks = B('<p>a & b<p>下一段<ul><li>项<img src="https://a.com/x.jpg"></ul>');
  assert.ok(blocks.length >= 2);
  const flat = (bs: ArticleBlock[]): ArticleBlock[] => bs.flatMap((b) => (
    b.t === 'list' ? b.items.flatMap(flat) : b.t === 'quote' ? flat(b.blocks) : [b]
  ));
  assert.ok(flat(blocks).some((b) => b.t === 'img'));
});
