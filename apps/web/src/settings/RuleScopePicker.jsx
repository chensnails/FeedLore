import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NO_AUTOFILL_PROPS, useNoAutofillName } from '../ui/noAutofill.js';

/**
 * 规则的适用范围选择器（v2.10.0）。
 *
 * 语义（与服务端 lib/scope.ts 一致）：
 *  - 老规则没有 scope 字段 → 全部频道；
 *  - 勾「全部频道」→ { all: true }；
 *  - 一个都不勾 → 规则不生效（用户明确要求的严格语义，不偷偷当成全部）；
 *  - 分组按名称动态跟随：以后加进该分组的频道自动纳入。
 *
 * 弹层挂到 body（settings 的滚动容器会裁掉绝对定位的子元素），
 * 窄屏由 CSS 改成底部整宽面板。
 */

export const emptyScope = () => ({ all: false, groups: [], feeds: [] });
export const allScope = () => ({ all: true, groups: [], feeds: [] });

export function normalizeScope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return allScope();
  if (raw.all === true) return allScope();
  return {
    all: false,
    groups: Array.isArray(raw.groups) ? raw.groups.filter((g) => typeof g === 'string') : [],
    feeds: Array.isArray(raw.feeds)
      ? raw.feeds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [],
  };
}

export function scopeIsEmpty(scope) {
  const s = normalizeScope(scope);
  return !s.all && !s.groups.length && !s.feeds.length;
}

export function scopeSummary(scope) {
  const s = normalizeScope(scope);
  if (s.all) return '全部频道';
  const parts = [];
  if (s.groups.length) parts.push(`${s.groups.length} 个分组`);
  if (s.feeds.length) parts.push(`${s.feeds.length} 个频道`);
  return parts.length ? parts.join(' · ') : '未选择（不生效）';
}

const feedName = (f) => f.customTitle || f.title || f.url || '未命名频道';

