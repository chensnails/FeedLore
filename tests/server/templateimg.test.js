'use strict';

/* 模板图识别的单测（不依赖数据库 / 网络）。
 *
 * 判据是「同一频道里 ≥3 条文章共用同一张图片」，图片本身一个字节都不读，
 * 只比 image_cache 建缓存时顺手写下的 (size, width, height)。
 * 所以这里最要紧的两条约定：
 *   1) URL → 缓存主键必须走 lib/util 的 imageCacheKey（归一化后才是主键）。
 *      实测线上数据：对原始 URL 直接 sha256 只能命中 62/109 张缓存，
 *      带 ?x-bce-process=image/format,f_auto 这类查询串的会全部漏掉 —— 漏了就是徽标照旧显示。
 *   2) 判据失败必须一路返回空结果，列表照常出来。
 */

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { imageCacheKey } = require('../../lib/util');
const { MIN_HITS, entryUrls, pickTemplates, dropForRows, _memo } = require('../../lib/templateImg');

const LOGO = 'https://cdn.t.com/logo-1.jpg';
const LOGO2 = 'https://cdn.t.com/logo-2.jpg';
const LOGO3 = 'https://cdn.t.com/logo-3.jpg';
const REAL = 'https://cdn.t.com/real.jpg';
/** 归一化后与原文不同的 URL（斜杠要被百分号编码）：用它守住第 1) 条约定 */
const NEEDS_ENC = 'https://img.x.com/a.jpg?x-bce-process=image/format,f_auto';
const PRINT = '3704:512x512';

/* 假库：cache = Map<主键, {size,width,height}>；feeds = Map<feedId, 条目行[]> */
function fakeDb({ cache = new Map(), feeds = new Map(), fail = null } = {}) {
  return {
    async imagePrints(keys) {
      if (fail === 'prints') throw new Error('boom');
      return (keys || []).filter((k) => cache.has(k)).map((k) => ({ key: k, ...cache.get(k) }));
    },
    async feedImageUrls(feedId, limit) {
      if (fail === 'scan') throw new Error('boom');
      const rows = (feeds.get(String(feedId)) || []).slice(0, limit);
      return rows.map((r) => ({ id: r.id, urls: [ ...(r.images || []), r.image || null ] }));
    },
  };
}

const logoCache = () => new Map([LOGO, LOGO2, LOGO3].map((u) => [imageCacheKey(u), { size: 3704, width: 512, height: 512 }]));
const realKey = () => new Map([[imageCacheKey(REAL), { size: 9999, width: 800, height: 600 }]]);

beforeEach(() => _memo.clear());

test('entryUrls：卡片图 / 图集 / 正文块里的图 URL 都算这条文章显示过的图', () => {
  const urls = entryUrls({
    image: LOGO,
    images: [LOGO, REAL, '', null],
    body_json: JSON.stringify([{ t: 'img', src: 'https://cdn.t.com/inline.jpg' }, { t: 'text', v: 'x' }]),
  });
  assert.deepEqual(urls, [LOGO, LOGO, REAL, 'https://cdn.t.com/inline.jpg']);
});

test('entryUrls：列表行没有 body_json 列也不报错，坏 JSON 静默跳过', () => {
  assert.deepEqual(entryUrls({ image: LOGO }), [LOGO]);
  assert.deepEqual(entryUrls({ body_json: 'not json' }), []);
  assert.deepEqual(entryUrls({ body_json: '{"t":"img"}' }), []);   // 非数组：不是图文块
});

test('pickTemplates：频道里 ≥MIN_HITS 条共用同一指纹 → 那些条目的这个 URL 进丢弃集合', () => {
  const rows = [
    { id: 1, feed_id: 7, image: LOGO, images: [LOGO] },
    { id: 2, feed_id: 7, image: LOGO2, images: [LOGO2] },
    { id: 3, feed_id: 7, image: LOGO3, images: [LOGO3] },
    { id: 4, feed_id: 7, image: REAL, images: [REAL] },
  ];
  const prints = new Map([[LOGO, PRINT], [LOGO2, PRINT], [LOGO3, PRINT], [REAL, '9999:800x600']]);
  const feedPrints = new Map([['7', new Set([PRINT])]]);
  const out = pickTemplates(rows, prints, feedPrints);
  assert.equal(out.size, 3);
  assert.deepEqual([...out.get('1')], [LOGO]);
  assert.ok(!out.has('4'), '只有这一条在用的真图不该被判成模板图');
});

test('pickTemplates：指纹相同的图在别的频道不是模板 —— 判据按频道隔离', () => {
  const rows = [{ id: 1, feed_id: 8, image: LOGO, images: [LOGO] }];
  const prints = new Map([[LOGO, PRINT]]);
  assert.equal(pickTemplates(rows, prints, new Map([['7', new Set([PRINT])]])).size, 0);
  assert.equal(pickTemplates(rows, prints, new Map([['8', new Set()]])).size, 0);
});

