/* 卡片详情弹窗（点击卡片页的卡片后展示整条内容）。
 *
 * 弹层形态沿用 src/views/Dropdown.jsx 的既有约定，不新增第二套弹层语言：
 * - 桌面（>720px）：遮罩 + 居中模态，复用 .modal-mask / .modal 一族；
 * - 移动（≤720px）：v1.3.4 起整屏铺开（.dd-sheet 在窄屏就是一整屏），从下方推入像进入一个页面；
 *   整屏没有「点遮罩关闭」这回事，出口是右上角悬浮 ×、Esc，以及往下拖（useSwipeDismiss）。
 * 形态在打开瞬间定格，本次开合内不随窗口变化重排。
 *
 * 正文渲染直接复用文章页的 ArtBody / CopyButton / OpenButton（同一套 .art-* 样式），
 * 两处展示保持一份实现。打开弹窗即把该条记为已读：卡片页不显示已读态，
 * 状态只体现在文章页（同一批 entries 行），逻辑见 core 的 cardsDetailRead。
 *
 * 弹窗只剩正文一种语言（v1.3.3，用户要求）：标题栏和底栏都撤掉，收藏与「在文章页查看」
 * 并进正文底部的动作行，和复制 / 打开并排成四个同尺寸图标按钮。
 * 因此这里刻意不再列频道 / 大小 / 日期 / 提取码（v1.3.2），也不再渲染标题（v1.3.3）：
 * 这些信息正文里本来就有（ArtBody 自带「发布时间」，提取码与大小来自正文解析出的行），
 * 卡片页的卡面在弹窗背后也已经写着标题。别把它们当漏掉的功能加回来。
 */

import { core } from '@core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isMobileMq } from './Dropdown.jsx';
import { useSwipeDismiss } from './useSwipeDismiss.js';
import { ArtBody, bodyShowsText, CopyButton, OpenButton } from './ReaderView.jsx';

const S = () => core;

const Icon = ({ n }) => (
  <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + n} /></svg>
);

/** 有没有正文可展示：图文块、正文文本、正文图片三者有其一即可 */
function hasBody(f) {
  if (!f) return false;
  if (f.bodyJson) {
    try {
      const a = JSON.parse(f.bodyJson);
      if (Array.isArray(a) && a.length) return true;
    } catch (_) { /* 不是块数组就继续看其它字段 */ }
  }
  if (String(f.content || '').trim()) return true;
  if (f.image) return true;
  return Array.isArray(f.images) && f.images.length > 0;
}

export function CardDetail({ e, onClose, onTag }) {
  const s = S();
  const [full, setFull] = useState(null);
  const [err, setErr] = useState(false);
  // 打开瞬间定格形态（与 Dropdown 同一约定），避免开合途中换布局
  const [mobile] = useState(isMobileMq());
  const closeRef = useRef(null);
  // CardsView 每次重绘都会传新的 onClose；存进 ref，避免它进入 effect 依赖导致重复拉正文 / 重复锁滚动
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let dead = false;
    const c = S();
    if (c.cardsDetailRead) c.cardsDetailRead(e.id);
    if (c.lockPageScroll) c.lockPageScroll();
    const onKey = (ev) => { if (ev.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    if (closeRef.current) closeRef.current.focus();
    c.apiFetch('/api/entries/' + encodeURIComponent(e.id))
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then((d) => { if (!dead) setFull(d); })
      .catch(() => { if (!dead) setErr(true); });
    return () => {
      dead = true;
      document.removeEventListener('keydown', onKey);
      if (c.unlockPageScroll) c.unlockPageScroll();
    };
  }, [e.id]);

  const fav = !!e.isFavorite;
  const toggleFav = () => {
    const next = !fav;
    s.cardsSetFlag(e.id, { isFavorite: next }).then((ok) => {
      if (ok) s.toast(next ? '已收藏' : '已取消收藏');
    });
  };

  const toReader = () => {
    s.jumpToFeed(e.feedId);
    onClose();
  };

  const showBody = !!full && hasBody(full);
  /* 摘要与正文同源（rss.js 里 desc 就是 content 压平换行得来的），正文区自己会渲染文字时
   * 再列一行摘要就是把同一段话摆两遍，所以只在正文区没有文字（纯图正文 / 无正文）时才列摘要。 */
  const descIsSummary = showBody && !bodyShowsText(full);

  /* 与 CopyButton / OpenButton 并排的另两个动作：只做图标，靠 title + aria-label 说明。
   * 图标沿用顶栏语义（收藏 ★ / 文章页 = inbox），不新造第三套符号。 */
  const extraActions = (
    <>
      <button type="button" className={'btn-fav' + (fav ? ' is-fav' : '')} onClick={toggleFav}
        aria-pressed={fav ? 'true' : 'false'} title={fav ? '取消收藏' : '收藏'}
        aria-label={fav ? '取消收藏' : '收藏'}>
        <Icon n={fav ? 'star' : 'star-o'} />
      </button>
      <button type="button" className="btn-jump" onClick={toReader} title="在文章页查看" aria-label="在文章页查看">
        <Icon n="inbox" />
      </button>
    </>
  );

  const closeBtn = (
    <button type="button" className="modal-close cd-close" ref={closeRef} aria-label="关闭详情" onClick={onClose}>
      <Icon n="x" />
    </button>
  );

  // 往下拖即可收起（整屏没有遮罩可点，这个手势 + × + Esc 是全部出口）
  const dismiss = useCallback(() => onCloseRef.current(), []);
  const { panelRef: sheetRef, handlers: sheetHandlers } = useSwipeDismiss(dismiss);

  const dialogLabel = e.name || '条目详情';

  let inner = null;
  if (err) inner = <div className="hint">正文加载失败，刷新页面重试</div>;
  else if (!full) inner = <div className="art-loading"><i /><i /><i /></div>;
  else if (showBody) inner = <div className="art-body cd-art"><ArtBody e={full} onTag={onTag} extraActions={extraActions} /></div>;
  else inner = (
    <div className="cd-none">
      {e.desc ? <p className="cd-desc">{e.desc}</p> : null}
      <div className="art-actions"><CopyButton e={e} /><OpenButton e={e} />{extraActions}</div>
    </div>
  );

  if (mobile) {
    return (
      <div className="dd-mask" onClick={onClose}>
        <div ref={sheetRef} className="dd-sheet cd-modal" role="dialog" aria-modal="true"
          aria-label={dialogLabel} onClick={(ev) => ev.stopPropagation()} {...sheetHandlers}>
          <div className="dd-sheet-grip" aria-hidden="true" />
          {closeBtn}
          <div className="dd-sheet-body cd-body">
            {descIsSummary ? <p className="cd-desc">{e.desc}</p> : null}
            {inner}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-mask" onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div className="modal cd-modal" role="dialog" aria-modal="true" aria-label={dialogLabel}>
        {closeBtn}
        <div className="modal-body">
          <div className="cd-scroll">
            {descIsSummary ? <p className="cd-desc">{e.desc}</p> : null}
            {inner}
          </div>
        </div>
      </div>
    </div>
  );
}
