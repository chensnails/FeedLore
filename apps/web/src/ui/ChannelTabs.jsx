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
import React, { useEffect, useRef } from 'react';
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

  const tab = (key, label, active, onClick, title) => (
    <button
      key={key}
      type="button"
      ref={active ? activeRef : undefined}
      className={'chan-tab' + (active ? ' active' : '')}
      aria-pressed={active ? 'true' : 'false'}
      title={title || label}
      onClick={onClick}
    >
      {label}
    </button>
  );

  const feedName = (f) => {
    const full = s.feedTitle ? s.feedTitle(f) : f.title;
    return s.shortFeedName ? s.shortFeedName(full) : full;
  };

  return (
    <nav className="chan-tabs" aria-label="频道切换">
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
      <button type="button" className="chan-tab chan-tabs-more" aria-label="打开完整频道列表"
        title="完整频道列表" onClick={onManage}>
        <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-menu" /></svg>
      </button>
    </nav>
  );
}
