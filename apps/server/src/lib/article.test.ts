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
const text = (nodes: ArticleInline[]): string =>
  nodes
    .map((n) =>
      n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? '\n' : 'v' in n ? text(n.v) : '',
    )
    .join('');

test('标题：h1/h2 归为 2 级，h3-h6 归为 3 级', () => {
  const blocks = B('<h1>大标题</h1><h2>二</h2><h3>三</h3><h4>四</h4><h6>六</h6>');
  assert.deepEqual(
    blocks.map((b) => (b.t === 'h' ? b.level : b.t)),
    [2, 2, 3, 3, 3],
  );
});

test('段落与行内语义：链接 / 加粗 / 斜体 / 行内代码 / 删除线 / 换行都保留', () => {
  const [p] = B(
    '<p>看 <a href="https://x.com/a">这里</a> <strong>粗</strong> <em>斜</em> ' +
      '<code>a&lt;b</code> <del>删</del><br>下一行</p>',
  );
  assert.equal(p?.t, 'p');
  if (p?.t !== 'p') return;
  assert.equal(text(p.v), '看 这里 粗 斜 a<b 删\n下一行');
  const link = p.v.find((n) => n.t === 'a');
  assert.deepEqual(link, { t: 'a', href: 'https://x.com/a', v: [{ t: 'text', v: '这里' }] });
  assert.equal(p.v.filter((n) => n.t === 'strong').length, 1);
  assert.equal(p.v.filter((n) => n.t === 'em').length, 1);
  assert.deepEqual(
    p.v.find((n) => n.t === 'code'),
    { t: 'code', v: 'a<b' },
  );
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
    '<blockquote><p>引用一</p><p>引用二</p></blockquote>' +
      '<pre><code class="language-ts">if (a) {\n  b();\n}</code></pre>',
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
    '<p><a href="/next">下一</a> <a href="javascript:alert(1)">坏</a></p>' +
      '<img src="pic.png" alt="图" width="640" height="480">',
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
    '<img src="/placeholder.png" data-src="/real.jpg">' +
      '<img src="data:image/gif;base64,AAA" srcset="https://a.com/s-320.jpg 320w, https://a.com/s-800.jpg 800w">' +
      '<img src="https://a.com/px.gif" width="1" height="1">',
    { baseUrl: 'https://example.com/p/1' },
  );
  assert.deepEqual(blocks, [
    { t: 'img', src: 'https://example.com/real.jpg' },
    { t: 'img', src: 'https://a.com/s-800.jpg' },
  ]);
});

