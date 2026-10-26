'use strict';

/**
 * 模板图识别（v1.3.7-test4）
 *
 * 症状：论坛 / Telegram 镜像类频道会在每一条转发内容上贴同一张站点徽标，它跟着 <img>
 * 进了正文，阅读页就被一张与文章无关的大 logo 占满整屏（卡片缩略图同样被污染）。
 *
 * 判据：同一频道最近 SCAN_ENTRIES 条里 ≥MIN_HITS 条共用「字节数 + 宽高」完全相同的图 → 判为模板图。
 * 指纹为什么不用 URL：这类徽标每条都是不同的签名地址（实测某频道 225 条里 34 个 URL 各不相同），
 * 按 URL 分组永远看不出重复；而 image_cache 建缓存时顺手写了 size/width/height，比三个数就够，
 * 一个图片字节都不必读。
 *
 * 只在读取端生效：库里的 body_json / images / image 一条都不改 —— 判据哪天觉得不对，
 * 退回代码即可，数据无损。代价是某张徽标被代理过之前它照常显示（那会儿还没有指纹可对）。
 */

const { imageCacheKey } = require('./util');

const MIN_HITS = 3;
const SCAN_ENTRIES = 200;   // 每个频道只看最近这么多条：模板图在近期内容里必然反复出现
const MEMO_MS = 60 * 1000;  // 一次列表请求要问两次库，同一频道的判据 60 秒内不必重算
const MEMO_MAX = 64;        // 键只有频道 id，个人实例就几十个；防长跑涨内存

const memo = new Map();

const print = (size, width, height) => `${size}:${width}x${height}`;

/** 条目上会显示某张图的所有位置：卡片图 image、图集 images、正文块 body_json 里的 img */
function entryUrls(row) {
  const out = [];
  if (typeof row.image === 'string' && row.image) out.push(row.image);
  for (const u of Array.isArray(row.images) ? row.images : []) {
    if (typeof u === 'string' && u) out.push(u);
  }
  if (row.body_json) {
    try {
      const blocks = JSON.parse(row.body_json);
      if (Array.isArray(blocks)) {
        for (const b of blocks) if (b && b.t === 'img' && typeof b.src === 'string' && b.src) out.push(b.src);
      }
    } catch { /* 正文块解析失败交给 toCard 原样透传，这里不额外判 */ }
  }
  return out;
}

/** URL → 指纹（Map<url, print>）：主键由 imageCacheKey 现算，与写缓存时严格同一口径 */
async function printsForUrls(db, urls) {
  const keyOf = new Map();
  for (const u of urls) {
    if (typeof u === 'string' && u && !keyOf.has(u)) keyOf.set(u, imageCacheKey(u));
  }
  if (!keyOf.size) return new Map();
  const rows = await db.imagePrints([...keyOf.values()]);
  const byKey = new Map(rows.map((r) => [r.key, print(r.size, r.width, r.height)]));
  const out = new Map();
  for (const [u, k] of keyOf) {
    const fp = byKey.get(k);
    if (fp) out.set(u, fp);
  }
  return out;
}

/** 某频道最近 SCAN_ENTRIES 条里，被 ≥MIN_HITS 条文章共用的指纹集合 */
async function scanFeed(db, feedId) {
  const rows = await db.feedImageUrls(feedId, SCAN_ENTRIES);
  const prints = await printsForUrls(db, rows.flatMap((r) => (Array.isArray(r.urls) ? r.urls : [])));
  const hits = new Map();   // 指纹 → 用过它的条目 id 集合（同一条里同一张图重复出现只算一次）
  for (const r of rows) {
    const seen = new Set();
    for (const fp of (Array.isArray(r.urls) ? r.urls : []).map((u) => prints.get(u))) {
      if (!fp || seen.has(fp)) continue;
      seen.add(fp);
      if (!hits.has(fp)) hits.set(fp, new Set());
      hits.get(fp).add(String(r.id));
    }
  }
  const out = new Set();
  for (const [fp, ids] of hits) if (ids.size >= MIN_HITS) out.add(fp);
  return out;
}

/** 带 memo 的频道判据：任何一步失败都当「没有模板图」，不报错也不隐藏 */
async function feedTemplates(db, feedId) {
  const key = String(feedId);
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.prints;
  try {
    const prints = await scanFeed(db, key);
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(key, { at: Date.now(), prints });
    return prints;
  } catch (_) {
    return new Set();
  }
}

/**
 * 纯判据（可直接单测）：把两组指纹折成「哪条条目的哪些 URL 该丢」。
 * @param rows         本批条目行（要 id / feed_id / image / images / 可选 body_json）
 * @param prints       Map<url, 指纹>，来自 db.imagePrints
 * @param feedPrints   Map<feedId, Set<指纹>>，该频道的模板指纹
 * @returns Map<entryId, Set<url>>
 */
function pickTemplates(rows, prints, feedPrints) {
  const out = new Map();
  for (const r of rows || []) {
    const group = feedPrints.get(String(r.feed_id));
    if (!group || !group.size) continue;
    let hit = null;
    for (const u of entryUrls(r)) {
      const fp = prints.get(u);
      if (fp && group.has(fp)) {
        if (!hit) hit = new Set();
        hit.add(u);
      }
    }
    if (hit) out.set(String(r.id), hit);
  }
  return out;
}

/**
 * 服务端入口：算出这批条目里该被隐藏的图片 URL。
 * 任何一步失败都返回空 Map —— 判据只是「少显示一张无关图」，不该把列表拖成报错。
 */
async function dropForRows(db, rows) {
  if (!db || !Array.isArray(rows) || !rows.length) return new Map();
  try {
    const prints = await printsForUrls(db, [...new Set(rows.flatMap(entryUrls))]);
    const feeds = [...new Set(rows.map((r) => String(r.feed_id)))];
    const groups = await Promise.all(feeds.map((f) => feedTemplates(db, f)));
    const feedPrints = new Map(feeds.map((f, i) => [f, groups[i]]));
    return pickTemplates(rows, prints, feedPrints);
  } catch (_) {
    return new Map();
  }
}

module.exports = { MIN_HITS, SCAN_ENTRIES, entryUrls, pickTemplates, dropForRows, _memo: memo, _printsForUrls: printsForUrls };
