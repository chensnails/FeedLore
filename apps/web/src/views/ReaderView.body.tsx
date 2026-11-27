/* 文章正文渲染：从 ReaderView.tsx 抽出的正文分层纯函数与块级组件。
 * 文章页与卡片详情弹窗共用同一套正文渲染，DOM 结构、类名与文案与原实现完全一致。 */

import type { ArticleInline } from '@feedlore/contract';
import type { ReactNode, SyntheticEvent as ReactSyntheticEvent } from 'react';
import { useRef, useState } from 'react';
import type { Card, EntryDetail } from '../core/types.ts';
import { isImgFailed, markImgFailed } from '../imgFail.ts';
import { widthSrcSet, withRetryParam } from '../imgSrc.ts';
import { safeHref } from '../ui/EntryActions.tsx';

/** 正文块：v1 纯文本块与 v2 结构化块共用的形状（字段都可选，按 t 取用）。 */
export interface BodyBlock {
  t: string;
  v?: ArticleInline[];
  text?: string;
  src?: string;
  alt?: string;
  w?: number;
  h?: number;
  level?: 2 | 3;
  ordered?: boolean;
  items?: BodyBlock[][];
  blocks?: BodyBlock[];
  code?: string;
  lang?: string;
  head?: ArticleInline[][];
  rows?: ArticleInline[][][];
  img?: { src: string; alt?: string; w?: number; h?: number };
  caption?: ArticleInline[];
}

/* ---------- 正文分层纯函数（自 app.js 迁移，纯函数、不依赖 DOM） ---------- */
const LONG_LINE = 110;
const MIN_SEG = 36;
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
const BREAK_RE = /(?<=[。！？；!])/g;
const TITLE_LINE_RE = /^\s*(?:名\s*称|标\s*题|主\s*题|题\s*目)\s*[：:]\s*(.*)$/;

/** 源站点没分段时按句读切；不在 URL 内部断 */
function splitLongLine(line: string): string[] {
  if (line.length < LONG_LINE) return [line];
  const spans: [number, number][] = [];
  for (const m of line.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    spans.push([at, at + m[0].length]);
  }
  const inUrl = (i: number) => spans.some(([a, b]) => i >= a && i < b);
  const sentences: string[] = [];
  let last = 0;
  for (const m of line.matchAll(BREAK_RE)) {
    const at = m.index ?? 0;
    if (inUrl(at)) continue;
    sentences.push(line.slice(last, at));
    last = at;
  }
  sentences.push(line.slice(last));
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (!s.trim()) continue;
    buf += s;
    if (buf.trim().length >= MIN_SEG) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [line];
}

