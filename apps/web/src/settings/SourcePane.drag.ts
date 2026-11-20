/* 数据源面板：排序与 Pointer 拖拽。从 SourcePane.controller.ts 抽出，逐字对齐。 */
import type * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityId, Feed } from '../core/types.ts';
import type { DragCtx, DragKind, DropTarget, FeedGroup, GripPayload } from './SourcePane.types.ts';
import { jsonPost, S } from './SourcePane.utils.ts';

/** 拖拽/排序的状态与操作。bump 由主 controller 传入（原地改动后强制重绘）。 */
export function useSourceDrag(opts: { bump: () => void }) {
  const { bump } = opts;
  const [drop, setDrop] = useState<DropTarget>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragCtx | null>(null);
  const moveRef = useRef<((ev: PointerEvent) => void) | null>(null);
  const endRef = useRef<(() => void) | null>(null);
  const lastDragEnd = useRef(0); // 拖拽松手时间戳：250ms 内抑制行点击

  // 按 groupOrder 把分组铺平为全局数组（组内保持相对顺序），并给每组重算 sort_order
  const flattenAndRenumber = useCallback((grouped: FeedGroup[]) => {
    const s = S();
    const order = s.state.groupOrder || [];
    const seq: FeedGroup[] = [];
    for (const n of order) {
      const g = grouped.find((x) => x.name === n);
      if (g) seq.push(g);
    }
    for (const g of grouped) if (order.indexOf(g.name) < 0) seq.push(g);
    const flat: Feed[] = [];
    let so = 0;
    for (const g of seq)
      for (const f of g.feeds || []) {
        f.sortOrder = so++;
        flat.push(f);
      }
    s.state.feedList = flat;
  }, []);

  const persistReorder = useCallback(async () => {
    const s = S();
    const items = (s.state.feedList || []).map((f) => ({
      id: f.id,
      sortOrder: f.sortOrder,
      groupName: f.groupName || '',
    }));
    try {
      await s.apiFetch('/api/feeds/reorder', jsonPost({ feeds: items }));
    } catch (e) {
      console.error('保存排序失败', e);
      if (s.toast) s.toast('排序保存失败');
    }
  }, []);

  const persistGroupOrder = useCallback(async () => {
    try {
      // 分组顺序是「每用户」偏好，走 /api/prefs（普通用户也能保存自己的分组顺序）
      await S().apiFetch('/api/prefs', jsonPost({ groupOrder: S().state.groupOrder }));
    } catch (e) {
      console.error('保存分组顺序失败', e);
    }
  }, []);

  const groupOfRow = useCallback((row: HTMLElement) => {
    const id = row.getAttribute('data-id');
    if (!id) return '';
    const f = (S().state.feedList || []).find((x) => String(x.id) === String(id));
    return f ? f.groupName || '' : '';
  }, []);

  const applyFeedReorder = useCallback(
    (ctx: DragCtx) => {
      const s = S();
      const dragId = ctx.id;
      const grouped: FeedGroup[] = s.groupFeeds(s.state.feedList || []);
      for (const g of grouped) {
        const feeds = g.feeds || [];
        const i = feeds.findIndex((f) => String(f.id) === String(dragId));
        if (i >= 0) {
          feeds.splice(i, 1);
          break;
        }
      }
      const t = ctx.target!;
      let gi = grouped.findIndex((g) => g.name === t.group);
      if (gi < 0) {
        grouped.push({ name: t.group || '', feeds: [] });
        gi = grouped.length - 1;
      }
      const targetFeeds = grouped[gi]!.feeds || [];
      grouped[gi]!.feeds = targetFeeds;
      let idx: number;
      if (t.type === 'head') idx = 0;
      else {
        const tid = t.id;
        idx = targetFeeds.findIndex((f) => String(f.id) === String(tid));
        if (idx < 0) idx = targetFeeds.length;
        else if (!t.before) idx += 1;
      }
      const dragFeed = (s.state.feedList || []).find((f) => String(f.id) === String(dragId));
      if (!dragFeed) return;
      dragFeed.groupName = t.group || '';
      targetFeeds.splice(idx, 0, dragFeed);
      flattenAndRenumber(grouped);
      bump();
      if (s.renderReaderChannels) s.renderReaderChannels();
      if (s.renderFeedSelect) s.renderFeedSelect();
      persistReorder();
    },
    [bump, flattenAndRenumber, persistReorder],
  );
  const applyGroupReorder = useCallback(
    (ctx: DragCtx) => {
      const s = S();
      const order = (s.state.groupOrder || []).slice();
      const i = order.indexOf(ctx.group);
      if (i >= 0) order.splice(i, 1);
      const t = ctx.target!;
      let j = order.indexOf(t.group);
      if (j < 0) j = order.length;
      else if (!t.before) j += 1;
      order.splice(j, 0, ctx.group);
      s.state.groupOrder = order;
      const grouped: FeedGroup[] = s.groupFeeds(s.state.feedList || []);
      flattenAndRenumber(grouped);
      bump();
      if (s.renderReaderChannels) s.renderReaderChannels();
      if (s.renderFeedSelect) s.renderFeedSelect();
      persistReorder();
      persistGroupOrder();
    },
    [bump, flattenAndRenumber, persistGroupOrder, persistReorder],
  );

  // 手动填序号：把某频道排到所在分组的第 N 位（1 基），与拖拽并存。
  // 只在「本组」内调整顺序；跨组仍用拖拽（拖拽会改 groupName）。
  const applyNumericOrder = useCallback(
    (id: EntityId, pos: number) => {
      const s = S();
      if (!Number.isFinite(pos) || pos < 1) {
        bump();
        return;
      } // 非法输入：恢复显示
      const grouped: FeedGroup[] = s.groupFeeds(s.state.feedList || []);
      let src: FeedGroup | null = null;
      for (const g of grouped) {
        const i = (g.feeds || []).findIndex((f) => String(f.id) === String(id));
        if (i >= 0) {
          src = g;
          break;
        }
      }
      if (!src) return;
      const feeds = src.feeds || [];
      src.feeds = feeds;
      const i = feeds.findIndex((f) => String(f.id) === String(id));
      const feed = feeds.splice(i, 1)[0];
      if (!feed) return;
      const p = Math.min(Math.max(1, Math.floor(pos)), feeds.length + 1);
      feeds.splice(p - 1, 0, feed);
      flattenAndRenumber(grouped); // 重算全局 sort_order（组内顺序由它决定）
      bump();
      if (s.renderReaderChannels) s.renderReaderChannels();
      if (s.renderFeedSelect) s.renderFeedSelect();
      persistReorder();
    },
    [bump, flattenAndRenumber, persistReorder],
  );

  /* ---- 拖拽（Pointer 事件，移植自旧实现） ---- */
  const onDragMove = useCallback(
    (ev: PointerEvent) => {
      const ctx = dragRef.current;
      if (!ctx) return;
      if (!ctx.moved) {
        if (Math.hypot(ev.clientX - ctx.x0, ev.clientY - ctx.y0) < 6) return;
        ctx.moved = true;
        setDragging(true);
        document.body.classList.add('is-dragging-feeds');
      }
      ev.preventDefault();
      // 拖动的源元素隐藏命中，便于 elementFromPoint 找到真正的放置目标
      if (ctx.el) ctx.el.style.pointerEvents = 'none';
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!under) {
        ctx.target = null;
        setDrop(null);
        return;
      }
      if (ctx.kind === 'feed') {
        const row = under.closest('.feed-row');
        const head = under.closest('.feed-group-head');
        let elm = null,
          before = true,
          group = '';
        if (row && ctx.el && !row.contains(ctx.el)) {
          const r = row.getBoundingClientRect();
          before = ev.clientY < r.top + r.height / 2;
          elm = row;
          group = groupOfRow(row as HTMLElement);
        } else if (head && ctx.el && !head.contains(ctx.el)) {
          elm = head;
          group = head.getAttribute('data-group') || '';
          before = true;
        }
        if (!elm) {
          ctx.target = null;
          setDrop(null);
          return;
        }
        ctx.target = {
          type: elm === head ? 'head' : 'row',
          id: elm.getAttribute('data-id') || '',
          group,
          before,
        };
        setDrop(ctx.target);
      } else {
        const head = under.closest('.feed-group-head');
        let elm = null,
          before = true;
        if (head && ctx.el && !head.contains(ctx.el)) {
          const r = head.getBoundingClientRect();
          before = ev.clientY < r.top + r.height / 2;
          elm = head;
        }
        if (!elm) {
          ctx.target = null;
          setDrop(null);
          return;
        }
        ctx.target = {
          type: 'group',
          id: '',
          group: elm.getAttribute('data-group') || '',
          before,
        };
        setDrop(ctx.target);
      }
    },
    [groupOfRow],
  );

  const onDragEnd = useCallback(() => {
    const mv = moveRef.current;
    if (mv) document.removeEventListener('pointermove', mv);
    const ed = endRef.current;
    if (ed) {
      document.removeEventListener('pointerup', ed);
      document.removeEventListener('pointercancel', ed);
    }
    document.body.classList.remove('is-dragging-feeds');
    const ctx = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    setDrop(null);
    if (ctx && ctx.el) ctx.el.style.pointerEvents = '';
    if (!ctx || !ctx.moved) return;
    lastDragEnd.current = Date.now(); // 松手后短暂抑制行点击，避免误开详情层
    if (!ctx.target) return;
    if (ctx.kind === 'feed') applyFeedReorder(ctx);
    else applyGroupReorder(ctx);
  }, [applyFeedReorder, applyGroupReorder]);

  moveRef.current = onDragMove;
  endRef.current = onDragEnd;

  const onGripDown = (
    ev: React.PointerEvent<HTMLElement>,
    kind: DragKind,
    payload: GripPayload,
  ) => {
    if (ev.button != null && ev.button !== 0) return;
    if (kind === 'group' && payload.group === '') return; // 「未分组」不可拖动（仍可作放置目标）
    const el = (ev.target as HTMLElement).closest(
      kind === 'feed' ? '.feed-row' : '.feed-group-head',
    );
    if (!el) return;
    ev.preventDefault();
    dragRef.current = {
      kind,
      id: payload.id == null ? '' : String(payload.id),
      group: payload.group || '',
      el: el as HTMLElement,
      x0: ev.clientX,
      y0: ev.clientY,
      moved: false,
      target: null,
    };
    const mv = moveRef.current;
    if (mv) document.addEventListener('pointermove', mv, { passive: false });
    const ed = endRef.current;
    if (ed) {
      document.addEventListener('pointerup', ed);
      document.addEventListener('pointercancel', ed);
    }
  };

  useEffect(() => {
    document.body.classList.toggle('is-dragging-feeds', dragging);
    return () => document.body.classList.remove('is-dragging-feeds');
  }, [dragging]);

  return {
    drop,
    setDrop,
    dragging,
    lastDragEnd,
    dragRef,
    moveRef,
    endRef,
    onGripDown,
    applyNumericOrder,
  };
}
