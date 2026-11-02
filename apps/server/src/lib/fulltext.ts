/**
 * 全文抓取（P2）：订阅只给摘要时，去原文页面抽正文。
 *
 * 分工：
 *  1. `extractArticleFromHtml` 是纯函数 —— Readability 找正文 + 我们的 `article.ts`
 *     转结构化块，可单测；
 *  2. `fetchArticleHtml` 只负责出网（复用 `safeFetch`，SSRF 校验 / 重定向逐跳校验原样继承）；
 *  3. `enhanceWithFullText` 管 `article_cache`：7 天内命中就不再回源，失败静默回退到
 *     订阅自带正文 —— 全文抓取是**增强**，任何一环坏掉都不能影响条目入库。
 *
 * 只在频道开了 `feeds.full_text` 时调用（见 fetcher.ts）。
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { inArray, sql } from 'drizzle-orm';
import { articleCache, type Db } from '@feedlore/db';
import { safeFetch } from './net';
import { parseArticleHtml } from './article';
import type { NormalizedItem } from './rss';

/* ----------------------------------------------------------------------------
 * 1. 限制参数
 * --------------------------------------------------------------------------*/

/** 原文页 HTML 上限（超过就放弃，Readability 解析超长页面很吃内存） */
const MAX_HTML_BYTES = 3 * 1024 * 1024;
/** 单篇原文页抓取超时 */
const FETCH_TIMEOUT_MS = 12_000;
/** 抽出少于这么多字视为「没找到正文」（登录墙 / 纯 JS 渲染 / 反爬页） */
const MIN_ARTICLE_CHARS = 120;
/** 订阅正文短于这么多字符才值得去抓全文 */
const THIN_CONTENT_CHARS = 1200;
/** 抽出正文至少要比现有长这么多、且长 30% 以上才替换 */
const MIN_GAIN_CHARS = 400;
/** article_cache 有效期 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 每轮每个频道最多发起多少次原文抓取（缓存命中不计；防止开全文后刷新卡太久） */
const MAX_NETWORK_FETCHES = 6;
/** 原文抓取并发 */
const FETCH_CONCURRENCY = 3;
/** entries.content 长度上限（与 rss.normalizeItem 保持一致） */
const ENTRY_TEXT_CHARS = 8000;
/** article_cache.content 上限（比 entries 宽一些，留给以后调整展示长度） */
const CACHE_TEXT_CHARS = 20_000;

const UA = 'Mozilla/5.0 (compatible; FeedLore/2.8; +RSS reader)';

/* ----------------------------------------------------------------------------
 * 2. HTML → 正文（纯函数）
 * --------------------------------------------------------------------------*/

export interface ExtractOptions {
  /** 原文落地页地址（相对链接的基准） */
  url?: string | null;
  /** 频道站点地址（落地页缺失时的兜底基准） */
  siteUrl?: string | null;
}

export interface ExtractedArticle {
  title: string | null;
  /** Readability 的纯文本正文 */
  text: string;
  /** 结构化块 JSON（与 `article.ts` 同一格式） */
  bodyJson: string | null;
  /** 正文图片绝对地址 */
  images: string[];
}

function validHttpUrl(raw: string | null | undefined): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 从原文页 HTML 抽正文。
 *
 * linkedom 先建文档再塞一个 `<base href>`：Readability 内部靠 `document.baseURI`
 * 补全相对链接，没有 base 时相册 / 站内链接会变成不可点的一串相对路径。
 */