test('pickTemplates：正文块里的徽标同样能命中（列表行没有 body_json，单条读取才有）', () => {
  const row = { id: 1, feed_id: 7, image: REAL, body_json: JSON.stringify([{ t: 'img', src: LOGO }]) };
  const prints = new Map([[LOGO, PRINT], [REAL, '9999:800x600']]);
  const out = pickTemplates([row], prints, new Map([['7', new Set([PRINT])]]));
  assert.deepEqual([...out.get('1')], [LOGO]);
});

test('dropForRows：整频道同一张徽标 → 每条都给出丢弃集合', async () => {
  const db = fakeDb({
    cache: new Map([...logoCache(), ...realKey()]),
    feeds: new Map([['7', [
      { id: 1, image: LOGO, images: [LOGO] },
      { id: 2, image: LOGO2, images: [LOGO2] },
      { id: 3, image: LOGO3, images: [LOGO3] },
    ]]]),
  });
  const rows = [
    { id: 1, feed_id: 7, image: LOGO, images: [LOGO] },
    { id: 4, feed_id: 7, image: REAL, images: [REAL] },
  ];
  const out = await dropForRows(db, rows);
  assert.deepEqual([...out.keys()], ['1']);
  assert.deepEqual([...out.get('1')], [LOGO]);
});

test('dropForRows：URL 需要归一化才等于缓存主键时照样识别（SQL 侧直接 sha256 会漏）', async () => {
  const db = fakeDb({
    cache: new Map([[imageCacheKey(NEEDS_ENC), { size: 3704, width: 512, height: 512 }]]),
    feeds: new Map([['7', [1, 2, 3].map((i) => ({ id: i, image: NEEDS_ENC, images: [] }))]]),
  });
  const out = await dropForRows(db, [{ id: 9, feed_id: 7, image: NEEDS_ENC, images: [] }]);
  assert.deepEqual([...out.get('9')], [NEEDS_ENC]);
});

test('dropForRows：共用条数不到 MIN_HITS 不过滤（同一频道只有两张同图 → 是真图）', async () => {
  const db = fakeDb({
    cache: logoCache(),
    feeds: new Map([['7', [{ id: 1, image: LOGO }, { id: 2, image: LOGO2 }]]]),
  });
  assert.equal((await dropForRows(db, [{ id: 1, feed_id: 7, image: LOGO }])).size, 0);
});

test('dropForRows：同一条文章里同一张图出现两次只算一条（图集 + 卡片图重复）', async () => {
  const db = fakeDb({
    cache: logoCache(),
    feeds: new Map([['7', [{ id: 1, image: LOGO, images: [LOGO, LOGO] }, { id: 2, image: LOGO }, { id: 3, image: LOGO }]]]),
  });
  assert.ok((await dropForRows(db, [{ id: 1, feed_id: 7, image: LOGO }])).has('1'));
});

test('dropForRows：图片没被代理过（缓存里没有指纹）时照常显示 —— 判据是「有证据才隐藏」', async () => {
  const db = fakeDb({ cache: new Map(), feeds: new Map([['7', [{ id: 1, image: LOGO }, { id: 2, image: LOGO }]]]) });
  assert.equal((await dropForRows(db, [{ id: 1, feed_id: 7, image: LOGO }])).size, 0);
});

test('dropForRows：库查询失败返回空 Map，列表不受影响', async () => {
  const rows = [{ id: 1, feed_id: 7, image: LOGO }];
  assert.equal((await dropForRows(fakeDb({ fail: 'prints' }), rows)).size, 0);
  assert.equal((await dropForRows(fakeDb({ fail: 'scan' }), rows)).size, 0);
  assert.equal((await dropForRows(null, rows)).size, 0);
  assert.equal((await dropForRows(fakeDb({}), [])).size, 0);
});

test('dropForRows：频道判据 60 秒内复用，第二个请求不再扫库', async () => {
  let scans = 0;
  const db = fakeDb({
    cache: logoCache(),
    feeds: new Map([['7', [{ id: 1, image: LOGO }, { id: 2, image: LOGO2 }, { id: 3, image: LOGO3 }]]]),
  });
  const inner = db.feedImageUrls;
  db.feedImageUrls = (feedId, limit) => { scans++; return inner(feedId, limit); };
  const row = { id: 1, feed_id: 7, image: LOGO };
  assert.ok((await dropForRows(db, [row])).has('1'));
  assert.ok((await dropForRows(db, [row])).has('1'));
  assert.equal(scans, 1, '同一频道的判据应命中 memo');
});

test('dropForRows：MIN_HITS 是 3 —— 少于一张徽标反复出现三次就还不敢判', () => {
  assert.equal(MIN_HITS, 3);
});
