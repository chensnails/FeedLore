import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArticleBlockSchema, ArticleInlineSchema, CardSchema } from './models';

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
});

test('bodyVersion 只接受 1 / 2', () => {
  const schema = CardSchema.shape.bodyVersion;
  assert.equal(schema.safeParse(1).success, true);
  assert.equal(schema.safeParse(2).success, true);
  assert.equal(schema.safeParse(3).success, false);
  assert.equal(schema.safeParse('2').success, false);
});
