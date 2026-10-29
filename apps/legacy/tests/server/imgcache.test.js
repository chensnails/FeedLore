'use strict';

// 抓取去重分组 + 图片缓存键 + sharp 压缩的纯函数单测（不依赖数据库 / 网络）

const test = require('node:test');
const assert = require('node:assert');
const { groupByUrl, canonicalImageUrl, imageCacheKey } = require('../../lib/util');
const { compressImage } = require('../../lib/image');
const sharp = require('sharp');

test('groupByUrl 按归一化 URL 分组，忽略大小写与空白', () => {
  const feeds = [
    { id: 1, url: 'https://example.com/feed.xml' },
    { id: 2, url: 'HTTPS://example.com/feed.xml' },   // 同 URL 不同大小写 → 同组
    { id: 3, url: ' https://other.com/rss ' },         // 带空白
    { id: 4, url: 'https://example.com/feed.xml' },    // 同 URL 不同订阅者 → 同组
    { id: 5, url: '' },                                // 空 URL 跳过
  ];
  const g = groupByUrl(feeds);
  assert.equal(g.size, 2);                  // example + other
  assert.deepEqual(g.get('https://example.com/feed.xml').map((f) => f.id).sort(), [1, 2, 4]);
  assert.equal(g.get('https://other.com/rss').length, 1);
});

test('canonicalImageUrl 去掉 fragment 与前端重试参数 ?r=', () => {
  assert.equal(canonicalImageUrl('https://x.com/a.jpg#frag'), 'https://x.com/a.jpg');
  assert.equal(canonicalImageUrl('https://x.com/a.jpg?r=1'), 'https://x.com/a.jpg');
  assert.equal(canonicalImageUrl('https://x.com/a.jpg?w=2&r=1'), 'https://x.com/a.jpg?w=2');
  assert.equal(canonicalImageUrl('https://x.com/a.jpg?w=2'), 'https://x.com/a.jpg?w=2');
});

test('imageCacheKey 同样输入产出稳定 sha256', () => {
  const a = imageCacheKey('https://x.com/a.jpg');
  const b = imageCacheKey('https://x.com/a.jpg#frag');   // 归一化后相同
  const c = imageCacheKey('https://x.com/b.jpg');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('compressImage 把栅格图压成更小的 WebP', async () => {
  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 200, g: 60, b: 60 } } }).png().toBuffer();
  const out = await compressImage(png, 'image/png');
  assert.ok(out, '应返回压缩结果');
  assert.equal(out.contentType, 'image/webp');
  assert.ok(out.buf.length < png.length, `WebP(${out.buf.length}) 应小于 PNG(${png.length})`);
  assert.equal(out.width, 300);
  assert.equal(out.height, 300);
});

test('compressImage 超过最长边时缩到 1280 以内', async () => {
  const big = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer();
  const out = await compressImage(big, 'image/png');
  assert.ok(out);
  assert.ok(out.width <= 1280, `宽度应≤1280，实际 ${out.width}`);
});

test('compressImage 对非栅格类型 / 空输入返回 null', async () => {
  assert.equal(await compressImage(Buffer.from('hello'), 'image/svg+xml'), null);
  assert.equal(await compressImage(null, 'image/png'), null);
});

test('compressImage 尊重 opts 的 maxDim / quality（v2.4.0 设置可调）', async () => {
  const big = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 90, g: 150, b: 90 } } }).png().toBuffer();
  // maxDim=64 → 长边缩至 64 以内（withoutEnlargement，不放大）
  const out = await compressImage(big, 'image/png', { maxDim: 64 });
  assert.ok(out);
  assert.ok(Math.max(out.width, out.height) <= 64, `长边应≤64，实际 ${out.width}x${out.height}`);
  // 不传 opts → 回落模块默认 1280
  const def = await compressImage(big, 'image/png');
  assert.ok(Math.max(def.width, def.height) <= 1280);
  // 非法 opts（0 / 非数）同样回落默认，而不是把图压坏
  const bad = await compressImage(big, 'image/png', { maxDim: 0, quality: 'abc' });
  assert.ok(bad && Math.max(bad.width, bad.height) <= 1280);
  // 低质量应比高质量小：用随机噪声图（纯色 / 规律图案上量化表差异可能反超，噪声才对质量敏感）
  const w = 400, h = 400;
  const rnd = Buffer.alloc(w * h * 3);
  let s = 123456789 >>> 0;
  for (let i = 0; i < rnd.length; i++) {   // xorshift32：确定性真随机字节（位运算精确，无浮点误差）
    s ^= (s << 13) >>> 0;
    s ^= s >>> 17;
    s ^= (s << 5) >>> 0;
    s >>>= 0;
    rnd[i] = s & 255;
  }
  const noise = await sharp(rnd, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const q40 = await compressImage(noise, 'image/png', { quality: 40 });
  const q95 = await compressImage(noise, 'image/png', { quality: 95 });
  assert.ok(q40 && q95);
  assert.ok(q40.buf.length < q95.buf.length, `q40(${q40.buf.length}) 应小于 q95(${q95.buf.length})`);
});
