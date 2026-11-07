/* 文章（reader）视图（v1.9.0 起 React 化，原 index.html 的 #readerView 内联 DOM +
 * app.js 的阅读页渲染迁移至此，P3c）。
 *
 * 迁移策略（沿用 CardsView 的「共享状态 + tick」约定）：
 * - 数据与逻辑仍归旧 app.js（state.rdEntries / rdExpanded / rdBody / rdScope / rdFeedId /
 *   rdGroup / rdQ / rdFlags，以及 loadReader / 展开取正文 / 已读收藏 / 抽屉 / 手势 /
 *   无限滚动 / 自动刷新）；本组件只负责渲染 + 控件，控件经桥改共享 state；
 * - app.js 每次需要刷新阅读页 UI 时派发 window 事件 `__readerTick`，组件监听后读实时 state 重绘；
 * - 类名 / ID / data 属性与旧 DOM 一致，样式零改动。
 */

import { core } from '@core';
import { on, EVENT } from '../kernel/events.js';
import { provide, revoke } from '../kernel/bridge.js';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChannelList } from './ChannelList.jsx';
import { OverflowMenu } from '../ui/OverflowMenu.jsx';
import { ViewNav } from '../ui/ViewNav.jsx';
import { ChannelTabs } from '../ui/ChannelTabs.jsx';
import { BrandLogo } from '../ui/BrandLogo.jsx';
import { useTopbarHeight } from '../shell/useTopbarHeight.js';
import { widthSrcSet } from '../imgSrc.js';
import { NO_AUTOFILL_PROPS, useNoAutofillName } from '../ui/noAutofill.js';
import { Icon } from '../ui/Icon.jsx';
// 动作按钮由 ui/EntryActions 统一提供：卡片页、文章页、卡片详情用同一份实现
import { ArtActions } from '../ui/EntryActions.jsx';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

/* ---------- 正文分层纯函数（自 app.js 迁移，纯函数、不依赖 DOM） ---------- */
const LONG_LINE = 110;
const MIN_SEG = 36;
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
const BREAK_RE = /(?<=[。！？；!])/g;
const TITLE_LINE_RE = /^\s*(?:名\s*称|标\s*题|主\s*题|题\s*目)\s*[：:]\s*(.*)$/;

