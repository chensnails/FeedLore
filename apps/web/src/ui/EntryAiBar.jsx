/* 单条目 AI 动作条（Phase 1 首发）：
 * 在文章详情 / 卡片详情的正文末尾提供「摘要 / 要点 / 翻译 / 解释」四个动作，
 * 点按调 POST /api/entry/:id/ai（后端按需调用模型，不落库缓存），结果就地展开。
 *
 * 为什么放这里：文章页（ReaderView 展开）与卡片详情（CardDetail）共用同一个 ArtBody，
 * 加在 ArtBody 里两处同时生效，避免再长一份 AI 入口。
 *
 * 防御式约束（无错误边界，渲染期一抛就白屏）：
 * - 只读账户 / 没有条目 id → 直接返回 null，不渲染任何东西；
 * - 调接口的可能异常全部在事件回调里 try/catch，绝不冒泡到渲染期；
 * - apiFetch 缺失时只 toast 提示，不抛。
 */

import { core } from '@core';
import { useState } from 'react';

const S = () => core;

const AI_ACTIONS = [
  { k: 'summary', label: '摘要' },
  { k: 'keypoints', label: '要点' },
  { k: 'translate', label: '翻译' },
  { k: 'explain', label: '解释' },
];

export function EntryAiBar({ entryId }) {
  const s = S();
  // 只读账户不提供 AI 写能力（后端也会拦 write 权限）；没有 id 无从定位条目
  const writable = s && s.isWritable ? !!s.isWritable() : true;
  const id = entryId == null ? null : entryId;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [tagResult, setTagResult] = useState(null);
  const [tagError, setTagError] = useState(null);

  if (!writable || id == null) return null;

  async function run(k) {
    if (busy) return;
    if (!s || typeof s.apiFetch !== 'function') {
      if (s && s.toast) s.toast('AI 功能当前不可用', false);
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await s.apiFetch('/api/entry/' + encodeURIComponent(id) + '/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: k }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText ? s.errText(data, 'AI 调用失败') : 'AI 调用失败');
      if (data && data.ok) {
        setResult(typeof data.result === 'string' ? data.result : '');
        setOpen(true);
      } else {
        setError((data && data.result) || 'AI 调用失败');
      }
    } catch (err) {
      const msg = s && s.errText ? s.errText(err, 'AI 调用失败') : String((err && err.message) || err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  // 按需为单篇生成 AI 标签（POST /api/entry/:id/ai-tags，后端落库并回写）
  async function runTags() {
    if (busy) return;
    if (!s || typeof s.apiFetch !== 'function') {
      if (s && s.toast) s.toast('AI 功能当前不可用', false);
      return;
    }
    setBusy(true);
    setTagError(null);
    setTagResult(null);
    try {
      const res = await s.apiFetch('/api/entry/' + encodeURIComponent(id) + '/ai-tags', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText ? s.errText(data, '生成失败') : '生成失败');
      if (data && data.ok) setTagResult(Array.isArray(data.tags) ? data.tags : []);
      else setTagError((data && data.error) || '生成失败');
    } catch (err) {
      const msg = s && s.errText ? s.errText(err, '生成失败') : String((err && err.message) || err);
      setTagError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="entry-ai">
      <div className="entry-ai-actions">
        <span className="entry-ai-label" aria-hidden="true">AI</span>
        {AI_ACTIONS.map((a) => (
          <button key={a.k} type="button" className="btn btn-ghost btn-sm"
            disabled={busy} aria-busy={busy ? 'true' : undefined}
            aria-label={'AI' + a.label}
            onClick={() => run(a.k)}>
            {busy ? '…' : a.label}
          </button>
        ))}
        <button key="tags" type="button" className="btn btn-ghost btn-sm"
          disabled={busy} aria-busy={busy ? 'true' : undefined}
          aria-label="AI 标签"
          onClick={runTags}>
          {busy ? '…' : '标签'}
        </button>
      </div>
      {open && result != null ? (
        <div className="entry-ai-result" role="region" aria-live="polite">
          <div className="entry-ai-res-head">
            <span>AI 生成结果</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="收起结果">收起</button>
          </div>
          <div className="entry-ai-res-body">{result}</div>
        </div>
      ) : null}
      {tagResult ? (
        <div className="entry-ai-tags" role="region" aria-live="polite">
          <span className="entry-ai-tags-label">AI 标签</span>
          {tagResult.length ? (
            tagResult.map((t) => (
              <span key={t} className="mini-tag mini-tag-ai">#{t}</span>
            ))
          ) : (
            <span className="hint">未生成标签</span>
          )}
        </div>
      ) : null}
      {error ? <div className="entry-ai-error hint" role="alert">{error}</div> : null}
      {tagError ? <div className="entry-ai-error hint" role="alert">{tagError}</div> : null}
    </div>
  );
}
