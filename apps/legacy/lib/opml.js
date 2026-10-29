'use strict';

/**
 * 笺川 · OPML 解析（无依赖）
 *
 * 从订阅管理软件导出的 .opml 里抽出订阅源与分组路径。用正则而非 XML 解析器是刻意的：
 * 各家导出的 OPML 常常不合法（未转义的 &、缺闭合标签），宽松匹配反而更实用。
 * v2.2.0 起抽出到 lib/ 由 node:test 覆盖。
 */

/** 抽出一段标签属性串里的键值对（键统一小写） */
function parseOpmlAttrs(s) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) out[m[1].toLowerCase()] = m[2];
  return out;
}

/**
 * 解析 OPML 文本 → { feeds, groups }
 *  - feeds：{ url, title, group }，group 是嵌套文件夹用 ' / ' 连接，无分组则 null
 *  - outline 有 xmlUrl/url → 订阅源；只有 title/text → 文件夹（压栈记录路径）
 *  - 自闭合的空文件夹立即弹栈，不会污染后面的订阅
 */
function parseOpml(text) {
  const feeds = [];
  const groups = [];          // 当前嵌套分组栈（文件夹名）
  const tagRe = /<(\/?)(outline|opml|head|body)\b([^>]*?)(\/?)>/gi;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3] || '';
    const selfClose = m[4] === '/';
    if (closing) { if (name === 'outline') groups.pop(); continue; }
    if (name !== 'outline') continue;
    const a = parseOpmlAttrs(attrs);
    const xmlUrl = (a.xmlurl || a.url || '').trim();
    if (xmlUrl) {
      const title = (a.title || a.text || '').trim();
      feeds.push({ url: xmlUrl, title, group: groups.filter(Boolean).join(' / ') || null });
      if (!selfClose) groups.push(null);   // 占位，等它自己的 </outline> 弹出
    } else {
      const folder = (a.title || a.text || '').trim();
      if (folder) {
        groups.push(folder);
        if (selfClose) groups.pop();        // 空文件夹，立即弹回
      }
    }
  }
  return feeds;
}

module.exports = { parseOpml, parseOpmlAttrs };
