'use strict';

/**
 * RSS / Atom 模块
 * 自带一个够用的 XML 解析器（不用额外依赖），在其上做 RSS 2.0 / Atom / RSS 1.0(RDF) 三种格式的归一化，
 * 再把条目解析成前端要的卡片结构（链接 / 提取码 / 大小 / 标签 / 配图）。
 */

/* ============================================================
 * 1. XML 解析
 * ============================================================ */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', hellip: '\u2026', mdash: '\u2014',
  ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
};

/** 单遍解码实体，避免 &amp;lt; 被二次解码成 < */
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(
    /&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (m, body) => {
      if (body[0] === '#') {
        const cp = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
        try { return String.fromCodePoint(cp); } catch (_) { return m; }
      }
      const v = NAMED_ENTITIES[body.toLowerCase()];
      return v === undefined ? m : v;
    }
  );
}

function localName(name) {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) {
    attrs[localName(m[1])] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

/**
 * 极简 XML 解析器：返回 { name, attrs, children, text }
 * 支持注释、CDATA、处理指令、DOCTYPE、自闭合标签；不做命名空间校验与 DTD 展开。
 */
function parseXml(xml) {
  const src = String(xml || '').replace(/^\uFEFF/, '');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;

  const push = (node) => {
    stack[stack.length - 1].children.push(node);
    return node;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      stack[stack.length - 1].text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));

    // <!-- 注释 -->
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    // <![CDATA[ ... ]]>
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      stack[stack.length - 1].text += end < 0 ? src.slice(lt + 9) : src.slice(lt + 9, end);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    // <?xml ... ?> 处理指令
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    // <!DOCTYPE ...>（可能含 [ 内部子集 ]）
    if (src.startsWith('<!', lt)) {
      let j = lt + 2;
      let depth = 0;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '[') depth += 1;
        else if (ch === ']') depth -= 1;
        else if (ch === '>' && depth <= 0) break;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    // </close>
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end < 0 ? src.length : end).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    // <open ...> / <open ... />
    const end = src.indexOf('>', lt);
    if (end < 0) { i = src.length; break; }
    let inner = src.slice(lt + 1, end);
    const selfClose = /\/\s*$/.test(inner);
    if (selfClose) inner = inner.replace(/\/\s*$/, '');

    const sp = inner.search(/[\s/]/);
    const name = (sp < 0 ? inner : inner.slice(0, sp)).trim();
    const attrSrc = sp < 0 ? '' : inner.slice(sp);

    if (name) {
      const node = { name, attrs: parseAttrs(attrSrc), children: [], text: '' };
      push(node);
      if (!selfClose) stack.push(node);
    }
    i = end + 1;
  }
  return root;
}

/** 取直接子节点（按本地名匹配，忽略命名空间前缀） */
function child(node, name) {
  if (!node) return null;
  const target = name.toLowerCase();
  return node.children.find((c) => localName(c.name).toLowerCase() === target) || null;
}
function children(node, name) {
  if (!node) return [];
  const target = name.toLowerCase();
  return node.children.filter((c) => localName(c.name).toLowerCase() === target);
}
/** 节点文本（含 CDATA 与后代文本） */
function textOfNode(node) {
  if (!node) return '';
  let s = node.text || '';
  for (const c of node.children) s += textOfNode(c);
  return s;
}
const textOf = (node, name) => {
  const c = name ? child(node, name) : node;
  return c ? textOfNode(c).trim() : '';
};

/* ============================================================
 * 2. Feed 解析（RSS 2.0 / Atom / RSS 1.0）
 * ============================================================ */
function pickLink(node) {
  if (!node) return null;
  // Atom：<link rel="alternate" href="..."/>，无 rel 视为 alternate
  const links = children(node, 'link');
  if (!links.length) return null;
  const scored = links.map((l) => {
    const rel = (l.attrs.rel || 'alternate').toLowerCase();
    const href = l.attrs.href || textOfNode(l).trim();
    return { rel, href };
  }).filter((x) => x.href);
  const alt = scored.find((x) => x.rel === 'alternate') || scored.find((x) => x.rel === '');
  return (alt || scored[0] || {}).href || null;
}

