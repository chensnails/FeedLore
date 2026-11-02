/**
 * 正文 HTML → 结构化块（bodyVersion 2）。
 *
 * 为什么自己遍历而不用现成的 HTML→Markdown 库：订阅源里的 HTML 质量参差不齐
 * （未闭合标签、内联样式、脚本、懒加载图片），我们只想要**语义**，过滤规则必须
 * 白名单化且可测试。输出直接对应 @feedlore/contract 的 ArticleBlock，前端用 React
 * 组件渲染，不经过 dangerouslySetInnerHTML —— XSS 面在入库时就关掉了。
 *
 * 解析器是纯函数：同样的 HTML + base 永远得到同样的块，便于单元测试与多用户复用。
 */

import { parseDocument } from 'htmlparser2';
import type { ArticleBlock, ArticleInline } from '@feedlore/contract';

/* ----------------------------------------------------------------------------
 * 1. 限制参数
 * --------------------------------------------------------------------------*/

/** 单篇正文最多保留的块数（超长页面只取前 300 块） */
const MAX_BLOCKS = 300;
/** 单篇正文最多保留的图片数（去重后） */
const MAX_IMAGES = 20;
/** 内联标签嵌套深度上限 */
const MAX_DEPTH = 20;
/** 列表 / 引用嵌套深度上限（防止病态 HTML 递归过深） */
const MAX_NEST = 6;
/** 序列化后的 JSON 上限（保证 JSON 合法，超了就丢尾部块而不是截字符串） */
const MAX_JSON = 64 * 1024;
/** 单个文本 / 代码块长度上限 */
const MAX_TEXT = 12_000;
const MAX_CODE = 24_000;
/** 表格上限：行 / 列（合并单元格不展开，按 1 格算） */
const MAX_TABLE_ROWS = 80;
const MAX_TABLE_COLS = 12;
/** 原始 HTML 上限：再长也只解析前 2MB（防止异常源把内存打满） */
const MAX_HTML = 2_000_000;

/* ----------------------------------------------------------------------------
 * 2. DOM 形状（不直接依赖 domhandler 类型，避免多一层包版本耦合）
 * --------------------------------------------------------------------------*/

interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

const isTag = (n: DomNode): boolean => n.type === 'tag' || n.type === 'script' || n.type === 'style';
const tagName = (n: DomNode): string => (n.name ?? '').toLowerCase();
/** 这些标签连文字都不要（脚本 / 表单控件 / 嵌入内容） */
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed',
  'svg', 'canvas', 'video', 'audio', 'source', 'track', 'map', 'area',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'label',
]);

/** 会切断行内流的块级标签（遇到就 flush 当前段落） */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'figure', 'figcaption', 'table', 'thead', 'tbody',
  'tfoot', 'tr', 'td', 'th', 'address', 'details', 'summary', 'fieldset',
  'legend', 'center', 'body', 'html',
]);

/** 只保留语义、可安全渲染的行内标签（判断在 inlineNodes 里按名字分支） */
const hasBlockChild = (n: DomNode, depth = 0): boolean => {
  if (depth > MAX_DEPTH) return false;
  if (!n.children) return false;
  for (const c of n.children) {
    if (!isTag(c)) continue;
    const name = tagName(c);
    if (name === 'img' || name === 'hr' || BLOCK_TAGS.has(name)) return true;
    if (hasBlockChild(c, depth + 1)) return true;
  }
  return false;
};

/* ----------------------------------------------------------------------------
 * 3. 文本 / URL 清洗
 * --------------------------------------------------------------------------*/

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

/** 行内空白压成一个空格；保留首尾单个空格（行内标签之间需要它） */
const collapse = (s: string): string => s.replace(/\u00a0/g, ' ').replace(/[ \t\r\n\f]+/g, ' ');

function appendText(out: ArticleInline[], raw: string): void {
  const s = collapse(raw);
  if (!s) return;
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.v = clip(last.v + s, MAX_TEXT);
  else out.push({ t: 'text', v: clip(s, MAX_TEXT) });
}

