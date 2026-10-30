/**
 * RSS / Atom 解析与条目归一化（移植自 apps/legacy/rss.js，逻辑逐行对齐）
 *
 * 为什么自带解析器而不引第三方：
 *  1. 订阅源里大量「不合法 XML」（未转义的 &、缺闭合、BOM、CDATA 混排），宽容解析器
 *     比严格解析器活得久——legacy 这套跑了两年、46 个真实订阅验证过；
 *  2. 归一化规则（名称/描述/夸克/大小/标签 字段、网盘直链优先、Telegram 频道搜索链接去重）
 *     是本项目的领域逻辑，第三方包只做「通用 RSS → 通用对象」，这层照样要自己写。
 *
 * 本文件是**纯函数**：不碰数据库、不发请求（抓取在 lib/fetcher.ts）。
 * 纯函数才可能被单元测试覆盖，也才能在「同一 URL 多用户订阅」时安全复用同一份解析结果。
 */

/* ============================================================================
 * 1. XML 解析
 * ==========================================================================*/

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', hellip: '\u2026', mdash: '\u2014',
  ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
};

/** 单遍解码实体，避免 `&amp;lt;` 被二次解码成 `<` */
export function decodeEntities(s: string | null | undefined): string {
  return String(s ?? '').replace(
    /&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (m, body: string) => {
      if (body.startsWith('#')) {
        const cp = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
        try {
          return String.fromCodePoint(cp);
        } catch {
          return m;
        }
      }
      const v = NAMED_ENTITIES[body.toLowerCase()];
      return v === undefined ? m : v;
    },
  );
}

const localName = (name: string): string => {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
};

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    attrs[localName(m[1] ?? '')] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/**
 * 极简 XML 解析器：返回 `{ name, attrs, children, text }`。
 * 支持注释、CDATA、处理指令、DOCTYPE、自闭合标签；不做命名空间校验与 DTD 展开
 * （订阅源里的 DTD 一律无视——展开外部实体正是 XXE 的入口）。
 */
export function parseXml(xml: string): XmlNode {
  const src = String(xml || '').replace(/^\uFEFF/, '');
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;

  const top = (): XmlNode => stack[stack.length - 1] as XmlNode;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      top().text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));

    // <!-- 注释 -->
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    // <![CDATA[ ... ]]>
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top().text += end < 0 ? src.slice(lt + 9) : src.slice(lt + 9, end);
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
        if (stack[k]?.name === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    // <open ...> / <open ... />
    const end = src.indexOf('>', lt);
    if (end < 0) break;
    let inner = src.slice(lt + 1, end);
    const selfClose = /\/\s*$/.test(inner);
    if (selfClose) inner = inner.replace(/\/\s*$/, '');

    const sp = inner.search(/[\s/]/);
    const name = (sp < 0 ? inner : inner.slice(0, sp)).trim();
    const attrSrc = sp < 0 ? '' : inner.slice(sp);

    if (name) {
      const node: XmlNode = { name, attrs: parseAttrs(attrSrc), children: [], text: '' };
      top().children.push(node);
      if (!selfClose) stack.push(node);
    }
    i = end + 1;
  }
  return root;
}

/** 取直接子节点（按本地名匹配，忽略命名空间前缀） */
function child(node: XmlNode | null, name: string): XmlNode | null {
  if (!node) return null;
  const target = name.toLowerCase();
  return node.children.find((c) => localName(c.name).toLowerCase() === target) ?? null;
}

function children(node: XmlNode | null, name: string): XmlNode[] {
  if (!node) return [];
  const target = name.toLowerCase();
  return node.children.filter((c) => localName(c.name).toLowerCase() === target);
}

/** 节点文本（含 CDATA 与后代文本） */
function textOfNode(node: XmlNode | null): string {
  if (!node) return '';
  let s = node.text || '';
  for (const c of node.children) s += textOfNode(c);
  return s;
}

const textOf = (node: XmlNode | null, name?: string): string => {
  const c = name ? child(node, name) : node;
  return c ? textOfNode(c).trim() : '';
};

/* ============================================================================
 * 2. Feed 解析（RSS 2.0 / Atom / RSS 1.0）
 * ==========================================================================*/

