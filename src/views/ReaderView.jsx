/* 文章（reader）视图（v1.9.0 起 React 化，原 index.html 的 #readerView 内联 DOM +
 * app.js 的阅读页渲染迁移至此，P3c）。
 *
 * 迁移策略（沿用 CardsView 的「共享状态 + tick」约定）：
 * - 数据与逻辑仍归旧 app.js（state.rdEntries / rdExpanded / rdBody / rdScope / rdFeedId /
 *   rdGroup / rdQ / rdFlags，以及 loadReader / 展开取正文 / 已读收藏 / 抽屉 / 手势 /
 *   无限滚动 / 键盘导航 / 自动刷新）；本组件只负责渲染 + 控件，控件经桥改共享 state；
 * - app.js 每次需要刷新阅读页 UI 时派发 window 事件 `__readerTick`，组件监听后读实时 state 重绘；
 * - 类名 / ID / data 属性与旧 DOM 一致，样式零改动。
 */

import { core } from '@core';
import React, { useEffect, useRef, useState } from 'react';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

/** 频道头像：图标加载失败（拉取 404 / 防盗链）时回退到首字母，避免破图标 */
function ChannelAvatar({ icon, name }) {
  const [failed, setFailed] = useState(false);
  if (!icon || failed) {
    return <span className="rd-ch-avatar rd-ch-avatar-txt">{String(name || '?').slice(0, 1)}</span>;
  }
  return (
    <img className="rd-ch-avatar" src={icon} alt="" loading="lazy"
      onError={() => setFailed(true)} />
  );
}

const Icon = ({ n }) => (
  <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + n} /></svg>
);

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

const proxied = (u) => (/^https?:\/\//i.test(u) ? '/api/img?u=' + encodeURIComponent(u) : u);

/** 正文图片：加载失败直接移除（旧行为）；点开走全局灯箱（app.js 的 document 委托） */
function ArtImg({ src }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img className="art-img" src={proxied(src)} alt="" loading="lazy" decoding="async" title="点击查看大图"
      onLoad={(ev) => ev.currentTarget.classList.add('img-ready')}
      onError={() => setFailed(true)} />
  );
}

async function copyToClipboard(text) {
  const s = S();
  if (s && s.copyText) return s.copyText(text);
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; }
}

function CopyButton({ e }) {
  const [copied, setCopied] = useState(false);
  const urls = Array.isArray(e.links) ? e.links.filter(Boolean) : [];
  const list = urls.length ? urls : (e.link ? [e.link] : []);
  const doIt = async (url) => {
    const ok = await copyToClipboard(url);
    if (!ok) { S().toast('复制失败，请手动选择链接', false); return; }
    setCopied(true);
    S().toast('已复制：' + (S().linkLabel ? S().linkLabel(url) : url));
    setTimeout(() => setCopied(false), 1600);
  };
  if (!list.length) return null;
  const many = list.length > 1;
  const onClick = (ev) => {
    if (!many) { doIt(list[0]); return; }
    if (S().openLinkMenu) S().openLinkMenu(ev.currentTarget, list, doIt);
    else doIt(list[0]);
  };
  return (
    <button type="button" className={'btn-copy' + (copied ? ' copied' : '')} onClick={onClick}
      title={many ? `复制链接（${list.length} 条，可选择）` : '复制链接'} aria-label="复制链接">
      {copied ? <><Icon n="check" /> 已复制</> : <Icon n="copy" />}
    </button>
  );
}

function OpenButton({ e }) {
  const url = e.sourceUrl || e.link || null;
  // 无原文地址时干脆不渲染：置灰的「打开」看起来像上了锁，反而引人误会（v2.2.4）
  if (!url) return null;
  return (
    <a className="btn-open" href={url} target="_blank" rel="noopener noreferrer"
      title="打开原文章" aria-label="打开原文章"><Icon n="external" /></a>
  );
}

