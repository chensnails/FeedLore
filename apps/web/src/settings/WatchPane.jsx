import { core } from '@core';
import { useState, useEffect, useRef } from 'react';
import { RuleScopePicker, emptyScope, normalizeScope } from './RuleScopePicker';

/**
 * 规则面板（v1.6.0-test5）：关注 / 屏蔽规则 + webhook 通知 + 入库前过滤。
 *
 * 关注 / 屏蔽规则存 users.prefs.watchRules（整组替换），关键词一行一个、子串匹配不分大小写；
 * 保存只影响「以后新抓的文章」，点「应用到已有文章」才回溯存量条目（/api/watch/apply）。
 * webhook 一条全局地址，每条关注规则单独决定要不要推送（屏蔽规则没有通知的意义）。
 * 入库前过滤存 users.prefs.filters（v2.7.0，原在账号面板），在抓取写库前生效。
 *
 * 两类规则都带 scope（v2.10.0）：新建时默认一个都不选 = 不生效；老数据缺 scope 视为全部频道。
 * 分组按名称动态跟随，以后加进该分组的频道自动纳入。
 */

const S = () => core;

let uidSeq = 0;
const newId = () => 'w' + Date.now().toString(36) + (++uidSeq).toString(36);
const blankRule = () => ({
  id: newId(), name: '', keywords: '', act: 'watch', notify: false, on: true, scope: emptyScope(),
});

/* 服务端数组 → 表单（keywords 摊成多行文本，便于直接编辑） */
function fromServer(list) {
  return (Array.isArray(list) ? list : []).map((r) => ({
    id: r.id,
    name: r.name || '',
    keywords: (r.keywords || []).join('\n'),
    act: r.act === 'block' ? 'block' : 'watch',
    notify: r.notify === true,
    on: r.on !== false,
    scope: normalizeScope(r.scope),
  }));
}

/* 表单 → 服务端（keywords 还原成数组；空行/重复由服务端 normalizeKeywords 再清一遍） */
function toServer(rules) {
  return rules.map((r) => ({
    id: r.id,
    name: r.name.trim(),
    keywords: r.keywords,
    act: r.act,
    notify: r.notify,
    on: r.on,
    scope: r.scope,
  }));
}

