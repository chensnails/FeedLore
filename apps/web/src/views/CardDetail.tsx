/* 卡片详情弹窗（点击卡片页的卡片后展示整条内容）。
 *
 * 弹层形态沿用 src/views/Dropdown.tsx 的既有约定，不新增第二套弹层语言：
 * - 桌面（>720px）：遮罩 + 居中模态，复用 .modal-mask / .modal 一族；
 * - 移动（≤720px）：整屏铺开（.dd-sheet 在窄屏就是一整屏），从下方推入像进入一个页面；
 *   出口是右上角悬浮 × / Esc（Radix Dialog 接管模态语义）。下滑关闭已于 v2.5.3 下线：
 *   真机上收起动画会整屏闪一下。
 * 形态在打开瞬间定格，本次开合内不随窗口变化重排。
 *
 * 正文渲染直接复用文章页的 ArtBody（同一套 .art-* 样式与按钮），两处展示保持一份实现。
 * 正文一次铺开、不做折叠（v2.5.2，与文章页一致）：真正的出口是右上角 ×、Esc，
 * 以及文章页吸顶条上的「收起这篇」——不再额外要一次「展开全文」。
 * 打开弹窗即把该条记为已读：状态与卡片圆点、文章页列表同步，
 * 逻辑见 core 的 cardsDetailRead → reader.ts markEntryRead。
 *
 * 弹窗只剩正文一种语言：标题栏和底栏都撤掉，收藏与「在文章页查看」
 * 并进正文底部的动作行，和复制 / 打开并排成四个同尺寸图标按钮。
 * 因此这里刻意不再列频道 / 大小 / 日期 / 提取码，也不再渲染标题：
 * 这些信息正文里本来就有（ArtBody 自带「发布时间」，提取码与大小来自正文解析出的行），
 * 卡片页的卡面在弹窗背后也已经写着标题。别把它们当漏掉的功能加回来。
 */

import { core } from '@core';
import type { Card, EntryDetail } from '@feedlore/contract';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { qk } from '../kernel/query.ts';
import { ArtActions } from '../ui/EntryActions.tsx';
import { Icon } from '../ui/Icon.tsx';
import { isMobileMq } from './Dropdown.tsx';
import { ArtBody, bodyShowsText } from './ReaderView.tsx';

const S = () => core;

/** 有没有正文可展示：图文块、正文文本、正文图片三者有其一即可 */
function hasBody(f: EntryDetail | null | undefined): boolean {
  if (!f) return false;
  if (f.bodyJson) {
    try {
      const a = JSON.parse(f.bodyJson);
      if (Array.isArray(a) && a.length) return true;
    } catch (_) {
      /* 不是块数组就继续看其它字段 */
    }
  }
  if (String(f.content || '').trim()) return true;
  if (f.image) return true;
  return Array.isArray(f.images) && f.images.length > 0;
}

interface CardDetailProps {
  e: Card;
  onClose?: () => void;
  onTag?: (tag: string) => void;
  onAiTag?: (tag: string) => void;
}

