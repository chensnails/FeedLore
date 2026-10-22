/* 卡片视图（v1.8.0 起 React 化，原 index.html 的 #cardsView 内联 DOM + app.js 的卡片渲染迁移至此，P3b）。
 *
 * 迁移策略（沿用 SourcePane 的「共享状态 + tick」约定）：
 * - 数据与状态仍由旧 app.js 持有（state.entries / tags / q / tag / feedFilter / sort / size /
 *   view / hasMore / loading，以及 loadPage / 自动刷新 / 收藏 PATCH 等逻辑）；
 * - 本组件只负责「渲染 + 控件」，控件经桥函数改共享 state 并触发重绘；
 * - app.js 每次需要刷新卡片 UI 时派发 window 事件 `__cardsTick`，组件监听后重渲染（读实时 state）。
 * - 类名 / ID / data 属性与旧 DOM 一致，样式零改动。
 *
 * 跨视图共享机制仍留在 app.js：自动刷新/新内容浮标（fetchHead/applyFresh/checkForNew）、
 * 收藏 PATCH（cardSetFlag）、
 * 「/」聚焦搜索（经 window.__cardsFocusSearch 委托到本组件的输入框）。
 *
 * 卡面不再有已读 / 未读态（v1.2.x 起）：点卡片打开详情弹窗（src/views/CardDetail.jsx）即记为已读，
 * 该状态只在文章页显示，卡片页只保留收藏 ★。
 */

import { core } from '@core';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CardDetail } from './CardDetail.jsx';
import { Dropdown } from './Dropdown.jsx';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）
const SKELETON_N = 8;

const Icon = ({ n }) => (
  <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + n} /></svg>
);

async function copyToClipboard(text) {
  const s = S();
  if (s && s.copyText) return s.copyText(text);
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; }
}

const copyableLinks = (e) => {
  const list = Array.isArray(e.links) ? e.links.filter(Boolean) : [];
  if (list.length) return list;
  return e.link ? [e.link] : [];
};

