/* 卡片视图（v1.8.0 起 React 化，原 index.html 的 #cardsView 内联 DOM + app.js 的卡片渲染迁移至此，P3b）。
 *
 * 迁移策略（沿用 SourcePane 的「共享状态 + tick」约定）：
 * - 数据与状态仍由旧 app.js 持有（state.entries / tags / q / tag / feedFilter / sort /
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
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { CardDetail } from './CardDetail.jsx';
import { ChannelList } from './ChannelList.jsx';
import { Dropdown } from './Dropdown.jsx';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）
const SKELETON_N = 8;

const Icon = ({ n }) => (
  <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + n} /></svg>
);

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
    const ok = await S().copyText(url);
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
    <button className="mini-tag" type="button" data-tag={t} key={t} onClick={() => onTag(t)}>#{t}</button>
  ));
}

/* 卡片与列表行都做成 memo：一次 __cardsTick 会把整列重新 map，
 * 而条目对象只在状态真的变化时换新（core/ui.js 的 cardSetFlag），没变的卡面不必重渲染。 */
const Card = memo(function Card({ e, onTag, onOpen }) {
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
});

const Row = memo(function Row({ e, onTag, onOpen }) {
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
});

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
  // 窄屏搜索框默认收起（标题栏只留放大镜），桌面不受影响 —— 与文章页同一套行为
  const [searchOpen, setSearchOpen] = useState(false);
  // 标签栏：roving tabindex（整组一个 Tab 停靠点）+ 手机端折叠
  const [chipIdx, setChipIdx] = useState(0);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const chipRefs = useRef([]);

  // 卡片 UI 重绘信号（app.js 在状态变化时派发）
  useEffect(() => {
    const onTick = () => bump((x) => x + 1);
    window.addEventListener('__cardsTick', onTick);
    return () => window.removeEventListener('__cardsTick', onTick);
  }, []);

  // 「/」聚焦委托：app.js 的全局快捷键经此把焦点交到本组件输入框
  // （窄屏下框是收着的，先展开再聚焦 —— 见下面 searchOpen 的 effect）
  useEffect(() => {
    window.__cardsFocusSearch = () => { setSearchOpen(true); };
    return () => { delete window.__cardsFocusSearch; };
  }, []);

  // 展开后把焦点送进输入框
  useEffect(() => {
    if (!searchOpen) return;
    const el = searchRef.current;
    if (el) { el.focus(); if (typeof el.select === 'function') el.select(); }
  }, [searchOpen]);

  // 外部（命令面板 / 深链）改了搜索词时同步草稿，并把搜索框展开
  useEffect(() => { setQDraft(st.q || ''); if (st.q) setSearchOpen(true); }, [st.q]);

  // 滚动到底部自动加载：与文章页一致（此前只有卡片页要手动点「加载更多」）。
  // 按钮保留，作为键盘用户与自动加载失灵时的降级入口。
  useEffect(() => {
    if (!st.hasMore) return undefined;
    const onScroll = () => {
      if (st.loading || !st.hasMore) return;
      const doc = document.documentElement;
      const gap = doc.scrollHeight - window.scrollY - window.innerHeight;
      if (gap < 480) { if (s.cardsLoadMore) s.cardsLoadMore(); }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [st.hasMore, st.loading]);

  const feeds = st.feedList || [];
  const list = (s && s.filterEntries) ? s.filterEntries() : (st.entries || []);
  const view = st.view || 'grid';
  const noEntries = (st.entries || []).length === 0;

  const cardFeeds = feeds.filter((f) => f.cardEnabled);
  const groups = (s && s.groupFeeds) ? s.groupFeeds(cardFeeds) : [{ name: '', feeds: cardFeeds }];
  // 只有「分了组」才画组头（和文章页侧栏同一判据）
  const hasGroups = groups.length > 1 || !!(groups[0] && groups[0].name);
  const collapsedGroups = (s && s.readerCollapsedGroups) ? s.readerCollapsedGroups() : new Set();
  const feedValue = st.feedFilter == null ? '' : String(st.feedFilter);

  // 「固定频道标题栏」的标题：当前频道 + 当前标签，滚到列表中段也知道自己在看哪一档
  const curCardFeed = st.feedFilter == null ? null : feeds.find((f) => String(f.id) === String(st.feedFilter));
  const headTitle = (curCardFeed
    ? (s.shortFeedName ? s.shortFeedName(s.feedTitle ? s.feedTitle(curCardFeed) : curCardFeed.title) : curCardFeed.title)
    : '全部频道') + (st.tag ? ` · ${st.tag}` : '');

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
    // 与文章页统一 300ms；回车立即检索
    debounceRef.current = setTimeout(() => { if (s.cardsSearch) s.cardsSearch(v.trim()); }, 300);
  };
  const onSearchKey = (ev) => {
    if (ev.key !== 'Enter') return;
    clearTimeout(debounceRef.current);
    if (s.cardsSearch) s.cardsSearch(String(ev.target.value).trim());
  };
  const onSearchClear = () => {
    clearTimeout(debounceRef.current);
    setQDraft('');
    if (s.cardsSearch) s.cardsSearch('');
    if (searchRef.current) searchRef.current.focus();
  };
  // 标题栏放大镜：展开 / 收起；收起时把关键词一起清掉（看不见却生效的过滤最难排查）
  const toggleSearch = () => {
    if (!searchOpen) { setSearchOpen(true); return; }
    if (qDraft || st.q) onSearchClear();
    setSearchOpen(false);
  };

  // memo 的前提是回调稳定：这两个必须与本次渲染无关（标签取调用时的 state.tag），
  // 否则每张卡片每次 tick 都会拿到新函数 props 而一起重渲染。
  const onTag = useCallback((t) => {
    const c = S();
    if (c.cardsTag) c.cardsTag(c.state.tag === t ? null : t);
  }, []);
  const onOpenCard = useCallback((e) => setDetailId(e.id), []);

  // 频道筛选里的组头折叠：与文章页侧栏共用同一份偏好（layout.rdCollapsedGroups），
  // 核心改动后会同时派发 __readerTick 与 __cardsTick，本组件靠上面的监听重绘即可。
  const toggleGroupFold = useCallback((name) => {
    const c = S();
    if (c.readerToggleGroupCollapse) c.readerToggleGroupCollapse(name);
  }, []);

  // 抽屉里点频道 = 换筛选 + 收起抽屉。抽屉是模态的：选完就该收起，否则盖着刚筛出来的列表。
  const pickFeed = (id) => {
    if (s.cardsFilterFeed) s.cardsFilterFeed(id == null ? '' : id);
    if (s.cardsCloseDrawer) s.cardsCloseDrawer();
  };
  const addChannel = () => {
    if (s.cardsCloseDrawer) s.cardsCloseDrawer();
    if (s.readerOpenSource) s.readerOpenSource();
  };

  const detailEntry = detailId == null ? null : (st.entries || []).find((x) => String(x.id) === String(detailId));

  const closeDetail = () => {
    const id = detailId;
    setDetailId(null);
    // 焦点回到来源卡片的标题按钮（弹窗里的控件都已随组件卸载）
    const el = document.querySelector('[data-id="' + (window.CSS && window.CSS.escape ? window.CSS.escape(String(id)) : id) + '"] .title-btn');
    if (el && el.focus) el.focus();
  };

  const tags = st.tags || [];
  const chipList = tags.slice(0, 16);          // 「全部」另算，最多再列 16 个
  /* 漫游焦点：整组只留一个 tabIndex=0，方向键在组内移动。
     只处理方向键 / Home / End —— Enter 与空格交给真按钮，不需要再手写一遍。 */
  const onChipKey = (ev) => {
    const n = chipList.length + 1;
    let next = null;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (chipIdx + 1) % n;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (chipIdx - 1 + n) % n;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = n - 1;
    if (next == null) return;
    ev.preventDefault();
    setChipIdx(next);
    const el = chipRefs.current[next];
    if (el) el.focus();
  };

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
  const sortLabel = (sortOpts.find((o) => o.value === String(st.sort || 'new')) || sortOpts[0]).label;

  return (
    <>
      {/* 窄屏频道抽屉：与文章页同一套交互（左侧推出 / 遮罩 / 关闭按钮 / 侧滑手势）。
          宽屏由 CSS 隐藏，频道筛选仍走工具栏下拉，桌面结构不变。 */}
      <div className="cards-mask" id="cardsMask" onClick={() => { if (s.cardsCloseDrawer) s.cardsCloseDrawer(); }} />
      <aside className="cards-side" id="cardsSide" aria-label="频道列表">
        <div className="cards-side-head">
          <span>频道</span>
          <span className="reader-side-n" id="cardsSideN">{cardFeeds.length ? `${cardFeeds.length} 个` : ''}</span>
          <button className="reader-side-close" id="cardsSideClose" type="button" aria-label="收起频道列表"
            onClick={() => { if (s.cardsCloseDrawer) s.cardsCloseDrawer(); }}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
          </button>
        </div>
        <nav className="cards-channels" id="cardsChannels">
          <ChannelList variant="cards" groups={groups} hasGroups={hasGroups} collapsed={collapsedGroups}
            activeFeedId={st.feedFilter} onFeed={pickFeed} onFold={toggleGroupFold} onAdd={addChannel} />
        </nav>
      </aside>

      {/* 标题行（与文章页共用一套头部规范）：[频道][标题][搜索] …… [筛选][排序][视图][放大镜]。
          搜索就在这一行里吃掉剩余宽度，不再单独占一行（那是整整 50px 只在打字时才有用的空白）。
          窄屏整条吸顶成一行（CSS 里 .cards-head / .page-tools 退化为 display:contents，
          靠 order 排位），搜索收进右侧放大镜。 */}
      <div className="cards-sticky">
        <div className="wrap cards-head page-head view-toolbar">
          <button className="btn btn-ghost btn-sm cards-menu-btn vt-channel" id="cardsMenuBtn" type="button"
            aria-label="打开频道列表" aria-controls="cardsSide"
            onClick={() => { if (s.cardsToggleDrawer) s.cardsToggleDrawer(); }}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-menu" /></svg>
            <span className="cards-menu-label">频道</span>
          </button>
          <h2 className="cards-title page-title vt-title" title={headTitle}>{headTitle}</h2>
          {/* 桌面（≥1081px）这里没有文字标题：同一句话标题与下拉各写一遍，等于同一信息出现两次，
              而其中只有下拉可点。改成「下拉即标题」—— 它本身就显示当前频道（含条数），
              既是标题也是筛选入口。窄屏（≤1080px）下拉退场、抽屉接管，文字标题回来。 */}
          <Dropdown wrapId="feedDD" id="feedSelect" title="频道筛选"
            ariaLabel={'频道筛选，当前：' + headTitle} value={feedValue}
            options={feedOpts} onChange={(v) => { if (s.cardsFilterFeed) s.cardsFilterFeed(v); }}
            collapsible collapsedGroups={collapsedGroups} onToggleGroup={toggleGroupFold} />
          {/* 右簇：排序 → 视图切换 → 搜索。搜索是这一簇的末端，也是整条工具栏的右边缘 ——
              两页、两档断点都只有这一个答案（窄屏收进放大镜，展开时独占第二行）。 */}
          <div className="page-tools vt-tools">
            {/* 排序：桌面是带文字的下拉（当档位一目了然），窄屏收成图标按钮。
                提示与无障碍名都带上当前值，否则屏幕阅读器只听到「排序」不知道排的是哪档 */}
            <Dropdown wrapId="sortDD" id="sortSelect" icon="i-sort"
              title={'排序：' + sortLabel} ariaLabel={'排序：' + sortLabel} value={st.sort || 'new'}
              options={sortOpts} onChange={(v) => { if (s.cardsSort) s.cardsSort(v); }} />
            <div className="viewmode vt-view" id="viewMode" role="group" aria-label="视图模式">
              <button className={'viewmode-btn' + (view === 'grid' ? ' active' : '')} type="button" data-mode="grid"
                title="卡片视图" aria-label="卡片视图" onClick={() => { if (s.cardsView) s.cardsView('grid'); }}>
                <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-grid" /></svg>
              </button>
              <button className={'viewmode-btn' + (view === 'list' ? ' active' : '')} type="button" data-mode="list"
                title="列表视图" aria-label="列表视图" onClick={() => { if (s.cardsView) s.cardsView('list'); }}>
                <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-list" /></svg>
              </button>
            </div>
            <button className={'btn btn-ghost btn-sm cards-search-toggle' + (searchOpen ? ' is-on' : '')}
              id="cardsSearchToggle" type="button"
              aria-expanded={searchOpen ? 'true' : 'false'} aria-controls="searchInput"
              title={searchOpen ? '收起搜索' : '搜索'}
              onClick={toggleSearch}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href={searchOpen ? '#i-x' : '#i-search'} /></svg>
            </button>
          </div>
          {/* 搜索：桌面常驻在右簇末端，与文章页同一个位置、同一套胶囊（窄屏收在放大镜后面） */}
          <div className={'search-box page-search vt-search' + (searchOpen ? ' is-open' : '')}>
            <svg className="search-ico" aria-hidden="true" focusable="false"><use href="#i-search" /></svg>
            <input id="searchInput" name="q" type="search" ref={searchRef}
              placeholder="搜索资源名称、描述、正文或标签…（服务端检索）" autoComplete="off" enterKeyHint="search" aria-label="搜索"
              value={qDraft} onChange={onSearchInput}
              onKeyDown={(ev) => {
                if (ev.key === 'Escape') { ev.stopPropagation(); toggleSearch(); return; }
                onSearchKey(ev);
              }} />
            <button className="search-clear" id="searchClear" type="button" hidden={!qDraft}
              aria-label="清除搜索" onClick={onSearchClear}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
            </button>
          </div>
        </div>
      </div>

      <div className="wrap" id="tagBar">
        {tags.length ? (
          <>
            {/* 标签原本是 16 个 span[role=button]，每个都 tabIndex=0 —— 键盘用户要按 16 次 Tab
                才到正文。改成真按钮 + 漫游焦点（roving tabindex）：整组只占 1 个 Tab 停靠点，
                组内用 ← → / Home / End 移动，与标签栏这类「一组同质选项」的惯例一致。 */}
            <div className={'tag-list' + (tagsExpanded ? ' is-open' : '')} role="toolbar" aria-label="标签筛选"
              onKeyDown={onChipKey}>
              <button type="button" className={'tag-chip' + (st.tag ? '' : ' active')} data-tag=""
                ref={(el) => { chipRefs.current[0] = el; }}
                tabIndex={chipIdx === 0 ? 0 : -1} aria-pressed={st.tag ? 'false' : 'true'}
                onClick={() => { setChipIdx(0); onTag(null); }}>全部</button>
              {chipList.map(({ tag, n }, i) => (
                <button type="button" className={'tag-chip' + (st.tag === tag ? ' active' : '')} data-tag={tag} key={tag}
                  ref={(el) => { chipRefs.current[i + 1] = el; }}
                  tabIndex={chipIdx === i + 1 ? 0 : -1}
                  aria-pressed={st.tag === tag ? 'true' : 'false'}
                  onClick={() => { setChipIdx(i + 1); onTag(tag); }}>
                  {tag}<span className="cnt">{n}</span>
                </button>
              ))}
            </div>
            {/* 手机上标签能铺满三四行，把首屏内容挤到下面。折叠成一排，其余收进这枚「+N」 */}
            {chipList.length > 3 ? (
              <button type="button" className={'tag-more' + (tagsExpanded ? ' is-open' : '')}
                aria-expanded={tagsExpanded ? 'true' : 'false'} aria-controls="tagBar"
                title={tagsExpanded ? '收起标签' : '展开全部标签'}
                onClick={() => setTagsExpanded((v) => !v)}>
                {tagsExpanded ? '收起' : `+${chipList.length - 2}`}
              </button>
            ) : null}
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
              ? <Row e={e} onTag={onTag} onOpen={onOpenCard} key={e.id} />
              : <Card e={e} onTag={onTag} onOpen={onOpenCard} key={e.id} />))}
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
