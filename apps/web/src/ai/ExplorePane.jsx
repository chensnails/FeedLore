/* 探索页的「问答」模式——IM 聊天形态。
 *
 * 用大白话检索自己的订阅，AI 给答案 + 引用条目卡（可跳文章）。连续消息流：
 * 双方气泡、时间戳、正在输入动画、自动滚动；支持全部历史轮次的多轮追问。
 *
 * 数据流与日报同构：submitAiJob → pollAiJob，四态齐全；历史只存内存（刷新即清），
 * 组件卸载即停止轮询（任务在服务端继续跑，与 DESIGN.md 的长任务约定一致）。
 * 提交时把已完成的轮次打包成 history：[#n] 的跨轮编号错位由服务端按 refs 修正。
 */
import { core } from '@core';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon.jsx';
import { StateBlock } from '../ui/StateBlock.jsx';
import { isImgFailed, markImgFailed } from '../imgFail.js';
import { widthVariant } from '../imgSrc.js';

const S = () => core;

const SUGGESTIONS = ['最近有什么好剧？', '最近服务器有什么羊毛？', '这周 AI 圈有哪些大事？'];

/** 引用卡日期：服务端给的是 ISO 原值（2026-11-17T04:27:...Z），这里统一成人看的「今天 HH:mm / MM-DD HH:mm」，与文章/卡片页一致。 */
const fmtDate = (d) => {
  const f = S().fmtDate;
  if (typeof f === 'function') return f(d);
  return d ? String(d).slice(0, 16).replace('T', ' ') : '';
};

const hhmm = (ts) => {
  const d = ts ? new Date(ts) : new Date();
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
};

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
        <div className="ex-ref-meta">
          <span title={`${hit.feedName || '订阅'}${hit.date ? ` · ${fmtDate(hit.date)}` : ''}`}>
            {hit.feedName || '订阅'}{hit.date ? ` · ${fmtDate(hit.date)}` : ''}
          </span>
          <button className="ex-ref-go" type="button" title="在文章页打开并展开这篇"
            aria-label={`读文章：${hit.name || ''}`} onClick={openArticle}>
            <Icon n="external" /><span>读文章</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** 用户消息气泡（右侧）。 */
function MeBubble({ turn }) {
  return (
    <div className="ex-row ex-row-me">
      <div className="ex-col">
        <div className="ex-bubble ex-bubble-me">{turn.question}</div>
        <div className="ex-time">{hhmm(turn.at)}</div>
      </div>
    </div>
  );
}

/** AI 消息气泡（左侧）：排队/生成中显示输入动画，成功显示答案 + 引用卡，失败显示错误 + 重试。 */
function AiBubble({ turn }) {
  const busy = turn.status === 'queued' || turn.status === 'running';
  return (
    <div className="ex-row ex-row-ai">
      <div className="ex-avatar" aria-hidden="true">AI</div>
      <div className="ex-col">
        <div className="ex-bubble ex-bubble-ai">
          {busy ? (
            <div className="ex-typing" role="status" aria-label="正在检索并生成">
              <i /><i /><i />
              <span className="ex-typing-text">
                {turn.status === 'queued' ? '排队中…' : `检索你的订阅 · 已等待 ${turn.elapsed || 0}s`}
              </span>
            </div>
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
            </>
          )}
        </div>
        <div className="ex-time">
          {turn.status === 'succeeded'
            ? `${hhmm(turn.at)}${turn.model ? ` · ${turn.model}` : ''}${turn.matched ? ` · 检索 ${turn.matched} 条` : ''}`
            : busy ? '正在生成…' : ''}
        </div>
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
  const [tick, setTick] = useState(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // 有任务在跑时每秒刷新等待秒数（IM 里体现为「正在输入」旁的实时秒数）
  useEffect(() => {
    if (!turns.some((t) => t.status === 'queued' || t.status === 'running')) return undefined;
    const iv = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [turns]);

  // 新消息 / 计时刷新都自动滚到底部（IM 的基本手感）
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, tick]);

  async function ask(question) {
    const q = String(question || '').trim();
    if (!q || !s || typeof s.submitAiJob !== 'function') return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const t0 = Date.now();
    /* 全部历史：把已经成功/失败但有内容的轮次都打包。失败的轮次不带答案，
     * 免得把错误信息喂给模型；只带 question + answer + refs。 */
    const history = turns
      .filter((t) => t.status === 'succeeded' && t.answer)
      .map((t) => ({
        question: t.question,
        answer: t.answer,
        refs: (t.refs || []).map((r) => ({ id: String(r.id), name: r.name })),
      }));
    const patch = (fn) => { if (aliveRef.current) setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t))); };
    setTurns((prev) => [...prev, { id, question: q, status: 'queued', at: new Date(t0).toISOString(), startedAt: t0 }]);
    setDraft('');
    try {
      const job = await s.submitAiJob({ kind: 'explore', question: q, history });
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
        <p className="ai-sub" id="exploreSub">用大白话问你的订阅，AI 检索条目后回答，可直接追问，答案带原文入口</p>
      </div>
      <div className="ex-thread" ref={scrollRef} id="exploreThread" role="log" aria-live="polite">
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
        ) : (
          <>
            <p className="ex-day">本次会话 · 可连续追问</p>
            {turns.map((t) => (
              <div className="ex-pair" key={t.id}>
                <MeBubble turn={t} />
                <AiBubble turn={{ ...t, elapsed: t.startedAt ? Math.round((Date.now() - t.startedAt) / 1000) : 0 }} />
              </div>
            ))}
          </>
        )}
      </div>
      <form className="ex-compose" id="exploreCompose"
        onSubmit={(e) => { e.preventDefault(); ask(draft); }}>
        <input id="exploreInput" type="search" value={draft} placeholder="追问一句话…"
          aria-label="向探索提问" autoComplete="off" onChange={(e) => setDraft(e.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={!draft.trim()}>
          发送<Icon n="sparkle" />
        </button>
      </form>
      <footer className="foot">答案由模型生成，可能不准确，请以引用条目的原文为准</footer>
    </section>
  );
}
