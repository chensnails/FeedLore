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
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChannelList } from './ChannelList.jsx';
import { OverflowMenu } from '../ui/OverflowMenu.jsx';
import { BrandLogo } from '../ui/BrandLogo.jsx';
import { useTopbarHeight } from '../shell/useTopbarHeight.js';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

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

/** ArtBody 会不会自己渲染出文字 —— 卡片详情弹窗用它决定要不要另列一行摘要。
 *  判定口径必须和 ArtBody 的分支一致：有块数组就只看非图片块（首行与标题重复的那行会被丢掉），
 *  没有块数组则回退到 readerBodyText（它本身就会拿 desc 当正文）。 */
export function bodyShowsText(e) {
  if (!e) return false;
  const blocks = parseBlocks(e.bodyJson);
  if (blocks) {
    return blocks.some((b, i) => b && b.t !== 'img' && String(b.text || '').trim()
      && !(i === 0 && isDuplicateTitleLine(b.text, e.name)));
  }
  return !!readerBodyText(e);
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

/** 复制链接（多条时弹选择菜单）。导出给卡片详情弹窗复用。 */
export function CopyButton({ e }) {
  const [copied, setCopied] = useState(false);
  const urls = Array.isArray(e.links) ? e.links.filter(Boolean) : [];
  const list = urls.length ? urls : (e.link ? [e.link] : []);
  const doIt = async (url) => {
    const ok = await S().copyText(url);
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
      {copied ? <><Icon n="check" /><span className="btn-label">已复制</span></> : <Icon n="copy" />}
    </button>
  );
}

export function OpenButton({ e }) {
  const url = e.sourceUrl || e.link || null;
  // 无原文地址时干脆不渲染：置灰的「打开」看起来像上了锁，反而引人误会（v2.2.4）
  if (!url) return null;
  return (
    <a className="btn-open" href={url} target="_blank" rel="noopener noreferrer"
      title="打开原文章" aria-label="打开原文章"><Icon n="external" /></a>
  );
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
        {e.tags.map((t) => <button className="mini-tag" type="button" data-tag={t} key={t} onClick={() => onTag(t)}>#{t}</button>)}
      </div>
    );
  }
  parts.push(<div className="art-actions" key="acts"><CopyButton e={e} /><OpenButton e={e} />{extraActions}</div>);
  return <div className="art-inner">{parts}</div>;
}

/** 列表项（对应旧 artItemHtml + expandArt/collapseArt）。
 *  做成 memo：每次 __readerTick 都会把整列 entries 重新 map 一遍，而条目对象只在
 *  状态真的变化时才换新（core/reader.js 的 applyEntryFlag / ui.js 的 cardSetFlag 同口径），
 *  所以没变的那几百条不必跟着重新渲染。 */
const ArtItem = memo(function ArtItem({ e, expanded, full, bodyErr, flash, onToggle, onFav, onTag }) {
  const s = S();
  const src = e.feedName ? (s.shortFeedName ? s.shortFeedName(e.feedName) : e.feedName) : '';
  const fmtFull = s.fmtFull || ((d) => (d ? String(d) : ''));
  const fmtDate = s.fmtDate || ((d) => (d ? String(d) : ''));
  const fav = !!e.isFavorite;
  const cls = 'art-item' + (e.isRead ? ' is-read' : ' is-unread') + (fav ? ' is-fav' : '') + (expanded ? ' open' : '')
    + (flash ? ' is-flash' : '');

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
});

/* ---------- 频道栏宽度分隔条 ----------
 * 拖拽期间只写 :root 上的 --reader-side-w（一次拖拽几十帧，走 state 会把整棵阅读页重渲染），
 * 松手才落一次账号偏好；双击复位默认宽度；方向键微调（键盘也要能调，不能只有鼠标）。 */
function ReaderSideResize() {
  const ref = useRef(null);
  const dragRef = useRef(null);

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
    s.toast('频道栏宽度已恢复默认');
  };

  const onKeyDown = (ev) => {
    const s = S();
    const step = 16;
    const cur = s.getReaderSideWidth();
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      s.setReaderSideWidth(cur + (ev.key === 'ArrowRight' ? step : -step));
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      s.setReaderSideWidth(s.READER_SIDE_DEFAULT);
    }
  };

  return (
    <div ref={ref} className="reader-resize" id="readerResize" role="separator" aria-orientation="vertical"
      tabIndex={0} title="拖动调整频道栏宽度，双击恢复默认"
      onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown} />
  );
}

