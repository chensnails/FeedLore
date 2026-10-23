/* 卡片详情弹窗（点击卡片页的卡片后展示整条内容）。
 *
 * 弹层形态沿用 src/views/Dropdown.jsx 的既有约定，不新增第二套弹层语言：
 * - 桌面（>720px）：遮罩 + 居中模态，复用 .modal-mask / .modal / .modal-head 一族；
 * - 移动（≤720px）：底部抽屉，复用 v1.1.10 的 .dd-mask / .dd-sheet；
 * 形态在打开瞬间定格，本次开合内不随窗口变化重排。
 *
 * 正文渲染直接复用文章页的 ArtBody / CopyButton / OpenButton（同一套 .art-* 样式），
 * 两处展示保持一份实现。打开弹窗即把该条记为已读：卡片页不显示已读态，
 * 状态只体现在文章页（同一批 entries 行），逻辑见 core 的 cardsDetailRead。
 */

import { core } from '@core';
import React, { useEffect, useRef, useState } from 'react';
import { isMobileMq } from './Dropdown.jsx';
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
  const [copied, setCopied] = useState(false);
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

  const copyPwd = async () => {
    const ok = await s.copyText(e.pwd);
    if (!ok) { s.toast('复制失败，请手动选择提取码', false); return; }
    setCopied(true);
    s.toast('已复制提取码');
    setTimeout(() => setCopied(false), 1600);
  };

  const toReader = () => {
    s.jumpToFeed(e.feedId);
    onClose();
  };

  const srcName = e.feedName ? (s.shortFeedName ? s.shortFeedName(e.feedName) : e.feedName) : '';
  const fmtDate = s.fmtDate || ((d) => (d ? String(d) : ''));
  const showBody = !!full && hasBody(full);
  /* 摘要与正文同源（rss.js 里 desc 就是 content 压平换行得来的），正文区自己会渲染文字时
   * 再列一行摘要就是把同一段话摆两遍，所以只在正文区没有文字（纯图正文 / 无正文）时才列摘要。 */
  const descIsSummary = showBody && !bodyShowsText(full);

  const titleId = 'cdTitle';
  const metaBar = (
    <div className="cd-meta">
      {srcName ? <span className="src-pill" title={e.feedName}>{srcName}</span> : null}
      {e.size ? <span className="meta-size">{e.size}</span> : null}
      {e.date ? <span className="meta-date">{fmtDate(e.date)}</span> : null}
    </div>
  );

  const pwdRow = e.pwd ? (
    <div className="cd-pwd">
      <span className="cd-pwd-k">提取码</span>
      <code className="cd-pwd-v">{e.pwd}</code>
      <button type="button" className="btn btn-ghost" onClick={copyPwd}>
        {copied ? <><Icon n="check" /> 已复制</> : <>复制</>}
      </button>
    </div>
  ) : null;

  let inner = null;
  if (err) inner = <div className="hint">正文加载失败，刷新页面重试</div>;
  else if (!full) inner = <div className="art-loading"><i /><i /><i /></div>;
  else if (showBody) inner = <div className="art-body"><ArtBody e={full} onTag={onTag} /></div>;
  else inner = (
    <div className="art-body">
      <div className="cd-none">
        {e.desc ? <p className="cd-desc">{e.desc}</p> : null}
        <div className="art-actions"><CopyButton e={e} /><OpenButton e={e} /></div>
      </div>
    </div>
  );

  const foot = (
    <div className="cd-foot">
      <button type="button" className={'btn' + (fav ? ' is-fav' : '')} aria-pressed={fav ? 'true' : 'false'}
        onClick={toggleFav}>
        <Icon n={fav ? 'star' : 'star-o'} /> {fav ? '已收藏' : '收藏'}
      </button>
      <span className="cd-foot-sp" />
      <button type="button" className="btn" onClick={toReader}>在文章页查看</button>
    </div>
  );

  if (mobile) {
    return (
      <div className="dd-mask" onClick={onClose}>
        <div className="dd-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}
          onClick={(ev) => ev.stopPropagation()}>
          <div className="dd-sheet-grip" aria-hidden="true" />
          <div className="dd-sheet-head">
            <span className="dd-sheet-title" id={titleId}>{e.name}</span>
            <button type="button" className="dd-sheet-close" ref={closeRef} aria-label="关闭详情" onClick={onClose}>
              <Icon n="x" />
            </button>
          </div>
          <div className="dd-sheet-body cd-body">
            {metaBar}
            {pwdRow}
            {descIsSummary ? <p className="cd-desc">{e.desc}</p> : null}
            {inner}
          </div>
          {foot}
        </div>
      </div>
    );
  }

  return (
    <div className="modal-mask" onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          <h2 id={titleId}>{e.name}</h2>
          <button type="button" className="modal-close" ref={closeRef} aria-label="关闭详情" onClick={onClose}>
            <Icon n="x" />
          </button>
        </div>
        <div className="modal-body">
          <div className="cd-scroll">
            {metaBar}
            {pwdRow}
            {descIsSummary ? <p className="cd-desc">{e.desc}</p> : null}
            {inner}
          </div>
        </div>
        {foot}
      </div>
    </div>
  );
}