/** 复制按钮：单条直接复制，多条弹选择菜单（复用 app.js 的 openLinkMenu） */
function CopyButton({ e }) {
  const [copied, setCopied] = useState(false);
  const urls = copyableLinks(e);
  const doIt = async (url) => {
    const ok = await copyToClipboard(url);
    if (!ok) { S().toast('复制失败，请手动选择链接', false); return; }
    setCopied(true);
    S().toast('已复制：' + (S().linkLabel ? S().linkLabel(url) : url));
    setTimeout(() => setCopied(false), 1600);
  };
  if (!urls.length) {
    return <button className="btn-copy" disabled title="无链接" aria-label="无链接"><Icon n="copy" /></button>;
  }
  const many = urls.length > 1;
  const onClick = (ev) => {
    if (!many) { doIt(urls[0]); return; }
    if (S().openLinkMenu) S().openLinkMenu(ev.currentTarget, urls, doIt);
    else doIt(urls[0]);
  };
  return (
    <button type="button" className={'btn-copy' + (copied ? ' copied' : '')} onClick={onClick}
      title={many ? `复制链接（${urls.length} 条，可选择）` : '复制链接'} aria-label="复制链接">
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

/** 懒加载图片：首次失败带 ?r=1 重试一次，再失败走兜底 */
function LazyImg({ src, alt, fallbackClass, fbIcon }) {
  const [state, setState] = useState('ok');   // ok | failed
  const triedRef = useRef(false);
  if (!src || state === 'failed') {
    return fallbackClass === 'row-thumb-fb'
      ? <span className="row-thumb-fb"><Icon n={fbIcon} /></span>
      : <div className={fallbackClass}><Icon n={fbIcon} /></div>;
  }
  return (
    <img
      loading="lazy"
      src={src}
      alt={alt}
      onLoad={(ev) => ev.currentTarget.classList.add('img-ready')}
      onError={(ev) => {
        const img = ev.currentTarget;
        if (img.complete && img.naturalWidth > 0) return;
        if (!triedRef.current) {
          triedRef.current = true;
          const u = src.split('#')[0] + (src.includes('?') ? '&' : '?') + 'r=1';
          img.src = u;
          return;
        }
        setState('failed');
      }}
    />
  );
}

function TagList({ tags, onTag }) {
  return (tags || []).slice(0, 4).map((t) => (
    <span className="mini-tag" data-tag={t} key={t} onClick={() => onTag(t)}>#{t}</span>
  ));
}

function Card({ e, onTag, onOpen }) {
  const s = S();
  const srcName = e.feedName ? (s.shortFeedName ? s.shortFeedName(e.feedName) : e.feedName) : '';
  const hasImg = !!e.image;
  const fmtDate = s.fmtDate || ((d) => d || '');

  const copyBtn = <CopyButton e={e} />;
  const openBtn = <OpenButton e={e} />;
  const tags = <TagList tags={e.tags} onTag={onTag} />;

  const media = hasImg ? (
    <div className="card-media">
      <LazyImg src={e.image} alt={e.name} fallbackClass="media-fallback" fbIcon="image" />
      {srcName ? <span className="badge-source" title={e.feedName}>{srcName}</span> : null}
      {e.size ? <span className="badge-size">{e.size}</span> : null}
      {e.date ? <span className="badge-idx">{fmtDate(e.date)}</span> : null}
      <div className="card-media-actions">{copyBtn}{openBtn}</div>
    </div>
  ) : null;

  const metaRow = hasImg ? null : (
    <div className="card-meta">
      {srcName ? <span className="src-pill" title={e.feedName}>{srcName}</span> : null}
      {e.size ? <span className="meta-size">{e.size}</span> : null}
      <span className="meta-date">{fmtDate(e.date)}</span>
    </div>
  );

  return (
    <article className={'card' + (e.isFavorite ? ' is-fav' : '')} data-id={e.id}
      onClick={(ev) => openFromClick(ev, e, onOpen)}>
      {media}
      <div className="card-body">
        {metaRow}
        <h3 className="card-title" title={e.name}>
          <button type="button" className="title-btn" onClick={() => onOpen(e)}>{e.name}</button>
        </h3>
        {e.desc ? <p className="card-desc">{e.desc}</p> : null}
        <div className="card-tags">{tags}</div>
        {hasImg ? null : <div className="card-foot">{copyBtn}{openBtn}</div>}
      </div>
    </article>
  );
}

function Row({ e, onTag, onOpen }) {
  const s = S();
  const srcName = e.feedName ? (s.shortFeedName ? s.shortFeedName(e.feedName) : e.feedName) : '';
  const fmtDate = s.fmtDate || ((d) => d || '');
  const metaHas = srcName || (e.tags || []).length;
  return (
    <article className={'row-item' + (e.isFavorite ? ' is-fav' : '')} data-id={e.id}
      onClick={(ev) => openFromClick(ev, e, onOpen)}>
      <div className="row-thumb">
        {e.image
          ? <LazyImg src={e.image} alt={e.name} fallbackClass="row-thumb-fb" fbIcon="image" />
          : <span className="row-thumb-fb"><Icon n="image" /></span>}
      </div>
      <div className="row-main">
        <div className="row-head">
          <h3 className="row-title" title={e.name}>
            <button type="button" className="title-btn" onClick={() => onOpen(e)}>{e.name}</button>
          </h3>
          <span className="row-facts">
            {e.size ? <span className="meta-size">{e.size}</span> : null}
            <span className="row-date">{fmtDate(e.date)}</span>
          </span>
        </div>
        {e.desc ? <p className="row-desc">{e.desc}</p> : null}
        {metaHas ? (
          <div className="row-tags">
            {srcName ? <span className="src-pill" title={e.feedName}>{srcName}</span> : null}
            <TagList tags={e.tags} onTag={onTag} />
          </div>
        ) : null}
      </div>
      <div className="row-actions">
        <CopyButton e={e} />
        <OpenButton e={e} />
      </div>
    </article>
  );
}

/** 点卡片空白处打开详情；卡内的按钮 / 链接 / 标签有自己的动作，不劫持它们 */
function openFromClick(ev, e, onOpen) {
  if (ev.target && ev.target.closest && ev.target.closest('button, a, [data-tag]')) return;
  onOpen(e);
}

const Skeletons = ({ view }) => {
  const n = Array.from({ length: SKELETON_N }, (_, i) => i);
  if (view === 'list') {
    return n.map((i) => (
      <div className="sk-row" key={i}>
        <div className="sk-row-thumb" />
        <div className="sk-row-lines">
          <div className="sk-row-line w70" />
          <div className="sk-row-line w90" />
          <div className="sk-row-line w40" />
        </div>
      </div>
    ));
  }
  return n.map((i) => (
    <div className="sk-card" key={i}>
      <div className="sk-media" />
      <div className="sk-line w85" />
      <div className="sk-line" />
      <div className="sk-line w60" />
    </div>
  ));
};

export function CardsView() {
  const s = S();
  const [, bump] = useState(0);
  const searchRef = useRef(null);
  const debounceRef = useRef(null);
  const st = (s && s.state) || {};

  const [qDraft, setQDraft] = useState(st.q || '');
  const [detailId, setDetailId] = useState(null);

  // 卡片 UI 重绘信号（app.js 在状态变化时派发）
  useEffect(() => {
    const onTick = () => bump((x) => x + 1);
    window.addEventListener('__cardsTick', onTick);
    return () => window.removeEventListener('__cardsTick', onTick);
  }, []);

  // 「/」聚焦委托：app.js 的全局快捷键经此把焦点交到本组件输入框
  useEffect(() => {
    window.__cardsFocusSearch = () => {
      const el = searchRef.current;
      if (el) { el.focus(); if (typeof el.select === 'function') el.select(); }
    };
    return () => { delete window.__cardsFocusSearch; };
  }, []);

  // 外部（命令面板 / 深链）改了搜索词时同步草稿
  useEffect(() => { setQDraft(st.q || ''); }, [st.q]);

  const feeds = st.feedList || [];
  const list = (s && s.filterEntries) ? s.filterEntries() : (st.entries || []);
  const view = st.view || 'grid';
  const noEntries = (st.entries || []).length === 0;

  const cardFeeds = feeds.filter((f) => f.cardEnabled);
  const groups = (s && s.groupFeeds) ? s.groupFeeds(cardFeeds) : [{ name: '', feeds: cardFeeds }];
  const feedValue = st.feedFilter == null ? '' : String(st.feedFilter);

  const noFeeds = !feeds.length;
  const noCards = !st.feedFilter && !feeds.some((f) => f.cardEnabled);

  let emptyMsg = null;
  if (st.loadError) emptyMsg = '数据加载失败，请稍后点击「刷新」重试';
  else if (noFeeds) emptyMsg = '还没有订阅源，点右上角「设置 → 数据源」添加 RSS 地址';
  else if (noCards) emptyMsg = '所有频道的「卡片」开关都关掉了。去「设置 → 数据源」打开，或切到「文章」页阅读';
  else if (!list.length) {
    emptyMsg = st.q ? '没有找到匹配的资源' : (st.tag ? '该标签下暂无内容' : '所选频道暂无内容');
  }

  const hasMeta = !!st.feedMeta;
  const firstLoad = !!st.loading && noEntries;
  const showSkeleton = firstLoad;
  const showEmpty = !firstLoad && hasMeta && emptyMsg != null;
  const showGrid = !showSkeleton && !showEmpty;
  const showLoadingMore = !!st.loading && !firstLoad;

  const onSearchInput = (ev) => {
    const v = ev.target.value;
    setQDraft(v);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { if (s.cardsSearch) s.cardsSearch(v); }, 420);
  };

  const onTag = (t) => { if (s.cardsTag) s.cardsTag(st.tag === t ? null : t); };

  const detailEntry = detailId == null ? null : (st.entries || []).find((x) => String(x.id) === String(detailId));

  const closeDetail = () => {
    const id = detailId;
    setDetailId(null);
    // 焦点回到来源卡片的标题按钮（弹窗里的控件都已随组件卸载）
    const el = document.querySelector('[data-id="' + (window.CSS && window.CSS.escape ? window.CSS.escape(String(id)) : id) + '"] .title-btn');
    if (el && el.focus) el.focus();
  };

  const tags = st.tags || [];

  const feedLabel = (f) => {
    const title = s.feedTitle ? s.feedTitle(f) : f.title;
    const name = s.shortFeedName ? s.shortFeedName(title) : title;
    return `${name}（${f.entryCount}）`;
  };
  // 频道 / 排序下拉选项（v1.1.9 起用自定义弹层 Dropdown 渲染，替代原生 select 的系统弹窗）
  const feedOpts = [{ value: '', label: `全部频道（${cardFeeds.length}）` }];
  for (const g of groups) {
    for (const f of g.feeds) feedOpts.push({ value: String(f.id), label: feedLabel(f), group: g.name || '' });
  }
  const sortOpts = [
    { value: 'new', label: '最新发布' },
    { value: 'old', label: '最早上架' },
    { value: 'name', label: '名称排序' },
  ];

  return (
    <>
      <div className="wrap toolbar">
        <div className="search-box">
          <svg className="search-ico" aria-hidden="true" focusable="false"><use href="#i-search" /></svg>
          <input id="searchInput" name="q" type="search" ref={searchRef}
            placeholder="搜索资源名称、描述、正文或标签…（服务端检索）" autoComplete="off"
            value={qDraft} onChange={onSearchInput} />
        </div>
        <Dropdown wrapId="feedDD" id="feedSelect" title="频道筛选" value={feedValue}
          options={feedOpts} onChange={(v) => { if (s.cardsFilterFeed) s.cardsFilterFeed(v); }} />
        <Dropdown wrapId="sortDD" id="sortSelect" title="排序" value={st.sort || 'new'}
          options={sortOpts} onChange={(v) => { if (s.cardsSort) s.cardsSort(v); }} />
        <div className="viewmode" id="viewMode" role="group" aria-label="视图模式">
          <button className={'viewmode-btn' + (view === 'grid' ? ' active' : '')} type="button" data-mode="grid"
            title="卡片视图" aria-label="卡片视图" onClick={() => { if (s.cardsView) s.cardsView('grid'); }}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-grid" /></svg>
          </button>
          <button className={'viewmode-btn' + (view === 'list' ? ' active' : '')} type="button" data-mode="list"
            title="列表视图" aria-label="列表视图" onClick={() => { if (s.cardsView) s.cardsView('list'); }}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-list" /></svg>
          </button>
        </div>
      </div>

      <div className="wrap" id="tagBar">
        {tags.length ? (
          <>
            <span className={'tag-chip' + (st.tag ? '' : ' active')} data-tag="" onClick={() => onTag(null)}>全部</span>
            {tags.slice(0, 16).map(({ tag, n }) => (
              <span className={'tag-chip' + (st.tag === tag ? ' active' : '')} data-tag={tag} key={tag}
                onClick={() => onTag(tag)}>{tag}<span className="cnt">{n}</span></span>
            ))}
          </>
        ) : null}
      </div>

      <main className="wrap">
        {showSkeleton ? (
          <div id="skeleton" className={'grid' + (view === 'list' ? ' list-mode' : '')}><Skeletons view={view} /></div>
        ) : null}

        {showGrid ? (
          <div id="grid" className={'grid' + (view === 'list' ? ' list-mode' : '')}>
            {list.map((e) => (view === 'list'
              ? <Row e={e} onTag={onTag} onOpen={(x) => setDetailId(x.id)} key={e.id} />
              : <Card e={e} onTag={onTag} onOpen={(x) => setDetailId(x.id)} key={e.id} />))}
          </div>
        ) : <div id="grid" className="grid" hidden />}

        {showEmpty ? (
          <div id="empty" className="empty">
            <div className="empty-ico"><svg className="ico" aria-hidden="true" focusable="false"><use href="#i-inbox" /></svg></div>
            <p>{emptyMsg}</p>
          </div>
        ) : <div id="empty" className="empty" hidden><div className="empty-ico"><svg className="ico" aria-hidden="true" focusable="false"><use href="#i-inbox" /></svg></div><p /></div>}

        <div className="loadmore-wrap">
          <button className="btn btn-primary" id="loadMoreBtn" hidden={!(st.hasMore && !firstLoad)}
            onClick={() => { if (s.cardsLoadMore) s.cardsLoadMore(); }}>加载更多</button>
          <div className="loading-dots" id="loadingMore" hidden={!showLoadingMore}><i /><i /><i /></div>
        </div>

        <footer className="foot">
          笺川 · FeedLore · 数据存于 PostgreSQL
        </footer>
      </main>

      {detailEntry ? (
        <CardDetail e={detailEntry} onClose={closeDetail}
          onTag={(t) => { closeDetail(); onTag(t); }} />
      ) : null}
    </>
  );
}