export function extractArticleFromHtml(html: string, opts: ExtractOptions = {}): ExtractedArticle | null {
  const src = String(html ?? '');
  if (!src.trim()) return null;

  const base = validHttpUrl(opts.url) ?? validHttpUrl(opts.siteUrl);

  let doc: ReturnType<typeof parseHTML>;
  try {
    doc = parseHTML(src);
  } catch {
    return null;
  }
  const document = doc.document;
  if (!document) return null;

  if (base) {
    const head = document.head ?? document.querySelector('head');
    if (head) {
      const tag = document.createElement('base');
      tag.setAttribute('href', base);
      head.insertBefore(tag, head.firstChild);
    }
  }

  let article: ReturnType<Readability['parse']> = null;
  try {
    article = new Readability(document, { charThreshold: MIN_ARTICLE_CHARS }).parse();
  } catch {
    return null;
  }
  if (!article?.content) return null;

  const text = String(article.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length < MIN_ARTICLE_CHARS) return null;

  const parsed = parseArticleHtml(article.content, {
    baseUrl: opts.url ?? null,
    siteUrl: opts.siteUrl ?? null,
  });

  return {
    title: article.title?.trim() || null,
    text: text.slice(0, CACHE_TEXT_CHARS),
    bodyJson: parsed.bodyJson,
    images: parsed.images,
  };
}

/* ----------------------------------------------------------------------------
 * 3. 出网
 * --------------------------------------------------------------------------*/

