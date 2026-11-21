/* 自动化规则（when → then）：挂在设置「规则」页底部。
 *
 * 独立读写 users.prefs.rules（GET/POST /api/prefs），与关注/屏蔽规则互不影响。
 * 早期范围固定「全部频道」：条件先做关键词（标题/描述/正文）+ 标签，动作做
 * 加标签 / 收藏 / 标记已读 / 通知（复用现有 webhook）。
 *
 * 防御式：错误边界只是最后一道网，渲染期仍不抛（map 前确保是数组、取值用可选链）。
 */

import { core } from '@core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { invalidate, qk } from '../kernel/query.ts';
import { Dropdown } from '../views/Dropdown.tsx';
import { Section, useFormLoadGuard } from './primitives.tsx';

const S = () => core;

const newId = () => 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

/** 规则草稿（表单里的扁平形状）。 */
interface RuleDraft {
  id: string;
  name: string;
  on: boolean;
  keywords: string;
  match: string;
  tag: string;
  addTags: string;
  favorite: boolean;
  markRead: boolean;
  notify: boolean;
}
type ResultState = { ok: boolean; msg: string } | null;

const parseLines = (text: unknown): string[] =>
  String(text || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
const parseComma = (text: unknown): string[] =>
  String(text || '')
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean);

const ALL_SCOPE = { all: true, groups: [], feeds: [] };

/** 服务端规则 → 草稿。输入是 JSON 边界，用 unknown + 窄化。 */
function toDraft(r: unknown): RuleDraft {
  const obj = (r && typeof r === 'object' && !Array.isArray(r) ? r : {}) as Record<string, unknown>;
  const when = (obj.when && typeof obj.when === 'object' ? obj.when : {}) as Record<
    string,
    unknown
  >;
  const then = (obj.then && typeof obj.then === 'object' ? obj.then : {}) as Record<
    string,
    unknown
  >;
  return {
    id: typeof obj.id === 'string' ? obj.id : newId(),
    name: typeof obj.name === 'string' ? obj.name : '',
    on: obj.on !== false,
    keywords: Array.isArray(when.keywords) ? when.keywords.join('\n') : '',
    match: when.match === 'all' ? 'all' : 'any',
    tag: typeof when.tag === 'string' ? when.tag : '',
    addTags: Array.isArray(then.addTags) ? then.addTags.join(', ') : '',
    favorite: then.favorite === true,
    markRead: then.markRead === true,
    notify: then.notify === true,
  };
}

function toPayload(d: RuleDraft) {
  return {
    id: d.id,
    name: String(d.name || '').trim(),
    on: d.on !== false,
    when: {
      scope: ALL_SCOPE,
      keywords: parseLines(d.keywords),
      match: d.match === 'all' ? 'all' : 'any',
      tag: String(d.tag || '').trim(),
    },
    then: {
      addTags: parseComma(d.addTags),
      favorite: !!d.favorite,
      markRead: !!d.markRead,
      notify: !!d.notify,
    },
  };
}

const blank = (): RuleDraft => toDraft(null);

const isComplete = (d: RuleDraft): boolean =>
  (parseLines(d.keywords).length > 0 || !!String(d.tag || '').trim()) &&
  (parseComma(d.addTags).length > 0 || d.favorite || d.markRead || d.notify);