/** 正文（对应旧 artBodyHtml）：图文按原顺序内联；老数据回退为图集 + 段落 */
function ArtBody({ e, onTag }) {
  const s = S();
  const fmtFull = s.fmtFull || ((d) => (d ? String(d) : ''));
  const parts = [];
  const blocks = parseBlocks(e.bodyJson);

  if (blocks) {
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
        {e.tags.map((t) => <span className="mini-tag" data-tag={t} key={t} onClick={() => onTag(t)}>#{t}</span>)}
      </div>
    );
  }
  parts.push(<div className="art-actions" key="acts"><CopyButton e={e} /><OpenButton e={e} /></div>);
  return <div className="art-inner">{parts}</div>;
}

/** 列表项（对应旧 artItemHtml + expandArt/collapseArt） */
function ArtItem({ e, expanded, full, bodyErr, onToggle, onFav, onTag }) {
  const s = S();
  const src = e.feedName ? (s.shortFeedName ? s.shortFeedName(e.feedName) : e.feedName) : '';
  const fmtFull = s.fmtFull || ((d) => (d ? String(d) : ''));
  const fmtDate = s.fmtDate || ((d) => (d ? String(d) : ''));
  const fav = !!e.isFavorite;
  const cls = 'art-item' + (e.isRead ? ' is-read' : ' is-unread') + (fav ? ' is-fav' : '') + (expanded ? ' open' : '');

  let inner = null;
  if (expanded) {
    if (full) inner = <ArtBody e={full} onTag={onTag} />;
    else if (bodyErr) inner = <div className="art-inner"><div className="hint">正文加载失败，刷新页面重试</div></div>;
    else inner = <div className="art-inner"><div className="art-loading"><i /><i /><i /></div></div>;
  }

  return (
    <article className={cls} data-id={e.id}>
      <div className="art-row">
        <button className="art-head" type="button" aria-expanded={expanded ? 'true' : 'false'} onClick={() => onToggle(e.id)}>
          <span className="art-dot" aria-hidden="true" />
          <svg className="art-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
          <span className="art-title">{e.name}</span>
          <span className="art-meta">
            {src ? <span className="src-pill">{src}</span> : null}
            {e.size ? <span className="art-size">{e.size}</span> : null}
            <span className="art-date" title={fmtFull(e.date)}>{fmtDate(e.date)}</span>
          </span>
        </button>
        <button className="art-star" type="button" data-fav={e.id} aria-pressed={fav ? 'true' : 'false'}
          aria-label={fav ? '取消收藏' : '收藏'} title={fav ? '取消收藏' : '收藏这篇'}
          onClick={(ev) => { ev.stopPropagation(); onFav(e.id); }}>
          <Icon n={fav ? 'star' : 'star-o'} />
        </button>
      </div>
      <div className="art-body" hidden={!expanded}>{inner}</div>
    </article>
  );
}

/** 频道侧栏（对应旧 renderReaderChannels） */
function ReaderChannels({ feeds, flags, scope, feedId, group }) {
  const s = S();
  const grouped = (s.groupFeeds) ? s.groupFeeds(feeds) : [{ name: '', feeds }];
  const atScope = feedId == null && group == null;
  const scopeBtn = (key, ico, name, n, cls) => (
    <button className={'rd-ch' + (atScope && scope === key ? ' active' : '')} type="button" data-scope={key}
      onClick={() => s.readerSetScope(key)}>
      <span className={'rd-ch-avatar ' + cls}><Icon n={ico} /></span>
      <span className="rd-ch-name">{name}</span>
      {n > 0 ? <span className="rd-ch-n">{n}</span> : null}
    </button>
  );
  const hasGroups = grouped.some((g) => g.name);

  return (
    <>
      {scopeBtn('all', 'circle', '全部文章', flags.total, 'rd-ch-avatar-all')}
      {scopeBtn('unread', 'dot', '未读', flags.unread, 'rd-ch-avatar-unread')}
      {scopeBtn('favorite', 'star', '收藏', flags.favorite, 'rd-ch-avatar-fav')}
      <div className="rd-ch-sep" aria-hidden="true" />
      {grouped.map((g) => {
        const gname = g.name || '';
        const gUnread = g.feeds.reduce((sum, x) => sum + Number(x.unreadCount || 0), 0);
        return (
          <div key={'g:' + gname}>
            {hasGroups ? (
              <div className="rd-ch-group-row">
                <button type="button"
                  className={'rd-ch-group' + (gname ? '' : ' muted') + (group === gname ? ' active' : '') + (gUnread > 0 ? ' has-unread' : '')}
                  data-group={gname} title={`只看「${gname || '未分组'}」分组下的文章`}
                  onClick={() => s.readerSetGroup(gname)}>
                  <span className="rd-ch-group-name">{gname || '未分组'}</span>
                  {gUnread > 0
                    ? <span className="rd-ch-n hot">{gUnread}</span>
                    : <span className="rd-ch-group-empty" aria-hidden="true">✓</span>}
                </button>
              </div>
            ) : null}
            {g.feeds.map((f) => {
              const name = s.shortFeedName ? s.shortFeedName(s.feedTitle ? s.feedTitle(f) : f.title) : f.title;
              const tip = f.enabled ? (s.feedTitle ? s.feedTitle(f) : f.title) : `${s.feedTitle ? s.feedTitle(f) : f.title}（已停止采集）`;
              const unread = Number(f.unreadCount || 0);
              const count = Number(f.entryCount || 0);
              const active = feedId != null && String(feedId) === String(f.id);
              return (
                <button key={f.id} className={'rd-ch' + (f.enabled ? '' : ' off') + (active ? ' active' : '')}
                  type="button" data-feed={f.id} onClick={() => s.readerSetFeed(f.id)}>
                  <ChannelAvatar icon={f.icon} name={name} />
                  <span className="rd-ch-name" title={tip || ''}>{name}</span>
                  {unread > 0 ? <span className="rd-ch-n hot" title={`${unread} 条未读 / 共 ${count} 条`}>{unread}</span> : null}
                </button>
              );
            })}
          </div>
        );
      })}
      <button type="button" className="rd-ch-add" data-action="open-source" onClick={() => s.readerOpenSource()}>
        <svg className="rd-ch-add-ico" aria-hidden="true" focusable="false"><use href="#i-plus" /></svg>
        <span>添加频道</span>
      </button>
    </>
  );
}

export function ReaderView() {
  const s = S();
  const [, bump] = useState(0);
  const searchRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    const onTick = () => bump((x) => x + 1);
    window.addEventListener('__readerTick', onTick);
    return () => window.removeEventListener('__readerTick', onTick);
  }, []);

  useEffect(() => {
    window.__readerFocusSearch = () => {
      const el = searchRef.current;
      if (el) { el.focus(); if (typeof el.select === 'function') el.select(); }
    };
    return () => { delete window.__readerFocusSearch; };
  }, []);

  const st = (s && s.state) || {};
  const feeds = st.feedList || [];
  const entries = st.rdEntries || [];
  const flags = st.rdFlags || { total: 0, unread: 0, favorite: 0 };
  const expanded = st.rdExpanded || new Set();
  const bodyMap = st.rdBody || new Map();
  const bodyErrSet = st.rdBodyErr || new Set();
  const accordionOn = !!(s && s.readerAccordionOn && s.readerAccordionOn());

  // 标题
  const cur = st.rdFeedId == null ? null : feeds.find((f) => String(f.id) === String(st.rdFeedId));
  let title = '全部文章';
  if (cur) title = (s.shortFeedName ? s.shortFeedName(s.feedTitle ? s.feedTitle(cur) : cur.title) : cur.title);
  else if (st.rdGroup != null) title = `分组 · ${st.rdGroup || '未分组'}`;
  else if (st.rdScope === 'unread') title = '未读';
  else if (st.rdScope === 'favorite') title = '收藏';

  const hasUnread = entries.some((e) => !e.isRead);
  const anyExpanded = expanded.size > 0;
  const q = st.rdQ || '';

  let emptyMsg = '';
  if (!entries.length) {
    if (st.rdReadError) emptyMsg = st.rdReadErrorMsg || '加载失败';
    else emptyMsg = q ? `没有找到匹配「${q}」的文章`
      : (st.rdScope === 'unread' ? '没有未读文章了'
        : st.rdScope === 'favorite' ? '还没有收藏，点文章右侧的星标收藏'
          : (feeds.length ? '这个频道还没有内容' : '还没有订阅源，去「设置 → 数据源」添加 RSS 地址'));
  }

  const onSearchInput = (ev) => {
    const v = ev.target.value;
    const box = searchRef.current;
    if (box) box.dataset.hasval = v ? '1' : '';
    bump((x) => x + 1);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { if (s.readerSearch) s.readerSearch(v.trim()); }, 280);
  };
  const onSearchClear = () => {
    if (searchRef.current) searchRef.current.value = '';
    if (s.readerSearch) s.readerSearch('');
    bump((x) => x + 1);
  };
  const onSearchKey = (ev) => {
    if (ev.key === 'Enter') { clearTimeout(debounceRef.current); if (s.readerSearch) s.readerSearch(String(ev.target.value).trim()); }
  };

  return (
    <>
      <div className="reader-mask" id="readerMask" onClick={() => s.readerCloseDrawer && s.readerCloseDrawer()} />
      <aside className="reader-side" id="readerSide">
        <div className="reader-side-head">
          <span>频道</span>
          <span className="reader-side-n" id="readerSideN">{feeds.length ? `${feeds.length} 个` : ''}</span>
          <button className="reader-side-close" id="readerSideClose" type="button" aria-label="收起频道列表"
            onClick={() => s.readerCloseDrawer && s.readerCloseDrawer()}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
          </button>
        </div>
        <nav className="reader-channels" id="readerChannels">
          <ReaderChannels feeds={feeds} flags={flags} scope={st.rdScope} feedId={st.rdFeedId} group={st.rdGroup} />
        </nav>
      </aside>

      <section className="reader-main">
        <div className="reader-head">
          <button className="btn btn-ghost btn-sm reader-menu-btn" id="readerMenuBtn" type="button" aria-label="打开频道列表"
            onClick={() => s.readerToggleDrawer && s.readerToggleDrawer()}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-menu" /></svg> 频道
          </button>
          <div className="reader-head-text"><h2 id="readerTitle">{title}</h2></div>
          <div className="reader-head-tools">
            <button className="btn btn-ghost btn-sm" id="readerAccBtn" type="button" aria-pressed={accordionOn ? 'true' : 'false'}
              title={accordionOn
                ? '单篇展开：展开一篇时自动收起上一篇（点这里改成多篇）'
                : '多篇展开：可以同时展开多篇（点这里改成单篇）'}
              onClick={() => s.readerToggleAccordion && s.readerToggleAccordion()}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-accordion" /></svg>
              <span className="btn-label" id="readerAccLabel">{accordionOn ? '单篇' : '多篇'}</span>
            </button>
            <button className="btn btn-ghost btn-sm" id="readerReadAllBtn" type="button" hidden={!hasUnread}
              title="把当前列表全部标为已读" onClick={() => s.readerReadAll && s.readerReadAll()}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-check-circle" /></svg>
              <span className="btn-label">全部已读</span>
            </button>
            <button className="btn btn-ghost btn-sm" id="readerCollapseAll" type="button" hidden={!anyExpanded}
              title="收起所有展开的文章" onClick={() => s.readerCollapseAll && s.readerCollapseAll()}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-chevrons-up" /></svg>
              <span className="btn-label">全部收起</span>
            </button>
          </div>
        </div>

        <div className="reader-search">
          <svg className="search-ico" aria-hidden="true" focusable="false"><use href="#i-search" /></svg>
          <input id="readerSearch" name="rq" type="search" ref={searchRef} defaultValue={q}
            placeholder="搜索标题、描述、正文或标签…（服务端检索）" autoComplete="off" enterKeyHint="search" aria-label="搜索文章"
            onInput={onSearchInput} onKeyDown={onSearchKey} />
          <button className="reader-search-clear" id="readerSearchClear" type="button" hidden={!q}
            aria-label="清除搜索" onClick={onSearchClear}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
          </button>
        </div>

        <div className="reader-list" id="readerList">
          {entries.map((e) => (
            <ArtItem key={e.id} e={e} expanded={expanded.has(e.id)}
              full={bodyMap.get(e.id)} bodyErr={bodyErrSet.has(e.id)}
              onToggle={(id) => s.readerToggleArt && s.readerToggleArt(id)}
              onFav={(id) => s.readerToggleFav && s.readerToggleFav(id)}
              onTag={(t) => s.readerTagToCards && s.readerTagToCards(t)} />
          ))}
        </div>

        <div className="empty" id="readerEmpty" hidden={entries.length > 0}>
          <div className="empty-ico"><svg className="ico" aria-hidden="true" focusable="false"><use href="#i-inbox" /></svg></div>
          <p>{emptyMsg}</p>
        </div>

        <div className="loadmore-wrap">
          <div className="loading-dots" id="readerMore" hidden={!st.rdLoading}><i /><i /><i /></div>
          <div className="reader-sentinel" id="readerSentinel" aria-hidden="true" />
        </div>

        <footer className="foot">点标题展开全文，再点一次收起</footer>
      </section>
    </>
  );
}