function pickLink(node: XmlNode | null): string | null {
  if (!node) return null;
  // Atom：`<link rel="alternate" href="..."/>`，无 rel 视为 alternate
  const links = children(node, 'link');
  if (!links.length) return null;
  const scored = links
    .map((l) => ({
      rel: (l.attrs.rel || 'alternate').toLowerCase(),
      href: l.attrs.href || textOfNode(l).trim(),
    }))
    .filter((x) => x.href);
  const alt = scored.find((x) => x.rel === 'alternate') ?? scored.find((x) => x.rel === '');
  return (alt ?? scored[0])?.href ?? null;
}

export interface RawItem {
  guid: string;
  title: string;
  url: string | null;
  content: string;
  enclosure: string | null;
  dateStr: string;
}

export interface ParsedFeed {
  title: string;
  siteUrl: string | null;
  description: string;
  iconUrl: string | null;
  items: RawItem[];
}

export function parseFeed(xml: string): ParsedFeed {
  const root = parseXml(xml);
  // parseXml 的根是虚拟的 #root，真正的最外层元素是它的第一个子节点
  let top: XmlNode = root;
  if (localName(top.name) === '#root') top = root.children[0] ?? root;

  let feedNode: XmlNode;
  let itemNodes: XmlNode[] = [];
  const lname = localName(top.name).toLowerCase();

  if (lname === 'rss' || lname === 'rdf') {
    feedNode = child(top, 'channel') ?? top;
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
    || (imgNode ? imgNode.attrs.href || textOf(imgNode, 'url') : '') || '';

  const items: RawItem[] = itemNodes
    .map((it) => {
      const guid = textOf(it, 'guid') || textOf(it, 'id') || pickLink(it) || textOf(it, 'title');
      // RSS 的 content:encoded 比 description 完整，优先用
      const body = textOf(it, 'encoded') || textOf(it, 'content') || textOf(it, 'description')
        || textOf(it, 'summary');
      const enc = children(it, 'enclosure').find((e) => /^image\//i.test(e.attrs.type || '')
        || /\.(?:jpe?g|png|webp|gif)$/i.test(e.attrs.url || ''));
      const dateStr = textOf(it, 'pubDate') || textOf(it, 'published') || textOf(it, 'updated')
        || textOf(it, 'date');
      return {
        guid: String(guid || '').trim() || textOf(it, 'title').slice(0, 120),
        title: textOf(it, 'title'),
        url: pickLink(it),
        content: body,
        enclosure: enc?.attrs.url ?? null,
        dateStr,
      };
    })
    .filter((x) => x.guid || x.title);

  return {
    title: textOf(feedNode, 'title'),
    siteUrl: pickLink(feedNode) || textOf(feedNode, 'link'),
    description: textOf(feedNode, 'description') || textOf(feedNode, 'subtitle'),
    iconUrl: icon || null,
    items,
  };
}

/* ============================================================================
 * 3. 条目归一化（沿用原先在 CommaFeed 版本里验证过的解析规则）
 * ==========================================================================*/

const FIELD_WORDS = ['名称', '描述', '链接', '百度', '夸克', '阿里', '迅雷', '大小', '标签',
  '直达链接', '主题', '分类', '发布者', '时间', '内容预览', '作者', '简介', '标题', '正文'];
const FIELD_LINE = new RegExp(
  '^[\\s\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\uFE0F]*('
  + FIELD_WORDS.map((w) => w.split('').join('\\s*')).join('|')
  + ')\\s*[：:]',
  'u',
);
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\uFE0F]/gu;
const DETAIL_HINT = /\/(?:post-\d+|t\/\d+|topic\/|thread\/|article\/|archives\/|detail|p\/\d+|\d+\.html)/i;

const PAN_RE = /https?:\/\/(?:pan\.baidu\.com|(?:www\.)?aliyundrive\.com|(?:www\.)?alipan\.com|cloud\.189\.cn|(?:www\.)?115\.com|pan\.quark\.cn|(?:www\.)?quark\.cn|(?:www\.)?123pan\.com|(?:www\.)?123684\.com|mypikpak\.com|(?:www\.)?aliyundrive\.net)\/[^\s"'<>）)]*/i;

export function stripTags(html: string): string {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ''));
}

