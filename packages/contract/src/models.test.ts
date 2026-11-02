import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArticleBlockSchema, ArticleInlineSchema, CardSchema, WatchRuleInputSchema } from './models';

/**
 * 正文块契约自检。
 *
 * 这组 schema 是服务端解析器与前端渲染器之间唯一的「形状合同」：
 * 递归结构写错（比如 list.items 少一层数组）时两端都能编译，只有真实数据过一遍才炸。
 */

const strong = { t: 'strong', v: [{ t: 'text', v: '粗' }] };
const link = { t: 'a', href: 'https://example.com/a', v: [strong, { t: 'br' }, { t: 'text', v: '链' }] };
const p = { t: 'p', v: [{ t: 'text', v: '正文' }, link, { t: 'code', v: 'x<y' }, { t: 'del', v: [{ t: 'text', v: '删' }] }] };

test('内联节点：语义标签可嵌套，解析后结构不变', () => {
  const parsed = ArticleInlineSchema.array().parse(p.v);
  assert.deepEqual(parsed, p.v);
});

test('块节点：标题 / 列表 / 引用 / 代码 / 图片 / 分隔线都能通过', () => {
  const blocks = [
    p,
    { t: 'h', level: 2, v: [{ t: 'text', v: '标题' }] },
    { t: 'list', ordered: true, items: [[p], [{ t: 'list', ordered: false, items: [[p]] }]] },
    { t: 'quote', blocks: [p, { t: 'hr' }] },
    { t: 'pre', code: 'const a = 1;', lang: 'ts' },
    { t: 'img', src: 'https://example.com/a.jpg', alt: '图', w: 640, h: 480 },
    {
      t: 'table',
      head: [[{ t: 'text', v: '名称' }], [{ t: 'text', v: '说明' }]],
      rows: [[[link], [{ t: 'text', v: '值' }]], [[{ t: 'text', v: '空' }]]],
    },
    {
      t: 'figure',
      img: { src: 'https://example.com/f.jpg', alt: '图注图', w: 800 },
      caption: [{ t: 'text', v: '图注' }, link],
    },
    { t: 'hr' },
  ];
  for (const b of blocks) {
    assert.deepEqual(ArticleBlockSchema.parse(b), b);
  }
});

test('块节点：非法层级 / 空图片地址 / 错误嵌套会被拒绝', () => {
  assert.equal(ArticleBlockSchema.safeParse({ t: 'h', level: 4, v: [] }).success, false);
  assert.equal(ArticleBlockSchema.safeParse({ t: 'img', src: 42 }).success, false);
  // items 必须是「块数组的数组」，写扁平数组是最常见的笔误
  assert.equal(
    ArticleBlockSchema.safeParse({ t: 'list', ordered: false, items: [p] }).success,
    false,
  );
  assert.equal(ArticleBlockSchema.safeParse({ t: 'unknown' }).success, false);
  // 表格的 head / rows 漏一层数组，前端 map 时就会拿到 undefined
  assert.equal(
    ArticleBlockSchema.safeParse({ t: 'table', head: [p], rows: [] }).success,
    false,
  );
  // figure 必须有图片；图注只能是内联节点
  assert.equal(ArticleBlockSchema.safeParse({ t: 'figure', caption: [] }).success, false);
  assert.equal(
    ArticleBlockSchema.safeParse({ t: 'figure', img: { src: 'https://e.com/a.jpg' }, caption: [p] }).success,
    false,
  );
});

test('bodyVersion 只接受 1 / 2', () => {
  const schema = CardSchema.shape.bodyVersion;
  assert.equal(schema.safeParse(1).success, true);
  assert.equal(schema.safeParse(2).success, true);
  assert.equal(schema.safeParse(3).success, false);
  assert.equal(schema.safeParse('2').success, false);
});

test('关注规则写入：keywords 兼容多行文本与数组', () => {
  const base = { id: 'w1', name: 'AI', act: 'watch', notify: false, on: true };
  assert.equal(WatchRuleInputSchema.safeParse({ ...base, keywords: 'OpenAI\nGPT-5' }).success, true);
  assert.equal(WatchRuleInputSchema.safeParse({ ...base, keywords: ['OpenAI', 'GPT-5'] }).success, true);
  assert.equal(WatchRuleInputSchema.safeParse({ ...base, keywords: 42 }).success, false);
});