/** 去掉段首段尾空白 / 空文本 / 首尾 br，并合并相邻文本 */
function normalizeInline(list: ArticleInline[]): ArticleInline[] {
  const out: ArticleInline[] = [];
  for (const node of list) {
    if (node.t === 'text') {
      appendText(out, node.v);
      continue;
    }
    if (node.t === 'br') {
      if (!out.length) continue;
      if (out[out.length - 1]?.t === 'br') continue;
      out.push(node);
      continue;
    }
    if (node.t === 'a' || node.t === 'strong' || node.t === 'em' || node.t === 'del') {
      const kids = normalizeInline(node.v);
      if (!kids.length) continue;
      out.push({ ...node, v: kids });
      continue;
    }
    out.push(node);
  }
  while (out.length && out[out.length - 1]?.t === 'br') out.pop();
  const first = out[0];
  if (first?.t === 'text') first.v = first.v.replace(/^ +/, '');
  const last = out[out.length - 1];
  if (last?.t === 'text') last.v = last.v.replace(/ +$/, '');
  return out.filter((n) => !(n.t === 'text' && !n.v));
}

/** 节点纯文本（br → 换行；图片忽略） */
function textOf(node: DomNode, depth = 0): string {
  if (depth > MAX_DEPTH) return '';
  if (node.type === 'text') return node.data ?? '';
  if (node.type === 'cdata') {
    let s = '';
    for (const c of node.children ?? []) s += textOf(c, depth + 1);
    return s;
  }
  if (!isTag(node)) return '';
  const name = tagName(node);
  if (SKIP_TAGS.has(name)) return '';
  if (name === 'br') return '\n';
  if (name === 'img') return '';
  let s = '';
  for (const c of node.children ?? []) s += textOf(c, depth + 1);
  return s;
}

function intAttr(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(String(v).replace(/[^\d].*$/, ''), 10);
  return Number.isFinite(n) && n > 0 && n < 100_000 ? n : undefined;
}

function pickSrcset(srcset: string | undefined): string | null {
  if (!srcset) return null;
  let best: { url: string; score: number } | null = null;
  for (const part of srcset.split(',')) {
    const m = part.trim().match(/^(\S+)(?:\s+(\d+)w|\s+([\d.]+)x)?$/);
    if (!m?.[1]) continue;
    const score = m[2] ? Number(m[2]) : m[3] ? Number(m[3]) * 1000 : 1;
    if (!best || score >= best.score) best = { url: m[1], score };
  }
  return best?.url ?? null;
}

/* ----------------------------------------------------------------------------
 * 4. 解析器
 * --------------------------------------------------------------------------*/

export interface ArticleParseOptions {
  /** 相对 URL 的第一基准（条目落地页） */
  baseUrl?: string | null;
  /** 第二基准（频道站点地址），baseUrl 缺失时使用 */
  siteUrl?: string | null;
}

export interface ParsedArticle {
  blocks: ArticleBlock[];
  /** 正文图片绝对地址（按出现顺序去重） */
  images: string[];
  /** 序列化后的块 JSON；没有块时为 null（保证是合法 JSON） */
  bodyJson: string | null;
}

class Parser {
  private blocks: ArticleBlock[] = [];
  private total = 0;
  private readonly base: string | null;
  private readonly images: string[] = [];
  private readonly imgSeen = new Set<string>();
  private readonly opts: ArticleParseOptions;

  constructor(opts: ArticleParseOptions) {
    this.opts = opts;
    this.base = this.validBase(opts.baseUrl) ?? this.validBase(opts.siteUrl);
  }

  run(html: string): ParsedArticle {
    const src = String(html || '');
    const doc = parseDocument(
      src.length > MAX_HTML ? src.slice(0, MAX_HTML) : src,
      { decodeEntities: true },
    ) as unknown as DomNode;
    this.walk(doc.children ?? [], 0);
    const blocks = this.prune(this.blocks);
    return { blocks, images: this.images, bodyJson: serialize(blocks) };
  }

  private validBase(u: string | null | undefined): string | null {
    const v = typeof u === 'string' ? u.trim() : '';
    if (!v) return null;
    try {
      const x = new URL(v);
      return /^https?:$/.test(x.protocol) ? x.toString() : null;
    } catch {
      return null;
    }
  }