/** 源站点没分段时按句读切；不在 URL 内部断 */
function splitLongLine(line) {
  if (line.length < LONG_LINE) return [line];
  const spans = [];
  for (const m of line.matchAll(URL_RE)) spans.push([m.index, m.index + m[0].length]);
  const inUrl = (i) => spans.some(([a, b]) => i >= a && i < b);
  const sentences = [];
  let last = 0;
  for (const m of line.matchAll(BREAK_RE)) {
    if (inUrl(m.index)) continue;
    sentences.push(line.slice(last, m.index));
    last = m.index;
  }
  sentences.push(line.slice(last));
  const out = [];
  let buf = '';
  for (const s of sentences) {
    if (!s.trim()) continue;
    buf += s;
    if (buf.trim().length >= MIN_SEG) { out.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [line];
}

function bodyParagraphs(text) {
  const paras = [];
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

function parseBlocks(json) {
  if (!json) return null;
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) && a.length ? a : null;
  } catch (_) { return null; }
}

/* ---------- 结构化正文（bodyVersion 2）的纯函数 ---------- */
function inlineText(nodes) {
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

function blockText(b) {
  if (!b) return '';
  if (b.t === 'p' || b.t === 'h') return inlineText(b.v);
  if (b.t === 'pre') return String(b.code || '');
  if (b.t === 'list') return (b.items || []).map((it) => it.map(blockText).join('\n')).join('\n');
  if (b.t === 'quote') return (b.blocks || []).map(blockText).join('\n');
  if (b.t === 'table') return [...(b.head || []), ...(b.rows || []).flat()].map(inlineText).join('\n');
  if (b.t === 'figure') return inlineText(b.caption || []);
  return '';
}

function blockHasText(b) {
  return blockText(b).trim().length > 0;
}

/** 正文块是不是 v2（结构化）格式。服务端总会带 bodyVersion；
 *  形状再兜一层，避免老缓存 / 手写 mock 少了字段时把 v2 块当 v1 渲染。 */
function isRichBody(e, blocks) {
  if (Number(e && e.bodyVersion) === 2) return true;
  return !!blocks && blocks.some((b) => b && (b.t === 'h' || b.t === 'list' || b.t === 'quote'
    || b.t === 'pre' || b.t === 'table' || b.t === 'figure' || b.t === 'hr' || Array.isArray(b.v)));
}

function isDuplicateTitleLine(txt, name) {
  const m = String(txt).match(TITLE_LINE_RE);
  return !!(m && m[1].trim() === String(name || '').trim());
}

/** 正文第一行常是「名称：xxx」（与标题重复），去掉它 */
function readerBodyText(e) {
  let t = e.content || e.desc || '';
  if (!t) return '';
  const first = t.split('\n')[0] || '';
  const m = first.match(/^\s*(?:名\s*称|标\s*题|主\s*题|题\s*目)\s*[：:]\s*(.*)$/);
  if (m && m[1].trim() === String(e.name || '').trim()) t = t.slice(first.length).replace(/^\n+/, '');
  return t.trim();
}

/** ArtBody 会不会自己渲染出文字 —— 卡片详情弹窗用它决定要不要另列一行摘要。
 *  判定口径必须和 ArtBody 的分支一致：有块数组就只看非图片块（首行与标题重复的那行会被丢掉），
 *  没有块数组则回退到 readerBodyText（它本身就会拿 desc 当正文）。 */
export function bodyShowsText(e) {
  if (!e) return false;
  const blocks = parseBlocks(e.bodyJson);
  if (blocks) {
    if (isRichBody(e, blocks)) return blocks.some(blockHasText);
    return blocks.some((b, i) => b && b.t !== 'img' && String(b.text || '').trim()
      && !(i === 0 && isDuplicateTitleLine(b.text, e.name)));
  }
  return !!readerBodyText(e);
}

const proxied = (u) => {
  const s = String(u || '');
  if (/^https?:\/\//i.test(s)) return '/api/img?u=' + encodeURIComponent(s);
  // 服务端已改写成代理地址的、以及内嵌图片直接放行；其它协议（javascript: / file: …）一律丢掉
  if (s.startsWith('/api/img?') || /^data:image\//i.test(s)) return s;
  return '';
};

/** 正文链接只放行 http(s) / mailto（服务端已清洗，这里再兜一层，防历史数据或回归） */
const safeHref = (h) => {
  const s = String(h || '');
  return /^(https?:|mailto:)/i.test(s) ? s : '';
};

/** 正文图片：加载失败直接移除（旧行为）；点开走全局灯箱（app.js 的 document 委托）。
 *  v2 块会带 alt 与原始宽高，宽高只用于预留比例，最终尺寸仍由 CSS 决定。 */
function ArtImg({ src, alt, w, h }) {
  const [failed, setFailed] = useState(false);
  const url = proxied(src);
  if (failed || !url) return null;
  return (
    <img className="art-img" src={url} srcSet={widthSrcSet(url, [640, 960])}
      sizes="(max-width: 720px) 92vw, 720px" alt={alt || ''}
      width={w || undefined} height={h || undefined}
      loading="lazy" decoding="async" title="点击查看大图"
      onLoad={(ev) => ev.currentTarget.classList.add('img-ready')}
      onError={() => setFailed(true)} />
  );
}

/** 内联节点：只输出文本与语义标签，不接收 HTML 字符串。 */
function Inline({ nodes }) {
  return (nodes || []).map((n, i) => {
    if (!n) return null;
    switch (n.t) {
      case 'text': return n.v;
      case 'code': return <code className="art-code" key={i}>{n.v}</code>;
      case 'br': return <br key={i} />;
      case 'a':
        return safeHref(n.href) ? (
          <a className="art-link" href={safeHref(n.href)} target="_blank" rel="noopener noreferrer" key={i}>
            <Inline nodes={n.v} />
          </a>
        ) : <Inline nodes={n.v} key={i} />;
      case 'strong': return <strong key={i}><Inline nodes={n.v} /></strong>;
      case 'em': return <em key={i}><Inline nodes={n.v} /></em>;
      case 'del': return <del key={i}><Inline nodes={n.v} /></del>;
      default: return null;
    }
  });
}

/** 块级节点。列表 / 引用内部递归复用；连续图片合并成图集（与 v1 一致）。 */
function RichBlocks({ blocks }) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b && b.t === 'img') {
      const grp = [];
      while (i < blocks.length && blocks[i] && blocks[i].t === 'img') { grp.push(blocks[i]); i++; }
      i--;
      out.push(grp.length === 1
        ? <ArtImg src={grp[0].src} alt={grp[0].alt} w={grp[0].w} h={grp[0].h} key={'r' + i} />
        : <div className="art-imgs" key={'r' + i}>{grp.map((im, k) => (
          <ArtImg src={im.src} alt={im.alt} w={im.w} h={im.h} key={k} />
        ))}</div>);
      continue;
    }
    if (!b) continue;
    switch (b.t) {
      case 'p':
        out.push(<p key={'r' + i}><Inline nodes={b.v} /></p>);
        break;
      case 'h':
        out.push(b.level === 3
          ? <h3 className="art-h3" key={'r' + i}><Inline nodes={b.v} /></h3>
          : <h2 className="art-h2" key={'r' + i}><Inline nodes={b.v} /></h2>);
        break;
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul';
        out.push(
          <Tag className="art-list" key={'r' + i}>
            {(b.items || []).map((item, k) => <li key={k}><RichBlocks blocks={item} /></li>)}
          </Tag>
        );
        break;
      }
      case 'quote':
        out.push(<blockquote className="art-quote" key={'r' + i}><RichBlocks blocks={b.blocks || []} /></blockquote>);
        break;
      case 'pre':
        out.push(
          <pre className="art-pre" key={'r' + i}>
            <code data-lang={b.lang || undefined}>{b.code}</code>
          </pre>
        );
        break;
      case 'table': {
        const head = b.head || [];
        const rows = b.rows || [];
        out.push(
          <div className="art-table-wrap" key={'r' + i}>
            <table className="art-table">
              {head.length ? (
                <thead><tr>{head.map((cell, k) => <th key={k}><Inline nodes={cell} /></th>)}</tr></thead>
              ) : null}
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri}>{row.map((cell, ci) => <td key={ci}><Inline nodes={cell} /></td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        break;
      }
      case 'figure':
        out.push(
          <figure className="art-figure" key={'r' + i}>
            <ArtImg src={b.img && b.img.src} alt={b.img && b.img.alt} w={b.img && b.img.w} h={b.img && b.img.h} />
            {b.caption && b.caption.length ? (
              <figcaption className="art-caption"><Inline nodes={b.caption} /></figcaption>
            ) : null}
          </figure>
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

/** 正文（对应旧 artBodyHtml）：图文按原顺序内联；老数据回退为图集 + 段落。
 *  导出给卡片详情弹窗（src/views/CardDetail.jsx）复用，两处正文渲染保持一套。
 *  extraActions：弹窗会把「收藏 / 在文章页查看」也塞进这条动作行，保证一个弹窗只有一排按钮。 */
export function ArtBody({ e, onTag, extraActions }) {
  const s = S();
  const fmtFull = s.fmtFull || ((d) => (d ? String(d) : ''));
  const parts = [];
  const blocks = parseBlocks(e.bodyJson);

  if (blocks) {
    if (isRichBody(e, blocks)) {
      parts.push(<div className="art-text art-rich" key="rich"><RichBlocks blocks={blocks} /></div>);
    } else {
      let i = 0;
      while (i < blocks.length) {
        const b = blocks[i];
        if (b.t === 'img') {
          const grp = [];
          while (i < blocks.length && blocks[i].t === 'img') { grp.push(blocks[i].src); i++; }
          parts.push(grp.length === 1
            ? <ArtImg src={grp[0]} key={'b' + i} />
            : <div className="art-imgs" key={'b' + i}>{grp.map((src, k) => <ArtImg src={src} key={k} />)}</div>);
        } else {
          if (i === 0 && isDuplicateTitleLine(b.text, e.name)) { i++; continue; }
          parts.push(
            <div className="art-text" key={'b' + i}>
              {bodyParagraphs(b.text).map((p, k) => <p className={p.cls || undefined} key={k}>{p.text}</p>)}
            </div>
          );
          i++;
        }
      }
    }
    if (!parts.length) parts.push(<div className="art-text art-text-empty" key="empty">这条没有正文，点「打开」看原文</div>);
  } else {
    const imgs = (Array.isArray(e.images) && e.images.length) ? e.images : (e.image ? [e.image] : []);
    if (imgs.length) {
      parts.push(imgs.length === 1
        ? <ArtImg src={imgs[0]} key="img" />
        : <div className="art-imgs" key="img">{imgs.map((src, k) => <ArtImg src={src} key={k} />)}</div>);
    }
    const text = readerBodyText(e);
    parts.push(text
      ? <div className="art-text" key="text">{bodyParagraphs(text).map((p, k) => <p className={p.cls || undefined} key={k}>{p.text}</p>)}</div>
      : <div className="art-text art-text-empty" key="text">这条没有正文，点「打开」看原文</div>);
  }

  if (e.date) {
    parts.push(
      <p className="art-pub" key="pub">
        <span className="art-pub-label">发布时间</span>
        <time dateTime={new Date(e.date).toISOString()}>{fmtFull(e.date)}</time>
      </p>
    );
  }
  if (e.tags && e.tags.length) {
    parts.push(
      <div className="art-tags" key="tags">
        {e.tags.map((t) => <button className="mini-tag" type="button" data-tag={t} key={t} onClick={() => onTag(t)}>#{t}</button>)}
      </div>
    );
  }
  parts.push(<ArtActions key="acts" e={e} extraActions={extraActions} />);
  return <div className="art-inner">{parts}</div>;
}

/* 外观里的「列表密度」会改变 DOM 结构（不是纯 CSS）：紧凑模式连 <img> 与摘要都不该下发。
 * 所以列表必须订阅 __appearanceChanged 重绘；只靠 data 属性 + CSS 的话，
 * 切到紧凑后动作按钮的 has-thumb 暗底仍会压在空处。 */
function useArticleListPrefs() {
  const read = () => {
    const a = (S().getAppearance && S().getAppearance()) || {};
    return a.listDensity !== 'compact';
  };
  const [comfortable, setComfortable] = useState(read);
  useEffect(() => {
    const sync = () => setComfortable(read());
    return on(EVENT.APPEARANCE, sync);
  }, []);
  return comfortable;
}

/** 列表项（对应旧 artItemHtml + expandArt/collapseArt）。
 *  做成 memo：每次 __readerTick 都会把整列 entries 重新 map 一遍，而条目对象只在
 *  状态真的变化时才换新（core/reader.js 的 applyEntryFlag / ui.js 的 cardSetFlag 同口径），
 *  所以没变的那几百条不必跟着重新渲染。 */
const ArtItem = memo(function ArtItem({ e, expanded, full, bodyErr, flash, comfortable, onToggle, onFav, onTag, onUnread, onRetryBody }) {
  const s = S();
  const src = e.feedName ? (s.shortFeedName ? s.shortFeedName(e.feedName) : e.feedName) : '';
  const fmtFull = s.fmtFull || ((d) => (d ? String(d) : ''));
  const fmtDate = s.fmtDate || ((d) => (d ? String(d) : ''));
  const fav = !!e.isFavorite;
  /* 未读态此前只有一个 aria-hidden 的 6px 圆点 + 字重差，读屏完全听不出来。
     把标题 / 来源 / 时间 / 未读 / 收藏拼进按钮的可访问名，视觉冗余保持不变；
     aria-label 会取代内部文本的朗读，所以这里要把信息补全而不是只写「未读」。 */
  const ariaLabel = [e.name, src, fmtDate(e.date), e.isRead ? '已读' : '未读', fav ? '已收藏' : '']
    .filter(Boolean).join('，');
  /* 缩略图：列表接口本来就把首图放在 e.image（已走 /api/img 代理），只是以前没渲染。
     展开后让位给正文（正文自己会出图），加载失败退成纯文字行 —— 不留一个灰框。
     失败态记在组件本地：条目对象换新时（已读 / 收藏）不该把失败的图又试一遍。
     「紧凑」密度直接不渲染 <img>：不只是藏起来，连首图请求都不发。 */
  const [imgFailed, setImgFailed] = useState(false);
  const rootRef = useRef(null);
  const thumb = !expanded && comfortable && e.image && !imgFailed ? e.image : null;
  /* 摘要来自抓取时压平的 description（纯文本），展开后正文已经在读，不再重复一遍 */
  const desc = !expanded && comfortable && e.desc ? String(e.desc) : '';
  /* 紧凑密度 = 单行清单：标题单行省略，来源与时间并到同一行。
     展开的那条恢复普通行式排版，别让正在读的文章标题也被截成一行。 */
  const lineMode = !comfortable && !expanded;
  // has-thumb 让样式知道图占了右下角：动作按钮要垫一层暗底，否则压在亮图上就看不见了
  const cls = 'art-item' + (e.isRead ? ' is-read' : ' is-unread') + (fav ? ' is-fav' : '') + (expanded ? ' open' : '')
    + (thumb ? ' has-thumb' : '') + (desc ? ' has-sum' : '') + (lineMode ? ' is-line' : '') + (flash ? ' is-flash' : '');

  /* 收起时正文一塌陷，视口会停在原处（常常正好是空白）。滚回本条标题 ——
     .art-item 的 scroll-margin-top 与吸顶头部同源（--reader-sticky-offset），
     所以 block:'start' 的落点就是标题行，不必再量一次高度。
     展开方向不滚：用户点标题的位置本来就在那里。 */
  const toggle = () => {
    const closing = expanded;
    onToggle(e.id);
    if (!closing) return;
    requestAnimationFrame(() => {
      const el = rootRef.current;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
    });
  };

  let inner = null;
  if (expanded) {
    if (full) inner = <ArtBody e={full} onTag={onTag} />;
    else if (bodyErr) {
      inner = (
        <div className="art-inner">
          <div className="hint">
            正文加载失败
            <button type="button" className="btn btn-sm" onClick={() => onRetryBody(e.id)}>重试</button>
          </div>
        </div>
      );
    } else inner = <div className="art-inner"><div className="art-loading"><i /><i /><i /></div></div>;
  }

  return (
    <article className={cls} data-id={e.id} ref={rootRef}>
      <div className="art-row">
        <button className="art-head" type="button" aria-expanded={expanded ? 'true' : 'false'}
          aria-label={ariaLabel} onClick={toggle}>
          <span className="art-dot" aria-hidden="true" />
          <svg className="art-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
          {/* 标题与来源/时间竖排成一栏：右边留给缩略图，底部只留一行元信息，
              与「标题 3 行 + 图 + 时间」的资讯流排版一致。 */}
          <span className="art-text">
            <span className="art-title">{e.name}</span>
            {desc ? <span className="art-sum">{desc}</span> : null}
            <span className="art-meta">
              {src ? <span className="src-pill">{src}</span> : null}
              {e.size ? <span className="art-size">{e.size}</span> : null}
              <span className="art-date" title={fmtFull(e.date)}>{fmtDate(e.date)}</span>
            </span>
          </span>
          {thumb ? (
            <span className="art-thumb">
              <img src={thumb} srcSet={widthSrcSet(thumb, [200, 400])} sizes="104px"
                alt="" loading="lazy" decoding="async" onError={() => setImgFailed(true)} />
            </span>
          ) : null}
        </button>
        <span className="art-acts">
          {/* 收起这篇：读到一半时的退出按钮。标题行本身也能点（同一个 toggle），
              但滚了几屏之后没人会想到「再点一次标题」，显式按钮才让退出路径看得见。 */}
          {expanded ? (
            <button className="art-star art-collapse" type="button"
              aria-label="收起这篇" title="收起这篇"
              onClick={(ev) => { ev.stopPropagation(); toggle(); }}>
              <Icon n="chevrons-up" />
            </button>
          ) : null}
          <button className="art-star" type="button" data-fav={e.id} aria-pressed={fav ? 'true' : 'false'}
            aria-label={fav ? '取消收藏' : '收藏'} title={fav ? '取消收藏' : '收藏这篇'}
            onClick={(ev) => { ev.stopPropagation(); onFav(e.id); }}>
            <Icon n={fav ? 'star' : 'star-o'} />
          </button>
          {e.isRead ? (
            <button className="art-star art-unread" type="button" data-unread={e.id}
              aria-label="标为未读" title="标为未读"
              onClick={(ev) => { ev.stopPropagation(); onUnread(e.id); }}>
              <Icon n="circle" />
            </button>
          ) : null}
        </span>
      </div>
      <div className="art-body" hidden={!expanded}>
        {inner}
      </div>
    </article>
  );
});

/* ---------- 频道栏宽度分隔条 ----------
 * 拖拽期间只写 :root 上的 --reader-side-w（一次拖拽几十帧，走 state 会把整棵阅读页重渲染），
 * 松手才落一次账号偏好；双击复位默认宽度；方向键微调（键盘也要能调，不能只有鼠标）。 */
function ReaderSideResize() {
  const dragRef = useRef(null);
  // 当前宽度只用于 aria-valuenow：拖动时直接写 CSS 变量（不走 React），
  // 所以这里同步维护一份，键盘调整后读屏能立刻读到新值。
  const [width, setWidth] = useState(() => S().getReaderSideWidth());

  const onPointerDown = (ev) => {
    // 移动端抽屉宽度由 CSS 的 min(272px,84vw) 决定，拖了也没意义
    if (window.innerWidth <= 720) return;
    const s = S();
    ev.preventDefault();
    const side = document.getElementById('readerSide');
    const measured = side ? side.getBoundingClientRect().width : 0;
    const startX = ev.clientX;
    // 量不到（宽度为 0，如无布局的测试环境）时以偏好值起算
    const startW = measured > 0 ? measured : s.getReaderSideWidth();
    dragRef.current = startW;
    const move = (e) => {
      const w = Math.min(s.readerSideCap(), Math.max(s.READER_SIDE_MIN, startW + (e.clientX - startX)));
      dragRef.current = w;
      s.applyReaderSideWidth(w);
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (dragRef.current != null) S().setReaderSideWidth(dragRef.current);
      dragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const onDoubleClick = () => {
    const s = S();
    s.setReaderSideWidth(s.READER_SIDE_DEFAULT);
    setWidth(s.READER_SIDE_DEFAULT);
    s.toast('频道栏宽度已恢复默认');
  };

  const onKeyDown = (ev) => {
    const s = S();
    const step = 16;
    const cur = s.getReaderSideWidth();
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      const next = Math.min(s.readerSideCap(),
        Math.max(s.READER_SIDE_MIN, cur + (ev.key === 'ArrowRight' ? step : -step)));
      s.setReaderSideWidth(next);
      setWidth(next);
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      s.setReaderSideWidth(s.READER_SIDE_DEFAULT);
      setWidth(s.READER_SIDE_DEFAULT);
    }
  };

  return (
    /* role="separator" + tabIndex 让它成了可聚焦控件，那就必须有名字和当前值：
       否则读屏只会念「分隔条」，用户不知道左右键在改什么。 */
    <div className="reader-resize" id="readerResize" role="separator" aria-orientation="vertical"
      aria-label="调整频道栏宽度" aria-valuenow={Math.round(width)}
      aria-valuemin={S().READER_SIDE_MIN} aria-valuemax={S().readerSideCap()}
      tabIndex={0} title="拖动调整频道栏宽度，双击恢复默认"
      onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown} />
  );
}

export function ReaderView() {
  const searchName = useNoAutofillName('reader-q');
  const s = S();
  const [, bump] = useState(0);
  const searchRef = useRef(null);
  const debounceRef = useRef(null);
  // 合并后第一行（≡频道 / 标题 / 文章动作 / 搜索 / ⋮）即吸顶条，由其写入 --topbar-h
  const headRef = useRef(null);
  // 窄屏（≤720px）搜索框默认收起，标题栏里只留一个放大镜按钮 —— 一整条搜索框占掉
  // 手机上最金贵的一行，而它大部分时间是空的。桌面不受影响（CSS 里按钮隐藏、搜索框常驻）。
  const [searchOpen, setSearchOpen] = useState(false);
  // 列表密度（外观偏好，只存本机）：改变的是 DOM 结构，订阅事件后重绘整列
  const listComfortable = useArticleListPrefs();

  useEffect(() => {
    const onTick = () => bump((x) => x + 1);
    return on(EVENT.READER, onTick);
  }, []);

  useEffect(() => {
    // 命令面板 / 「/」快捷键要求聚焦搜索：窄屏下得先把搜索框展开，否则焦点落到 display:none 上。
    // 已展开时 setSearchOpen(true) 不会触发状态变化，这里直接聚焦，保证再按「/」同样生效。
    provide('readerFocusSearch', () => {
      setSearchOpen(true);
      requestAnimationFrame(() => {
        const el = searchRef.current;
        if (el) { el.focus(); if (typeof el.select === 'function') el.select(); }
      });
    });
    return () => { revoke('readerFocusSearch'); };
  }, []);

  // 展开后把焦点送进输入框（展开这一步是 display 切换，同 tick 聚焦无效）
  useEffect(() => {
    if (!searchOpen) return;
    const el = searchRef.current;
    if (el) { el.focus(); if (typeof el.select === 'function') el.select(); }
  }, [searchOpen]);

  // 合并头部：本视图第一行即吸顶条，实测高度写入 --topbar-h（隐藏视图测得 0 高不写，避免覆盖）
  useTopbarHeight(headRef);

  const st = (s && s.state) || {};
  const writable = !!(s && s.isWritable ? s.isWritable() : true);
  const feeds = st.feedList || [];
  const entries = st.rdEntries || [];
  const rawFlags = st.rdFlags || { total: 0, unread: 0, favorite: 0 };
  const flagsKey = `${rawFlags.total}|${rawFlags.unread}|${rawFlags.favorite}|${rawFlags.watching ?? ''}|${rawFlags.blocked ?? ''}`;
  // D：标记仅在计数变化时重算，避免每次 tick 重建对象导致侧栏无谓重渲染
  const flags = useMemo(() => rawFlags, [flagsKey]);
  const expanded = st.rdExpanded || new Set();
  const bodyMap = st.rdBody || new Map();
  const bodyErrSet = st.rdBodyErr || new Set();
  const accordionOn = !!(s && s.readerAccordionOn && s.readerAccordionOn());
  const flashId = st.rdFlashId == null ? null : String(st.rdFlashId);

  // 频道栏：分组与折叠状态一次算好，头部「全部折叠」按钮与列表必须同源
  // D：分组 / 折叠只在订阅源或折叠集合变化时重算，避免每次阅读页 tick 都重建整条侧栏
  const grouped = useMemo(() => (s.groupFeeds ? s.groupFeeds(feeds) : [{ name: '', feeds }]), [st.feedList]);
  const collapseKey = JSON.stringify(st.rdCollapsedGroups || []);
  const collapsed = useMemo(() => (s.readerCollapsedGroups ? s.readerCollapsedGroups() : new Set()), [collapseKey]);
  const hasGroups = grouped.some((g) => g.name);
  const allCollapsed = hasGroups && grouped.every((g) => collapsed.has(g.name || ''));

  // 标题
  const cur = st.rdFeedId == null ? null : feeds.find((f) => String(f.id) === String(st.rdFeedId));
  let title = '全部文章';
  if (cur) title = (s.shortFeedName ? s.shortFeedName(s.feedTitle ? s.feedTitle(cur) : cur.title) : cur.title);
  else if (st.rdWatch === 'watch') title = '关注';
  else if (st.rdWatch === 'block') title = '屏蔽';
  else if (st.rdGroup != null) title = `分组 · ${st.rdGroup || '未分组'}`;
  else if (st.rdScope === 'unread') title = '未读';
  else if (st.rdScope === 'favorite') title = '收藏';

  const hasUnread = entries.some((e) => !e.isRead);
  const anyExpanded = expanded.size > 0;
  const q = st.rdQ || '';
  // 搜索框本身是非受控的（打字不被抢光标）；草稿只用于「清除」按钮的即时显隐，
  // 否则要等 280ms 防抖请求回来、q 变了、按钮才出现。
  const [qDraft, setQDraft] = useState(q);

  // 别处带来的搜索词（命令面板 / 卡片页跳转）要让框是展开的，否则关键词在生效、框却收着
  useEffect(() => { if (q) setSearchOpen(true); }, [q]);


  // 搜索框故意做成非受控（受控会在打字时抢光标），代价是外部改 rdQ 时框里不会跟着变 ——
  // 从卡片页跳过来会把关键词清空（否则目标文章被旧关键词筛掉），此时必须把手动的框刷回去。
  // 正在框里打字时不抢：那时 value 是用户刚敲的，比 debounce 后的 state 更新。
  useEffect(() => {
    const el = searchRef.current;
    if (!el) return;
    // 有词时不抢正在输入的框；外部「清空」必须落地，否则跳转路径会把旧词留在框上
    if (q && el === document.activeElement) return;
    if (el.value === q && qDraft === q) return;
    el.value = q;
    el.dataset.hasval = q ? '1' : '';
    setQDraft(q);
  }, [q]);

  // 切频道 / 分组 / 范围会先把列表清空再请求，此刻的空列表不是「真没有内容」。
  // 加载中先按住空态，等这次请求落地仍为空再提示，否则每次切换都闪一下假空态。
  const firstLoad = !!st.rdLoading && !entries.length;

  let emptyMsg = '';
  let emptyAction = null;
  if (!entries.length && !firstLoad) {
    if (st.rdReadError) {
      emptyMsg = st.rdReadErrorMsg || '加载失败';
      emptyAction = { label: '重试', run: () => s.readerReload() };
    } else if (q) {
      emptyMsg = `没有找到匹配「${q}」的文章`;
      emptyAction = { label: '清除搜索', run: () => onSearchClear() };
    } else if (st.rdWatch === 'watch') {
      emptyMsg = writable
        ? '还没有命中的文章；在「设置 → 规则」里配置关键词，保存后点「应用到已有文章」'
        : '还没有命中的文章';
      emptyAction = writable ? { label: '打开规则设置', run: () => s.openSettings('watch') } : null;
    } else if (st.rdWatch === 'block') {
      emptyMsg = '没有被屏蔽的文章';
      emptyAction = writable ? { label: '管理屏蔽规则', run: () => s.openSettings('watch') } : null;
    } else if (st.rdScope === 'unread') {
      emptyMsg = '没有未读文章了';
      emptyAction = { label: '查看全部文章', run: () => s.readerSetScope('all') };
    } else if (st.rdScope === 'favorite') {
      emptyMsg = '还没有收藏，点文章右侧的星标收藏';
      emptyAction = { label: '查看全部文章', run: () => s.readerSetScope('all') };
    } else if (!feeds.length) {
      emptyMsg = writable ? '还没有订阅源，去「设置 → 数据源」添加 RSS 地址' : '还没有订阅源；只读账户不能自行添加';
      emptyAction = writable ? { label: '添加订阅源', run: () => s.readerOpenSource() } : null;
    } else {
      emptyMsg = '这个频道还没有内容';
      emptyAction = writable ? { label: '重新抓取', run: () => s.refresh() } : null;
    }
  }

  const onSearchInput = (ev) => {
    const v = ev.target.value;
    const box = searchRef.current;
    if (box) box.dataset.hasval = v ? '1' : '';
    // setQDraft 本身就会触发重绘（清除按钮的显隐读它），不必再 bump 一次
    setQDraft(v);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { if (s.readerSearch) s.readerSearch(v.trim()); }, 280);
  };
  const onSearchClear = () => {
    if (searchRef.current) {
      searchRef.current.value = '';
      searchRef.current.dataset.hasval = '';
    }
    setQDraft('');
    if (s.readerSearch) s.readerSearch('');
    bump((x) => x + 1);
  };
  const onSearchKey = (ev) => {
    if (ev.key === 'Enter') { clearTimeout(debounceRef.current); if (s.readerSearch) s.readerSearch(String(ev.target.value).trim()); }
    // Esc 收起搜索（与 iOS 搜索框一致）；有词时先清词再收，避免「看不见却生效」的过滤
    if (ev.key === 'Escape') { ev.stopPropagation(); if (qDraft) onSearchClear(); setSearchOpen(false); }
  };
  // 标题栏放大镜：展开 / 收起。收起时若有关键词一并清掉 —— 留着一个看不见的过滤条件，
  // 表现成「列表莫名少了一半」，比直接清空更难排查。
  const toggleSearch = () => {
    if (!searchOpen) { setSearchOpen(true); return; }
    if (qDraft || q) onSearchClear();
    setSearchOpen(false);
  };

  // memo 的前提是回调稳定：写成行内箭头函数的话，每次 tick 每个条目都会拿到新函数 props，
  // 几百条一起重渲染，等于把 memo 白加。core 是单例，回调里现取即可。
  const onToggleArt = useCallback((id) => { const c = S(); if (c.readerToggleArt) c.readerToggleArt(id); }, []);
  const onFavArt = useCallback((id) => { const c = S(); if (c.readerToggleFav) c.readerToggleFav(id); }, []);
  const onUnreadArt = useCallback((id) => { const c = S(); if (c.readerMarkUnread) c.readerMarkUnread(id); }, []);
  const onRetryBodyArt = useCallback((id) => { const c = S(); if (c.readerRetryBody) c.readerRetryBody(id); }, []);
  const onTagArt = useCallback((t) => { const c = S(); if (c.readerTagToCards) c.readerTagToCards(t); }, []);
  // D：侧栏回调稳定化（memo 的前提是 props 引用稳定），否则每次 tick 都拿到新函数、memo 失效
  const cbScope = useCallback((k) => S().readerSetScope(k), []);
  const cbFeed = useCallback((id) => S().readerSetFeed(id), []);
  const cbGroup = useCallback((g) => S().readerSetGroup(g), []);
  const cbFold = useCallback((g) => S().readerToggleGroupCollapse(g), []);
  const cbWatch = useCallback((k) => S().readerSetWatch(k), []);
  const cbAdd = useCallback(() => S().readerOpenSource(), []);

  return (
    <>
      <div className="reader-mask" id="readerMask" onClick={() => s.readerCloseDrawer && s.readerCloseDrawer()} />
      <aside className="reader-side" id="readerSide">
        {/* 品牌 logo 移到频道栏顶部（v1.6.0：顶栏并入内容行后，品牌标识落在这里） */}
        <div className="side-brand">
          <BrandLogo />
          <span className="side-brand-name">笺川</span>
        </div>
        <div className="reader-side-head">
          <span>频道</span>
          <span className="reader-side-n" id="readerSideN">{feeds.length ? `${s.fmtBadge(feeds.length)} 个` : ''}</span>
          <button className="reader-side-fold" id="readerFoldAll" type="button" hidden={!hasGroups}
            title={allCollapsed ? '展开全部分组' : '收起全部分组'}
            aria-label={allCollapsed ? '展开全部分组' : '收起全部分组'}
            onClick={() => s.readerToggleAllGroups && s.readerToggleAllGroups()}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href={allCollapsed ? '#i-chevrons-down' : '#i-chevrons-up'} /></svg>
          </button>
          <button className="reader-side-close" id="readerSideClose" type="button" aria-label="收起频道列表"
            onClick={() => s.readerCloseDrawer && s.readerCloseDrawer()}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
          </button>
        </div>
        <nav className="reader-channels" id="readerChannels">
          <ChannelList variant="reader" groups={grouped} collapsed={collapsed} hasGroups={hasGroups}
            flags={flags} activeScope={st.rdScope} activeFeedId={st.rdFeedId} activeGroup={st.rdGroup}
            activeWatch={st.rdWatch}
            onScope={cbScope} onFeed={cbFeed}
            onGroup={cbGroup} onFold={cbFold}
            onWatch={cbWatch}
            onAdd={cbAdd} />
        </nav>
      </aside>
      <ReaderSideResize />

      <section className="reader-main">
        <div className="reader-head page-head view-toolbar" ref={headRef}>
          <button className="btn btn-ghost btn-sm reader-menu-btn vt-channel" id="readerMenuBtn" type="button" aria-label="打开频道列表"
            onClick={() => s.readerToggleDrawer && s.readerToggleDrawer()}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-menu" /></svg><span className="reader-menu-label">频道</span>
          </button>
          <div className="reader-head-text"><h2 className="page-title vt-title" id="readerTitle">{title}</h2></div>
          {/* 右侧簇：文章动作（单篇/多篇、全部已读、全部收起）+ 搜索 + ⋮ 菜单。
              桌面：动作 + 常驻搜索胶囊 + ⋮；窄屏：动作收成图标、搜索收进放大镜，整条压成一行。 */}
          <div className="reader-head-tools page-tools vt-tools">
            <button className="btn btn-ghost btn-sm vt-action" id="readerAccBtn" type="button" aria-pressed={accordionOn ? 'true' : 'false'}
              title={accordionOn
                ? '单篇展开：展开一篇时自动收起上一篇（点这里改成多篇）'
                : '多篇展开：可以同时展开多篇（点这里改成单篇）'}
              onClick={() => s.readerToggleAccordion && s.readerToggleAccordion()}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-accordion" /></svg>
              <span className="btn-label" id="readerAccLabel">{accordionOn ? '单篇' : '多篇'}</span>
            </button>
            <button className="btn btn-ghost btn-sm vt-action" id="readerReadAllBtn" type="button" hidden={!hasUnread}
              title="把当前列表全部标为已读" onClick={() => s.readerReadAll && s.readerReadAll()}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-check-circle" /></svg>
              <span className="btn-label">全部已读</span>
            </button>
            <button className="btn btn-ghost btn-sm vt-action" id="readerCollapseAll" type="button" hidden={!anyExpanded}
              title="收起所有展开的文章" onClick={() => s.readerCollapseAll && s.readerCollapseAll()}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-chevrons-up" /></svg>
              <span className="btn-label">全部收起</span>
            </button>
            {/* 搜索：桌面常驻胶囊、窄屏收进放大镜，展开时独占第二行 */}
            <div className={'reader-search page-search vt-search' + (searchOpen ? ' is-open' : '')}>
              <svg className="search-ico" aria-hidden="true" focusable="false"><use href="#i-search" /></svg>
              <input id="readerSearch" name={searchName} type="search" ref={searchRef} defaultValue={q}
                placeholder="搜索标题、描述、正文或标签…（服务端检索）" enterKeyHint="search" aria-label="搜索文章"
                onInput={onSearchInput} onKeyDown={onSearchKey} {...NO_AUTOFILL_PROPS} />
              <button className="reader-search-clear" id="readerSearchClear" type="button" hidden={!qDraft}
                aria-label="清除搜索" onClick={onSearchClear}>
                <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
              </button>
            </div>
            <button className={'btn btn-ghost btn-sm reader-search-toggle' + (searchOpen ? ' is-on' : '')}
              id="readerSearchToggle" type="button"
              aria-expanded={searchOpen ? 'true' : 'false'} aria-controls="readerSearch"
              title={searchOpen ? '收起搜索' : '搜索文章'}
              onClick={toggleSearch}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href={searchOpen ? '#i-x' : '#i-search'} /></svg>
            </button>
            <ViewNav />
            <OverflowMenu view="reader" readerControls
              readerState={{ accordionOn, hasUnread, anyExpanded }} />
          </div>
          {/* 窄屏第二行：横滑频道条（桌面 display:none，仍走常驻侧栏）。
              放在头部内部 = 跟着头部一起吸顶，不用再算一层 sticky 偏移。 */}
          <ChannelTabs variant="reader" groups={grouped} activeScope={st.rdScope}
            activeFeedId={st.rdFeedId} activeGroup={st.rdGroup} activeWatch={st.rdWatch}
            onScope={cbScope} onFeed={cbFeed} onWatch={cbWatch}
            onManage={() => s.readerToggleDrawer && s.readerToggleDrawer()} />
        </div>

        {q && entries.length > 0 ? (
          <div className="list-count" role="status">「{q}」找到 {st.rdTotal} 篇文章</div>
        ) : null}
        <div className="reader-list" id="readerList">
          {entries.map((e) => (
            <ArtItem key={e.id} e={e} expanded={expanded.has(e.id)}
              full={bodyMap.get(e.id)} bodyErr={bodyErrSet.has(e.id)}
              flash={flashId != null && flashId === String(e.id)}
              comfortable={listComfortable}
              onToggle={onToggleArt} onFav={onFavArt} onUnread={onUnreadArt}
              onRetryBody={onRetryBodyArt} onTag={onTagArt} />
          ))}
        </div>

        <div className="empty" id="readerEmpty" hidden={entries.length > 0 || firstLoad}>
          <div className="empty-ico"><svg className="ico" aria-hidden="true" focusable="false"><use href="#i-inbox" /></svg></div>
          <p>{emptyMsg}</p>
          {emptyAction ? (
            <button type="button" className="btn btn-primary empty-action" onClick={emptyAction.run}>{emptyAction.label}</button>
          ) : null}
        </div>

        <div className="loadmore-wrap">
          {st.rdLoadMoreErr ? (
            <div className="load-retry" role="alert">
              <span>加载失败</span>
              <button type="button" className="btn" onClick={() => s.readerRetryMore()}>重试</button>
            </div>
          ) : null}
          <div className="loading-dots" id="readerMore" hidden={!st.rdLoading}><i /><i /><i /></div>
          <div className="reader-sentinel" id="readerSentinel" aria-hidden="true" />
        </div>
        {entries.length > 0 && !st.rdHasMore && !st.rdLoading ? (
          <div className="list-end">已经到底了</div>
        ) : null}

        <footer className="foot">点标题阅读全文，再点一次收起</footer>
      </section>
    </>
  );
}