export function ReaderView() {
  const s = S();
  const [, bump] = useState(0);
  const searchRef = useRef(null);
  const debounceRef = useRef(null);
  // 合并后第一行（≡频道 / 标题 / 文章动作 / 搜索 / ⋮）即吸顶条，由其写入 --topbar-h
  const headRef = useRef(null);
  // 窄屏（≤720px）搜索框默认收起，标题栏里只留一个放大镜按钮 —— 一整条搜索框占掉
  // 手机上最金贵的一行，而它大部分时间是空的。桌面不受影响（CSS 里按钮隐藏、搜索框常驻）。
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onTick = () => bump((x) => x + 1);
    window.addEventListener('__readerTick', onTick);
    return () => window.removeEventListener('__readerTick', onTick);
  }, []);

  useEffect(() => {
    // 命令面板 / 「/」快捷键要求聚焦搜索：窄屏下得先把搜索框展开，否则焦点落到 display:none 上
    window.__readerFocusSearch = () => { setSearchOpen(true); };
    return () => { delete window.__readerFocusSearch; };
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
  const feeds = st.feedList || [];
  const entries = st.rdEntries || [];
  const flags = st.rdFlags || { total: 0, unread: 0, favorite: 0 };
  const expanded = st.rdExpanded || new Set();
  const bodyMap = st.rdBody || new Map();
  const bodyErrSet = st.rdBodyErr || new Set();
  const accordionOn = !!(s && s.readerAccordionOn && s.readerAccordionOn());
  const flashId = st.rdFlashId == null ? null : String(st.rdFlashId);

  // 频道栏：分组与折叠状态一次算好，头部「全部折叠」按钮与列表必须同源
  const grouped = (s.groupFeeds) ? s.groupFeeds(feeds) : [{ name: '', feeds }];
  const collapsed = (s.readerCollapsedGroups) ? s.readerCollapsedGroups() : new Set();
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

  // 别处带来的搜索词（命令面板 / 卡片页跳转）要让框是展开的，否则关键词在生效、框却收着
  useEffect(() => { if (q) setSearchOpen(true); }, [q]);


  // 搜索框故意做成非受控（受控会在打字时抢光标），代价是外部改 rdQ 时框里不会跟着变 ——
  // 从卡片页跳过来会把关键词清空（否则目标文章被旧关键词筛掉），此时必须把手动的框刷回去。
  // 正在框里打字时不抢：那时 value 是用户刚敲的，比 debounce 后的 state 更新。
  useEffect(() => {
    const el = searchRef.current;
    if (!el || el === document.activeElement || el.value === q) return;
    el.value = q;
    el.dataset.hasval = q ? '1' : '';
  }, [q]);

  let emptyMsg = '';
  if (!entries.length) {
    if (st.rdReadError) emptyMsg = st.rdReadErrorMsg || '加载失败';
    else emptyMsg = q ? `没有找到匹配「${q}」的文章`
      : (st.rdWatch === 'watch' ? '还没有命中的文章；在「设置 → 规则」里配置关键字，保存后点「应用到已有文章」'
        : st.rdWatch === 'block' ? '没有被屏蔽的文章'
          : st.rdScope === 'unread' ? '没有未读文章了'
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
    // Esc 收起搜索（与 iOS 搜索框一致）；有词时先清词再收，避免「看不见却生效」的过滤
    if (ev.key === 'Escape') { ev.stopPropagation(); if (q) onSearchClear(); setSearchOpen(false); }
  };
  // 标题栏放大镜：展开 / 收起。收起时若有关键词一并清掉 —— 留着一个看不见的过滤条件，
  // 表现成「列表莫名少了一半」，比直接清空更难排查。
  const toggleSearch = () => {
    if (!searchOpen) { setSearchOpen(true); return; }
    if (q) onSearchClear();
    setSearchOpen(false);
  };

  // memo 的前提是回调稳定：写成行内箭头函数的话，每次 tick 每个条目都会拿到新函数 props，
  // 几百条一起重渲染，等于把 memo 白加。core 是单例，回调里现取即可。
  const onToggleArt = useCallback((id) => { const c = S(); if (c.readerToggleArt) c.readerToggleArt(id); }, []);
  const onFavArt = useCallback((id) => { const c = S(); if (c.readerToggleFav) c.readerToggleFav(id); }, []);
  const onTagArt = useCallback((t) => { const c = S(); if (c.readerTagToCards) c.readerTagToCards(t); }, []);

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
          <span className="reader-side-n" id="readerSideN">{feeds.length ? `${feeds.length} 个` : ''}</span>
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
            onScope={(k) => s.readerSetScope(k)} onFeed={(id) => s.readerSetFeed(id)}
            onGroup={(g) => s.readerSetGroup(g)} onFold={(g) => s.readerToggleGroupCollapse(g)}
            onWatch={(k) => s.readerSetWatch(k)}
            onAdd={() => s.readerOpenSource()} />
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
              <input id="readerSearch" name="rq" type="search" ref={searchRef} defaultValue={q}
                placeholder="搜索标题、描述、正文或标签…（服务端检索）" autoComplete="off" enterKeyHint="search" aria-label="搜索文章"
                onInput={onSearchInput} onKeyDown={onSearchKey} />
              <button className="reader-search-clear" id="readerSearchClear" type="button" hidden={!q}
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
            <OverflowMenu view="reader" />
          </div>
        </div>

        <div className="reader-list" id="readerList">
          {entries.map((e) => (
            <ArtItem key={e.id} e={e} expanded={expanded.has(e.id)}
              full={bodyMap.get(e.id)} bodyErr={bodyErrSet.has(e.id)}
              flash={flashId != null && flashId === String(e.id)}
              onToggle={onToggleArt} onFav={onFavArt} onTag={onTagArt} />
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
