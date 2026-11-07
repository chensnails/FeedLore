/* 卡片详情弹窗（点击卡片页的卡片后展示整条内容）。
 *
 * 弹层形态沿用 src/views/Dropdown.jsx 的既有约定，不新增第二套弹层语言：
 * - 桌面（>720px）：遮罩 + 居中模态，复用 .modal-mask / .modal 一族；
 * - 移动（≤720px）：v1.3.4 起整屏铺开（.dd-sheet 在窄屏就是一整屏），从下方推入像进入一个页面；
 *   整屏没有「点遮罩关闭」这回事，出口是右上角悬浮 ×、Esc、往下拖或边缘横滑（useSwipeDismiss）。
 * 形态在打开瞬间定格，本次开合内不随窗口变化重排。
 *
 * 正文渲染直接复用文章页的 ArtBody / ArtClip / ArtActions（同一套 .art-* 样式与按钮），
 * 两处展示保持一份实现。长文折叠也走同一个 ArtClip（v2.5.1）：默认两屏 + 渐隐，
 * 底部「展开全文 · 共 N 字 / 收起全文」，与文章页的按钮、位置、点击行为完全一致，
 * 只是「收起后回到哪儿」不同 —— 这里把弹窗的滚动容器归零（文章页是滚回标题行）。
 * 动作行（复制 / 打开 / 收藏 / 在文章页查看）刻意留在折叠区外面：折叠只裁正文，
 * 让长文卡片仍然一点就能拿链接，不为折叠多付一步。
 * 打开弹窗即把该条记为已读：状态与卡片圆点、文章页列表同步，
 * 逻辑见 core 的 cardsDetailRead → reader.js markEntryRead。
 *
 * 弹窗只剩正文一种语言（v1.3.3，用户要求）：标题栏和底栏都撤掉，收藏与「在文章页查看」
 * 并进正文底部的动作行，和复制 / 打开并排成四个同尺寸图标按钮。
 * 因此这里刻意不再列频道 / 大小 / 日期 / 提取码（v1.3.2），也不再渲染标题（v1.3.3）：
 * 这些信息正文里本来就有（ArtBody 自带「发布时间」，提取码与大小来自正文解析出的行），
 * 卡片页的卡面在弹窗背后也已经写着标题。别把它们当漏掉的功能加回来。
 */

import { core } from '@core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isMobileMq } from './Dropdown.jsx';
import { useSwipeDismiss } from './useSwipeDismiss.js';
import { ArtActions, ArtBody, ArtClip, bodyCharCount, bodyShowsText } from './ReaderView.jsx';

const S = () => core;

const Icon = ({ n }) => (
  <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + n} /></svg>
);

