'use strict';

/* 模板图识别的单测（不依赖数据库 / 网络）。
 *
 * 判据是「同一频道里 ≥3 条文章共用同一张图片」，但「是不是同一张」的判据在
 * v1.5.1-test1 起改为『图片字节的 sha256（content_hash）』，更早的版本用 size:宽x高
 * 当指纹会因为「两张不同的图恰好同尺寸 + 同字节数」而被误并、整批删掉（即 v1.5.0 之后
 * 出现的「条目图片消失」）。所以这里最要紧的两条约定：
 *   1) URL → 缓存主键必须走 lib/util 的 imageCacheKey（归一化后才是主键）。
 *      实测线上数据：对原始 URL 直接 sha256 只能命中 62/109 张缓存，
 *      带 ?x-bce-process=image/format,f_auto 这类查询串的会全部漏掉 —— 漏了就是徽标照旧显示。
 *   2) 判据失败必须一路返回空结果，列表照常出来。
 *   3) 指纹必须基于内容哈希（或存量图的 URL 主键），绝不能退回到 size:宽x高，
 *      否则不同图会被误并（见下方回归用例）。
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
/** 内容哈希（sha256 十六进制，64 位）。同一张图（哪怕 URL 不同）用同一个值，不同的图用不同值 */
const CH_LOGO = 'a1'.repeat(32);
const CH_REAL = 'b2'.repeat(32);
const CH_OTHER = 'c3'.repeat(32);
const CH_THIRD = 'd4'.repeat(32);

/* 假库：cache = Map<主键, {size,width,height,content_hash?}>；feeds = Map<feedId, 条目行[]> */
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

// 三个不同 URL 的徽标，但字节完全相同（内容哈希一致）—— 这才是「同一张模板图」的真判据
const logoCache = () => new Map([LOGO, LOGO2, LOGO3].map((u) => [imageCacheKey(u), { size: 3704, width: 512, height: 512, content_hash: CH_LOGO }]));
const realKey = () => new Map([[imageCacheKey(REAL), { size: 9999, width: 800, height: 600, content_hash: CH_REAL }]]);

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

test('pickTemplates：频道里 ≥MIN_HITS 条共用同一内容哈希 → 那些条目的这个 URL 进丢弃集合', () => {
  const rows = [
    { id: 1, feed_id: 7, image: LOGO, images: [LOGO] },
    { id: 2, feed_id: 7, image: LOGO2, images: [LOGO2] },
    { id: 3, feed_id: 7, image: LOGO3, images: [LOGO3] },
    { id: 4, feed_id: 7, image: REAL, images: [REAL] },
  ];
  const prints = new Map([[LOGO, CH_LOGO], [LOGO2, CH_LOGO], [LOGO3, CH_LOGO], [REAL, CH_REAL]]);
  const feedPrints = new Map([['7', new Set([CH_LOGO])]]);
  const out = pickTemplates(rows, prints, feedPrints);
  assert.equal(out.size, 3);
  assert.deepEqual([...out.get('1')], [LOGO]);
  assert.ok(!out.has('4'), '只有这一条在用的真图不该被判成模板图');
});

test('pickTemplates：指纹相同的图在别的频道不是模板 —— 判据按频道隔离', () => {
  const rows = [{ id: 1, feed_id: 8, image: LOGO, images: [LOGO] }];
  const prints = new Map([[LOGO, CH_LOGO]]);
  assert.equal(pickTemplates(rows, prints, new Map([['7', new Set([CH_LOGO])]])).size, 0);
  assert.equal(pickTemplates(rows, prints, new Map([['8', new Set()]])).size, 0);
});

test('pickTemplates：正文块里的徽标同样能命中（列表行没有 body_json，单条读取才有）', () => {
  const row = { id: 1, feed_id: 7, image: REAL, body_json: JSON.stringify([{ t: 'img', src: LOGO }]) };
  const prints = new Map([[LOGO, CH_LOGO], [REAL, CH_REAL]]);
  const out = pickTemplates([row], prints, new Map([['7', new Set([CH_LOGO])]]));
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
    cache: new Map([[imageCacheKey(NEEDS_ENC), { size: 3704, width: 512, height: 512, content_hash: CH_LOGO }]]),
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

/* ============ 回归：v1.5.0 的「条目图片消失」根因 ============ */

test('回归：尺寸 + 字节数相同但内容不同的图绝不会被误并（旧指纹 size:宽x高会整批删掉）', async () => {
  const db = fakeDb({
    cache: new Map([
      [imageCacheKey(LOGO), { size: 3704, width: 512, height: 512, content_hash: CH_LOGO }],
      [imageCacheKey(LOGO2), { size: 3704, width: 512, height: 512, content_hash: CH_OTHER }],
      [imageCacheKey(LOGO3), { size: 3704, width: 512, height: 512, content_hash: CH_THIRD }],
    ]),
    feeds: new Map([['7', [
      { id: 1, image: LOGO }, { id: 2, image: LOGO2 }, { id: 3, image: LOGO3 },
    ]]]),
  });
  const out = await dropForRows(db, [
    { id: 1, feed_id: 7, image: LOGO },
    { id: 2, feed_id: 7, image: LOGO2 },
    { id: 3, feed_id: 7, image: LOGO3 },
  ]);
  assert.equal(out.size, 0, '三张尺寸 / 字节数一致但内容不同的图绝不能被判成同一张');
});

test('回归：存量图没有 content_hash 时退回「URL 主键」指纹，不同 URL 绝不误并', async () => {
  const db = fakeDb({
    // 故意不写 content_hash，模拟升级前已缓存、尚未重新抓取的图
    cache: new Map([
      [imageCacheKey(LOGO), { size: 3704, width: 512, height: 512 }],
      [imageCacheKey(LOGO2), { size: 3704, width: 512, height: 512 }],
      [imageCacheKey(LOGO3), { size: 3704, width: 512, height: 512 }],
    ]),
    feeds: new Map([['7', [
      { id: 1, image: LOGO }, { id: 2, image: LOGO2 }, { id: 3, image: LOGO3 },
    ]]]),
  });
  const out = await dropForRows(db, [
    { id: 1, feed_id: 7, image: LOGO },
    { id: 2, feed_id: 7, image: LOGO2 },
    { id: 3, feed_id: 7, image: LOGO3 },
  ]);
  assert.equal(out.size, 0, '三个不同 URL 即使同尺寸也绝不能误删（存量图走 URL 主键指纹）');
});

test('回归：存量图同一个 URL 重复出现（即便没 content_hash）仍判为模板', async () => {
  const db = fakeDb({
    cache: new Map([[imageCacheKey(LOGO), { size: 3704, width: 512, height: 512 }]]),
    feeds: new Map([['7', [
      { id: 1, image: LOGO }, { id: 2, image: LOGO }, { id: 3, image: LOGO },
    ]]]),
  });
  const out = await dropForRows(db, [
    { id: 1, feed_id: 7, image: LOGO },
    { id: 4, feed_id: 7, image: REAL },
  ]);
  assert.ok(out.has('1'), '同一 URL 重复 3 次应判为模板图');
  assert.equal(out.size, 1);
});
