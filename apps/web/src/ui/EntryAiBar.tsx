/* 单条目 AI 动作条（Phase 1 首发）：
 * 在文章标题正下方（正文之前）提供「摘要 / 要点 / 翻译 / 解释」四个动作，
 * 点按调 POST /api/entry/:id/ai（后端按需调用模型，不落库缓存），结果就地展开。
 *
 * 位置：由 ArtBody 决定（views/ReaderView.tsx 的 parts 首位）。文章页（ReaderView 展开）
 * 与卡片详情（CardDetail）共用同一个 ArtBody，所以两处同时生效，不必再长一份 AI 入口。
 * 早先放在正文末尾，用户反馈「读完才知道有 AI」，故移到标题下方、正文之前。
 *
 * 防御式约束（无错误边界，渲染期一抛就白屏）：
 * - 只读账户 / 没有条目 id → 直接返回 null，不渲染任何东西；
 * - 调接口的可能异常全部在事件回调里 try/catch，绝不冒泡到渲染期；
 * - apiFetch 缺失时只 toast 提示，不抛。
 */

import { core } from '@core';
import type { AiJobBody, ENTRY_AI_ACTIONS } from '@feedlore/contract';
import { useEffect, useRef, useState } from 'react';
import type { EntityId } from '../core/types.ts';

const S = () => core;

type EntryAiAction = (typeof ENTRY_AI_ACTIONS)[number];

const AI_ACTIONS: Array<{ k: EntryAiAction; label: string }> = [
  { k: 'summary', label: '摘要' },
  { k: 'keypoints', label: '要点' },
  { k: 'translate', label: '翻译' },
  { k: 'explain', label: '解释' },
];

/** 单篇 AI 任务的 result 形状（按动作收窄 dynamic）。 */
interface EntryAiResult {
  result?: string;
  tags?: string[];
}

function asResult(v: unknown): EntryAiResult {
  return typeof v === 'object' && v !== null ? (v as EntryAiResult) : {};
}

interface EntryAiBarProps {
  entryId?: EntityId | null;
}