function parseFeed(xml) {
  const root = parseXml(xml);
  // parseXml 的根是虚拟的 #root，真正的最外层元素是它的第一个子节点
  let top = root;
  if (localName(top.name) === '#root') top = root.children[0] || root;

  let feedNode = null;
  let itemNodes = [];
  const lname = localName(top.name).toLowerCase();

  if (lname === 'rss' || lname === 'rdf') {
    feedNode = child(top, 'channel') || top;
    itemNodes = children(feedNode, 'item');
    // RSS 1.0(RDF)：item 与 channel 平级
    if (!itemNodes.length) itemNodes = children(top, 'item');
  } else if (lname === 'feed') {
    feedNode = top;
    itemNodes = children(feedNode, 'entry');
  } else if (lname === 'channel') {
    feedNode = top;
    itemNodes = children(top, 'item');
  } else {
    // 兜底：把最外层的 item / entry 全收了
    feedNode = top;
    itemNodes = [...children(top, 'item'), ...children(top, 'entry')];
  }

  const imgNode = child(feedNode, 'image');
  const icon = textOf(feedNode, 'icon') || textOf(feedNode, 'logo')
    || (imgNode ? (imgNode.attrs.href || textOf(imgNode, 'url')) : '') || '';

  const items = itemNodes.map((it) => {
    const guid = textOf(it, 'guid') || textOf(it, 'id') || pickLink(it) || textOf(it, 'title');
    // RSS 的 content:encoded 比 description 完整，优先用
    const body = textOf(it, 'encoded') || textOf(it, 'content') || textOf(it, 'description')
      || textOf(it, 'summary');
    const enc = children(it, 'enclosure').find((e) => /^image\//i.test(e.attrs.type || '')
      || /\.(?:jpe?g|png|webp|gif)$/i.test(e.attrs.url || ''));
    const dateStr = textOf(it, 'pubDate') || textOf(it, 'published') || textOf(it, 'updated')
      || textOf(it, 'date');
    return {
      guid: String(guid || '').trim() || String(textOf(it, 'title')).slice(0, 120),
      title: textOf(it, 'title'),
      url: pickLink(it),
      content: body,
      enclosure: enc ? enc.attrs.url : null,
      dateStr,
    };
  }).filter((x) => x.guid || x.title);

  return {
    title: textOf(feedNode, 'title'),
    siteUrl: pickLink(feedNode) || textOf(feedNode, 'link'),
    description: textOf(feedNode, 'description') || textOf(feedNode, 'subtitle'),
    iconUrl: icon || null,
    items,
  };
}

/* ============================================================
 * 3. 条目归一化（沿用原先在 CommaFeed 版本里验证过的解析规则）
 * ============================================================ */
const FIELD_WORDS = ['名称', '描述', '链接', '百度', '夸克', '阿里', '迅雷', '大小', '标签',
  '直达链接', '主题', '分类', '发布者', '时间', '内容预览', '作者', '简介', '标题', '正文'];
const FIELD_LINE = new RegExp(
  '^[\\s\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\uFE0F]*(' +
  FIELD_WORDS.map((w) => w.split('').join('\\s*')).join('|') + ')\\s*[：:]', 'u'
);
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F]/gu;
const DETAIL_HINT = /\/(?:post-\d+|t\/\d+|topic\/|thread\/|article\/|archives\/|detail|p\/\d+|\d+\.html)/i;