export function WatchPane() {
  const s = S();
  const [rules, setRules] = useState([]);
  const [webhook, setWebhook] = useState('');
  const [expireDays, setExpireDays] = useState('90'); // 关注保留天数，0 = 永不
  const [savedRules, setSavedRules] = useState('');   // JSON 指纹，用来算「改过没」
  const [savedWebhook, setSavedWebhook] = useState('');
  const [savedExpireDays, setSavedExpireDays] = useState('90');
  const [busy, setBusy] = useState('');               // save | apply | webhook | ''
  const [result, setResult] = useState(null);         // { ok, msg } | null

  // 入库前过滤（原在账号面板，v2.8.0 起归入「规则」）
  const [filters, setFilters] = useState([]);
  const [filtersLoaded, setFiltersLoaded] = useState(false);
  const [savingFilter, setSavingFilter] = useState(false);
  const [filterResult, setFilterResult] = useState(null);
  const paneRef = useRef(null);

  // 适用范围选择器要用的频道 / 分组清单
  const [feedsList, setFeedsList] = useState([]);
  const [groupOrder, setGroupOrder] = useState([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await s.apiFetch('/api/prefs');
        const d = await res.json();
        if (!alive) return;
        const r = fromServer(d.watchRules);
        const w = typeof d.webhookUrl === 'string' ? d.webhookUrl : '';
        const days = Number.isFinite(Number(d.watchExpireDays)) ? String(Number(d.watchExpireDays)) : '90';
        setRules(r);
        setWebhook(w);
        setExpireDays(days);
        setSavedRules(JSON.stringify(r));
        setSavedWebhook(w);
        setSavedExpireDays(days);
        setFilters((Array.isArray(d.filters) ? d.filters : [])
          .map((f) => Object.assign({}, f, { scope: normalizeScope(f.scope) })));
      } catch (err) {
        if (alive) setResult({ ok: false, msg: '读取失败：' + String((err && err.message) || err) });
      } finally {
        if (alive) setFiltersLoaded(true);
      }
      // 频道清单只有适用范围选择器用得到，失败时选择器里只剩「全部频道」
      try {
        const data = await s.loadFeeds();
        if (!alive) return;
        setFeedsList((data && data.feeds) || []);
        setGroupOrder((data && Array.isArray(data.groupOrder)) ? data.groupOrder : []);
      } catch (_) { /* 拿不到频道清单时选择器仍可切「全部频道」 */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 可折叠分组的开合按账号持久化（与账号面板同一机制）
  useEffect(() => {
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 过滤规则的成功提示 4s 后自动清除（与账号面板旧行为一致），失败常驻
  useEffect(() => {
    if (!filterResult || !filterResult.ok) return undefined;
    const t = setTimeout(() => setFilterResult(null), 4000);
    return () => clearTimeout(t);
  }, [filterResult]);

  const rulesDirty = JSON.stringify(rules) !== savedRules;
  const webhookDirty = webhook !== savedWebhook;
  const expireDirty = expireDays.trim() !== savedExpireDays;

  const patchRule = (id, patch) => {
    setRules((rs) => rs.map((r) => (r.id === id ? Object.assign({}, r, patch) : r)));
  };

  const onSaveRules = async () => {
    setBusy('save');
    try {
      // 空输入按默认值提交，避免 Number('') = 0 把「永不退出」误存进去
      const rawDays = expireDays.trim() === '' ? 90 : Number(expireDays);
      const days = Number.isFinite(rawDays) ? Math.max(0, Math.min(3650, Math.round(rawDays))) : 90;
      const res = await s.apiFetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watchRules: toServer(rules), watchExpireDays: days }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setResult({ ok: false, msg: data.error || '保存失败' }); return; }
      const next = fromServer(data.watchRules);
      const nextDays = Number.isFinite(Number(data.watchExpireDays)) ? String(Number(data.watchExpireDays)) : String(days);
      setRules(next);
      setExpireDays(nextDays);
      setSavedRules(JSON.stringify(next));
      setSavedExpireDays(nextDays);
      // 服务端清洗会丢掉非法规则，数量对不上要如实说
      const dropped = rules.length - next.length;
      setResult({ ok: true, msg: dropped > 0
        ? `已保存 ${next.length} 条规则（${dropped} 条因没有有效关键词被忽略）。只对之后新抓取的文章生效。`
        : '规则已保存，只对之后新抓取的文章生效；已有文章用下方「应用到已有文章」回溯。' });
    } catch (err) {
      setResult({ ok: false, msg: '保存失败：' + String((err && err.message) || err) });
    } finally {
      setBusy('');
    }
  };

  const onApply = async () => {
    // 回溯前先把手头的改动落库 —— 不然用户改完没保存就点应用，回溯的还是旧规则
    if (rulesDirty) { setResult({ ok: false, msg: '规则有未保存的改动，请先保存再应用。' }); return; }
    const okGo = await s.confirm({
      title: '把规则应用到已有文章？',
      desc: '会按当前规则重新判定全部已有文章：命中关注规则的加入「关注」，命中屏蔽规则的标为「屏蔽」并自动标为已读。',
      confirmText: '应用',
    });
    if (!okGo) return;
    setBusy('apply');
    try {
      const res = await s.apiFetch('/api/watch/apply', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setResult({ ok: false, msg: d.error || '应用失败' }); return; }
      setResult({ ok: true, msg: `已回溯：重新判定 ${d.tagged} 篇，关注命中 ${d.watching} 篇、屏蔽命中 ${d.blocked} 篇（清除旧标记 ${d.cleared} 条）。` });
      // 侧栏的关注 / 屏蔽计数变了，让频道栏重新拉一遍
      if (s.loadFeeds) await s.loadFeeds();
    } catch (err) {
      setResult({ ok: false, msg: '应用失败：' + String((err && err.message) || err) });
    } finally {
      setBusy('');
    }
  };

  const onSaveWebhook = async () => {
    setBusy('webhook');
    try {
      const res = await s.apiFetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl: webhook }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setResult({ ok: false, msg: data.error || '保存失败' }); return; }
      const w = typeof data.webhookUrl === 'string' ? data.webhookUrl : '';
      setWebhook(w);
      setSavedWebhook(w);
      setResult({ ok: true, msg: w ? 'Webhook 已保存，关注规则命中的新文章会推送到这个地址。' : 'Webhook 已清空，不再推送通知。' });
    } catch (err) {
      setResult({ ok: false, msg: '保存失败：' + String((err && err.message) || err) });
    } finally {
      setBusy('');
    }
  };

  const addRule = () => setRules((rs) => rs.concat([blankRule()]));
  const delRule = (id) => setRules((rs) => rs.filter((r) => r.id !== id));

  /* ---------- 入库前过滤：按账号独立保存，抓取写库前对新条目生效 ---------- */

  const onSaveFilters = async () => {
    setSavingFilter(true);
    try {
      const res = await s.apiFetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setFilterResult({ ok: false, msg: data.error || '保存失败' }); return; }
      // 服务端会重新清洗：空模式 / 非法正则 / 超长 都被丢弃，用回填结果告知差量
      const saved = (Array.isArray(data.filters) ? data.filters : [])
        .map((f) => Object.assign({}, f, { scope: normalizeScope(f.scope) }));
      setFilters(saved);
      const dropped = filters.length - saved.length;
      setFilterResult({ ok: true, msg: dropped > 0
        ? `已保存 ${saved.length} 条规则（${dropped} 条为空或非法，已丢弃）`
        : `已保存 ${saved.length} 条规则` });
    } catch (err) {
      setFilterResult({ ok: false, msg: '保存失败：' + String((err && err.message) || err) });
    } finally {
      setSavingFilter(false);
    }
  };

  const filterUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const addFilter = () => setFilters((list) => [...list,
    { id: filterUid(), on: true, act: 'block', field: 'title', kind: 'kw', pattern: '', scope: emptyScope() }]);

  /** 本地改一条规则的某个字段（不动其它字段） */
  const patchFilter = (id, patch) => {
    setFilters((list) => list.map((f) => (f.id === id ? Object.assign({}, f, patch) : f)));
  };

  const removeFilter = (id) => setFilters((list) => list.filter((f) => f.id !== id));

  return (
    <div className="tab-pane" data-pane="watch" ref={paneRef}>
      <div className="pane-scroll">
        <details className="sec" data-sec="watch-rules" open>
          <summary className="sec-head">
            <svg className="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
            <span className="sec-title">关注 / 屏蔽规则</span>
            <span className="sec-sub">{rules.length ? `${rules.length} 条` : '未配置'}</span>
          </summary>
          <div className="sec-body">
        <div className="form-row">
          <label htmlFor="watchWebhook">Webhook 通知地址（可选）</label>
          <div className="input-with-btn">
            <input
              id="watchWebhook"
              type="url"
              placeholder="https://…" spellCheck="false" autoComplete="off"
              value={webhook}
              onChange={(ev) => setWebhook(ev.target.value)}
            />
            <button className="btn btn-ghost" type="button" disabled={busy === 'webhook'}
              onClick={onSaveWebhook}>
              {busy === 'webhook' ? '保存中…' : '保存'}
            </button>
          </div>
          <small className="form-tip">
            新抓取的文章命中关注规则时，向该地址 POST 一条 JSON；同一轮多条合并成一条。留空则不推送。
          </small>
        </div>

        <div className="form-row form-row-inline">
          <label htmlFor="watchExpireDays">关注保留天数</label>
          <input
            id="watchExpireDays" type="number" inputMode="numeric" min="0" max="3650" step="1"
            style={{ width: '6.5em', flex: '0 0 auto' }}
            value={expireDays}
            onChange={(ev) => setExpireDays(ev.target.value)}
          />
          <span className="muted">天后自动取消关注（0 表示永久保留，默认 90 天）</span>
          <small className="form-tip">
            只取消「关注」标记，文章仍留在原频道，已读 / 收藏状态不变；屏蔽不受影响。清理在下一轮刷新时执行。
          </small>
        </div>

        <div className="form-row">
          <label className="form-row-head">
            <span>关注 / 屏蔽规则（{rules.length}/30）</span>
            <button className="btn btn-ghost btn-sm" type="button" onClick={addRule}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-plus" /></svg>
              添加规则
            </button>
          </label>
          <small className="form-tip">
            每行一个关键词，标题、摘要或正文中出现即命中（不区分大小写）。同一篇文章同时命中关注和屏蔽规则时，以「屏蔽」为准。
            「关注」和「屏蔽」是智能分组：只给文章打标记，不改变它所在的频道。
          </small>
        </div>

        {rules.map((r) => (
          <div className={'watch-rule' + (r.on ? '' : ' is-off')} key={r.id} data-rule-id={r.id}>
            <div className="watch-rule-head">
              <input
                className="watch-rule-name" type="text" placeholder="规则名称（可留空）"
                aria-label="规则名称" maxLength="40" spellCheck="false"
                value={r.name}
                onChange={(ev) => patchRule(r.id, { name: ev.target.value })}
              />
              <div className="seg" role="radiogroup" aria-label="规则动作">
                <button type="button" className={'seg-btn' + (r.act === 'watch' ? ' active' : '')}
                  aria-pressed={r.act === 'watch' ? 'true' : 'false'}
                  title="命中后加入「关注」"
                  onClick={() => patchRule(r.id, { act: 'watch' })}>
                  <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-eye" /></svg>关注
                </button>
                <button type="button" className={'seg-btn is-block' + (r.act === 'block' ? ' active' : '')}
                  aria-pressed={r.act === 'block' ? 'true' : 'false'}
                  title="命中后标为「屏蔽」，并自动标为已读"
                  onClick={() => patchRule(r.id, { act: 'block', notify: false })}>
                  <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-block" /></svg>屏蔽
                </button>
              </div>
            </div>
            <textarea
              className="watch-rule-kw" rows="3" spellCheck="false"
              placeholder={'关键词，一行一个，例如：\nOpenAI\nGPT-5'}
              aria-label="关键词（每行一个）"
              value={r.keywords}
              onChange={(ev) => patchRule(r.id, { keywords: ev.target.value })}
            />
            <div className="watch-rule-scope">
              <RuleScopePicker
                value={r.scope}
                onChange={(scope) => patchRule(r.id, { scope })}
                feeds={feedsList}
                groupOrder={groupOrder}
              />
            </div>
            <div className="watch-rule-foot">
              {r.act === 'watch' ? (
                <label className="watch-check">
                  <input type="checkbox" checked={r.notify}
                    onChange={(ev) => patchRule(r.id, { notify: ev.target.checked })} />
                  命中新文章时推送 Webhook
                </label>
              ) : (
                <span className="watch-check muted">命中后自动标为已读</span>
              )}
              <label className="watch-check">
                <input type="checkbox" checked={r.on}
                  onChange={(ev) => patchRule(r.id, { on: ev.target.checked })} />
                启用
              </label>
              <button className="btn btn-ghost btn-sm watch-rule-del" type="button"
                aria-label={`删除规则「${r.name || r.id}」`}
                onClick={() => delRule(r.id)}>
                <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-trash" /></svg>删除
              </button>
            </div>
          </div>
        ))}

        {rules.length === 0 ? (
          <div className="watch-empty">还没有规则。点「添加规则」新建一条，比如把标题含「OpenAI」的文章加入关注。</div>
        ) : null}

        <div className="watch-actions">
          <button className="btn btn-primary" type="button" disabled={busy === 'save' || !(rulesDirty || expireDirty)}
            onClick={onSaveRules}>
            {busy === 'save' ? '保存中…' : '保存规则'}
          </button>
          <button className="btn btn-ghost" type="button" disabled={busy === 'apply'}
            title="按当前已保存的规则重新判定全部已有文章"
            onClick={onApply}>
            {busy === 'apply' ? '回溯中…' : '应用到已有文章'}
          </button>
        </div>

            {result && (
              <div className={'test-result show ' + (result.ok ? 'ok' : 'err')} id="watchResult" role="status">
                {result.msg}
              </div>
            )}
          </div>
        </details>

        <details className="sec" data-sec="watch-filters">
          <summary className="sec-head">
            <svg className="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
            <span className="sec-title">入库前过滤</span>
            <span className="sec-sub">{!filtersLoaded ? '读取中…' : (filters.length ? `${filters.length} 条` : '未配置')}</span>
          </summary>
          <div className="sec-body">
            {!filtersLoaded ? <div className="hint">正在读取规则…</div>
              : !filters.length ? <div className="hint">还没有规则。点「添加过滤规则」试试，比如丢弃标题含「广告」的文章。</div>
                : filters.map((f) => (
                  <div className="filter-row" key={f.id} data-fid={f.id}>
                    <input className="filter-on" type="checkbox" checked={f.on !== false} title="启用该规则"
                      aria-label="启用该规则"
                      onChange={(e) => patchFilter(f.id, { on: e.target.checked })} />
                    <select className="select filter-act" title="动作" aria-label="动作"
                      value={f.act} onChange={(e) => patchFilter(f.id, { act: e.target.value })}>
                      <option value="block">丢弃</option>
                      <option value="allow">只收</option>
                    </select>
                    <select className="select filter-field" title="匹配范围" aria-label="匹配范围"
                      value={f.field} onChange={(e) => patchFilter(f.id, { field: e.target.value })}>
                      <option value="title">标题</option>
                      <option value="desc">摘要</option>
                      <option value="content">正文</option>
                      <option value="all">全部</option>
                    </select>
                    <select className="select filter-kind" title="匹配方式" aria-label="匹配方式"
                      value={f.kind} onChange={(e) => patchFilter(f.id, { kind: e.target.value })}>
                      <option value="kw">关键词</option>
                      <option value="re">正则</option>
                    </select>
                    <input className="filter-pattern" type="text" spellCheck="false" autoComplete="off"
                      placeholder={f.kind === 're' ? '如：v\\d+\\.\\d+' : '关键词，不区分大小写'}
                      value={f.pattern}
                      onChange={(e) => patchFilter(f.id, { pattern: e.target.value })} />
                    <RuleScopePicker
                      compact
                      value={f.scope}
                      onChange={(scope) => patchFilter(f.id, { scope })}
                      feeds={feedsList}
                      groupOrder={groupOrder}
                    />
                    <button className="btn btn-ghost btn-sm filter-del" type="button"
                      onClick={() => removeFilter(f.id)}>删除</button>
                  </div>
                ))}
            <div className="filter-actions">
              <button className="btn btn-ghost btn-sm" id="addFilterBtn" type="button"
                onClick={addFilter}>添加过滤规则</button>
            </div>
            <small className="form-tip">
              在写入数据库之前过滤，只影响之后新抓的文章，已入库的历史文章不动。<br />
              <b>丢弃</b>：命中即不入库；<b>只收</b>：只保留命中的文章（白名单）。两者同时存在时，先丢弃、再只收。<br />
              关键词不区分大小写；范围「全部」= 标题 + 摘要 + 正文；非法正则在保存时会被忽略。
            </small>
            <div id="filterResult" role="status" aria-live="polite"
              className={'test-result' + (filterResult ? ' show ' + (filterResult.ok ? 'ok' : 'err') : '')}>
              {filterResult ? filterResult.msg : ''}
            </div>
            <div className="filter-save">
              <button className="btn btn-primary btn-sm" id="saveFilterBtn" type="button"
                disabled={savingFilter} onClick={onSaveFilters}>
                {savingFilter ? '保存中…' : '保存规则'}
              </button>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