export function RulesEditor() {
  const [drafts, setDrafts] = useState<RuleDraft[]>([]);
  const [saved, setSaved] = useState('[]');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ResultState>(null);
  const [busy, setBusy] = useState(false);
  const guard = useFormLoadGuard();

  // V5：服务端数据交给 Query 管理（去重 / stale / 写后失效）；queryFn 仍走 core.apiFetch
  // 这个 I/O 端口，行为测试桩照常生效。面板条件挂载，refetchOnMount:'always' 保住
  // 「每次进入都重拉」的旧语义（stale 缓存不会让二次进入跳过请求）。
  const prefsQuery = useQuery({
    queryKey: qk.prefs,
    queryFn: async () => {
      const res = await S().apiFetch('/api/prefs');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    },
    refetchOnMount: 'always',
    retry: false,
  });

  // 把 Query 的取数结果喂回原有的回填逻辑（drafts/saved/loading/error 语义逐字保留）。
  // loading 初值为 true，只等首包；写后 invalidate 的后台重拉不闪 loading（旧实现亦如此）。
  useEffect(() => {
    if (prefsQuery.isPending) return;
    if (prefsQuery.isError) {
      const err = prefsQuery.error;
      setError('读取规则失败：' + String((err && err.message) || err));
      setLoading(false);
      return;
    }
    if (!prefsQuery.data) return;
    const list = Array.isArray(prefsQuery.data.rules) ? prefsQuery.data.rules.map(toDraft) : [];
    // 慢网下首包晚到时用户可能已经在编辑：跳过这次回填，别把草稿整块覆盖掉。
    guard.apply(() => {
      setError('');
      setDrafts(list);
      setSaved(JSON.stringify(list));
      setLoading(false);
    });
  }, [prefsQuery.data, prefsQuery.isPending, prefsQuery.isError, prefsQuery.error]);

  const update = (id: string, patch: Partial<RuleDraft>) => {
    guard.mark();
    setDrafts((list) => list.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };
  const remove = (id: string) => {
    guard.mark();
    setDrafts((list) => list.filter((d) => d.id !== id));
  };
  const add = () => {
    guard.mark();
    setDrafts((list) => [...list, blank()]);
  };

  async function onSave() {
    if (busy) return;
    setResult(null);
    const incomplete = drafts.some((d) => !isComplete(d));
    if (incomplete) {
      setResult({ ok: false, msg: '每条规则至少要有一个条件（关键词或标签）和一个动作' });
      return;
    }
    setBusy(true);
    try {
      const res = await S().apiFetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: drafts.map(toPayload) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ ok: false, msg: S().errText ? S().errText(data, '保存失败') : '保存失败' });
        return;
      }
      const list = Array.isArray(data.rules) ? data.rules.map(toDraft) : [];
      setDrafts(list);
      setSaved(JSON.stringify(list));
      setResult({ ok: true, msg: '自动化规则已保存，对之后新抓的文章生效' });
      // 写后失效：其它也读 prefs 的面板下次进入会重拉；本面板回填仍用保存回包（clamp 后的真值）。
      void invalidate(qk.prefs);
    } catch (err) {
      setResult({ ok: false, msg: '保存失败：' + String((err && err.message) || err) });
    } finally {
      setBusy(false);
    }
  }

  const dirty = JSON.stringify(drafts) !== saved;

  return (
    <Section
      secKey="watch-rules-engine"
      title="自动化规则"
      open
      sub={drafts.length ? `${drafts.length} 条 · 新文章入库时执行` : '还没配置'}
    >
      {loading ? <div className="sl-empty">正在读取规则…</div> : null}
      {error ? (
        <div className="sl-empty" role="alert">
          {error}
        </div>
      ) : null}

      {!loading && !error ? (
        <div className="sl-list">
          {drafts.length ? (
            drafts.map((d) => (
              <div className="rule-card" key={d.id}>
                <div className="rule-card-head">
                  <label className="switch" title={d.on ? '已启用' : '已停用'}>
                    <input
                      type="checkbox"
                      checked={d.on}
                      onChange={/** @param {*} [e] */ (e) => update(d.id, { on: e.target.checked })}
                    />
                    <span className="switch-slider" />
                  </label>
                  <input
                    className="rule-name"
                    type="text"
                    placeholder="规则名称（可选）"
                    value={d.name}
                    onChange={/** @param {*} [e] */ (e) => update(d.id, { name: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => remove(d.id)}
                  >
                    删除
                  </button>
                </div>
                <div className="rule-grid">
                  <label>
                    <span>关键词（一行一个，任选其一→ any）</span>
                    <textarea
                      rows={2}
                      spellCheck="false"
                      placeholder={'锂电\n新能源'}
                      value={d.keywords}
                      onChange={
                        /** @param {*} [e] */ (e) => update(d.id, { keywords: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>匹配方式</span>
                    <Dropdown
                      id={'ruleMatch-' + d.id}
                      wrapId={'ruleMatchDD-' + d.id}
                      title="匹配方式"
                      ariaLabel="匹配方式"
                      value={d.match}
                      onChange={/** @param {*} [v] */ (v) => update(d.id, { match: v })}
                      options={[
                        { value: 'any', label: '命中任一关键词' },
                        { value: 'all', label: '需同时命中全部关键词' },
                      ]}
                    />
                  </label>
                  <label>
                    <span>标签（可选，需已有该标签）</span>
                    <input
                      type="text"
                      placeholder="AI"
                      value={d.tag}
                      onChange={/** @param {*} [e] */ (e) => update(d.id, { tag: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>加标签（逗号分隔）</span>
                    <input
                      type="text"
                      placeholder="新能源, 关注"
                      value={d.addTags}
                      onChange={
                        /** @param {*} [e] */ (e) => update(d.id, { addTags: e.target.value })
                      }
                    />
                  </label>
                </div>
                <div className="rule-actions">
                  <label>
                    <input
                      type="checkbox"
                      checked={d.favorite}
                      onChange={
                        /** @param {*} [e] */ (e) => update(d.id, { favorite: e.target.checked })
                      }
                    />{' '}
                    收藏
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={d.markRead}
                      onChange={
                        /** @param {*} [e] */ (e) => update(d.id, { markRead: e.target.checked })
                      }
                    />{' '}
                    标记已读
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={d.notify}
                      onChange={
                        /** @param {*} [e] */ (e) => update(d.id, { notify: e.target.checked })
                      }
                    />{' '}
                    通知（webhook）
                  </label>
                </div>
              </div>
            ))
          ) : (
            <div className="sl-empty">
              还没有自动化规则。点「新增规则」，比如：标题含「锂电」→ 加标签「新能源」并收藏。
            </div>
          )}
        </div>
      ) : null}

      <div className="rule-foot">
        <button type="button" className="btn btn-ghost btn-sm" onClick={add} disabled={busy}>
          新增规则
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onSave}
          disabled={busy || !dirty}
        >
          {busy ? '保存中…' : '保存规则'}
        </button>
      </div>

      {result ? (
        <div className={'hint ' + (result.ok ? 'ok' : 'err')} role="status">
          {result.msg}
        </div>
      ) : null}
    </Section>
  );
}
