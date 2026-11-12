/* 条目级动作按钮（复制链接 / 打开原文）：卡片页、文章页、卡片详情共用这一份。
 *
 * 此前两页各写一套：卡片页在「没有链接」时渲染一个 `disabled` 的复制图标（title="无链接"），
 * 文章页直接不渲染。同一条目在两页表现不同，而且置灰按钮不可点也不解释，正是
 * OpenButton 注释里要避免的「像上了锁」。现在统一为「没有链接就不渲染」：
 * 一排动作按钮里出现几个，就代表能做什么，不会出现点不动的东西。
 */

import { useState } from 'react';
import { core } from '@core';
import { Icon } from './Icon.jsx';

const S = () => core;

/** 可复制的链接列表：多条时优先 links，单条退回 link */
export function copyableLinks(e) {
  const list = Array.isArray(e.links) ? e.links.filter(Boolean) : [];
  if (list.length) return list;
  return e.link ? [e.link] : [];
}

/** 链接兜底清洗：只放行 http(s) / mailto，其余（javascript: / file: / data: …）一律返回空。
 *  服务端入库前已清洗过，这里再兜一层，防历史脏数据或回归把危险协议塞进 <a href>。
 *  卡片页 OpenButton、文章页正文链接、AI 日报条目共用这一份，别处不再各写一套。 */
export function safeHref(h) {
  const s = String(h || '');
  return /^(https?:|mailto:)/i.test(s) ? s : '';
}

/** 复制 + 反馈的唯一实现：成功换勾 1.6s，失败 toast 提示。
 *  两个视觉（.btn-copy / .icon-btn）共用它，避免第三份复制逻辑再长出来。 */
function useCopyAction() {
  const [copied, setCopied] = useState(false);
  const run = async (url) => {
    const ok = await S().copyText(url);
    if (!ok) { S().toast('复制失败，请手动选择链接', false); return; }
    setCopied(true);
    S().toast('已复制：' + (S().linkLabel ? S().linkLabel(url) : url));
    setTimeout(() => setCopied(false), 1600);
  };
  return { copied, run };
}

/** 复制按钮：单条直接复制，多条弹选择菜单（复用 openLinkMenu） */
export function CopyButton({ e }) {
  const { copied, run } = useCopyAction();
  const list = copyableLinks(e);

  // 没有链接就什么都不渲染（两页一致；见文件头注释）
  if (!list.length) return null;

  const many = list.length > 1;
  const onClick = (ev) => {
    if (!many) { run(list[0]); return; }
    if (S().openLinkMenu) S().openLinkMenu(ev.currentTarget, list, run);
    else run(list[0]);
  };

  return (
    <button type="button" className={'btn-copy' + (copied ? ' copied' : '')} onClick={onClick}
      title={many ? `复制链接（${list.length} 条，可选择）` : '复制链接'} aria-label="复制链接">
      {/* 成功态的「已复制」用 .btn-label 包裹：图标方块按钮里这行字会被
          CSS 隐藏（.btn-copy .btn-label{display:none}），文字由 toast 播报 */}
      {copied ? <><Icon n="check" /><span className="btn-label">已复制</span></> : <Icon n="copy" />}
    </button>
  );
}

/** 紧凑版复制按钮（日报条目用）：同样是「复制链接 + 成功换勾」，
 *  只是视觉是 .icon-btn —— 行为与 CopyButton 共用同一个 hook，不再各写一份。 */
export function CopyIconButton({ url }) {
  const { copied, run } = useCopyAction();
  if (!url) return null;
  return (
    <button type="button" className={'icon-btn' + (copied ? ' ok' : '')}
      title="复制链接" aria-label="复制链接" onClick={() => run(url)}>
      <Icon n={copied ? 'check' : 'link'} />
    </button>
  );
}

/** 打开原文：只在有「安全」地址时出现，不做禁用态。
 *  sourceUrl / link 先过 safeHref：危险协议（javascript: 等）清洗成空 → 不渲染。 */
export function OpenButton({ e }) {
  const url = safeHref(e.sourceUrl) || safeHref(e.link);
  if (!url) return null;
  return (
    <a className="btn-open" href={url} target="_blank" rel="noopener noreferrer"
      title="打开原文章" aria-label="打开原文章"><Icon n="external" /></a>
  );
}

/** 正文底部那一排动作（复制 / 打开原文，弹窗再加收藏 / 在文章页查看）。
 *  ArtBody 内部用它；卡片详情在「没有正文」的分支也直接渲染这一排，
 *  保证两处都是同一组按钮、同一套间距。 */
export function ArtActions({ e, extraActions }) {
  return <div className="art-actions"><CopyButton e={e} /><OpenButton e={e} />{extraActions}</div>;
}
