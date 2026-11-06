/* 频道列表（v1.3.10）：文章页左侧栏与卡片页抽屉共用这一份实现。
 *
 * 此前两页各写了一遍 —— 文章页 81 行（带「全部文章 / 未读 / 收藏」三个范围行、
 * 分组未读数、分组漏斗），卡片页 59 行（只有「全部频道 + 总数」）。类名同为 .rd-ch-*，
 * 也就是说视觉上本来就该一样，却是两套会各自漂移的代码：加个「已停止采集」标记、
 * 改一次头像回退、换个计数口径，都得改两处，漏一处就是两页不一致。
 *
 * 这里合成一份，差异收敛成一个 variant：
 *   reader —— 三个范围行 + 分组未读数 + 分组漏斗（只看这组）
 *   cards  —— 单行「全部频道」+ 每频道未读数（分组漏斗同样可用）
 * 两页的频道 / 分组计数统一按未读算（与文章页一致）；总条数退到悬停提示里。
 *
 * DOM 结构、类名、data-* 属性与合并前逐字一致（样式与旧逻辑零改动）。
 */

import { core } from '@core';
import { memo, useDeferredValue, useState } from 'react';
import { ChannelAvatar } from './ChannelAvatar.jsx';
import { NO_AUTOFILL_PROPS, useNoAutofillName } from '../ui/noAutofill.js';

const S = () => core;

const Icon = ({ n }) => (
  <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + n} /></svg>
);

