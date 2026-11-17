/* 探索页的「问答」模式：用大白话检索自己的订阅，AI 给答案 + 引用条目卡（可跳文章）。
 *
 * 数据流与日报同构：submitAiJob → pollAiJob，四态齐全；历史只存内存（刷新即清），
 * 组件卸载即停止轮询（任务在服务端继续跑，与 DESIGN.md 的长任务约定一致）。
 * 引用卡带后端给的 entryId，点「读文章」走 core.jumpToFeed(feedId, id) 打开并展开。
 */
import { core } from '@core';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon.jsx';
import { StateBlock } from '../ui/StateBlock.jsx';
import { isImgFailed, markImgFailed } from '../imgFail.js';
import { widthVariant } from '../imgSrc.js';

const S = () => core;

const SUGGESTIONS = ['最近有什么好剧？', '最近服务器有什么羊毛？', '这周 AI 圈有哪些大事？'];

/** 一条引用条目：缩略图 + 来源 + 标题 + 跳文章。 */
function RefCard({ ref: hit }) {
  const s = S();
  const [imgFailed, setImgFailed] = useState(false);
  const thumb = (hit.image && !imgFailed && !isImgFailed(hit.image))
    ? <img className="ex-ref-thumb" loading="lazy" src={widthVariant(hit.image, 160) || hit.image} alt=""
      onLoad={(ev) => ev.currentTarget.classList.add('img-ready')}
      onError={() => { markImgFailed(hit.image); setImgFailed(true); }} />
    : <div className="ex-ref-thumb ex-ref-thumb-fb"><Icon n="file" /></div>;
  const openArticle = () => {
    // 引用卡只有条目 id，没有 feedId：先用 id 在已加载的条目里找频道，找不到也能让
    // jumpToFeed 走「全部」范围按 id 定位（focusReaderArt 会翻页找目标）。
    let feedId = null;
    const all = (s.state && (s.state.entries || s.state.rdEntries)) || [];
    const found = all.find((e) => String(e.id) === String(hit.id));
    if (found && found.feedId != null) feedId = found.feedId;
    if (typeof s.jumpToFeed === 'function') s.jumpToFeed(feedId, hit.id);
  };
  return (
    <div className="ex-ref">
      {thumb}
      <div className="ex-ref-main">
        <div className="ex-ref-name" title={hit.name}>{hit.name || '(无标题)'}</div>
        <div className="ex-ref-meta">{hit.feedName || '订阅'}{hit.date ? ` · ${hit.date}` : ''}</div>
      </div>
      <button className="ex-ref-go" type="button" title="在文章页打开并展开这篇"
        aria-label={`读文章：${hit.name || ''}`} onClick={openArticle}>
        读文章<Icon n="external" />
      </button>
    </div>
  );
}

/** 一轮问答：用户问题 + AI 答案/状态 + 引用卡。 */
function Turn({ turn }) {
  const busy = turn.status === 'queued' || turn.status === 'running';
  return (
    <div className="ex-turn">
      <div className="ex-msg ex-msg-me">{turn.question}</div>
      <div className="ex-msg ex-msg-ai">
        {busy ? (
          <StateBlock className="ex-busy" spinner>
            {turn.status === 'queued' ? '已提交，排队中…' : `检索你的订阅并生成中 · 已等待 ${turn.elapsed || 0}s`}
          </StateBlock>
        ) : turn.status === 'error' ? (
          <div className="ex-error" role="alert">
            <span>{turn.errorText || '生成失败'}</span>
            {turn.retry ? <button className="btn btn-ghost btn-sm" type="button" onClick={turn.retry}>重试</button> : null}
          </div>
        ) : (
          <>
            <div className="ex-answer">{turn.answer}</div>
            {turn.refs && turn.refs.length ? (
              <div className="ex-refs">
                {turn.refs.map((hit, i) => <RefCard ref={hit} key={hit.id || i} />)}
              </div>
            ) : null}
            {turn.model ? <div className="ex-answer-meta">由 {turn.model} 生成 · 检索 {turn.matched || 0} 条候选</div> : null}
          </>
        )}
      </div>
    </div>
  );
}

export function ExplorePane() {
  const s = S();
  const [turns, setTurns] = useState([]);
  const [draft, setDraft] = useState('');
  const aliveRef = useRef(true);
  const scrollRef = useRef(null);
  /* 与日报一样按「当前这一轮」计时：轮询期间每秒刷新等待秒数，给用户「确实在跑」的证据。 */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    if (!turns.some((t) => t.status === 'queued' || t.status === 'running')) return undefined;
    const iv = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [turns]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, tick]);

  async function ask(question) {
    const q = String(question || '').trim();
    if (!q || !s || typeof s.submitAiJob !== 'function') return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const t0 = Date.now();
    const patch = (fn) => { if (aliveRef.current) setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t))); };
    setTurns((prev) => [...prev, { id, question: q, status: 'queued', startedAt: t0 }]);
    setDraft('');
    try {
      const job = await s.submitAiJob({ kind: 'explore', question: q });
      if (!aliveRef.current) return;
      patch((t) => ({ ...t, status: job.status || 'queued' }));
      const done = await s.pollAiJob(job.id, {
        onStatus: (j) => patch((t) => ({ ...t, status: j.status })),
        isCancelled: () => !aliveRef.current,
      });
      if (!aliveRef.current) return;
      const r = (done && done.result) || {};
      if (!r.answer) throw new Error('任务完成但没有返回答案');
      patch((t) => ({
        ...t, status: 'succeeded', answer: r.answer, refs: Array.isArray(r.refs) ? r.refs : [],
        model: r.model || '', matched: Number(r.matched) || 0,
      }));
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = s.errText ? s.errText(err, '检索失败') : String((err && err.message) || err);
      patch((t) => ({ ...t, status: 'error', errorText: msg, retry: () => ask(q) }));
    }
  }

  const hasTurns = turns.length > 0;

  return (
    <section className="ai-pane ex-pane" data-ai-pane="explore">
      <div className="ex-head">
        <p className="ai-sub" id="exploreSub">用大白话问你的订阅，AI 检索条目后回答，并给出可直接打开的原文</p>
      </div>
      <div className="ex-thread" ref={scrollRef} id="exploreThread">
        {!hasTurns ? (
          <div className="ex-intro">
            <div className="ex-intro-ico"><Icon n="sparkle" /></div>
            <h3>想从订阅里找点什么？</h3>
            <p className="hint">试试这些问题，或直接输入你自己的</p>
            <div className="ex-suggest">
              {SUGGESTIONS.map((q) => (
                <button className="ex-suggest-btn" type="button" key={q} onClick={() => ask(q)}>
                  {q}<Icon n="sparkle" />
                </button>
              ))}
            </div>
          </div>
        ) : turns.map((t) => (
          <Turn turn={{ ...t, elapsed: t.startedAt ? Math.round((Date.now() - t.startedAt) / 1000) : 0 }} key={t.id} />
        ))}
      </div>
      <form className="ex-compose" id="exploreCompose"
        onSubmit={(e) => { e.preventDefault(); ask(draft); }}>
        <input id="exploreInput" type="search" value={draft} placeholder="问点什么，比如「最近有什么好剧？」"
          aria-label="向探索提问" autoComplete="off" onChange={(e) => setDraft(e.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={!draft.trim()}>
          发送<Icon n="sparkle" />
        </button>
      </form>
      <footer className="foot">答案由模型生成，可能不准确，请以引用条目的原文为准</footer>
    </section>
  );
}