export function plainText(html: string): string {
  return decodeEntities(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
}

export type BodyBlock =
  | { t: 'p'; text: string }
  | { t: 'img'; src: string };

/**
 * 把正文 HTML 按「图文原始顺序」拆成有序块，供阅读页内联渲染。
 *  - 块级标签（p/div/br/li/h1-6…）当作段落分隔，保留「名称：/描述：」逐行结构
 *  - `<img>` 落在它原本出现的位置（支持 src / data-src / data-original 懒加载写法）
 *  - 内联标签（a/b/i/span…）只保留文字，格式化被压平，安全且无 XSS（前端再 escape）
 *  - 只收 http(s)，去重，最多 12 张；总块数上限 120，防个别超长正文把库撑爆
 */
export function buildBlocks(html: string): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  const IMG_CAP = 12;
  const seenImg = new Set<string>();
  const BLOCK_TAGS = new Set(['br', 'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'pre', 'tr', 'table', 'ul', 'ol', 'section', 'article', 'header', 'footer']);
  let buf = '';

  const imgCount = (): number => blocks.filter((b) => b.t === 'img').length;
  const flush = (): void => {
    const t = buf.replace(/\s+/g, ' ').trim();
    if (t) blocks.push({ t: 'p', text: t });
    buf = '';
  };

  const re = /<[^>]*>|[^<]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(html)))) {
    const tk = m[0];
    if (tk.startsWith('<')) {
      const tag = tk.match(/^<\s*\/?\s*([a-zA-Z0-9]+)/i);
      const name = tag ? (tag[1] ?? '').toLowerCase() : '';
      if (name === 'img') {
        const srcM = tk.match(/\bsrc\s*=\s*["']([^"']+)["']/i)
          ?? tk.match(/\bdata-src\s*=\s*["']([^"']+)["']/i)
          ?? tk.match(/\bdata-original\s*=\s*["']([^"']+)["']/i);
        const raw = srcM?.[1];
        if (raw) {
          const u = decodeEntities(raw.trim());
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
        buf += lines[i] ?? '';
        if (i < lines.length - 1) flush();
      }
    }
  }
  flush();
  return blocks.slice(0, 120);
}

