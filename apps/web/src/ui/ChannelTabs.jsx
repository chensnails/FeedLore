/* 移动端横滑频道条（v2.5.0）
 * ------------------------------------------------------------
 * 手机上一屏只看得见一个频道名（顶栏标题），换频道要拉抽屉、滚到目标、再点。
 * 这里把「全部 / 未读 / 收藏 / 关注 + 各频道」铺成一条可横滑的标签带，
 * 一级频道一步可达；抽屉不删 —— 它仍是完整树（分组折叠、未读计数、添加频道）。
 *
 * 状态与抽屉完全同源：都读 state.rdScope / rdFeedId / rdGroup / rdWatch，
 * 都调同一个 setter，所以从标签条选完，抽屉里的高亮同步跟着变，不存在第二套筛选。
 * 只在 ≤720px 显示（CSS 控制），桌面继续用常驻侧栏。
 */
import React, { useEffect, useRef, useState } from 'react';
import { core } from '@core';

const S = () => core;

export function ChannelTabs({
  variant = 'reader',
  groups = [],
  activeScope = null,
  activeFeedId = null,
  activeGroup = null,
  activeWatch = null,
  onScope,
  onFeed,
  onWatch,
  onManage,
}) {
  const s = S();
  const isReader = variant === 'reader';
  const activeRef = useRef(null);
  const navRef = useRef(null);
  const [atEnd, setAtEnd] = useState(false);

  // 分组里的频道摊平：标签条是一维的，分组层级留在抽屉里
  const feeds = [];
  for (const g of groups || []) for (const f of g.feeds || []) feeds.push(f);

  // 卡片页的「全部」是空字符串（cardsFilterFeed 的约定），两种空值按同一个语义算
  const feedId = activeFeedId == null || activeFeedId === '' ? null : activeFeedId;
  const baseAll = feedId == null;
  const scopeOn = (key) => baseAll && activeWatch == null && activeScope === key;
  const watchOn = (key) => baseAll && activeGroup == null && activeWatch === key;

  // 分组筛选在抽屉里选，标签条上没有对应项：仍把「全部」标上，
  // 否则整条看起来一个选中项都没有，像是筛选丢了。
  let activeKey = baseAll && activeWatch == null ? 'scope:' + (isReader ? activeScope : 'all') : null;
  if (activeWatch) activeKey = 'watch:' + activeWatch;
  if (feedId != null) activeKey = 'feed:' + feedId;

  // 选中项可能在横向滚动区外（默认停在「全部」）：每次切换把它滚到中间。
  // block:'nearest' 是必须的 —— 不写的话部分浏览器会顺带纵向滚动整页。
  useEffect(() => {
    const el = activeRef.current;
    if (el && typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (_) { /* 老浏览器忽略 */ }
    }
  }, [activeKey]);

  /* 右缘渐隐只在「右侧还有内容」时出现；滚到末尾就撤掉，否则最后一个标签
     和「更多」按钮会一直灰着一截。滚动条本身是隐藏的，渐隐是唯一的可发现性提示。 */
  useEffect(() => {
    const el = navRef.current;
    if (!el) return undefined;
    const update = () => setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [feeds.length]);

  /* 标签条用 roving tabindex：Tab 一次进入，方向键在频道间移动并直接切换，
     不再让键盘用户逐个穿过几十个频道才能到达末尾的「完整频道列表」。 */
  const rovingKey = activeKey || 'scope:all';
  const onKeyDown = (ev) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
    const tabs = Array.from(ev.currentTarget.querySelectorAll('.chan-tab'));
    const idx = tabs.indexOf(document.activeElement);
    if (idx < 0 || !tabs.length) return;
    ev.preventDefault();
    let next = idx;
    if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = tabs.length - 1;
    else next = Math.max(0, Math.min(tabs.length - 1, idx + (ev.key === 'ArrowRight' ? 1 : -1)));
    tabs[next].focus();
    tabs[next].click();
  };

  // 再点当前项：筛选条件没变，重设状态不会重绘列表 —— 顺手把视线带回顶部，
  // 与底部视图导航的 retap 同一套手感。换项时仍走原来的 setter（会自己回顶）。
  const activate = (active, run) => () => {
    if (active) {
      const api = S();
      if (api.scrollTop) api.scrollTop();
    }
    if (run) run();
  };

  const tab = (key, label, active, onClick, title) => (
    <button
      key={key}
      type="button"
      ref={active ? activeRef : undefined}
      className={'chan-tab' + (active ? ' active' : '')}
      aria-pressed={active ? 'true' : 'false'}
      tabIndex={key === rovingKey ? 0 : -1}
      title={title || label}
      onClick={activate(active, onClick)}
    >
      {label}
    </button>
  );

  const feedName = (f) => {
    const full = s.feedTitle ? s.feedTitle(f) : f.title;
    return s.shortFeedName ? s.shortFeedName(full) : full;
  };

  return (
    <nav ref={navRef} className={'chan-tabs' + (atEnd ? ' at-end' : '')}
      aria-label="频道切换，可横向滚动，方向键可换频道" onKeyDown={onKeyDown}>
      {isReader
        ? tab('scope:all', '全部', scopeOn('all'), () => onScope && onScope('all'))
        : tab('scope:all', '全部', baseAll, () => onFeed && onFeed(null))}
      {isReader ? (
        <>
          {tab('scope:unread', '未读', scopeOn('unread'), () => onScope && onScope('unread'))}
          {tab('scope:favorite', '收藏', scopeOn('favorite'), () => onScope && onScope('favorite'))}
          {tab('watch:watch', '关注', watchOn('watch'), () => onWatch && onWatch('watch'))}
        </>
      ) : null}
      {feeds.map((f) => tab(
        'feed:' + f.id,
        feedName(f),
        feedId != null && String(feedId) === String(f.id),
        () => onFeed && onFeed(f.id),
        f.enabled === false ? `${feedName(f)}（已停止采集）` : feedName(f),
      ))}
      <button type="button" className="chan-tab chan-tabs-more" tabIndex={-1}
        aria-label={`打开完整频道列表，共 ${feeds.length} 个订阅频道`}
        title="完整频道列表" onClick={onManage}>
        <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-menu" /></svg>
        <span className="chan-tabs-more-n">{feeds.length}</span>
      </button>
    </nav>
  );
}