/** 抓原文页 HTML；非 HTML / 超限 / 网络失败一律返回 null（调用方回退订阅正文）。 */
export async function fetchArticleHtml(
  url: string,
  { timeoutMs = FETCH_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<{ html: string; finalUrl: string } | null> {
  const target = validHttpUrl(url);
  if (!target) return null;

  const ctl = new AbortController();
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : FETCH_TIMEOUT_MS;
  const timer = setTimeout(() => ctl.abort(), budget);
  try {
    const resp = await safeFetch(target, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      },
      signal: ctl.signal,
    });

    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      return null;
    }
    const ct = resp.headers.get('content-type') ?? '';
    if (ct && !/text\/html|application\/xhtml\+xml/i.test(ct)) {
      await resp.body?.cancel().catch(() => {});
      return null;
    }
    const len = Number(resp.headers.get('content-length') ?? 0);
    if (len > MAX_HTML_BYTES) {
      await resp.body?.cancel().catch(() => {});
      return null;
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_HTML_BYTES) return null;

    const cs = /charset=([\w-]+)/i.exec(ct)?.[1];
    let html: string;
    if (cs && !/utf-?8/i.test(cs)) {
      try {
        html = new TextDecoder(cs).decode(buf);
      } catch {
        html = buf.toString('utf8');
      }
    } else {
      html = buf.toString('utf8');
    }
    return { html, finalUrl: resp.url || target };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 抓取 + 抽取；任一环节失败返回 null。 */
export async function fetchArticle(
  url: string,
  opts: ExtractOptions & { timeoutMs?: number } = {},
): Promise<ExtractedArticle | null> {
  const got = await fetchArticleHtml(url, { timeoutMs: opts.timeoutMs });
  if (!got) return null;
  return extractArticleFromHtml(got.html, { url: got.finalUrl || opts.url, siteUrl: opts.siteUrl });
}

/* ----------------------------------------------------------------------------
 * 4. 替换判定 / 应用
 * --------------------------------------------------------------------------*/

/** 订阅正文是否「只有摘要」（正文抓取候选） */
export function isThinContent(item: Pick<NormalizedItem, 'content'>): boolean {
  return String(item.content ?? '').trim().length < THIN_CONTENT_CHARS;
}

/**
 * 只有抽出的正文**明显更长**才替换：有些 RSS 本来就给全文，Readability 反而可能
 * 漏掉图片说明 / 附录；没有足够增益就保留订阅原文。
 */
export function shouldApplyFullText(current: string | null, extracted: string): boolean {
  const len = String(current ?? '').trim().length;
  const next = String(extracted ?? '').trim().length;
  if (next < MIN_ARTICLE_CHARS) return false;
  return next >= len + MIN_GAIN_CHARS && next >= len * 1.3;
}

/** 应用抽取结果（调用方保证 bodyJson 非空且增益足够）。 */
export function applyFullText(
  item: NormalizedItem,
  text: string,
  bodyJson: string,
  images: string[],
): NormalizedItem {
  const merged = [...new Set([...images, ...item.images].filter(Boolean))].slice(0, 12);
  return {
    ...item,
    content: text.slice(0, ENTRY_TEXT_CHARS),
    bodyJson,
    bodyVersion: 2,
    images: merged,
    image: merged[0] ?? item.image,
  };
}

/* ----------------------------------------------------------------------------
 * 5. 缓存 + 批量增强
 * --------------------------------------------------------------------------*/

/** 原文页地址：优先条目自身 URL，其次主链接（网盘资源的主链接可能不是文章页）。 */
function articleUrlOf(item: NormalizedItem): string | null {
  return validHttpUrl(item.sourceUrl) ?? validHttpUrl(item.link);
}

export interface FullTextOptions {
  siteUrl?: string | null;
  timeoutMs?: number;
  /** 单轮最多发起多少次原文抓取 */
  maxFetches?: number;
  /** 缓存有效期（毫秒） */
  ttlMs?: number;
}

/**
 * 给一个频道的条目补全文。就地返回新数组；缓存 / 出网失败都只影响「增强与否」，
 * 不会抛错（调用方不必再包一层 catch，但 DB 完全不可用时也能安全降级）。
 */
export async function enhanceWithFullText(
  db: Db,
  items: NormalizedItem[],
  opts: FullTextOptions = {},
): Promise<NormalizedItem[]> {
  const candidates = items
    .map((item, index) => ({ item, index, url: articleUrlOf(item) }))
    .filter((c): c is { item: NormalizedItem; index: number; url: string } =>
      Boolean(c.url) && isThinContent(c.item));
  if (!candidates.length) return items;

  const ttl = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : CACHE_TTL_MS;
  const now = Date.now();
  const out = items.slice();

  const cached = new Map<string, typeof articleCache.$inferSelect>();
  try {
    const urls = [...new Set(candidates.map((c) => c.url))];
    const rows = await db.select().from(articleCache).where(inArray(articleCache.url, urls));
    for (const row of rows) cached.set(row.url, row);
  } catch (e) {
    console.error('[fulltext] 读取缓存失败：', (e as Error)?.message ?? e);
  }

  const missing: Array<{ item: NormalizedItem; index: number; url: string }> = [];
  for (const c of candidates) {
    const hit = cached.get(c.url);
    const fresh = hit && now - hit.fetchedAt.getTime() <= ttl;
    if (hit && fresh && hit.bodyJson && shouldApplyFullText(c.item.content, hit.content ?? '')) {
      out[c.index] = applyFullText(c.item, hit.content ?? '', hit.bodyJson, hit.images ?? []);
      continue;
    }
    missing.push(c);
  }
  if (!missing.length) return out;

  const budget = Math.max(0, Math.min(opts.maxFetches ?? MAX_NETWORK_FETCHES, missing.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++;
      if (idx >= budget) return;
      const c = missing[idx];
      if (!c) return;

      const got = await fetchArticle(c.url, { url: c.url, siteUrl: opts.siteUrl, timeoutMs: opts.timeoutMs })
        .catch(() => null);
      if (!got) continue;

      await db
        .insert(articleCache)
        .values({
          url: c.url,
          content: got.text,
          bodyJson: got.bodyJson,
          images: got.images,
          fetchedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: articleCache.url,
          set: {
            content: got.text,
            bodyJson: got.bodyJson,
            images: got.images,
            fetchedAt: new Date(),
          },
        })
        .catch((e: unknown) => {
          console.error('[fulltext] 写缓存失败：', (e as Error)?.message ?? e);
        });

      if (got.bodyJson && shouldApplyFullText(c.item.content, got.text)) {
        out[c.index] = applyFullText(c.item, got.text, got.bodyJson, got.images);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, budget) }, worker));
  return out;
}

/** 清理过期原文缓存（默认 30 天；每轮刷新调用一次即可）。 */
export async function pruneArticleCache(db: Db, keepDays = 30): Promise<number> {
  const days = Math.max(1, Math.floor(Number(keepDays) || 30));
  const res = await db.execute(sql`
    delete from article_cache
     where fetched_at < now() - make_interval(days => ${days})
  `);
  return res.rowCount ?? 0;
}