export function CardDetail({ e, onClose, onTag, onAiTag }: CardDetailProps) {
  const s = S();
  const [full, setFull] = useState<EntryDetail | null>(null);
  const [err, setErr] = useState(false);
  // 正文重试走 bodyQuery.refetch()（见下方加载逻辑），锁滚动 / 记已读 / 焦点不重复执行
  // 打开瞬间定格形态（与 Dropdown 同一约定），避免开合途中换布局
  const [mobile] = useState<boolean>(isMobileMq());
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // 打开即记为已读（V5：滚动锁 / Esc / 焦点陷阱 / 层级仲裁全部交由 Radix Dialog）。
  useEffect(() => {
    const c = S();
    if (c.cardsDetailRead) c.cardsDetailRead(e.id);
  }, [e.id]);

  // V5：正文交给 Query；queryFn 走 core.apiFetch 端口，测试桩照常生效。
  // key 带 e.id：切换条目是不同 key，旧响应不会回填到新条目（替代原 dead 竞态守卫）。
  const bodyQuery = useQuery({
    queryKey: qk.readerBody(e.id),
    queryFn: async () => {
      const res = await S().apiFetch('/api/entries/' + encodeURIComponent(e.id));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    },
    refetchOnMount: 'always',
    retry: false,
  });
  useEffect(() => {
    if (bodyQuery.isPending) {
      setFull(null);
      setErr(false);
      return;
    }
    if (bodyQuery.isError) {
      setErr(true);
      return;
    }
    if (bodyQuery.data) {
      setFull(bodyQuery.data);
      setErr(false);
    }
  }, [bodyQuery.data, bodyQuery.isPending, bodyQuery.isError]);

  const fav = !!e.isFavorite;
  const toggleFav = () => {
    const next = !fav;
    s.cardsSetFlag(e.id, { isFavorite: next }).then(
      /** @param {*} [ok] */ (ok) => {
        if (ok) s.toast(next ? '已收藏' : '已取消收藏');
      },
    );
  };

  const toReader = () => {
    s.jumpToFeed(e.feedId, e.id);
    onClose?.();
  };

  const showBody = !!full && hasBody(full);
  /* 摘要与正文同源（rss.js 里 desc 就是 content 压平换行得来的），正文区自己会渲染文字时
   * 再列一行摘要就是把同一段话摆两遍，所以只在正文区没有文字（纯图正文 / 无正文）时才列摘要。 */
  const descIsSummary = showBody && !bodyShowsText(full);

  /* 与 CopyButton / OpenButton 并排的另两个动作：只做图标，靠 title + aria-label 说明。
   * 图标沿用顶栏语义（收藏 ★ / 文章页 = inbox），不新造第三套符号。 */
  const extraActions = (
    <>
      <button
        type="button"
        className={'btn-fav' + (fav ? ' is-fav' : '')}
        onClick={toggleFav}
        aria-pressed={fav ? 'true' : 'false'}
        title={fav ? '取消收藏' : '收藏'}
        aria-label={fav ? '取消收藏' : '收藏'}
      >
        <Icon n={fav ? 'star' : 'star-o'} />
      </button>
      <button
        type="button"
        className="btn-jump"
        onClick={toReader}
        title="在文章页查看"
        aria-label="在文章页查看"
      >
        <Icon n="inbox" />
      </button>
    </>
  );

  const closeBtn = (
    <button
      type="button"
      className="modal-close cd-close"
      ref={closeRef}
      aria-label="关闭详情"
      onClick={onClose}
    >
      <Icon n="x" />
    </button>
  );

  const dialogLabel = e.name || '条目详情';
  let inner = null;
  if (err) {
    inner = (
      <div className="hint" role="alert">
        正文加载失败
        <button type="button" className="btn btn-sm" onClick={() => bodyQuery.refetch()}>
          重试
        </button>
      </div>
    );
  } else if (!full)
    inner = (
      <div className="art-loading">
        <i />
        <i />
        <i />
      </div>
    );
  else if (showBody) {
    inner = (
      <div className="art-body cd-art">
        {/* 与文章页同一份 ArtBody：正文一次铺开，动作行在正文末尾（一个弹窗只有一排按钮） */}
        <ArtBody
          e={full}
          onTag={onTag}
          onAiTag={onAiTag}
          extraActions={extraActions}
          onRefreshed={() => {
            void bodyQuery.refetch();
          }}
        />
      </div>
    );
  } else
    inner = (
      <div className="cd-none">
        {e.desc ? <p className="cd-desc">{e.desc}</p> : null}
        <ArtActions e={e} extraActions={extraActions} />
      </div>
    );

  // 不用 Portal：详情就地渲染在卡片视图容器内（测试按其所在容器作用域查询，
  // Portal 会把内容甩到别处）。遮罩用原生 div 保留 .modal-mask > [role=dialog] 的
  // DOM 契约；Radix Content asChild 只接管语义（模态 / focus / Esc / 滚动锁）。
  const shell = (body: ReactNode) => (
    <Dialog.Root
      open
      onOpenChange={(o) => {
        if (!o) onClose?.();
      }}
    >
      <div className={mobile ? 'dd-mask' : 'modal-mask'} role="presentation">
        <Dialog.Content asChild ref={dialogRef} aria-describedby={undefined}>
          {body}
        </Dialog.Content>
      </div>
    </Dialog.Root>
  );

  if (mobile) {
    return shell(
      <div className="dd-sheet cd-modal" role="dialog" aria-modal="true" aria-label={dialogLabel}>
        <Dialog.Title className="sr-only">{dialogLabel}</Dialog.Title>
        <Dialog.Close asChild>{closeBtn}</Dialog.Close>
        <div className="dd-sheet-body cd-body">
          {descIsSummary ? <p className="cd-desc">{e.desc}</p> : null}
          {inner}
          <p className="cd-read-tip">打开此详情已将它标记为已读（两页同步）</p>
        </div>
      </div>,
    );
  }

  return shell(
    <div className="modal cd-modal" role="dialog" aria-modal="true" aria-label={dialogLabel}>
      <Dialog.Title className="sr-only">{dialogLabel}</Dialog.Title>
      <Dialog.Close asChild>{closeBtn}</Dialog.Close>
      <div className="modal-body">
        <div className="cd-scroll">
          {descIsSummary ? <p className="cd-desc">{e.desc}</p> : null}
          {inner}
          <p className="cd-read-tip">打开此详情已将它标记为已读（两页同步）</p>
        </div>
      </div>
    </div>,
  );
}