const PAN_RE = /https?:\/\/(?:pan\.baidu\.com|(?:www\.)?aliyundrive\.com|(?:www\.)?alipan\.com|cloud\.189\.cn|(?:www\.)?115\.com|pan\.quark\.cn|(?:www\.)?quark\.cn|(?:www\.)?123pan\.com|(?:www\.)?123684\.com|mypikpak\.com|(?:www\.)?aliyundrive\.net)\/[^\s"'<>）)]*/i;

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ''));
}
function plainText(html) {
  return decodeEntities(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
}

/* 把正文 HTML 按「图文原始顺序」拆成有序块，供阅读页内联渲染：
   [{t:'p',text:'...'}, {t:'img',src:'...'}, ...]
   - 块级标签（p/div/br/li/h1-6/...）当作段落分隔，保留「名称：/描述：」逐行结构
   - <img> 落在它原本出现的位置（支持 src / data-src / data-original 懒加载写法）
   - 内联标签（a/b/i/span…）只保留其文字，格式化被压平，安全且无 XSS（前端再 escape）
   - 只收 http(s)，去重，最多 12 张；总块数上限 120，防止个别超长正文把库撑爆 */
function buildBlocks(html) {
  const blocks = [];
  const IMG_CAP = 12;
  const seenImg = new Set();
  const BLOCK_TAGS = new Set(['br', 'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'pre', 'tr', 'table', 'ul', 'ol', 'section', 'article', 'header', 'footer']);
  let buf = '';
  const flush = () => {
    const t = buf.replace(/\s+/g, ' ').trim();
    if (t) blocks.push({ t: 'p', text: t });
    buf = '';
  };
  const imgCount = () => { let n = 0; for (const b of blocks) if (b.t === 'img') n++; return n; };

  const re = /<[^>]*>|[^<]+/g;
  let m;
  while ((m = re.exec(String(html)))) {
    const tk = m[0];
    if (tk[0] === '<') {
      const tag = tk.match(/^<\s*\/?\s*([a-zA-Z0-9]+)/i);
      const name = tag ? tag[1].toLowerCase() : '';
      if (name === 'img') {
        const srcM = tk.match(/\bsrc\s*=\s*["']([^"']+)["']/i)
          || tk.match(/\bdata-src\s*=\s*["']([^"']+)["']/i)
          || tk.match(/\bdata-original\s*=\s*["']([^"']+)["']/i);
        if (srcM) {
          const u = decodeEntities(srcM[1].trim());
          if (/^https?:\/\//i.test(u) && imgCount() < IMG_CAP && !seenImg.has(u)) {
            seenImg.add(u);
            flush();
            blocks.push({ t: 'img', src: u });
          }
        }
      } else if (BLOCK_TAGS.has(name)) {
        flush(); // 块级边界：段落分隔（开/闭标签都算）
      }
      // 其它标签忽略，其内文作为后续文本 token 被捕获
    } else {
      const lines = tk.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        buf += lines[i];
        if (i < lines.length - 1) flush();
      }
    }
  }
  flush();
  return blocks.slice(0, 120);
}
function field(txt, label) {
  const pat = label.split('').join('\\s*');
  const m = txt.match(new RegExp(pat + '\\s*[：:]\\s*([^\\n]*)'));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}
function isNoiseLine(l) {
  const stripped = l.replace(/#[^\s#]+/g, '').replace(EMOJI_RE, '').replace(/[\s\-–—·|,，、]+/g, '');
  return stripped.length === 0;
}
function validUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    if (!/\./.test(x.hostname)) return false;
    if (/(?:^|\.)(t\.me|telegram\.me)$/i.test(x.hostname)) return false;
    return true;
  } catch (_) { return false; }
}
function cleanTitle(t) {
  return stripTags(t || '')
    .replace(/^[^\u4e00-\u9fa5A-Za-z0-9【\[(]+/, '')
    .replace(/^\s*(?:主\s*题|标\s*题|名\s*称|题\s*目)\s*[：:]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(String(s).trim());
  return Number.isFinite(t) ? new Date(t) : null;
}

/** 把原始 feed item 转成卡片条目 */
function normalizeItem(raw, feedTitle) {
  const content = String(raw.content || '');

  // 配图：正文里的「所有」<img> 都收进来（多图文章需要），其次 enclosure。
  // 去重 + 只留 http(s)，最多 12 张，避免追踪像素之类把库撑爆。
  const imgSet = new Set();
  for (const m of content.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const u = m[1].trim();
    if (/^https?:\/\//i.test(u)) imgSet.add(u);
  }
  if (raw.enclosure && /^https?:\/\//i.test(raw.enclosure)) imgSet.add(raw.enclosure);
  const images = [...imgSet].slice(0, 12);
  const image = images[0] || null; // 单图（卡片/缩略图）沿用第一张

  // 链接：网盘直链 > 正文详情页 > 条目自身 URL
  let link = null;
  const pan = content.match(PAN_RE);
  if (pan) link = pan[0];
  if (!link) {
    const hrefs = [...content.matchAll(/href=["']([^"']+)["']/gi)]
      .map((m) => decodeEntities(m[1])).filter(validUrl);
    link = hrefs.find((u) => DETAIL_HINT.test(u)) || hrefs[0] || null;
  }
  if (!link && validUrl(raw.url || '')) link = raw.url;

  // 文章内所有可复制的链接：主链接排第一，其余按出现顺序（href → 网盘直链 → 正文里的纯文本 URL）
  // 前端「复制」按钮用它做多选；去重、只留 http(s)、上限 20 条
  const links = (() => {
    const out = [];
    const seen = new Set();
    const add = (u) => {
      if (!u) return;
      let s = decodeEntities(String(u)).trim().replace(/[)\]}>"'）】。，；、]+$/, '');
      if (!/^https?:\/\//i.test(s)) return;
      let host = '';
      try { host = new URL(s).hostname.toLowerCase(); } catch (_) { /* 非法 URL 保留原样 */ }
      // Telegram 的媒体 CDN（帖子里的图片地址）不是可复制的资源链接，跳过
      if (/(^|\.)(telesco\.pe|cdn-telegram\.org)$/.test(host)) return;
      // Telegram 的「?q=#标签」是频道内搜索链接：同一个帖子会带出好几条，
      // 去掉查询串并合并，避免复制菜单里出现一堆长得一样的项
      if (/(^|\.)(t\.me|telegram\.me)$/.test(host)) {
        try { const x = new URL(s); x.search = ''; x.hash = ''; s = x.toString(); } catch (_) {}
      }
      if (seen.has(s)) return;
      seen.add(s);
      out.push(s);
    };
    add(link);
    for (const m of content.matchAll(/href=["']([^"']+)["']/gi)) add(m[1]);
    // PAN_RE 本体没有 g 标志（别处用 .match() 取首个），matchAll 必须传全局版
    for (const m of content.matchAll(new RegExp(PAN_RE.source, 'gi'))) add(m[0]);
    for (const m of content.matchAll(/https?:\/\/[^\s"'<>()（）【】[\]]+/g)) add(m[0]);
    return out.slice(0, 20);
  })();

  // 提取码 ?pwd=xxxx
  let pwd = null;
  if (link) {
    const pm = link.match(/[?&]pwd=([A-Za-z0-9]{1,10})/);
    if (pm) pwd = pm[1];
  }

  const txt = plainText(content);
  const title = field(txt, '名称') || cleanTitle(raw.title) || '(无标题)';

  // 正文：阅读页展开「全文」用。列表查询不取这一列，展开时才按 id 单独拉。
  // 保留原文的「名称：/描述：/夸克：/大小：/标签：」行结构 —— 那才是帖子的完整内容。
  const body = txt
    .replace(/[ \t\u00a0]+/g, ' ')      // 行内空白压成一个空格（原文里常有一串全角空格）
    .replace(/\n{3,}/g, '\n\n')         // 最多留一个空行
    .trim();

  let desc = field(txt, '描述');
  if (!desc) {
    desc = txt.split('\n').map((l) => l.trim()).filter(Boolean)
      .filter((l) => !FIELD_LINE.test(l) && !isNoiseLine(l))
      .join(' ').replace(/\s+/g, ' ').trim();
  }
  const size = field(txt, '大小').replace(/^[^\w\d.]*/, '');

  let tags = [];
  for (const m of content.matchAll(/>#([^<#]+)</g)) {
    const t = m[1].trim();
    if (t) tags.push(t);
  }
  if (!tags.length) {
    const tm = txt.match(/标签\s*[：:]\s*([^\n]*)/);
    if (tm) tags = tm[1].split(/[\s,，]+/).map((s) => s.replace(/^#/, '').trim()).filter(Boolean);
  }
  tags = [...new Set(tags)].slice(0, 8);

  return {
    guid: String(raw.guid || '').slice(0, 300),
    title: title.slice(0, 300),
    link: link ? link.slice(0, 1000) : null,
    pwd,
    description: desc ? desc.slice(0, 2000) : null,
    content: body ? body.slice(0, 8000) : null,
    // 图文顺序块：阅读页内联渲染用；无块（纯文本）时前端退回纯文本路径
    bodyJson: JSON.stringify(buildBlocks(content)).slice(0, 20000),
    size: size ? size.slice(0, 40) : null,
    tags,
    image: image ? image.slice(0, 1000) : null,
    images: images.map((u) => u.slice(0, 1000)),
    links: links.map((u) => u.slice(0, 1000)),
    sourceUrl: validUrl(raw.url || '') ? String(raw.url).slice(0, 1000) : null,
    publishedAt: parseDate(raw.dateStr) || new Date(),
    feedName: feedTitle || '',
  };
}

/* ============================================================
 * 4. 抓取
 * ============================================================ */
const UA = 'Mozilla/5.0 (compatible; FeedLore/2.8; +RSS reader)';
const FEED_TIMEOUT = Number(process.env.RSS_TIMEOUT_MS || 25000);
const MAX_BYTES = 12 * 1024 * 1024;
const { getDispatcher: getProxyDispatcher } = require('./proxy.js');

// 抓取重试：5xx / 网络 / 超时 都按指数退避重试；4xx（除 408/425/429）直接判为永久错误不重试。
// 这样 503/524/连接被重置/超时 之类的瞬时故障就不会直接判失败，而是过几秒再试。
const RETRY_MAX = 3;
const RETRY_BACKOFF_BASE_MS = 800;   // 第一次重试前等 0.8s
const RETRY_BACKOFF_FACTOR = 2.4;    // 0.8s → 1.9s → 4.6s

/** 错误是否值得重试 */
function isRetryableHttpStatus(status) {
  if (status >= 500) return true;        // 5xx 一律重试
  if (status === 408 || status === 425 || status === 429) return true;
  return false;                          // 4xx 其他都是客户端配置问题，重试也白搭
}
function isRetryableError(e) {
  if (!e) return false;
  // 显式标了 permanent=false 的都重试（包括 HTTP 5xx/408/425/429 与「响应体过大」）
  if (e.permanent === false) return true;
  if (e.permanent === true) return false;
  // 兜底：按消息文本识别
  const msg = String((e && e.message) || e);
  if (msg === '抓取超时' || msg === '响应体过大') return true;
  // 各种 Node 网络错（ECONNRESET / ECONNREFUSED / EAI_AGAIN / fetch failed 等）
  if (/ECONN|EAI_|fetch failed|socket hang up|network/i.test(msg)) return true;
  return false;
}

/** 指数退避 sleep */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function assertFeedUrl(u) {
  let x;
  try { x = new URL(String(u || '').trim()); } catch (_) { throw new Error('RSS 地址格式不正确'); }
  if (!/^https?:$/.test(x.protocol)) throw new Error('RSS 地址需以 http:// 或 https:// 开头');
  if (!/\./.test(x.hostname)) throw new Error('RSS 地址的主机名看起来不合法');
  return x.toString();
}

/**
 * 抓取 feed；带 ETag / Last-Modified 条件请求。
 * 返回 { notModified, body, etag, lastModified, finalUrl, status }
 *
 * 失败分类：
 *   - 网络/超时/HTTP 5xx/408/425/429 → 自动指数退避重试，最多 RETRY_MAX 次
 *   - HTTP 4xx（除 408/425/429）     → 立即判为永久错误（参数配错、重试也白搭）
 *   - 304 Not Modified                → 视为成功（内容未变）
 */
async function fetchFeed(url, { etag, lastModified, timeoutMs, proxyUrl } = {}) {
  const target = assertFeedUrl(url);
  const headers = { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : FEED_TIMEOUT;
  // 出网代理：proxyUrl 形如 http://user:pass@host:port 或 socks5://host:1080；空字符串走直连
  const dispatcher = getProxyDispatcher(proxyUrl);

  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), budget);
    try {
      const resp = await fetch(target, { headers, signal: ctl.signal, redirect: 'follow', dispatcher: dispatcher || undefined });
      if (resp.status === 304) {
        return { notModified: true, status: 304, finalUrl: target };
      }
      // 4xx 永久错误：抛出去，外层不重试
      if (!resp.ok) {
        const status = resp.status;
        const e = new Error('HTTP ' + status);
        e.status = status;
        e.permanent = !isRetryableHttpStatus(status);
        throw e;
      }

      const len = Number(resp.headers.get('content-length') || 0);
      if (len && len > MAX_BYTES) {
        const e = new Error('响应体过大');
        e.permanent = false;          // 服务器返回异常大小 → 也许是临时的
        throw e;
      }

      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_BYTES) {
        const e = new Error('响应体过大');
        e.permanent = false;
        throw e;
      }

      // 统一按 UTF-8 解码；声明了 charset 的按声明来
      const ct = resp.headers.get('content-type') || '';
      const cs = (ct.match(/charset=([\w-]+)/i) || [])[1];
      let body;
      if (cs && !/utf-?8/i.test(cs)) {
        try { body = new TextDecoder(cs).decode(buf); }
        catch (_) { body = buf.toString('utf8'); }
      } else {
        body = buf.toString('utf8');
      }

      return {
        notModified: false,
        status: resp.status,
        body,
        etag: resp.headers.get('etag') || null,
        lastModified: resp.headers.get('last-modified') || null,
        finalUrl: resp.url || target,
      };
    } catch (e) {
      lastErr = e;
      if (e && e.name === 'AbortError') {
        lastErr = new Error('抓取超时');
        lastErr.permanent = false;
      }
      // 永久错误 / 已达最大重试次数 → 抛出
      const permanent = !!(e && e.permanent);
      if (permanent || attempt >= RETRY_MAX) throw lastErr;
      if (!isRetryableError(lastErr)) throw lastErr;  // 不该重试的错也直接抛
      const backoff = Math.round(RETRY_BACKOFF_BASE_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1));
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }
  // 不会走到这里；保险起见抛最后一次的错误
  throw lastErr || new Error('抓取失败');
}

/** 一次抓取 + 解析 + 归一化 */
async function loadFeed(url, cond = {}) {
  const res = await fetchFeed(url, cond);
  if (res.notModified) return { notModified: true, items: [] };
  const feed = parseFeed(res.body);
  if (!feed.items.length && !feed.title) throw new Error('不是可识别的 RSS / Atom 内容');
  return {
    notModified: false,
    title: feed.title || null,
    siteUrl: feed.siteUrl || null,
    description: feed.description || null,
    iconUrl: feed.iconUrl || null,
    etag: res.etag,
    lastModified: res.lastModified,
    items: feed.items.map((it) => normalizeItem(it, feed.title)),
  };
}

module.exports = {
  parseXml, parseFeed, normalizeItem, loadFeed, fetchFeed, assertFeedUrl,
  decodeEntities, localName, child, children, textOfNode,
};