function field(txt: string, label: string): string {
  const pat = label.split('').join('\\s*');
  const m = txt.match(new RegExp(pat + '\\s*[：:]\\s*([^\\n]*)'));
  return m?.[1] ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function isNoiseLine(l: string): boolean {
  const stripped = l.replace(/#[^\s#]+/g, '').replace(EMOJI_RE, '').replace(/[\s\-–—·|,，、]+/g, '');
  return stripped.length === 0;
}

function validUrl(u: string): boolean {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    if (!x.hostname.includes('.')) return false;
    if (/(?:^|\.)(t\.me|telegram\.me)$/i.test(x.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function cleanTitle(t: string): string {
  return stripTags(t || '')
    .replace(/^[^\u4e00-\u9fa5A-Za-z0-9【\[(]+/, '')
    .replace(/^\s*(?:主\s*题|标\s*题|名\s*称|题\s*目)\s*[：:]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const t = Date.parse(String(s).trim());
  return Number.isFinite(t) ? new Date(t) : null;
}

export interface NormalizedItem {
  guid: string;
  title: string;
  link: string | null;
  pwd: string | null;
  description: string | null;
  content: string | null;
  bodyJson: string | null;
  size: string | null;
  tags: string[];
  image: string | null;
  images: string[];
  links: string[];
  sourceUrl: string | null;
  publishedAt: Date;
}

/** 把原始 feed item 转成卡片条目（字段语义与 legacy 完全一致） */
export function normalizeItem(raw: RawItem, feedTitle: string): NormalizedItem {
  void feedTitle; // 保留签名对齐 legacy：条目不再冗余存频道名（靠 feed_id join）
  const content = String(raw.content || '');

  // 配图：正文里的「所有」<img> 都收进来（多图文章需要），其次 enclosure。
  // 去重 + 只留 http(s)，最多 12 张，避免追踪像素之类把库撑爆。
  const imgSet = new Set<string>();
  for (const m of content.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const u = (m[1] ?? '').trim();
    if (/^https?:\/\//i.test(u)) imgSet.add(u);
  }
  if (raw.enclosure && /^https?:\/\//i.test(raw.enclosure)) imgSet.add(raw.enclosure);
  const images = [...imgSet].slice(0, 12);
  const image = images[0] ?? null; // 单图（卡片/缩略图）沿用第一张

  // 链接：网盘直链 > 正文详情页 > **条目自身 URL** > 正文第一个外链
  //
  // 第三档是相对 legacy 的一处有意修正：legacy 的顺序是「详情页 > 第一个 href > 自身 URL」，
  // 结果 IT之家这类资讯源的文章链接会被正文里的京东/淘宝推广链抢走（实测卡片点开跳到电商）。
  // 自身 URL 只要合法就比「正文第一个外链」更可信；资源型频道（Telegram）的自身 URL 是
  // t.me，`validUrl` 直接判非法，仍会落回正文链接，行为不变。
  let link: string | null = null;
  const pan = content.match(PAN_RE);
  if (pan) link = pan[0];
  if (!link) {
    const hrefs = [...content.matchAll(/href=["']([^"']+)["']/gi)]
      .map((m) => decodeEntities(m[1] ?? ''))
      .filter(validUrl);
    link = hrefs.find((u) => DETAIL_HINT.test(u)) ?? null;
    if (!link && validUrl(raw.url ?? '')) link = raw.url;
    if (!link) link = hrefs[0] ?? null;
  }
  if (!link && validUrl(raw.url ?? '')) link = raw.url;

  // 文章内所有可复制的链接：主链接排第一，其余按出现顺序（href → 网盘直链 → 正文里的纯文本 URL）
  const links = ((): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (u: string | null | undefined): void => {
      if (!u) return;
      let s = decodeEntities(String(u)).trim().replace(/[)\]}>"'）】。，；、]+$/, '');
      if (!/^https?:\/\//i.test(s)) return;
      let host = '';
      try {
        host = new URL(s).hostname.toLowerCase();
      } catch {
        /* 非法 URL 保留原样 */
      }
      // Telegram 的媒体 CDN（帖子里的图片地址）不是可复制的资源链接，跳过
      if (/(^|\.)(telesco\.pe|cdn-telegram\.org)$/.test(host)) return;
      // Telegram 的「?q=#标签」是频道内搜索链接：同一个帖子会带出好几条，
      // 去掉查询串并合并，避免复制菜单里出现一堆长得一样的项
      if (/(^|\.)(t\.me|telegram\.me)$/.test(host)) {
        try {
          const x = new URL(s);
          x.search = '';
          x.hash = '';
          s = x.toString();
        } catch {
          /* 保留原样 */
        }
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
  let pwd: string | null = null;
  if (link) {
    const pm = link.match(/[?&]pwd=([A-Za-z0-9]{1,10})/);
    if (pm?.[1]) pwd = pm[1];
  }

  const txt = plainText(content);
  const title = field(txt, '名称') || cleanTitle(raw.title) || '(无标题)';

  // 正文：阅读页展开「全文」用。列表查询不取这一列，展开时才按 id 单独拉。
  // 保留原文的「名称：/描述：/夸克：/大小：/标签：」行结构 —— 那才是帖子的完整内容。
  const body = txt
    .replace(/[ \t\u00a0]+/g, ' ') // 行内空白压成一个空格（原文里常有一串全角空格）
    .replace(/\n{3,}/g, '\n\n') // 最多留一个空行
    .trim();

  let desc = field(txt, '描述');
  if (!desc) {
    desc = txt.split('\n').map((l) => l.trim()).filter(Boolean)
      .filter((l) => !FIELD_LINE.test(l) && !isNoiseLine(l))
      .join(' ').replace(/\s+/g, ' ').trim();
  }
  const size = field(txt, '大小').replace(/^[^\w\d.]*/, '');

  let tags: string[] = [];
  for (const m of content.matchAll(/>#([^<#]+)</g)) {
    const t = (m[1] ?? '').trim();
    if (t) tags.push(t);
  }
  if (!tags.length) {
    const tm = txt.match(/标签\s*[：:]\s*([^\n]*)/);
    if (tm?.[1]) {
      tags = tm[1].split(/[\s,，]+/).map((s) => s.replace(/^#/, '').trim()).filter(Boolean);
    }
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
    sourceUrl: validUrl(raw.url ?? '') ? String(raw.url).slice(0, 1000) : null,
    publishedAt: parseDate(raw.dateStr) ?? new Date(),
  };
}