  /** 绝对化 URL；只放行 http(s)，邮件链接单独放行 */
  private abs(raw: string | undefined, allowMail = false): string | null {
    let s = typeof raw === 'string' ? raw.trim().replace(/[\u0000-\u001f\u007f]+/g, '') : '';
    if (!s) return null;
    s = s.replace(/^(https?):\1:\/\//i, '$1://');
    try {
      const x = s.startsWith('//')
        ? new URL('https:' + s)
        : new URL(s, this.base ?? undefined);
      if (/^https?:$/.test(x.protocol)) return x.toString();
      if (allowMail && x.protocol === 'mailto:') return x.toString();
      return null;
    } catch {
      return null;
    }
  }

  private push(block: ArticleBlock): void {
    if (this.total >= MAX_BLOCKS) return;
    this.total += 1;
    this.blocks.push(block);
  }

  /** 在独立数组里收集块（列表项 / 引用内部），块总数仍与正文共享上限 */
  private collect(nodes: DomNode[], depth: number): ArticleBlock[] {
    const saved = this.blocks;
    this.blocks = [];
    this.walk(nodes, depth);
    const out = this.blocks;
    this.blocks = saved;
    return this.prune(out);
  }

  private prune(blocks: ArticleBlock[]): ArticleBlock[] {
    const out: ArticleBlock[] = [];
    for (const b of blocks) {
      if (b.t === 'p') {
        const v = normalizeInline(b.v);
        if (v.length) out.push({ t: 'p', v });
      } else if (b.t === 'h') {
        const v = normalizeInline(b.v);
        if (v.length) out.push({ ...b, v });
      } else if (b.t === 'list') {
        const items = b.items.map((it) => this.prune(it)).filter((it) => it.length);
        if (items.length) out.push({ t: 'list', ordered: b.ordered, items });
      } else if (b.t === 'quote') {
        const inner = this.prune(b.blocks);
        if (inner.length) out.push({ t: 'quote', blocks: inner });
      } else if (b.t === 'pre') {
        if (b.code.trim()) out.push(b);
      } else if (b.t === 'table') {
        const head = b.head.map((cell) => normalizeInline(cell)).filter((cell) => cell.length);
        const rows = b.rows
          .map((row) => row.map((cell) => normalizeInline(cell)))
          .filter((row) => row.some((cell) => cell.length));
        if (head.length || rows.length) out.push({ t: 'table', head, rows });
      } else if (b.t === 'figure') {
        const caption = b.caption ? normalizeInline(b.caption) : [];
        out.push(caption.length ? { ...b, caption } : { t: 'figure', img: b.img });
      } else {
        out.push(b);
      }
    }
    return out;
  }

  private walk(nodes: DomNode[], depth: number): void {
    if (depth > MAX_NEST) return;
    let inline: ArticleInline[] = [];
    const flush = (): void => {
      const v = normalizeInline(inline);
      if (v.length) this.push({ t: 'p', v });
      inline = [];
    };

    for (const node of nodes) {
      if (this.total >= MAX_BLOCKS) return;

      if (node.type === 'text') {
        this.blockText(node.data ?? '', inline, flush);
        continue;
      }
      if (node.type === 'cdata') {
        for (const c of node.children ?? []) this.blockText(textOf(c), inline, flush);
        continue;
      }
      if (!isTag(node)) continue;

      const name = tagName(node);
      if (SKIP_TAGS.has(name)) continue;
      if (name === 'figcaption') continue; // 图注只在 <figure> 内收，散落的忽略

      if (name === 'br') {
        if (inline.length) inline.push({ t: 'br' });
        continue;
      }
      if (name === 'img') {
        flush();
        const img = this.imageBlock(node);
        if (img) this.push(img);
        continue;
      }
      if (name === 'table') {
        flush();
        this.pushTable(node);
        continue;
      }
      if (name === 'figure') {
        flush();
        this.pushFigure(node, depth);
        continue;
      }
      if (name === 'hr') {
        flush();
        this.push({ t: 'hr' });
        continue;
      }

      if (name === 'p') {
        flush();
        if (hasBlockChild(node)) this.walk(node.children ?? [], depth + 1);
        else {
          const v = normalizeInline(this.inlineNodes(node.children ?? [], depth + 1));
          if (v.length) this.push({ t: 'p', v });
        }
        continue;
      }

      if (/^h[1-6]$/.test(name)) {
        flush();
        if (hasBlockChild(node)) {
          this.walk(node.children ?? [], depth + 1);
        } else {
          const v = normalizeInline(this.inlineNodes(node.children ?? [], depth + 1));
          if (v.length) this.push({ t: 'h', level: name === 'h1' || name === 'h2' ? 2 : 3, v });
        }
        continue;
      }

      if (name === 'ul' || name === 'ol') {
        flush();
        this.pushList(name === 'ol', node, depth);
        continue;
      }

      if (name === 'blockquote') {
        flush();
        const inner = this.collect(node.children ?? [], depth + 1);
        if (inner.length) this.push({ t: 'quote', blocks: inner });
        continue;
      }

      if (name === 'pre') {
        flush();
        this.pushPre(node);
        continue;
      }

      if (BLOCK_TAGS.has(name)) {
        flush();
        this.walk(node.children ?? [], depth + 1);
        continue;
      }

      // 行内标签 / 未知标签出现在块级位置：正常并入当前段落；含块级内容时按块展开
      if (hasBlockChild(node)) {
        flush();
        this.walk(node.children ?? [], depth + 1);
      } else {
        inline.push(...this.inlineNodes([node], depth + 1));
      }
    }
    flush();
  }

  /**
   * 块级位置的文本节点：换行是**段落边界**（纯文本帖子的「名称：/描述：」结构靠它保住），
   * 同一行内的连续文本仍并入当前段落。
   */
  private blockText(raw: string, inline: ArticleInline[], flush: () => void): void {
    const s = String(raw ?? '').replace(/\r\n?/g, '\n');
    if (!s) return;
    if (!s.includes('\n')) {
      appendText(inline, s);
      return;
    }
    const lines = s.split('\n');
    const head = lines.shift() ?? '';
    if (head) appendText(inline, head);
    flush();
    for (const line of lines) {
      if (this.total >= MAX_BLOCKS) return;
      const t = collapse(line).trim();
      if (t) this.push({ t: 'p', v: [{ t: 'text', v: clip(t, MAX_TEXT) }] });
    }
  }

  private inlineNodes(nodes: DomNode[], depth: number): ArticleInline[] {
    if (depth > MAX_DEPTH) return [];
    const out: ArticleInline[] = [];

    for (const node of nodes) {
      if (node.type === 'text') {
        appendText(out, node.data ?? '');
        continue;
      }
      if (node.type === 'cdata') {
        for (const c of node.children ?? []) appendText(out, textOf(c));
        continue;
      }
      if (!isTag(node)) continue;

      const name = tagName(node);
      if (SKIP_TAGS.has(name) || name === 'img' || name === 'hr') continue;
      if (name === 'br') {
        out.push({ t: 'br' });
        continue;
      }

      const kids = (): ArticleInline[] => normalizeInline(this.inlineNodes(node.children ?? [], depth + 1));

      if (name === 'a') {
        const href = this.abs(node.attribs?.href, true);
        const v = kids();
        if (!v.length) continue;
        if (href) out.push({ t: 'a', href, v });
        else out.push(...v); // 非法协议只留文字，不生成可点链接
        continue;
      }
      if (name === 'strong' || name === 'b') {
        const v = kids();
        if (v.length) out.push({ t: 'strong', v });
        continue;
      }
      if (name === 'em' || name === 'i') {
        const v = kids();
        if (v.length) out.push({ t: 'em', v });
        continue;
      }
      if (name === 'del' || name === 's' || name === 'strike') {
        const v = kids();
        if (v.length) out.push({ t: 'del', v });
        continue;
      }
      if (name === 'code') {
        const t = clip(collapse(textOf(node)).trim(), MAX_TEXT);
        if (t) out.push({ t: 'code', v: t });
        continue;
      }
      // span / u / small / 未知标签：透明展开
      out.push(...this.inlineNodes(node.children ?? [], depth + 1));
    }
    return normalizeInline(out);
  }

  private pushList(ordered: boolean, node: DomNode, depth: number): void {
    if (depth > MAX_NEST) {
      this.walk(node.children ?? [], depth + 1);
      return;
    }
    const items: ArticleBlock[][] = [];
    for (const child of node.children ?? []) {
      if (!isTag(child) || tagName(child) !== 'li') continue;
      if (this.total >= MAX_BLOCKS) break;
      const blocks = this.collect(child.children ?? [], depth + 1);
      if (blocks.length) items.push(blocks);
    }
    if (items.length) this.push({ t: 'list', ordered, items });
  }

  private pushPre(node: DomNode): void {
    let code = textOf(node).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    code = code.replace(/^\n+/, '').replace(/\s+$/, '');
    if (!code) return;
    // 语言标记通常在 <pre><code class="language-ts"> 的内层 code 上
    const findCode = (n: DomNode, depth = 0): DomNode | null => {
      if (depth > 3) return null;
      for (const c of n.children ?? []) {
        if (!isTag(c)) continue;
        if (tagName(c) === 'code') return c;
        const hit = findCode(c, depth + 1);
        if (hit) return hit;
      }
      return null;
    };
    const inner = findCode(node) ?? node;
    const attrs = { ...(node.attribs ?? {}), ...(inner.attribs ?? {}) };
    // 内层的 class 与 data-lang 优先；都没有再看 pre 自己
    const cls = (inner.attribs?.class ?? '') || (node.attribs?.class ?? '');
    const lang = (
      cls.match(/(?:language|lang)-([\w+#.-]+)/i)?.[1]
      ?? attrs['data-lang']
      ?? cls.match(/brush:\s*(\w+)/i)?.[1]
      ?? ''
    ).slice(0, 30);
    this.push({ t: 'pre', code: clip(code, MAX_CODE), ...(lang ? { lang } : {}) });
  }

  /** 图片块（同时登记到 images）；重复图 / data: / 跟踪像素返回 null */
  private imageBlock(node: DomNode): ArticleBlock | null {
    if (this.images.length >= MAX_IMAGES) return null;
    const attrs = node.attribs ?? {};
    const raw = attrs.src || null;
    const lazy = attrs['data-src'] || attrs['data-original'] || attrs['data-lazy-src']
      || attrs['data-actualsrc'] || attrs['data-original-src'] || null;
    // 懒加载占位图通常是 data: 或 1px，优先用 data-* 的真图
    const candidate = (lazy && !/^data:/i.test(lazy) ? lazy : null)
      ?? (raw && !/^data:/i.test(raw) ? raw : null)
      ?? pickSrcset(attrs.srcset)
      ?? pickSrcset(attrs['data-srcset']);
    const src = this.abs(candidate ?? undefined);
    if (!src || !/^https?:/i.test(src)) return null;
    if (this.imgSeen.has(src)) return null;

    const w = intAttr(attrs.width);
    const h = intAttr(attrs.height);
    if (w !== undefined && h !== undefined && w <= 2 && h <= 2) return null; // 跟踪像素

    this.imgSeen.add(src);
    this.images.push(src);
    const alt = String(attrs.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return { t: 'img', src, ...(alt ? { alt } : {}), ...(w ? { w } : {}), ...(h ? { h } : {}) };
  }

  /** <figure>：第一张图 + figcaption；没有图就按普通容器展开（不丢正文） */
  private pushFigure(node: DomNode, depth: number): void {
    if (depth > MAX_NEST) {
      this.walk(node.children ?? [], depth + 1);
      return;
    }
    const found: { img: DomNode | null; caption: DomNode | null } = { img: null, caption: null };
    const scan = (n: DomNode, d = 0): void => {
      if (d > 4 || (found.img && found.caption)) return;
      for (const c of n.children ?? []) {
        if (!isTag(c)) continue;
        const name = tagName(c);
        if (name === 'img' && !found.img) found.img = c;
        if (name === 'figcaption' && !found.caption) found.caption = c;
        scan(c, d + 1);
      }
    };
    scan(node);

    const block = found.img ? this.imageBlock(found.img) : null;
    if (block && block.t === 'img') {
      const cap = found.caption
        ? normalizeInline(this.inlineNodes(found.caption.children ?? [], depth + 1))
        : [];
      const captionText = clip(cap.map((n) => (n.t === 'text' ? n.v : '')).join(' ').trim(), MAX_TEXT);
      this.push({
        t: 'figure',
        img: {
          src: block.src,
          ...(block.alt ? { alt: block.alt } : {}),
          ...(block.w ? { w: block.w } : {}),
          ...(block.h ? { h: block.h } : {}),
        },
        ...(captionText ? { caption: cap } : {}),
      });
      return;
    }
    // 没有可用图片：图注以外的内容照常展开
    this.walk((node.children ?? []).filter((c) => !isTag(c) || tagName(c) !== 'figcaption'), depth + 1);
  }

  /** <table>：thead 作表头，tbody/tfoot 作数据行；colspan/rowspan 不展开 */
  private pushTable(node: DomNode): void {
    const headRows: DomNode[] = [];
    const bodyRows: DomNode[] = [];

    const collectRows = (n: DomNode, inHead: boolean, d = 0): void => {
      if (d > 4) return;
      for (const c of n.children ?? []) {
        if (!isTag(c)) continue;
        const name = tagName(c);
        if (name === 'tr') {
          (inHead ? headRows : bodyRows).push(c);
          continue;
        }
        if (name === 'table') continue; // 嵌套表格不并入外层
        collectRows(c, inHead || name === 'thead', d + 1);
      }
    };
    collectRows(node, false);

    let head: ArticleInline[][] = [];
    let dataRows = bodyRows;
    const firstHead = headRows[0];
    if (firstHead) {
      head = this.cellRow(firstHead);
      dataRows = [...headRows.slice(1), ...bodyRows];
    } else if (bodyRows[0] && this.looksLikeHeader(bodyRows[0])) {
      head = this.cellRow(bodyRows[0]);
      dataRows = bodyRows.slice(1);
    }

    const rows: ArticleInline[][][] = [];
    for (const tr of dataRows.slice(0, MAX_TABLE_ROWS)) {
      const row = this.cellRow(tr);
      if (row.some((cell) => cell.length)) rows.push(row);
      if (rows.length >= MAX_TABLE_ROWS) break;
    }
    if (!head.length && !rows.length) return;
    this.push({ t: 'table', head, rows });
  }

  private looksLikeHeader(tr: DomNode): boolean {
    const cells = (tr.children ?? []).filter((c) => isTag(c) && /^(td|th)$/.test(tagName(c)));
    return cells.length > 0 && cells.every((c) => tagName(c) === 'th');
  }

  /** 一行：每个单元格是一组内联节点（colspan/rowspan 忽略，按 1 格算） */
  private cellRow(tr: DomNode): ArticleInline[][] {
    const out: ArticleInline[][] = [];
    for (const c of tr.children ?? []) {
      if (out.length >= MAX_TABLE_COLS) break;
      if (!isTag(c)) continue;
      const name = tagName(c);
      if (name !== 'td' && name !== 'th') continue;
      out.push(this.cellInline(c, 0));
    }
    return out;
  }

  /** 单元格内容：块级子元素之间用换行分隔（嵌套列表不会粘成一串） */
  private cellInline(node: DomNode, depth: number): ArticleInline[] {
    if (depth > MAX_DEPTH) return [];
    const out: ArticleInline[] = [];
    for (const c of node.children ?? []) {
      if (isTag(c) && (BLOCK_TAGS.has(tagName(c)) || tagName(c) === 'figure')) {
        const inner = this.cellInline(c, depth + 1);
        if (!inner.length) continue;
        if (out.length && out[out.length - 1]?.t !== 'br') out.push({ t: 'br' });
        out.push(...inner);
      } else {
        out.push(...this.inlineNodes([c], depth + 1));
      }
    }
    return normalizeInline(out);
  }
}

/** 序列化并保证 JSON 合法：超长时从尾部丢块，绝不截断字符串 */
function serialize(blocks: ArticleBlock[]): string | null {
  let arr = blocks;
  while (arr.length) {
    const json = JSON.stringify(arr);
    if (json.length <= MAX_JSON) return json;
    arr = arr.slice(0, -1);
  }
  return null;
}

/** 把 feed item 的正文 HTML 解析成结构化块。 */
export function parseArticleHtml(html: string, opts: ArticleParseOptions = {}): ParsedArticle {
  return new Parser(opts).run(html);
}