export function RuleScopePicker({ value, onChange, feeds = [], groupOrder = [], compact = false }) {
  const scope = normalizeScope(value);
  const searchName = useNoAutofillName('scope-q');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const triggerRef = useRef(null);
  const inputRef = useRef(null);

  const groups = useMemo(() => {
    const map = new Map();
    for (const f of feeds) {
      const name = f.groupName || '';
      const list = map.get(name);
      if (list) list.push(f);
      else map.set(name, [f]);
    }
    const names = [];
    for (const n of groupOrder) {
      if (map.has(n) && !names.includes(n)) names.push(n);
    }
    for (const n of map.keys()) {
      if (!names.includes(n)) names.push(n);
    }
    return names.map((name) => ({ name, feeds: map.get(name) }));
  }, [feeds, groupOrder]);

  const query = q.trim().toLowerCase();
  const visibleGroups = groups.map((g) => {
    const label = g.name || '未分组';
    if (!query) return { ...g, feeds: g.feeds, nameHit: false };
    const nameHit = label.toLowerCase().includes(query);
    const hitFeeds = g.feeds.filter((f) => [feedName(f), f.url, label]
      .some((t) => String(t || '').toLowerCase().includes(query)));
    if (!nameHit && !hitFeeds.length) return null;
    return { ...g, feeds: nameHit ? g.feeds : hitFeeds, nameHit };
  }).filter(Boolean);

  // 打开时把已选的频道展开，别让「已选 3 个」藏在折叠里
  useEffect(() => {
    if (!open) { setQ(''); return; }
    const next = new Set();
    for (const g of groups) {
      if (scope.feeds.some((id) => g.feeds.some((f) => Number(f.id) === Number(id)))) next.add(g.name);
    }
    setExpanded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = triggerRef.current && triggerRef.current.getBoundingClientRect();
      if (!r) return;
      // 触发按钮被滚出可视区（弹层在 body 上，不会跟着走）就收起，别留一块悬空面板
      // 无布局环境（jsdom）矩形恒为 0，此时跳过判定
      if ((r.width || r.height) && (r.bottom < 8 || r.top > window.innerHeight - 8)) { setOpen(false); return; }
      const w = Math.min(320, window.innerWidth - 16);
      const x = compact
        ? Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))
        : Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
      const h = Math.min(420, window.innerHeight * 0.6);
      const below = r.bottom + 6;
      const y = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
      setPos({ x, y });
    };
    place();
    // settings 的滚动发生在 .pane-scroll 上，滚动事件不冒泡；用捕获阶段接管。
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; place(); });
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
    // compact 只影响左右对齐
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, compact]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (ev) => {
      if (wrapRef.current && wrapRef.current.contains(ev.target)) return;
      if (popRef.current && popRef.current.contains(ev.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => { if (inputRef.current) inputRef.current.focus(); }, 0);
    return () => clearTimeout(t);
  }, [open]);

  const commit = (groupsNext, feedsNext) => onChange({ all: false, groups: groupsNext, feeds: feedsNext });

  const toggleAll = (on) => {
    onChange(on ? allScope() : emptyScope());
    if (!on) setExpanded(new Set());
  };

  const toggleGroup = (name) => {
    const groupsNext = scope.groups.includes(name)
      ? scope.groups.filter((g) => g !== name)
      : scope.groups.concat([name]);
    commit(groupsNext, scope.feeds);
  };

  const toggleFeed = (id) => {
    const feedsNext = scope.feeds.includes(id)
      ? scope.feeds.filter((n) => n !== id)
      : scope.feeds.concat([id]);
    commit(scope.groups, feedsNext);
  };

  const toggleExpand = (name) => {
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const summary = scopeSummary(scope);
  const empty = scopeIsEmpty(scope);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className={'rule-scope-btn' + (compact ? ' compact' : '') + (empty ? ' is-empty' : '')}
      aria-haspopup="dialog"
      aria-expanded={open ? 'true' : 'false'}
      title={empty ? '未选择适用范围，这条规则不会生效' : `适用范围：${summary}`}
      onClick={() => setOpen((v) => !v)}
    >
      <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-filter" /></svg>
      {compact ? null : <span className="rule-scope-btn-label">适用范围</span>}
      <span className="rule-scope-btn-value">{summary}</span>
      <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-chevron-down" /></svg>
    </button>
  );

  const panel = open ? createPortal(
    <div
      ref={popRef}
      className={'rule-scope-pop' + (compact ? ' compact' : '')}
      role="dialog"
      aria-label="选择适用范围"
      style={{ '--scope-x': pos.x + 'px', '--scope-y': pos.y + 'px' }}
      onKeyDown={(ev) => {
        if (ev.key !== 'Escape') return;
        ev.stopPropagation();
        setOpen(false);
      }}
    >
      <div className="rule-scope-search">
        <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-search" /></svg>
        <input
          ref={inputRef}
          type="search"
          name={searchName}
          value={q}
          placeholder="搜索分组 / 频道"
          aria-label="搜索分组或频道"
          onChange={(ev) => setQ(ev.target.value)}
          {...NO_AUTOFILL_PROPS}
        />
      </div>

      <div className="rule-scope-list">
        <label className="rule-scope-all">
          <input type="checkbox" checked={scope.all} onChange={(ev) => toggleAll(ev.target.checked)} />
          <span className="rule-scope-name">全部频道</span>
          <span className="rule-scope-hint">含以后新增的频道</span>
        </label>

        {!scope.all && visibleGroups.map((g) => {
          const groupOn = scope.groups.includes(g.name);
          const isOpen = !!query || expanded.has(g.name);
          return (
            <div className="rule-scope-group" key={g.name || '__ungrouped'}>
              <div className="rule-scope-group-row">
                <button
                  type="button"
                  className="rule-scope-caret"
                  aria-expanded={isOpen ? 'true' : 'false'}
                  aria-label={(isOpen ? '收起' : '展开') + `分组「${g.name || '未分组'}」`}
                  onClick={() => toggleExpand(g.name)}
                >
                  <svg className="ico" aria-hidden="true" focusable="false">
                    <use href={isOpen ? '#i-chevron-down' : '#i-chevron-right'} />
                  </svg>
                </button>
                <label className="rule-scope-check">
                  <input type="checkbox" checked={groupOn} onChange={() => toggleGroup(g.name)} />
                  <span className="rule-scope-name">{g.name || '未分组'}</span>
                  <span className="rule-scope-count">{g.feeds.length}</span>
                </label>
              </div>
              {isOpen ? (
                <div className="rule-scope-feeds">
                  {g.feeds.map((f) => {
                    const id = Number(f.id);
                    const on = groupOn || scope.feeds.includes(id);
                    return (
                      <label className="rule-scope-feed" key={f.id}>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={groupOn}
                          onChange={() => toggleFeed(id)}
                        />
                        <span className="rule-scope-name">{feedName(f)}</span>
                        {groupOn ? <span className="rule-scope-hint">整组已选</span> : null}
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}

        {!scope.all && !visibleGroups.length ? (
          <div className="rule-scope-none">没有匹配的频道</div>
        ) : null}
      </div>

      {empty ? <div className="rule-scope-warn">一个都没选，这条规则不会生效。</div> : null}

      <div className="rule-scope-foot">
        <span className="rule-scope-foot-tip">
          勾分组会覆盖整组（含以后新加入的频道）；只选其中几个频道就展开逐条勾。
        </span>
        <span className="rule-scope-foot-actions">
          <button type="button" className="btn btn-ghost btn-sm"
            onClick={() => { onChange(emptyScope()); setExpanded(new Set()); }}>清空</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(false)}>完成</button>
        </span>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div className="rule-scope-wrap" ref={wrapRef}>
      {trigger}
      {panel}
    </div>
  );
}