export function EntryAiBar({ entryId }: EntryAiBarProps) {
  const s = S();
  // 只读账户不提供 AI 写能力（后端也会拦 write 权限）；没有 id 无从定位条目
  const writable = s && s.isWritable ? !!s.isWritable() : true;
  const id = entryId == null ? null : entryId;
  /* 忙碌态按动作区分：只有一个正在跑，其余按钮只置灰、不变「…」也不转圈。
   * 共用一枚 boolean 时点「摘要」会让四个兄弟按钮同时变「… ⟳」，看起来像四个任务都在跑
   * （用户明确反馈过这一点）。并发仍要挡：AI_ACTIONS 共用一块结果区，两个请求同时回来会互相覆盖。 */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const begin = (k: string) => {
    if (busyRef.current) return false;
    busyRef.current = k;
    setBusyKey(k);
    return true;
  };
  const end = () => {
    busyRef.current = null;
    setBusyKey(null);
  };
  const anyBusy = busyKey !== null;

  /* 已等待秒数：单篇生成实测可能跑 1~2 分钟（长文 + 慢上游），只显示一个「…」
   * 用户会以为卡死并重复点击。超过 3 秒才亮出来，避免快请求闪一下。 */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!anyBusy) {
      setElapsed(0);
      return undefined;
    }
    const t0 = Date.now();
    const iv = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [anyBusy]);

  /* 任务阶段：'' | 'queued'（已提交、排队中）| 'running'（模型在跑）。
   * 长任务改成「提交 → 轮询」后，请求本身是毫秒级的，界面上的等待感来自任务状态，
   * 而不是一个挂 90 秒的 POST。 */
  const [phase, setPhase] = useState('');

  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [tagResult, setTagResult] = useState<string[] | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);

  /* 组件卸载（收起文章 / 切走）后不再轮询：任务在服务端照常跑完，
   * 结果仍会写进「模型状态」列表，只是这个组件不再更新。 */
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  if (!writable || id == null) return null;
  const eid: EntityId = id;

  /** 提交并轮询一个任务；成功返回 job，失败抛出已翻译的错误。 */
  async function runJob(body: AiJobBody, onPhase: (status: string) => void) {
    const job = await s.submitAiJob(body);
    if (aliveRef.current) onPhase(job.status || 'queued');
    return s.pollAiJob(job.id, {
      onStatus: (j) => {
        if (aliveRef.current) onPhase(j.status);
      },
      isCancelled: () => !aliveRef.current,
    });
  }

  async function run(k: EntryAiAction) {
    if (busyRef.current) return;
    if (!s || typeof s.submitAiJob !== 'function') {
      if (s && s.toast) s.toast('AI 功能当前不可用', false);
      return;
    }
    if (!begin(k)) return;
    setError(null);
    setResult(null);
    setPhase('');
    try {
      const job = await runJob({ kind: 'entry_ai', entryId: eid, action: k }, setPhase);
      const r = asResult(job && job.result);
      const text = typeof r.result === 'string' ? r.result : '';
      if (!text) throw new Error('AI 调用失败：任务完成但没有返回内容');
      setResult(text);
      setOpen(true);
    } catch (err) {
      if (!aliveRef.current) return;
      const msg =
        s && s.errText ? s.errText(err, 'AI 调用失败') : String((err && err.message) || err);
      setError(msg);
    } finally {
      if (aliveRef.current) setPhase('');
      end();
    }
  }

  // 按需为单篇生成 AI 标签（任务落库 → 服务端执行并回写 entry_ai_tags）
  async function runTags() {
    if (busyRef.current) return;
    if (!s || typeof s.submitAiJob !== 'function') {
      if (s && s.toast) s.toast('AI 功能当前不可用', false);
      return;
    }
    if (!begin('tags')) return;
    setTagError(null);
    setTagResult(null);
    setPhase('');
    try {
      const job = await runJob({ kind: 'ai_tags', entryId: eid }, setPhase);
      const r = asResult(job && job.result);
      const tags: string[] = Array.isArray(r.tags) ? r.tags : [];
      setTagResult(tags);
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = s && s.errText ? s.errText(err, '生成失败') : String((err && err.message) || err);
      setTagError(msg);
    } finally {
      if (aliveRef.current) setPhase('');
      end();
    }
  }

  return (
    <div className="entry-ai">
      <div className="entry-ai-actions">
        <span className="entry-ai-label" aria-hidden="true">
          AI
        </span>
        {AI_ACTIONS.map(
          /** @param {*} [a] */ (a) => (
            <button
              key={a.k}
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={anyBusy}
              aria-busy={busyKey === a.k ? 'true' : undefined}
              aria-label={'AI' + a.label}
              onClick={() => run(a.k)}
            >
              {busyKey === a.k ? '…' : a.label}
            </button>
          ),
        )}
        <button
          key="tags"
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={anyBusy}
          aria-busy={busyKey === 'tags' ? 'true' : undefined}
          aria-label="AI 标签"
          onClick={runTags}
        >
          {busyKey === 'tags' ? '…' : '标签'}
        </button>
        {anyBusy && phase === 'queued' ? (
          <span className="entry-ai-wait">
            <span className="sr-only" role="status">
              AI 已提交，排队中
            </span>
            <span aria-hidden="true">排队中…</span>
          </span>
        ) : null}
        {anyBusy && phase === 'running' ? (
          <span className="entry-ai-wait">
            {/* 秒数每秒变，aria-hidden；读屏只播报一次「生成中」 */}
            <span className="sr-only" role="status">
              AI 正在生成
            </span>
            <span aria-hidden="true">
              {elapsed >= 3 ? `生成中 · 已等待 ${elapsed}s` : '生成中…'}
            </span>
          </span>
        ) : null}
      </div>
      {open && result != null ? (
        <div className="entry-ai-result" role="region" aria-live="polite">
          <div className="entry-ai-res-head">
            <span>AI 生成结果</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setOpen(false)}
              aria-label="收起结果"
            >
              收起
            </button>
          </div>
          <div className="entry-ai-res-body">{result}</div>
        </div>
      ) : null}
      {tagResult ? (
        <div className="entry-ai-tags" role="region" aria-live="polite">
          <span className="entry-ai-tags-label">AI 标签</span>
          {tagResult.length ? (
            tagResult.map(
              /** @param {*} [t] */ (t) => (
                <span key={t} className="mini-tag mini-tag-ai">
                  #{t}
                </span>
              ),
            )
          ) : (
            <span className="hint">未生成标签</span>
          )}
        </div>
      ) : null}
      {error ? (
        <div className="entry-ai-error hint" role="alert">
          {error}
        </div>
      ) : null}
      {tagError ? (
        <div className="entry-ai-error hint" role="alert">
          {tagError}
        </div>
      ) : null}
    </div>
  );
}