test('XSS：脚本 / 样式 / iframe / 事件属性都不会进入块', () => {
  const blocks = B(
    '<p>前<script>alert(1)</script>后</p>' +
      '<style>body{display:none}</style>' +
      '<iframe src="https://evil.example"><p>内嵌</p></iframe>' +
      '<img src="https://a.com/ok.jpg" onerror="alert(1)">' +
      '<p><a href="vbscript:msgbox(1)">点我</a><img src="javascript:alert(1)"></p>',
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

test('容器透明：div/section 展开，figure 收成图注块', () => {
  const blocks = B(
    '<div><section><p>一</p><figure><img src="https://a.com/1.jpg" alt="图">' +
      '<figcaption>图注 <a href="/more">来源</a></figcaption></figure><p>二</p></section></div>',
    { baseUrl: 'https://a.com/post/1' },
  );
  assert.deepEqual(
    blocks.map((b) => b.t),
    ['p', 'figure', 'p'],
  );
  const fig = blocks[1];
  assert.ok(fig?.t === 'figure');
  assert.equal(fig.img.src, 'https://a.com/1.jpg');
  assert.equal(fig.img.alt, '图');
  assert.equal(text(fig.caption ?? []), '图注 来源');
  const link = (fig.caption ?? []).find((n) => n.t === 'a');
  assert.equal(link?.t === 'a' ? link.href : null, 'https://a.com/more');
});

test('figure：没有图片时按普通容器展开，图注丢弃', () => {
  const blocks = B('<figure><figcaption>说明</figcaption><p>正文</p></figure>');
  assert.deepEqual(
    blocks.map((b) => b.t),
    ['p'],
  );
  assert.equal(text((blocks[0] as { t: 'p'; v: ArticleInline[] }).v), '正文');
});

test('表格：thead 作表头、tbody 作数据行，单元格保留链接与加粗', () => {
  const [table] = B(
    '<table><thead><tr><th>名称</th><th>说明</th></tr></thead>' +
      '<tbody><tr><td><a href="https://x.com">甲</a></td><td><strong>乙</strong></td></tr>' +
      '<tr><td>丙</td><td></td></tr></tbody></table>',
  );
  assert.equal(table?.t, 'table');
  if (table?.t !== 'table') return;
  assert.equal(table.head.length, 2);
  assert.equal(text(table.head[0] ?? []), '名称');
  assert.equal(table.rows.length, 2);
  const a = (table.rows[0]?.[0] ?? []).find((n) => n.t === 'a');
  assert.equal(a?.t === 'a' ? a.href : null, 'https://x.com/');
  assert.equal(text(table.rows[0]?.[1] ?? []), '乙');
});

test('表格：没有 thead 时，首行全是 th 才当表头', () => {
  const withHead = B(
    '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>',
  )[0];
  assert.ok(withHead?.t === 'table' && withHead.head.length === 2 && withHead.rows.length === 1);

  const noHead = B('<table><tr><td>1</td><td>2</td></tr></table>')[0];
  assert.ok(noHead?.t === 'table' && noHead.head.length === 0 && noHead.rows.length === 1);
});

test('表格：单元格里的块按换行摊平，colspan/rowspan 不展开', () => {
  const [table] = B(
    '<table><tr><td rowspan="2" colspan="2"><p>第一行</p><ul><li>项</li></ul></td>' +
      '<td>尾</td></tr></table>',
  );
  assert.ok(table?.t === 'table');
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0]?.length, 2); // colspan 不重复生成格子
  assert.equal(text(table.rows[0]?.[0] ?? []), '第一行\n项');
});

test('上限：图片与正文共享 600 块，40/120 张图都保留，超出后仍是合法 JSON', () => {
  // 阮一峰周刊一类文章单篇 30+ 图：旧实现把第 21 张起连块一起砍掉，正文后半段整段消失。
  const imgs = B(
    Array.from({ length: 40 }, (_, i) => `<img src="https://a.com/${i}.jpg">`).join(''),
  );
  assert.equal(imgs.filter((b) => b.t === 'img').length, 40);
  const parsed = parseArticleHtml(
    Array.from({ length: 36 }, (_, i) => `<img src="https://a.com/${i}.jpg">`).join(''),
  );
  assert.equal(parsed.images.length, 36);
  assert.equal(JSON.parse(parsed.bodyJson ?? '[]').length, 36);

  // 放宽后的常用区间：120 张图集不再被 60 张砍掉。
  const wide = parseArticleHtml(
    Array.from({ length: 120 }, (_, i) => `<img src="https://a.com/${i}.jpg">`).join(''),
  );
  assert.equal(wide.images.length, 120);
  assert.equal(JSON.parse(wide.bodyJson ?? '[]').length, 120);

  const tooMany = B(
    Array.from({ length: 800 }, (_, i) => `<img src="https://a.com/${i}.jpg">`).join(''),
  );
  assert.equal(tooMany.filter((b) => b.t === 'img').length, 600);

  const many = B(Array.from({ length: 400 }, (_, i) => `<p>段落 ${i}</p>`).join(''));
  assert.equal(many.length, 400);
  assert.equal(B(Array.from({ length: 800 }, (_, i) => `<p>段落 ${i}</p>`).join('')).length, 600);

  const long = Array.from({ length: 900 }, (_, i) => `<p>${'长'.repeat(300)}${i}</p>`).join('');
  const out = parseArticleHtml(long);
  assert.ok(out.bodyJson);
  assert.ok(out.bodyJson.length <= 256 * 1024);
  assert.doesNotThrow(() => JSON.parse(out.bodyJson ?? ''));
});

test('fallbackImages: 正文无图时用 media/enclosure 图补块，正文有图则不插手', () => {
  const out = parseArticleHtml('<p>图集说明</p>', {
    fallbackImages: [
      'https://cdn.example.com/1.jpg',
      'data:image/png;base64,AAA',
      '/relative-without-base.jpg',
    ],
  });
  assert.deepEqual(out.images, ['https://cdn.example.com/1.jpg']);
  const blocks = JSON.parse(out.bodyJson ?? '[]') as ArticleBlock[];
  assert.equal(blocks.filter((b) => b.t === 'img').length, 1);

  const withBody = parseArticleHtml('<img src="https://cdn.example.com/body.jpg">', {
    fallbackImages: ['https://cdn.example.com/1.jpg'],
  });
  assert.deepEqual(withBody.images, ['https://cdn.example.com/body.jpg']);
});

test('images 与 bodyJson 同步：JSON 上限丢掉的尾部图不留在 images', () => {
  const html = Array.from(
    { length: 800 },
    (_, i) => `<img src="https://a.com/${i}.jpg" alt="${'x'.repeat(300)}">`,
  ).join('');
  const out = parseArticleHtml(html);
  const blocks = JSON.parse(out.bodyJson ?? '[]') as Array<{ t: string; src?: string }>;
  const kept = blocks.filter((b) => b.t === 'img').map((b) => b.src ?? '');
  assert.ok(kept.length > 0 && kept.length < 800);
  assert.deepEqual(out.images, kept);
});

test('空正文 / 只有空白：没有块，bodyJson 为 null', () => {
  assert.deepEqual(parseArticleHtml(''), { blocks: [], images: [], bodyJson: null });
  assert.deepEqual(parseArticleHtml('<div>   </div>').blocks, []);
  assert.equal(parseArticleHtml('<p>&nbsp;</p>').bodyJson, null);
});

test('畸形 HTML 不抛错（未闭合标签 / 未转义 &）', () => {
  const blocks = B('<p>a & b<p>下一段<ul><li>项<img src="https://a.com/x.jpg"></ul>');
  assert.ok(blocks.length >= 2);
  const flat = (bs: ArticleBlock[]): ArticleBlock[] =>
    bs.flatMap((b) =>
      b.t === 'list' ? b.items.flatMap(flat) : b.t === 'quote' ? flat(b.blocks) : [b],
    );
  assert.ok(flat(blocks).some((b) => b.t === 'img'));
});