/** 把 Tab / Shift+Tab 圈在弹窗内：背景卡片仍在 DOM 里，不拦的话键盘会跑到弹层后面 */
function trapTab(panel, ev) {
  if (!panel) return;
  const nodes = Array.from(panel.querySelectorAll(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
  )).filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}

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
  // 正文重试计数：+1 就重跑拉取 effect，其余（锁滚动 / 记已读 / 焦点）不重复执行
  const [reloadKey, setReloadKey] = useState(0);
  // 打开瞬间定格形态（与 Dropdown 同一约定），避免开合途中换布局
  const [mobile] = useState(isMobileMq());
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  /* 弹窗自己的滚动容器（桌面 .cd-scroll / 移动 .dd-sheet-body）。
     「收起全文」后正文塌陷，视口会停在原处；把它归零就是这里的「回到这条的开头」，
     对应文章页的滚回标题行。 */
  const scrollRef = useRef(null);
  // CardsView 每次重绘都会传新的 onClose；存进 ref，避免它进入 effect 依赖导致重复拉正文 / 重复锁滚动
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const c = S();
    if (c.cardsDetailRead) c.cardsDetailRead(e.id);
    if (c.lockPageScroll) c.lockPageScroll();
    const onKey = (ev) => {
      if (ev.key === 'Escape') { onCloseRef.current(); return; }
      if (ev.key === 'Tab') trapTab(mobile ? sheetRef.current : dialogRef.current, ev);
    };
    document.addEventListener('keydown', onKey);
    if (closeRef.current) closeRef.current.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      if (c.unlockPageScroll) c.unlockPageScroll();
    };
  }, [e.id, mobile]);

  useEffect(() => {
    let dead = false;
    setErr(false);
    setFull(null);
    S().apiFetch('/api/entries/' + encodeURIComponent(e.id))
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then((d) => { if (!dead) setFull(d); })
      .catch(() => { if (!dead) setErr(true); });
    return () => { dead = true; };
  }, [e.id, reloadKey]);

  const fav = !!e.isFavorite;
  const toggleFav = () => {
    const next = !fav;
    s.cardsSetFlag(e.id, { isFavorite: next }).then((ok) => {
      if (ok) s.toast(next ? '已收藏' : '已取消收藏');
    });
  };

  const toReader = () => {
    s.jumpToFeed(e.feedId, e.id);
    onClose();
  };

  const showBody = !!full && hasBody(full);
  /* 折叠阈值与文章页同源（bodyCharCount + CLIP_MIN_CHARS）：两页对「多长算长」的口径一致 */
  const charCount = showBody ? bodyCharCount(full) : 0;
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

  // 往下拖即可收起；从左右边缘横滑也能关（整屏没有遮罩可点，手势 + × + Esc 是全部出口）。
  // hook 走原生 passive:false touch 监听，接管后阻止默认，Android 的下拉刷新抢不走手势。
  const dismiss = useCallback(() => onCloseRef.current(), []);
  const backToTop = useCallback(() => {
    const box = scrollRef.current;
    if (box) box.scrollTop = 0;
  }, []);
  const { panelRef: sheetRef, setPanelRef, handlers: sheetHandlers } =
    useSwipeDismiss(dismiss, { allowHorizontal: true });

  const dialogLabel = e.name || '条目详情';

  let inner = null;
  if (err) {
    inner = (
      <div className="hint">
        正文加载失败
        <button type="button" className="btn btn-sm" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
      </div>
    );
  }
  else if (!full) inner = <div className="art-loading"><i /><i /><i /></div>;
  else if (showBody) {
    inner = (
      <div className="art-body cd-art">
        {/* 与文章页同一个折叠组件、同一段文案：默认两屏 + 渐隐，点一次展开、再点一次收起 */}
        <ArtClip id={'cdClip-' + e.id} charCount={charCount} resetKey={e.id} onCollapse={backToTop}>
          <ArtBody e={full} onTag={onTag} showActions={false} />
        </ArtClip>
        {/* 动作行留在折叠区外：长文卡片也能一点就拿链接，不因为折叠多出一步 */}
        <ArtActions e={full} extraActions={extraActions} />
      </div>
    );
  }
  else inner = (
    <div className="cd-none">
      {e.desc ? <p className="cd-desc">{e.desc}</p> : null}
      <ArtActions e={e} extraActions={extraActions} />
    </div>
  );

  if (mobile) {
    return (
      <div className="dd-mask" onClick={onClose}>
        <div ref={setPanelRef} className="dd-sheet cd-modal" role="dialog" aria-modal="true"
          aria-label={dialogLabel} onClick={(ev) => ev.stopPropagation()} {...sheetHandlers}>
          <div className="dd-sheet-grip" aria-hidden="true" />
          {closeBtn}
          <div className="dd-sheet-body cd-body" ref={scrollRef}>
            {descIsSummary ? <p className="cd-desc">{e.desc}</p> : null}
            {inner}
            <p className="cd-read-tip">打开此详情已将它标记为已读（两页同步）</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-mask" onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div className="modal cd-modal" role="dialog" aria-modal="true" aria-label={dialogLabel} ref={dialogRef}>
        {closeBtn}
        <div className="modal-body">
          <div className="cd-scroll" ref={scrollRef}>
            {descIsSummary ? <p className="cd-desc">{e.desc}</p> : null}
            {inner}
            <p className="cd-read-tip">打开此详情已将它标记为已读（两页同步）</p>
          </div>
        </div>
      </div>
    </div>
  );
}
