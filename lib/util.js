'use strict';

const crypto = require('crypto');

/**
 * 笺川 · 后端纯函数工具集（无副作用、无状态、可直接单测）
 *
 * 从 server.js 抽出的纯逻辑：数值夹取、URL 归一化、版本比较、SSRF 主机判定。
 * 这些函数以前埋在 server.js 里无法测试（require 该文件会直接 listen + 连库），
 * v2.2.0 起抽出到 lib/ 由 node:test 覆盖。
 */

/* ---------------- 数值 ---------------- */

/** parseInt + 非有限回落 */
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

/** 宽松布尔：true / '1' / 'true' / 'yes' 为真；undefined / null / '' 回落默认值 */
const bool = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  return v === true || v === '1' || v === 'true' || v === 'yes';
};

/** 取整并夹到 [lo, hi]，防止手改库 / 表单塞进离谱值 */
const clampInt = (v, d, lo, hi) => Math.min(Math.max(int(v, d), lo), hi);

/** 取浮点并夹到 [lo, hi] */
const clampNum = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d;
};

/* ---------------- URL / 版本 ---------------- */

/** 把 url 归一化用于去重比较（忽略大小写与首尾空白） */
const normUrl = (u) => String(u || '').trim().toLowerCase();

/** 语义化版本比较：a 比 b 新返回 1，相同 0，旧 -1 */
function compareVersion(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/* ---------------- SSRF ---------------- */

/**
 * 判断主机是否指向内网 / 保留地址。
 * /api/img 图片代理用它挡住「让服务器去请求 169.254.169.254（云元数据）」这类 SSRF。
 * 覆盖：localhost 段、IPv6（除明确放行的 ::1 外一律拒绝）、IPv4 私有段与多播/保留段。
 */
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '0.0.0.0') return true;
  if (h === '[::1]' || h === '::1') return true;
  const m = h.match(/^\[?([0-9a-f:]+)\]?$/);
  if (m && /:/.test(m[1])) return true;                     // 其它 IPv6 一律拒绝
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
  }
  return false;
}

/* ---------------- 分组 ---------------- */

/** 从频道列表里抽出分组名（去重、未分组不列入、按中文排序） */
function groupsOf(feeds) {
  const set = new Set();
  for (const f of feeds || []) {
    const g = (f.groupName || '').trim();
    if (g) set.add(g);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
}

/* ---------------- 图片缓存 ---------------- */

/** 图片 URL 归一化（用于缓存 key）：去掉 fragment、去掉前端 onError 重试加的 ?r=、保留 query、小写主机 */
function canonicalImageUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    x.hash = '';
    x.searchParams.delete('r');   // 前端 LazyImg 重试时拼的 ?r=1，不应影响缓存键
    return x.toString();
  } catch (_) {
    return String(u || '').trim();
  }
}

/** 图片缓存键：归一化 URL 的 sha256 十六进制（与 image_cache.key 对齐） */
function imageCacheKey(u) {
  return crypto.createHash('sha256').update(canonicalImageUrl(u)).digest('hex');
}

/* ---------------- 抓取去重分组 ---------------- */

/**
 * 把频道列表按归一化 URL 分组：多用户订阅同一个频道 → 落进同一组，抓取时只抓一次。
 * 返回 Map<url, feed[]>。空/非法 url 跳过。
 */
function groupByUrl(feeds) {
  const map = new Map();
  for (const f of feeds || []) {
    const k = normUrl(f && f.url);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(f);
  }
  return map;
}

module.exports = { int, bool, clampInt, clampNum, normUrl, compareVersion, isPrivateHost, groupsOf, canonicalImageUrl, imageCacheKey, groupByUrl };
