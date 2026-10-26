'use strict';

/**
 * 笺川 · 数据库行 → 前端 DTO
 *
 * 这里最要紧的一条约定：**所有外链图片都要改写成本站的 /api/img 代理**。
 * bodyJson 里的图片块存的是原始外链，浏览器直连会被防盗链拦 / 过期签名失效
 * （卡片缩略图的 image / images 都走了 /api/img 代理，这里保持一致）。
 * v2.2.0 起抽出到 lib/ 由 node:test 覆盖。
 */

/** 图片外链 → 本站代理地址 */
const proxied = (u) => '/api/img?u=' + encodeURIComponent(u);

/**
 * 频道图标特殊处理：
 * 1) data: 内嵌图标（如 RSSHub 给的 svg base64）本身就是完整资源，浏览器可直接渲染，
 *    不该走 /api/img 代理——代理用 new URL() 解析会把 data: 当成非法协议返回 400，
 *    导致频道图标整片加载不出来（v2.2.5 修复）。
 * 2) 个别源会把图标写成 https:https://... 这种重复协议头，归一化成正常 https://。
 */
function cleanIcon(raw) {
  if (!raw) return null;
  let u = String(raw).trim();
  if (/^data:/i.test(u)) return u;
  u = u.replace(/^(https?):\1:\/\//i, '$1://');
  return proxied(u);
}

/**
 * 重写 bodyJson 里的图片块 src；不是数组或解析失败时原样返回。
 * 返回值可能是 string（未改动时保持原样，避免无谓的反序列化开销）。
 * dropUrls 命中时整块丢掉（模板徽标，见 lib/templateImg.js）—— 判据只在读取端，库里不动。
 */
function proxyBodyJson(json, dropUrls) {
  if (!json) return null;
  try {
    const blocks = JSON.parse(json);
    if (!Array.isArray(blocks)) return json;
    let changed = false;
    const kept = [];
    for (const b of blocks) {
      if (b && b.t === 'img' && typeof b.src === 'string') {
        if (dropUrls && dropUrls.has(b.src)) { changed = true; continue; }
        if (/^https?:\/\//i.test(b.src)) { b.src = proxied(b.src); changed = true; }
      }
      kept.push(b);
    }
    if (!changed) return json;
    return JSON.stringify(kept);
  } catch { return json; }
}

/**
 * @param row 条目行
 * @param dropUrls 该条目要隐藏的图片 URL（Set，来自 lib/templateImg）；不传就是不过滤
 */
function toCard(row, dropUrls) {
  const dropped = (u) => !!(dropUrls && u && dropUrls.has(u));
  const images = (Array.isArray(row.images) ? row.images : []).filter((u) => !dropped(u));
  // 卡片图被判为模板图时退到图集里下一张真图，而不是整张卡片变无图
  const image = dropped(row.image) ? (images.find(Boolean) || null) : (row.image || null);
  return {
    id: String(row.id),
    name: row.title,
    desc: row.description || '',
    size: row.size || '',
    tags: row.tags || [],
    link: row.link || null,
    pwd: row.pwd || null,
    // 文章内所有可复制的链接（主链接优先）；复制按钮用它做多选，不做代理（复制的是原始地址）
    links: Array.isArray(row.links) ? row.links : [],
    image: image ? proxied(image) : null,
    // 多图文章：每张都走 /api/img 代理；没有就空数组（前端会退回单张 image）
    images: images.map(proxied),
    // 图文顺序块 JSON（阅读页内联渲染用）；图片块统一走 /api/img 代理；没有就 null
    bodyJson: proxyBodyJson(row.body_json, dropUrls),
    sourceUrl: row.source_url || null,
    date: row.published_at ? new Date(row.published_at).toISOString() : null,
    feedId: String(row.feed_id),
    feedName: row.feed_name || '',
    isRead: !!row.is_read,
    isFavorite: !!row.is_favorite,
    favoritedAt: row.favorited_at ? new Date(row.favorited_at).toISOString() : null,
  };
}

/**
 * 频道 DTO。refreshMinutes = 该频道单独设置的频率（null 表示跟随全局），
 * effectiveRefreshMinutes = 实际生效值；nextRefreshAt 由「上次抓取 + 生效间隔」推出。
 * globalRefreshMinutes 由调用方传入（原本直接读模块级 settings，抽出来后不再依赖）。
 */
function toFeedDto(f, globalRefreshMinutes) {
  const own = Number(f.refresh_minutes);
  const ownMins = Number.isFinite(own) && own > 0 ? own : null;
  const effMins = ownMins || (Number(globalRefreshMinutes) || 30);
  const lastMs = f.last_fetched_at ? new Date(f.last_fetched_at).getTime() : 0;
  return {
    id: String(f.id),
    url: f.url,
    title: f.title || f.url,
    customTitle: f.custom_title || null,
    siteUrl: f.site_url || null,
    description: f.description || '',
    icon: cleanIcon(f.icon_url),
    // enabled = 采集开关；cardEnabled = 卡片页展示开关（两个独立开关）
    enabled: !!f.enabled,
    cardEnabled: !!f.card_enabled,
    groupName: f.group_name || '',
    sortOrder: Number(f.sort_order || 0),
    entryCount: Number(f.entry_count || 0),
    unreadCount: Number(f.unread_count || 0),
    refreshMinutes: ownMins,
    effectiveRefreshMinutes: effMins,
    nextRefreshAt: lastMs ? new Date(lastMs + effMins * 60000).toISOString() : null,
    status: f.last_status || null,
    error: f.last_error || null,
    lastFetchedAt: f.last_fetched_at ? new Date(f.last_fetched_at).toISOString() : null,
    // 连续抓取失败次数（达到 settings.source.feedFailLimit 会被自动停用采集）
    failStreak: Number(f.fail_streak || 0),
  };
}

module.exports = { proxied, proxyBodyJson, toCard, toFeedDto };
