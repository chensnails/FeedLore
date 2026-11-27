/* 日报（探索页）子视图：单条目、日报正文、六态状态块。
 * DOM 类名 / id / aria / 文案与旧实现一致，全部从 AiView.tsx 原样迁移。 */

import { core } from '@core';
import type { Digest, DigestItem, DigestSection } from '@feedlore/contract';
import type { SyntheticEvent } from 'react';
import { useRef, useState } from 'react';
import { isImgFailed, markImgFailed } from '../imgFail.ts';
import { widthVariant, withRetryParam } from '../imgSrc.ts';
import { CopyIconButton, safeHref } from '../ui/EntryActions.tsx';
import { Icon } from '../ui/Icon.tsx';
import { StateBlock } from '../ui/StateBlock.tsx';
import type { DigestViewState } from './AiView.hooks.ts';

const S = () => core;

/** 日报里的一条条目（来自 DigestSection.items）。 */
type DigestEntry = DigestSection['items'][number];

export function DgItem({ it }: { it: DigestEntry }) {
  const e: Partial<DigestItem> = it.item || {};
  const [imgFailed, setImgFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const triedRef = useRef(false);
  const baseSrc = e.image ? widthVariant(e.image, 320) || e.image : '';
  // 首错先重试一次（r=1 只让浏览器重发，代理缓存键会归一掉它），再失败才进负缓存。
  const thumbSrc = retrying ? withRetryParam(baseSrc) : baseSrc;
  const thumb =
    e.image && !imgFailed && !isImgFailed(e.image) ? (
      <img
        className="dg-item-thumb"
        loading="lazy"
        src={thumbSrc}
        alt=""
        onLoad={(ev: SyntheticEvent<HTMLImageElement>) =>
          ev.currentTarget.classList.add('img-ready')
        }
        onError={(ev: SyntheticEvent<HTMLImageElement>) => {
          if (ev.currentTarget.complete && ev.currentTarget.naturalWidth > 0) return;
          if (!triedRef.current) {
            triedRef.current = true;
            setRetrying(true);
            return;
          }
          markImgFailed(e.image);
          setImgFailed(true);
        }}
      />
    ) : (
      <div className="dg-item-thumb-fb">
        <Icon n="file" />
      </div>
    );
  return (
    <div className="dg-item">
      {thumb}
      <div className="dg-item-main">
        <div className="dg-item-top">
          {it.comment ? <span className="dg-comment">{it.comment}</span> : null}
          {e.feedName ? <span className="src-pill">{e.feedName}</span> : null}
        </div>
        <div className="dg-item-name">{e.name || '(无标题)'}</div>
        <div className="dg-item-foot">
          {e.link ? <CopyIconButton url={e.link} /> : null}
          {safeHref(e.link) ? (
            <a
              className="icon-btn"
              title="打开原文章"
              aria-label="打开原文章"
              href={safeHref(e.link)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon n="external" />
            </a>
          ) : null}
          {e.size ? <span className="dg-item-size">{e.size}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** 日报正文（有数据时） */
export function DigestView({ digest }: { digest: Digest }) {
  const d = digest;
  const gen = d.generatedAt
    ? new Date(d.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '—';
  const highlights = d.highlights || [];
  const sections = d.sections || [];
  return (
    <>
      <div className="dg-card">
        <div className="dg-overview">
          <svg className="ico dg-pin" aria-hidden="true" focusable="false">
            <use href="#i-pin" />
          </svg>
          <span>
            {d.overview || '（无概览）'}
            {d.fallback ? <span className="dg-tag-fallback">规则摘要</span> : null}
          </span>
        </div>
        <div className="dg-meta">
          <span>
            <b>生成时间</b> {gen}
          </span>
          <span>
            <b>模型</b> {d.model || '—'}
          </span>
          <span>
            <b>采集</b> {(d.stats && d.stats.collected) || 0} 条 → 精选{' '}
            {(d.stats && d.stats.kept) || 0} 条
          </span>
          <span>
            <b>覆盖频道</b> {(d.stats && d.stats.feeds) || 0} 个
          </span>
          {d.usedMapReduce ? (
            <span>
              <b>模式</b> 分批汇总
            </span>
          ) : null}
        </div>
        {d.error ? (
          <div className="dg-meta is-plain">
            <span className="dg-warn">模型调用失败，已降级为规则摘要：{S().errText(d.error)}</span>
          </div>
        ) : null}
      </div>

      {highlights.length ? (
        <div className="dg-card">
          <h3 className="dg-section-title">
            今日亮点<span className="cnt">{highlights.length} 条</span>
          </h3>
          <div className="dg-hl-list">
            {highlights.map(
              /** @param {*} [h] @param {*} [i] */ (h, i) => (
                <div className="dg-hl" key={i}>
                  <div className="dg-hl-idx">{i + 1}</div>
                  <div className="dg-hl-body">
                    <div className="dg-hl-text">{h.text || ''}</div>
                    {h.item && h.item.name ? <div className="dg-hl-name">{h.item.name}</div> : null}
                  </div>
                </div>
              ),
            )}
          </div>
        </div>
      ) : null}

      {sections.length ? (
        sections.map(
          /** @param {*} [s] @param {*} [i] */ (s, i) => (
            <div className="dg-card" key={i}>
              <h3 className="dg-section-title">
                {s.title || '未分类'}
                <span className="cnt">{s.items.length} 条</span>
              </h3>
              <div className="dg-items">
                {s.items.map(
                  /** @param {*} [it] @param {*} [j] */ (it, j) => (
                    <DgItem it={it} key={j} />
                  ),
                )}
              </div>
            </div>
          ),
        )
      ) : (
        <StateBlock className="dg-empty" icon="inbox">
          <p>没有可展示的条目</p>
        </StateBlock>
      )}
    </>
  );
}

/** 日报的读取 / 生成 / 失败 / 空 / 就绪五态（就绪态复用 DigestView）。 */
export function DigestStateBody({
  view,
  writable,
  genElapsed,
  selected,
  showDigest,
  generate,
}: {
  view: DigestViewState;
  writable: boolean;
  genElapsed: number;
  selected: string;
  showDigest: (date: string) => void;
  generate: (force?: boolean, key?: string) => void;
}) {
  if (view.kind === 'loading') {
    return (
      <StateBlock className="dg-loading" spinner>
        读取中…
      </StateBlock>
    );
  }
  if (view.kind === 'genLoading') {
    return (
      <StateBlock className="dg-loading" spinner>
        正在采集过去 24 小时的新条目并生成摘要…
        <div className="hint mt-2">
          {view.phase === 'queued' ? '任务已提交，排队中…' : `任务运行中 · 已等待 ${genElapsed}s`}
          <br />
          任务在服务端跑，可以先离开这个页面；回到「日报」时会读到结果
        </div>
      </StateBlock>
    );
  }
  if (view.kind === 'error') {
    return (
      <StateBlock className="dg-error" icon="alert" alert>
        <p>读取失败：{view.msg}</p>
        <button className="btn btn-ghost" type="button" onClick={() => showDigest(selected)}>
          重试
        </button>
      </StateBlock>
    );
  }
  if (view.kind === 'genError') {
    return (
      <StateBlock className="dg-error" icon="alert" alert>
        <p>生成失败：{view.msg}</p>
        <p className="hint">请在「设置 → 模型」检查模型地址与 Key 是否正确</p>
        {writable ? (
          <button className="btn btn-ghost" type="button" onClick={() => generate(false)}>
            重新生成
          </button>
        ) : null}
      </StateBlock>
    );
  }
  if (view.kind === 'empty') {
    return (
      <StateBlock className="dg-empty" icon="calendar">
        <p>
          <strong>{view.date}</strong> 还没有摘要
        </p>
        <p className="hint">
          {writable ? '把所选频道过去 24 小时的新内容整理成简报' : '只读账户不能手动生成摘要'}
        </p>
        {writable ? (
          <button className="btn btn-primary" type="button" onClick={() => generate(false)}>
            生成摘要
          </button>
        ) : null}
      </StateBlock>
    );
  }
  return <DigestView digest={view.digest} />;
}