export const ChannelList = memo(function ChannelList({
  variant = 'reader',
  groups = [],
  hasGroups = false,
  collapsed = new Set(),
  onFold,
  activeScope = null,
  activeFeedId = null,
  activeGroup = null,
  activeWatch = null,      // 关注 / 屏蔽虚拟视图（v21）：null | 'watch' | 'block'
  flags = null,            // reader：{ total, unread, favorite, watching, blocked }
  onScope,
  onFeed,
  onGroup,
  onWatch,
  onAdd,
}) {
  const s = S();
  const searchName = useNoAutofillName('channel-q');
  const isReader = variant === 'reader';
  const writable = !(s && s.state && s.state.role === 'readonly');
  // 「全部」高亮的判据两页一致：既没挑频道、也没锁分组
  const atAll = activeFeedId == null && activeGroup == null;

  // 频道内搜索（本地态，两页抽屉共用）：按频道名过滤，命中即展开分组
  const [q, setQ] = useState('');
  // C：频道内搜索防抖（React 19 useDeferredValue）—— 输入框即时响应，过滤重算延迟到绘制后，
  // 避免每敲一字就同步重算整条侧栏（频道 × 分组）造成卡顿
  const qDeferred = useDeferredValue(q);
  const ql = qDeferred.trim().toLowerCase();
  const collapsedView = ql ? new Set() : collapsed;
  const groupsView = ql
    ? groups.map((g) => ({ ...g, feeds: g.feeds.filter((f) => (titleOf(f) || '').toLowerCase().includes(ql)) }))
      .filter((g) => g.feeds.length > 0)
    : groups;

  const nameOf = (f) => (s.shortFeedName ? s.shortFeedName(s.feedTitle ? s.feedTitle(f) : f.title) : f.title);
  const titleOf = (f) => (s.feedTitle ? s.feedTitle(f) : f.title);

  // 卡片页「全部频道」：徽标是未读总数，总量留到悬停提示（与单频道徽标同口径）
  const cardUnread = groups.reduce((n, g) => n + g.feeds.reduce((m, f) => m + Number(f.unreadCount || 0), 0), 0);
  const cardTotal = groups.reduce((n, g) => n + g.feeds.reduce((m, f) => m + Number(f.entryCount || 0), 0), 0);

  // 关注/屏蔽视图下 rdScope 仍是 'all'，范围行不能跟着高亮（两行同时 active 会误导）
  const scopeBtn = (key, ico, name, n, cls) => (
    <button className={'rd-ch' + (atAll && activeWatch == null && activeScope === key ? ' active' : '')}
      type="button" data-scope={key} aria-pressed={activeScope === key && atAll && activeWatch == null ? 'true' : 'false'}
      onClick={() => onScope && onScope(key)}>
      <span className={'rd-ch-avatar ' + cls}><Icon n={ico} /></span>
      <span className="rd-ch-name">{name}</span>
      {n > 0 ? <span className="rd-ch-n">{s.fmtBadge(n)}</span> : null}
    </button>
  );

  // 关注 / 屏蔽虚拟视图（v21）：与范围行同款视觉，但语义是「规则命中的聚合视图」，
  // 激活条件看 activeWatch 而不是 activeScope —— 两套状态，互不覆盖。
  const watchBtn = (key, ico, name, n, cls) => (
    <button className={'rd-ch' + (atAll && activeGroup == null && activeWatch === key ? ' active' : '')}
      type="button" data-watch={key} aria-pressed={activeWatch === key && atAll ? 'true' : 'false'}
      title={key === 'watch' ? '规则命中的文章（在设置 → 规则里配置）' : '被规则屏蔽的文章（已自动标为已读）'}
      onClick={() => onWatch && onWatch(key)}>
      <span className={'rd-ch-avatar ' + cls}><Icon n={ico} /></span>
      <span className="rd-ch-name">{name}</span>
      {n > 0 ? <span className="rd-ch-n">{s.fmtBadge(n)}</span> : null}
    </button>
  );

  return (
    <>
      <div className="rd-ch-search" role="search">
        <svg className="rd-ch-search-ico" aria-hidden="true" focusable="false"><use href="#i-search" /></svg>
        <input type="search" className="rd-ch-search-input" name={searchName}
          placeholder="搜索频道…" aria-label="搜索频道"
          value={q} onChange={(e) => setQ(e.target.value)} {...NO_AUTOFILL_PROPS} />
        {q ? (
          <button type="button" className="rd-ch-search-clear" aria-label="清除搜索" onClick={() => setQ('')}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
          </button>
        ) : null}
      </div>
      {isReader ? (
        <>
          {scopeBtn('all', 'circle', '全部文章', flags ? flags.total : 0, 'rd-ch-avatar-all')}
          {scopeBtn('unread', 'dot', '未读', flags ? flags.unread : 0, 'rd-ch-avatar-unread')}
          {scopeBtn('favorite', 'star', '收藏', flags ? flags.favorite : 0, 'rd-ch-avatar-fav')}
          {watchBtn('watch', 'eye', '关注', flags ? flags.watching : 0, 'rd-ch-avatar-watch')}
        </>
      ) : (
        <button className={'rd-ch' + (atAll ? ' active' : '')} type="button" data-feed=""
          aria-pressed={atAll ? 'true' : 'false'} onClick={() => onFeed && onFeed(null)}>
          <span className="rd-ch-avatar rd-ch-avatar-all"><Icon n="grid" /></span>
          <span className="rd-ch-name">全部频道</span>
          {cardUnread > 0 ? (
            <span className="rd-ch-n hot" title={`${cardUnread} 条未读 / 共 ${cardTotal} 条资源`}>{s.fmtBadge(cardUnread)}</span>
          ) : null}
        </button>
      )}
      <div className="rd-ch-sep" aria-hidden="true" />

      {groupsView.map((g) => {
        const gname = g.name || '';
        const isCollapsed = collapsedView.has(gname);
        const gUnread = g.feeds.reduce((sum, x) => sum + Number(x.unreadCount || 0), 0);
        // 收起的分组里若正看着其中一条，只留那一条 —— 别让「收起」把当前频道变没，
        // 也不该把整组都放出来（那就等于没收起）
        const shown = isCollapsed
          ? (activeFeedId == null ? [] : g.feeds.filter((f) => String(f.id) === String(activeFeedId)))
          : g.feeds;
        return (
          <div key={'g:' + gname}>
            {hasGroups ? (
              <div className={'rd-ch-group-row' + (isCollapsed ? ' is-collapsed' : '')
                + (activeGroup === gname ? ' is-filtered' : '')}>
                {/* 整行就是折叠开关：收起/展开是高频动作，命中区不该只有左侧那 18px 箭头。
                    箭头降成状态指示，「只看这组」让位给右侧的漏斗按钮（两页一致）。 */}
                <button type="button" className={'rd-ch-group' + (gname ? '' : ' muted')}
                  data-group={gname} data-group-fold={gname}
                  aria-expanded={isCollapsed ? 'false' : 'true'}
                  title={(isCollapsed ? '展开' : '收起') + `分组「${gname || '未分组'}」`}
                  onClick={() => onFold && onFold(gname)}>
                  <svg className="ico rd-ch-caret" aria-hidden="true" focusable="false">
                    <use href={isCollapsed ? '#i-chevron-right' : '#i-chevron-down'} />
                  </svg>
                  <span className="rd-ch-group-name">{gname || '未分组'}</span>
                  {gUnread > 0
                    ? <span className="rd-ch-n hot" title={`${gUnread} 条未读`}>{s.fmtBadge(gUnread)}</span>
                    : isCollapsed
                      ? <span className="rd-ch-group-n" title={`该分组 ${g.feeds.length} 个频道，全部已读`}>{s.fmtBadge(g.feeds.length)}</span>
                      : <span className="rd-ch-group-empty" aria-hidden="true"><svg className="ico" focusable="false"><use href="#i-check" /></svg></span>}
                </button>
                {onGroup ? (
                  /* 低频动作平时隐身，悬停 / 键盘聚焦 / 正在筛选该组时才现身（触屏常显在 CSS 里） */
                  <button type="button" className={'rd-ch-filter' + (activeGroup === gname ? ' is-active' : '')}
                    data-group-filter={gname}
                    aria-pressed={activeGroup === gname ? 'true' : 'false'}
                    title={`只看「${gname || '未分组'}」分组下的${isReader ? '文章' : '卡片'}`}
                    onClick={() => onGroup(gname)}>
                    <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-filter" /></svg>
                  </button>
                ) : null}
              </div>
            ) : null}
            {shown.map((f) => {
              const title = titleOf(f);
              const name = nameOf(f);
              const tip = f.enabled ? title : `${title}（已停止采集）`;
              // 两页同口径：徽标只报未读，总条数放在悬停提示里
              const count = Number(f.unreadCount || 0);
              const active = activeFeedId != null && String(activeFeedId) === String(f.id);
              return (
                <button key={f.id} className={'rd-ch' + (f.enabled ? '' : ' off') + (active ? ' active' : '')}
                  type="button" data-feed={f.id} aria-pressed={active ? 'true' : 'false'}
                  onClick={() => onFeed && onFeed(f.id)}>
                  <ChannelAvatar icon={f.icon} name={name} />
                  <span className="rd-ch-name" title={tip}>{name}</span>
                  {count > 0 ? (
                    <span className="rd-ch-n hot"
                      title={`${count} 条未读 / 共 ${Number(f.entryCount || 0)} 条`}>
                      {s.fmtBadge(count)}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        );
      })}

      {groupsView.length === 0 && ql ? (
        <div className="rd-ch-empty">没有匹配的频道</div>
      ) : null}

      {/* 屏蔽（v21）：置底收纳 —— 隔一条分隔线放在频道栏最末尾，
          与「关注」分开是刻意的：屏蔽是被规则挡住的内容，不该和正常入口混排。
          命中即已自动标为已读，这里只做「想看看挡了什么」的入口。 */}
      {isReader ? (
        <>
          <div className="rd-ch-sep" aria-hidden="true" />
          {watchBtn('block', 'block', '屏蔽', flags ? flags.blocked : 0, 'rd-ch-avatar-block')}
        </>
      ) : null}

      {writable ? (
        <button type="button" className="rd-ch-add" data-action="open-source" onClick={() => onAdd && onAdd()}>
          <svg className="rd-ch-add-ico" aria-hidden="true" focusable="false"><use href="#i-plus" /></svg>
          <span>添加频道</span>
        </button>
      ) : null}
    </>
  );
});