function bodyParagraphs(text: string): { cls: string; text: string }[] {
  const paras: { cls: string; text: string }[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    for (const seg of splitLongLine(raw)) {
      const s = seg.trim();
      if (!s) continue;
      const prose = /[。！？；!?;]$/.test(s) || /[。！？；!?;][”’")）]*$/.test(s);
      paras.push({ cls: prose ? 'is-prose' : '', text: s });
    }
  }
  return paras;
}

export function parseBlocks(json: string | null | undefined): BodyBlock[] | null {
  if (!json) return null;
  try {
    const a = JSON.parse(json) as unknown;
    return Array.isArray(a) && a.length ? (a as BodyBlock[]) : null;
  } catch (_) {
    return null;
  }
}

/* ---------- 结构化正文（bodyVersion 2）的纯函数 ---------- */
function inlineText(nodes: ArticleInline[] | null | undefined): string {
  if (!Array.isArray(nodes)) return '';
  let s = '';
  for (const n of nodes) {
    if (!n) continue;
    if (n.t === 'text' || n.t === 'code') s += n.v || '';
    else if (n.t === 'br') s += '\n';
    else if (Array.isArray(n.v)) s += inlineText(n.v);
  }
  return s;
}

function blockText(b: BodyBlock | null | undefined): string {
  if (!b) return '';
  if (b.t === 'p' || b.t === 'h') return inlineText(b.v);
  if (b.t === 'pre') return String(b.code || '');
  if (b.t === 'list') return (b.items || []).map((it) => it.map(blockText).join('\n')).join('\n');
  if (b.t === 'quote') return (b.blocks || []).map(blockText).join('\n');
  if (b.t === 'table')
    return [...(b.head || []), ...(b.rows || []).flat()].map(inlineText).join('\n');
  if (b.t === 'figure') return inlineText(b.caption || []);
  return '';
}

function blockHasText(b: BodyBlock): boolean {
  return blockText(b).trim().length > 0;
}

/** 正文块是不是 v2（结构化）格式。服务端总会带 bodyVersion；
 *  形状再兜一层，避免老缓存 / 手写 mock 少了字段时把 v2 块当 v1 渲染。 */
function isRichBody(e: EntryDetail | Card, blocks: BodyBlock[]): boolean {
  if (Number(e && e.bodyVersion) === 2) return true;
  return (
    !!blocks &&
    blocks.some(
      (b) =>
        b &&
        (b.t === 'h' ||
          b.t === 'list' ||
          b.t === 'quote' ||
          b.t === 'pre' ||
          b.t === 'table' ||
          b.t === 'figure' ||
          b.t === 'hr' ||
          Array.isArray(b.v)),
    )
  );
}

function isDuplicateTitleLine(txt: unknown, name: unknown): boolean {
  const m = String(txt).match(TITLE_LINE_RE);
  return !!(m && (m[1] || '').trim() === String(name || '').trim());
}

/** 正文第一行常是「名称：xxx」（与标题重复），去掉它 */
function readerBodyText(e: EntryDetail | Card): string {
  let t = ('content' in e ? e.content : '') || e.desc || '';
  if (!t) return '';
  const first = t.split('\n')[0] || '';
  const m = first.match(/^\s*(?:名\s*称|标\s*题|主\s*题|题\s*目)\s*[：:]\s*(.*)$/);
  if (m && (m[1] || '').trim() === String(e.name || '').trim())
    t = t.slice(first.length).replace(/^\n+/, '');
  return t.trim();
}

/** ArtBody 会不会自己渲染出文字 —— 卡片详情弹窗用它决定要不要另列一行摘要。 */
export function bodyShowsText(e: EntryDetail | null | undefined): boolean {
  if (!e) return false;
  const blocks = parseBlocks(e.bodyJson);
  if (blocks) {
    if (isRichBody(e, blocks)) return blocks.some(blockHasText);
    return blocks.some(
      (b, i) =>
        b &&
        b.t !== 'img' &&
        String(b.text || '').trim() &&
        !(i === 0 && isDuplicateTitleLine(b.text, e.name)),
    );
  }
  return !!readerBodyText(e);
}

const proxied = (u: unknown): string => {
  const s = String(u || '');
  if (/^https?:\/\//i.test(s)) return '/api/img?u=' + encodeURIComponent(s);
  // 服务端已改写成代理地址的、以及内嵌图片直接放行；其它协议（javascript: / file: …）一律丢掉
  if (s.startsWith('/api/img?') || /^data:image\//i.test(s)) return s;
  return '';
};

/** 正文图片：和卡片墙 LazyImg 一样先重试一次再移除；点开走全局灯箱。
 *  正文图此前首错即 markImgFailed + 移除，一次上游抖动就会让整篇图消失 10 分钟。 */
function ArtImg({
  src,
  alt,
  w,
  h,
}: {
  src?: string | null;
  alt?: string | null;
  w?: number;
  h?: number;
}) {
  const [failed, setFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const triedRef = useRef(false);
  const url = proxied(src);
  if (failed || !url || isImgFailed(url)) return null;
  // 重试去掉 srcset 并加 r=1：服务端缓存键会归一掉 r，但浏览器会当成新请求重新验证。
  const imgSrc = retrying ? withRetryParam(url) : url;
  return (
    <img
      className="art-img"
      src={imgSrc}
      srcSet={retrying ? undefined : widthSrcSet(url, [640, 960])}
      sizes="(max-width: 720px) 92vw, 720px"
      alt={alt || ''}
      width={w || undefined}
      height={h || undefined}
      loading="lazy"
      decoding="async"
      title="点击查看大图"
      onLoad={(ev: ReactSyntheticEvent<HTMLImageElement>) =>
        ev.currentTarget.classList.add('img-ready')
      }
      onError={(ev: ReactSyntheticEvent<HTMLImageElement>) => {
        if (ev.currentTarget.complete && ev.currentTarget.naturalWidth > 0) return;
        if (!triedRef.current) {
          triedRef.current = true;
          setRetrying(true);
          return;
        }
        markImgFailed(url);
        setFailed(true);
      }}
    />
  );
}

/** 内联节点：只输出文本与语义标签，不接收 HTML 字符串。 */
function Inline({ nodes }: { nodes?: ArticleInline[] }) {
  return (nodes || []).map((n, i) => {
    if (!n) return null;
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return (
          <code className="art-code" key={i}>
            {n.v}
          </code>
        );
      case 'br':
        return <br key={i} />;
      case 'a':
        return safeHref(n.href) ? (
          <a
            className="art-link"
            href={safeHref(n.href)}
            target="_blank"
            rel="noopener noreferrer"
            key={i}
          >
            <Inline nodes={n.v} />
          </a>
        ) : (
          <Inline nodes={n.v} key={i} />
        );
      case 'strong':
        return (
          <strong key={i}>
            <Inline nodes={n.v} />
          </strong>
        );
      case 'em':
        return (
          <em key={i}>
            <Inline nodes={n.v} />
          </em>
        );
      case 'del':
        return (
          <del key={i}>
            <Inline nodes={n.v} />
          </del>
        );
      default:
        return null;
    }
  });
}

/** 块级节点。列表 / 引用内部递归复用；连续图片合并成图集。 */
function RichBlocks({ blocks }: { blocks: BodyBlock[] }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b && b.t === 'img') {
      const grp: BodyBlock[] = [];
      while (i < blocks.length && blocks[i]?.t === 'img') {
        grp.push(blocks[i]!);
        i++;
      }
      i--;
      out.push(
        grp.length === 1 ? (
          <ArtImg src={grp[0]!.src} alt={grp[0]!.alt} w={grp[0]!.w} h={grp[0]!.h} key={'r' + i} />
        ) : (
          <div className="art-imgs" key={'r' + i}>
            {grp.map((im, k) => (
              <ArtImg src={im.src} alt={im.alt} w={im.w} h={im.h} key={k} />
            ))}
          </div>
        ),
      );
      continue;
    }
    if (!b) continue;
    switch (b.t) {
      case 'p':
        out.push(
          <p key={'r' + i}>
            <Inline nodes={b.v} />
          </p>,
        );
        break;
      case 'h':
        out.push(
          b.level === 3 ? (
            <h3 className="art-h3" key={'r' + i}>
              <Inline nodes={b.v} />
            </h3>
          ) : (
            <h2 className="art-h2" key={'r' + i}>
              <Inline nodes={b.v} />
            </h2>
          ),
        );
        break;
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul';
        out.push(
          <Tag className="art-list" key={'r' + i}>
            {(b.items || []).map((item, k) => (
              <li key={k}>
                <RichBlocks blocks={item} />
              </li>
            ))}
          </Tag>,
        );
        break;
      }
      case 'quote':
        out.push(
          <blockquote className="art-quote" key={'r' + i}>
            <RichBlocks blocks={b.blocks || []} />
          </blockquote>,
        );
        break;
      case 'pre':
        out.push(
          <pre className="art-pre" key={'r' + i}>
            <code data-lang={b.lang || undefined}>{b.code}</code>
          </pre>,
        );
        break;
      case 'table': {
        const head = b.head || [];
        const rows = b.rows || [];
        out.push(
          <div className="art-table-wrap" key={'r' + i}>
            <table className="art-table">
              {head.length ? (
                <thead>
                  <tr>
                    {head.map((cell, k) => (
                      <th key={k}>
                        <Inline nodes={cell} />
                      </th>
                    ))}
                  </tr>
                </thead>
              ) : null}
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci}>
                        <Inline nodes={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        break;
      }
      case 'figure':
        out.push(
          <figure className="art-figure" key={'r' + i}>
            <ArtImg
              src={b.img && b.img.src}
              alt={b.img && b.img.alt}
              w={b.img && b.img.w}
              h={b.img && b.img.h}
            />
            {b.caption && b.caption.length ? (
              <figcaption className="art-caption">
                <Inline nodes={b.caption} />
              </figcaption>
            ) : null}
          </figure>,
        );
        break;
      case 'hr':
        out.push(<hr className="art-hr" key={'r' + i} />);
        break;
      default:
        break;
    }
  }
  return out;
}

/** ArtBody 的正文部分（AI 条与动作行由 ReaderView 的 ArtBody 负责，保证守卫锚点留在原文件）。
 *  图文按原顺序内联；老数据回退为图集 + 段落；日期 / 手动标签 / AI 标签随后追加。 */
export function renderBodyContent(
  e: EntryDetail,
  blocks: BodyBlock[] | null,
  fmtFull: (d: string | number | null | undefined) => string,
  onTag?: (tag: string) => void,
  onAiTag?: (tag: string) => void,
  refreshSlot?: ReactNode,
): ReactNode[] {
  const parts: ReactNode[] = [];
  if (blocks) {
    if (isRichBody(e, blocks)) {
      parts.push(
        <div className="art-text art-rich" key="rich">
          <RichBlocks blocks={blocks} />
        </div>,
      );
    } else {
      let i = 0;
      while (i < blocks.length) {
        const b = blocks[i]!;
        if (b.t === 'img') {
          const grp: string[] = [];
          while (i < blocks.length && blocks[i]?.t === 'img') {
            grp.push(blocks[i]!.src || '');
            i++;
          }
          parts.push(
            grp.length === 1 ? (
              <ArtImg src={grp[0]} key={'b' + i} />
            ) : (
              <div className="art-imgs" key={'b' + i}>
                {grp.map((src, k) => (
                  <ArtImg src={src} key={k} />
                ))}
              </div>
            ),
          );
        } else {
          if (i === 0 && isDuplicateTitleLine(b.text, e.name)) {
            i++;
            continue;
          }
          parts.push(
            <div className="art-text" key={'b' + i}>
              {bodyParagraphs(b.text || '').map((p, k) => (
                <p className={p.cls || undefined} key={k}>
                  {p.text}
                </p>
              ))}
            </div>,
          );
          i++;
        }
      }
    }
    if (!parts.length)
      parts.push(
        <div className="art-text art-text-empty" key="empty">
          这条没有正文，点「打开」看原文
        </div>,
      );
  } else {
    const imgs: string[] =
      Array.isArray(e.images) && e.images.length ? e.images : e.image ? [e.image] : [];
    if (imgs.length) {
      parts.push(
        imgs.length === 1 ? (
          <ArtImg src={imgs[0]} key="img" />
        ) : (
          <div className="art-imgs" key="img">
            {imgs.map((src, k) => (
              <ArtImg src={src} key={k} />
            ))}
          </div>
        ),
      );
    }
    const text = readerBodyText(e);
    parts.push(
      text ? (
        <div className="art-text" key="text">
          {bodyParagraphs(text).map((p, k) => (
            <p className={p.cls || undefined} key={k}>
              {p.text}
            </p>
          ))}
        </div>
      ) : (
        <div className="art-text art-text-empty" key="text">
          这条没有正文，点「打开」看原文
        </div>
      ),
    );
  }

  if (e.date) {
    // 脏数据里的非法日期不能在这里抛 RangeError：错误边界是最后一道网，
    // 渲染期仍不抛（文章页 / 卡片详情共用这个 ArtBody，别让一处脏数据降级两块）。
    const d = new Date(e.date);
    const iso = Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
    parts.push(
      <p className="art-pub" key="pub">
        <span className="art-pub-label">发布时间</span>
        <time dateTime={iso}>{fmtFull(e.date)}</time>
        {refreshSlot}
      </p>,
    );
  } else if (refreshSlot) {
    parts.push(
      <p className="art-pub art-pub-only-refresh" key="pub">
        {refreshSlot}
      </p>,
    );
  }
  if (e.tags && e.tags.length) {
    parts.push(
      <div className="art-tags" key="tags">
        {e.tags.map((t) => (
          <button
            className="mini-tag"
            type="button"
            data-tag={t}
            key={t}
            onClick={() => onTag?.(t)}
          >
            #{t}
          </button>
        ))}
      </div>,
    );
  }
  // AI 自动标签（与手动 tags 物理隔离，独立成组，避免和手动机标混淆）
  if (e.aiTags && e.aiTags.length) {
    parts.push(
      <div className="art-tags art-tags-ai" key="aiTags">
        <span className="art-tags-label">AI 标签</span>
        {e.aiTags.map((t) => (
          <button
            className="mini-tag mini-tag-ai"
            type="button"
            data-tag={t}
            key={t}
            onClick={() => (onAiTag || onTag)?.(t)}
          >
            #{t}
          </button>
        ))}
      </div>,
    );
  }
  return parts;
}
