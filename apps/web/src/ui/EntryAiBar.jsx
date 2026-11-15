/* 单条目 AI 动作条（Phase 1 首发）：
 * 在文章标题正下方（正文之前）提供「摘要 / 要点 / 翻译 / 解释」四个动作，
 * 点按调 POST /api/entry/:id/ai（后端按需调用模型，不落库缓存），结果就地展开。
 *
 * 位置：由 ArtBody 决定（views/ReaderView.jsx 的 parts 首位）。文章页（ReaderView 展开）
 * 与卡片详情（CardDetail）共用同一个 ArtBody，所以两处同时生效，不必再长一份 AI 入口。
 * 早先放在正文末尾，用户反馈「读完才知道有 AI」，故移到标题下方、正文之前。
 *
 * 防御式约束（无错误边界，渲染期一抛就白屏）：
 * - 只读账户 / 没有条目 id → 直接返回 null，不渲染任何东西；
 * - 调接口的可能异常全部在事件回调里 try/catch，绝不冒泡到渲染期；
 * - apiFetch 缺失时只 toast 提示，不抛。
 */

import { core } from '@core';
import { useEffect, useRef, useState } from 'react';

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
  /* 忙碌态按动作区分：只有一个正在跑，其余按钮只置灰、不变「…」也不转圈。
   * 共用一枚 boolean 时点「摘要」会让四个兄弟按钮同时变「… ⟳」，看起来像四个任务都在跑
   * （用户明确反馈过这一点）。并发仍要挡：AI_ACTIONS 共用一块结果区，两个请求同时回来会互相覆盖。 */
  const [busyKey, setBusyKey] = useState(null);
  const busyRef = useRef(null);
  const begin = (k) => {
    if (busyRef.current) return false;
    busyRef.current = k;
    setBusyKey(k);
    return true;
  };
  const end = () => { busyRef.current = null; setBusyKey(null); };
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

  /* AI 调用必须吃长超时：服务端一次模型调用允许 180s，走默认 30s 写超时会在
   * 中途掐断并报错，服务端其实还在跑（实测前端 30s 报错、服务端 99s 成功）。 */
  const aiTimeout = (s && s.AI_TIMEOUT_MS) || 200000;

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [tagResult, setTagResult] = useState(null);
  const [tagError, setTagError] = useState(null);

  if (!writable || id == null) return null;

  async function run(k) {
    if (busyRef.current) return;
    if (!s || typeof s.apiFetch !== 'function') {
      if (s && s.toast) s.toast('AI 功能当前不可用', false);
      return;
    }
    if (!begin(k)) return;
    setError(null);
    setResult(null);
    try {
      const res = await s.apiFetch('/api/entry/' + encodeURIComponent(id) + '/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: k }),
        timeoutMs: aiTimeout,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText ? s.errText(data, 'AI 调用失败') : 'AI 调用失败');
      if (data && data.ok) {
        setResult(typeof data.result === 'string' ? data.result : '');
        setOpen(true);
      } else {
        // 失败原因回来的是 `E_AI_TIMEOUT: ...` 这类稳定码，交给词典翻译
        setError(s.errText ? s.errText(data && data.result ? data.result : data, 'AI 调用失败') : 'AI 调用失败');
      }
    } catch (err) {
      const msg = s && s.errText ? s.errText(err, 'AI 调用失败') : String((err && err.message) || err);
      setError(msg);
    } finally {
      end();
    }
  }

  // 按需为单篇生成 AI 标签（POST /api/entry/:id/ai-tags，后端落库并回写）
  async function runTags() {
    if (busyRef.current) return;
    if (!s || typeof s.apiFetch !== 'function') {
      if (s && s.toast) s.toast('AI 功能当前不可用', false);
      return;
    }
    if (!begin('tags')) return;
    setTagError(null);
    setTagResult(null);
    try {
      const res = await s.apiFetch('/api/entry/' + encodeURIComponent(id) + '/ai-tags', {
        method: 'POST',
        timeoutMs: aiTimeout,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.errText ? s.errText(data, '生成失败') : '生成失败');
      if (data && data.ok) setTagResult(Array.isArray(data.tags) ? data.tags : []);
      else setTagError(s.errText ? s.errText(data && data.error ? data.error : data, '生成失败') : '生成失败');
    } catch (err) {
      const msg = s && s.errText ? s.errText(err, '生成失败') : String((err && err.message) || err);
      setTagError(msg);
    } finally {
      end();
    }
  }

  return (
    <div className="entry-ai">
      <div className="entry-ai-actions">
        <span className="entry-ai-label" aria-hidden="true">AI</span>
        {AI_ACTIONS.map((a) => (
          <button key={a.k} type="button" className="btn btn-ghost btn-sm"
            disabled={anyBusy} aria-busy={busyKey === a.k ? 'true' : undefined}
            aria-label={'AI' + a.label}
            onClick={() => run(a.k)}>
            {busyKey === a.k ? '…' : a.label}
          </button>
        ))}
        <button key="tags" type="button" className="btn btn-ghost btn-sm"
          disabled={anyBusy} aria-busy={busyKey === 'tags' ? 'true' : undefined}
          aria-label="AI 标签"
          onClick={runTags}>
          {busyKey === 'tags' ? '…' : '标签'}
        </button>
        {anyBusy && elapsed >= 3 ? (
          <span className="entry-ai-wait" role="status">已等待 {elapsed}s</span>
        ) : null}
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
