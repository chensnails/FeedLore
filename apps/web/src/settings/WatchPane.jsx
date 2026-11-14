import { core } from '@core';
import { useState, useEffect, useRef } from 'react';
import { DetailSheet } from './DetailSheet.jsx';
import { Result, Section } from './primitives.jsx';
import { RuleScopePicker, emptyScope, normalizeScope, scopeSummary } from './RuleScopePicker';
import { NO_AUTOFILL_PROPS } from '../ui/noAutofill.js';

/**
 * 规则面板（A 方案）：关注 / 屏蔽规则 + 入库前过滤，都是「紧凑列表 + 详情层」。
 *
 * 关注 / 屏蔽规则存 users.prefs.watchRules（整组替换），关键词一行一个、子串匹配不分大小写；
 * 保存只影响「以后新抓的文章」，点「应用到已有文章」才回溯存量条目（/api/watch/apply）。
 * 入库前过滤存 users.prefs.filters，在抓取写库前生效。
 * 两类规则都带 scope：新建时默认一个都不选 = 不生效；老数据缺 scope 视为全部频道。
 *
 * 列表行上的开关即改即存，附「撤销」toast；点行开详情层，改完关层时自动落库。
 * Webhook 与关注保留天数单独收在「通知与保留」里，失焦 / 回车即提交。
 */

const S = () => core;

let uidSeq = 0;
const newId = () => 'w' + Date.now().toString(36) + (++uidSeq).toString(36);

const jsonPost = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const parseKeywords = (text) => String(text || '')
  .split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

const blankRule = () => ({
  id: newId(), name: '', keywords: '', act: 'watch', notify: false, on: true, scope: emptyScope(),
});

const blankFilter = (id) => ({
  id: id || newId(), on: true, act: 'block', field: 'title', kind: 'kw', pattern: '', scope: emptyScope(),
});

const ruleName = (r) => r.name || parseKeywords(r.keywords)[0] || '未命名规则';
const actText = (act) => (act === 'block' ? '屏蔽' : '关注');
const filterActText = (act) => (act === 'allow' ? '只收' : '丢弃');
const fieldText = (field) => ({ title: '标题', desc: '摘要', content: '正文', all: '全部' }[field] || '标题');
const kindText = (kind) => (kind === 're' ? '正则' : '关键词');

const ruleSummary = (r) => {
  const n = parseKeywords(r.keywords).length;
  return [
    actText(r.act),
    scopeSummary(r.scope),
    n ? `${n} 个关键词` : '没有关键词',
  ].concat(r.act === 'watch' && r.notify ? ['推送 Webhook'] : []).join(' · ');
};

const filterSummary = (f) => [filterActText(f.act), fieldText(f.field), kindText(f.kind), scopeSummary(f.scope)].join(' · ');

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

/* 表单 → 服务端（keywords 还原成数组；空行 / 重复由服务端再清一遍） */
function toServer(rules) {
  return rules.map((r) => ({
    id: r.id,
    name: r.name.trim(),
    keywords: parseKeywords(r.keywords),
    act: r.act,
    notify: r.notify,
    on: r.on,
    scope: r.scope,
  }));
}

const filtersFromServer = (list) => (Array.isArray(list) ? list : [])
  .map((f) => Object.assign({}, f, { scope: normalizeScope(f.scope) }));

const sameRule = (a, b) => a.name === b.name && a.keywords === b.keywords && a.act === b.act
  && a.notify === b.notify && a.on === b.on && JSON.stringify(a.scope) === JSON.stringify(b.scope);

const sameFilter = (a, b) => a.on === b.on && a.act === b.act && a.field === b.field
  && a.kind === b.kind && a.pattern === b.pattern && JSON.stringify(a.scope) === JSON.stringify(b.scope);

const blurOnEnter = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.currentTarget.blur(); } };

/* ---------- 规则详情层 ---------- */
function RuleSheet({ rule, isNew, busy, feeds, groupOrder, onClose, onSave, onDelete }) {
  const s = S();
  const [draft, setDraft] = useState(rule);
  const patch = (p) => setDraft((d) => Object.assign({}, d, p));
  const kws = parseKeywords(draft.keywords);
  const dirty = !sameRule(draft, rule);
  const invalid = kws.length === 0;

  // 关层不丢编辑：已有规则改过且合法就顺手存掉；清空关键词的老规则放弃改动并说明
  const requestClose = () => {
    if (!isNew && dirty && !invalid) { onSave(draft); return; }
    if (!isNew && dirty && invalid) s.toast('关键词已清空，改动未保存', false);
    onClose();
  };

  return (
    <DetailSheet
      title={isNew ? '新建规则' : ruleName(rule)}
      subtitle={isNew ? '设好关键词与适用范围后保存' : ruleSummary(rule)}
      onClose={requestClose}
      saveHint="关闭本层会保存已有规则的改动；新建请点「保存」"
      foot={
        <>
          {isNew ? null : (
            <button className="btn btn-danger" type="button" id="delRuleBtn" disabled={busy}
              onClick={() => onDelete(draft)}>删除规则</button>
          )}
          <button className="btn btn-primary" type="button" id="saveRuleBtn"
            disabled={busy || invalid} title={invalid ? '至少填写一个关键词' : ''}
            onClick={() => onSave(draft)}>{busy ? '保存中…' : '保存'}</button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="ruleName">名称</label>
        <input id="ruleName" type="text" maxLength="40" spellCheck="false" autoComplete="off"
          placeholder="可留空，默认用第一个关键词"
          value={draft.name} onChange={(ev) => patch({ name: ev.target.value })} {...NO_AUTOFILL_PROPS} />
      </div>

      <div className="form-row">
        <label>动作</label>
        <div className="seg" role="radiogroup" aria-label="规则动作">
          <button type="button" className={'seg-btn' + (draft.act === 'watch' ? ' active' : '')}
            aria-pressed={draft.act === 'watch' ? 'true' : 'false'}
            onClick={() => patch({ act: 'watch' })}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-eye" /></svg>关注
          </button>
          <button type="button" className={'seg-btn is-block' + (draft.act === 'block' ? ' active' : '')}
            aria-pressed={draft.act === 'block' ? 'true' : 'false'}
            onClick={() => patch({ act: 'block', notify: false })}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-block" /></svg>屏蔽
          </button>
        </div>
        <small className="form-tip">
          {draft.act === 'watch'
            ? '命中后加入「关注」智能分组，不改变文章所在的频道。'
            : '命中后标为「屏蔽」并自动标为已读。'}
        </small>
      </div>

      <div className="form-row">
        <label htmlFor="ruleKeywords">关键词</label>
        <textarea id="ruleKeywords" className="watch-rule-kw" rows="5" spellCheck="false"
          placeholder={'一行一个，例如：\nOpenAI\nGPT-5'}
          value={draft.keywords} onChange={(ev) => patch({ keywords: ev.target.value })} />
        <small className="form-tip">
          标题、摘要或正文中出现即命中（不区分大小写）{kws.length ? ` · 当前 ${kws.length} 个` : ' · 至少填一个'}
        </small>
      </div>

      <div className="form-row">
        <label>适用范围</label>
        <RuleScopePicker value={draft.scope} onChange={(scope) => patch({ scope })}
          feeds={feeds} groupOrder={groupOrder} />
        <small className="form-tip">勾分组会覆盖整组（含以后新加入的频道）；一个都不选时这条规则不生效。</small>
      </div>

      {draft.act === 'watch' ? (
        <label className="ds-sw-row">
          <span className="ds-sw-txt">
            <span className="ds-sw-name">推送 Webhook</span>
            <span className="ds-sw-desc">命中新文章时向已配置的 Webhook 地址推送</span>
          </span>
          <span className="switch">
            <input type="checkbox" checked={draft.notify}
              onChange={(ev) => patch({ notify: ev.target.checked })} />
            <span className="switch-slider" />
          </span>
        </label>
      ) : null}
      <label className="ds-sw-row">
        <span className="ds-sw-txt">
          <span className="ds-sw-name">启用</span>
          <span className="ds-sw-desc">关闭后这条规则不参与判定</span>
        </span>
        <span className="switch">
          <input type="checkbox" checked={draft.on}
            onChange={(ev) => patch({ on: ev.target.checked })} />
          <span className="switch-slider" />
        </span>
      </label>
    </DetailSheet>
  );
}

/* ---------- 过滤规则详情层 ---------- */
function FilterSheet({ filter, isNew, busy, feeds, groupOrder, onClose, onSave, onDelete }) {
  const s = S();
  const [draft, setDraft] = useState(filter);
  const patch = (p) => setDraft((d) => Object.assign({}, d, p));
  const dirty = !sameFilter(draft, filter);
  const invalid = !String(draft.pattern || '').trim();

  const requestClose = () => {
    if (!isNew && dirty && !invalid) { onSave(draft); return; }
    if (!isNew && dirty && invalid) s.toast('匹配模式已清空，改动未保存', false);
    onClose();
  };

  return (
    <DetailSheet
      title={isNew ? '新建过滤规则' : (filter.pattern || '过滤规则')}
      subtitle={isNew ? '保存后对之后新抓取的文章生效' : filterSummary(filter)}
      onClose={requestClose}
      saveHint="关闭本层会保存已有规则的改动；新建请点「保存」"
      foot={
        <>
          {isNew ? null : (
            <button className="btn btn-danger" type="button" id="delFilterBtn" disabled={busy}
              onClick={() => onDelete(draft)}>删除规则</button>
          )}
          <button className="btn btn-primary" type="button" id="saveFilterBtn"
            disabled={busy || invalid} title={invalid ? '请填写匹配模式' : ''}
            onClick={() => onSave(draft)}>{busy ? '保存中…' : '保存'}</button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="filterAct">动作</label>
        <select id="filterAct" className="select filter-act" value={draft.act}
          onChange={(ev) => patch({ act: ev.target.value })}>
          <option value="block">丢弃（命中即不入库）</option>
          <option value="allow">只收（只保留命中）</option>
        </select>
        <small className="form-tip">两者同时存在时，先丢弃、再只收。</small>
      </div>

      <div className="form-row">
        <label htmlFor="filterField">匹配范围</label>
        <select id="filterField" className="select filter-field" value={draft.field}
          onChange={(ev) => patch({ field: ev.target.value })}>
          <option value="title">标题</option>
          <option value="desc">摘要</option>
          <option value="content">正文</option>
          <option value="all">全部（标题 + 摘要 + 正文）</option>
        </select>
      </div>

      <div className="form-row">
        <label htmlFor="filterKind">匹配方式</label>
        <select id="filterKind" className="select filter-kind" value={draft.kind}
          onChange={(ev) => patch({ kind: ev.target.value })}>
          <option value="kw">关键词</option>
          <option value="re">正则</option>
        </select>
      </div>

      <div className="form-row">
        <label htmlFor="filterPattern">匹配模式</label>
        <input id="filterPattern" className="filter-pattern" type="text"
          placeholder={draft.kind === 're' ? '如：v\d+\.\d+' : '关键词，不区分大小写'}
          value={draft.pattern} onChange={(ev) => patch({ pattern: ev.target.value })}
          {...NO_AUTOFILL_PROPS} />
        <small className="form-tip">
          {draft.kind === 're' ? '非法正则在保存时会被忽略。' : '子串匹配，不区分大小写。'}
        </small>
      </div>

      <div className="form-row">
        <label>适用范围</label>
        <RuleScopePicker value={draft.scope} onChange={(scope) => patch({ scope })}
          feeds={feeds} groupOrder={groupOrder} />
        <small className="form-tip">一个都不选时这条规则不生效；勾分组会覆盖整组。</small>
      </div>

      <label className="ds-sw-row">
        <span className="ds-sw-txt">
          <span className="ds-sw-name">启用</span>
          <span className="ds-sw-desc">关闭后这条规则不参与过滤</span>
        </span>
        <span className="switch">
          <input type="checkbox" checked={draft.on}
            onChange={(ev) => patch({ on: ev.target.checked })} />
          <span className="switch-slider" />
        </span>
      </label>
    </DetailSheet>
  );
}

export function WatchPane({ onDirtyChange }) {
  const s = S();
  const [rules, setRules] = useState([]);
  const [filters, setFilters] = useState([]);
  const [webhook, setWebhook] = useState('');
  const [savedWebhook, setSavedWebhook] = useState('');
  const [expireDays, setExpireDays] = useState('90'); // 关注保留天数，0 = 永不
  const [savedExpireDays, setSavedExpireDays] = useState('90');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');               // rules | filters | webhook | expire | apply
  const [result, setResult] = useState(null);         // { ok, msg } | null —— #watchResult
  const [prefsError, setPrefsError] = useState('');   // /api/prefs 读取失败（面板级，编辑动作要禁用）
  const [sheet, setSheet] = useState(null);           // { type: 'rule' | 'filter', value, isNew }
  const paneRef = useRef(null);

  // 适用范围选择器要用的频道 / 分组清单
  const [feedsList, setFeedsList] = useState([]);
  const [groupOrder, setGroupOrder] = useState([]);

  /** 进入面板与「重试」共用一份回填。读取失败时不能把空数组显示成「还没有规则」：
   *  用户会以为服务端本来就没规则，新建一条后整组替换，把真实规则覆盖掉。 */
  const loadPrefs = async (alive = () => true) => {
    setPrefsError('');
    try {
      const res = await s.apiFetch('/api/prefs');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      if (!alive()) return;
      setRules(fromServer(d.watchRules));
      const w = typeof d.webhookUrl === 'string' ? d.webhookUrl : '';
      const days = Number.isFinite(Number(d.watchExpireDays)) ? String(Number(d.watchExpireDays)) : '90';
      setWebhook(w);
      setSavedWebhook(w);
      setExpireDays(days);
      setSavedExpireDays(days);
      setFilters(filtersFromServer(d.filters));
    } catch (err) {
      if (alive()) setPrefsError('读取失败：' + String((err && err.message) || err));
    } finally {
      if (alive()) setLoaded(true);
    }
    // 频道清单只有适用范围选择器用得到，失败时选择器里只剩「全部频道」
    try {
      const data = await s.loadFeeds();
      if (!alive()) return;
      setFeedsList((data && data.feeds) || []);
      setGroupOrder((data && Array.isArray(data.groupOrder)) ? data.groupOrder : []);
    } catch (_) { /* 拿不到频道清单时选择器仍可切「全部频道」 */ }
  };

  useEffect(() => {
    let alive = true;
    loadPrefs(() => alive);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 可折叠分组的开合按账号持久化（与其它面板同一机制）
  useEffect(() => {
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 成功提示 4s 后自动清除，失败常驻
  useEffect(() => {
    if (!result || !result.ok) return undefined;
    const t = setTimeout(() => setResult(null), 4000);
    return () => clearTimeout(t);
  }, [result]);

  // 改动都是即存；详情层里的草稿在关层时落库，所以没有面板级脏态
  useEffect(() => {
    if (onDirtyChange) onDirtyChange(false);
  }, [onDirtyChange]);

  const postPrefs = async (body) => {
    const res = await s.apiFetch('/api/prefs', jsonPost(body));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(s.errText(data, '保存失败'));
    return data;
  };

  /* ---------- 关注 / 屏蔽规则 ---------- */

  const commitRules = async (next) => {
    setBusy('rules');
    try {
      const data = await postPrefs({ watchRules: toServer(next) });
      const saved = fromServer(data.watchRules);
      setRules(saved);
      return { ok: true, saved, dropped: next.length - saved.length };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    } finally {
      setBusy('');
    }
  };

  const restoreRules = async (prev, msg) => {
    const out = await commitRules(prev);
    if (out.ok) s.toast(msg);
    else s.toast('撤销失败：' + out.error, false);
  };

  const openRule = (r, isNew) => setSheet({ type: 'rule', value: isNew ? blankRule() : r, isNew });

  const saveRuleDraft = async (draft) => {
    const exists = rules.some((r) => r.id === draft.id);
    const prev = rules;
    const next = exists ? rules.map((r) => (r.id === draft.id ? draft : r)) : rules.concat([draft]);
    const out = await commitRules(next);
    if (!out.ok) { s.toast('保存失败：' + out.error, false); return; }
    setSheet(null);
    if (out.dropped > 0) { s.toast('关键词为空，这条规则没有保存', false); return; }
    s.toast(exists ? '规则已保存，只对之后新抓取的文章生效' : '规则已添加，只对之后新抓取的文章生效', true, {
      actionText: '撤销', ms: 6000,
      action: () => restoreRules(prev, exists ? '已撤销修改' : '已撤销添加'),
    });
  };

  const deleteRule = async (r) => {
    const okGo = await s.confirm({
      title: `删除规则「${ruleName(r)}」？`,
      desc: '只影响以后新抓取的文章判定；已入库文章上的关注 / 屏蔽标记不变。',
      confirmText: '删除', danger: true,
    });
    if (!okGo) return;
    const prev = rules;
    const out = await commitRules(rules.filter((x) => x.id !== r.id));
    if (!out.ok) { s.toast('删除失败：' + out.error, false); return; }
    setSheet(null);
    s.toast('规则已删除', true, {
      actionText: '撤销', ms: 6000,
      action: () => restoreRules(prev, '已恢复规则'),
    });
  };

  const toggleRule = async (r, on) => {
    const prev = rules;
    const out = await commitRules(rules.map((x) => (x.id === r.id ? Object.assign({}, x, { on }) : x)));
    if (!out.ok) { s.toast('保存失败：' + out.error, false); return; }
    s.toast(`${ruleName(r)} 已${on ? '启用' : '停用'}`, true, {
      actionText: '撤销', ms: 6000,
      action: () => restoreRules(prev, '已撤销'),
    });
  };

  const onApply = async () => {
    if (sheet) { s.toast('先关闭正在编辑的规则', false); return; }
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
      if (!res.ok) { setResult({ ok: false, msg: s.errText(d, '应用失败') }); return; }
      setResult({ ok: true, msg: `已回溯：重新判定 ${d.tagged} 篇，关注命中 ${d.watching} 篇、屏蔽命中 ${d.blocked} 篇（清除旧标记 ${d.cleared} 条）。` });
      // 侧栏的关注 / 屏蔽计数变了，让频道栏重新拉一遍
      if (s.loadFeeds) await s.loadFeeds();
    } catch (err) {
      setResult({ ok: false, msg: '应用失败：' + String((err && err.message) || err) });
    } finally {
      setBusy('');
    }
  };

  /* ---------- 入库前过滤 ---------- */

  const commitFilters = async (next) => {
    setBusy('filters');
    try {
      const data = await postPrefs({ filters: next });
      const saved = filtersFromServer(data.filters);
      setFilters(saved);
      return { ok: true, saved, dropped: next.length - saved.length };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    } finally {
      setBusy('');
    }
  };

  const restoreFilters = async (prev, msg) => {
    const out = await commitFilters(prev);
    if (out.ok) s.toast(msg);
    else s.toast('撤销失败：' + out.error, false);
  };

  const openFilter = (f, isNew) => setSheet({ type: 'filter', value: isNew ? blankFilter() : f, isNew });

  const saveFilterDraft = async (draft) => {
    const exists = filters.some((f) => f.id === draft.id);
    const prev = filters;
    const next = exists ? filters.map((f) => (f.id === draft.id ? draft : f)) : filters.concat([draft]);
    const out = await commitFilters(next);
    if (!out.ok) { s.toast('保存失败：' + out.error, false); return; }
    setSheet(null);
    if (out.dropped > 0) { s.toast('匹配模式为空或非法，这条规则没有保存', false); return; }
    s.toast(exists ? '过滤规则已保存' : '过滤规则已添加，对之后新抓取的文章生效', true, {
      actionText: '撤销', ms: 6000,
      action: () => restoreFilters(prev, exists ? '已撤销修改' : '已撤销添加'),
    });
  };

  const deleteFilter = async (f) => {
    const okGo = await s.confirm({
      title: `删除过滤规则「${f.pattern || '未命名'}」？`,
      desc: '只影响以后新抓取的文章，已入库的历史文章不动。',
      confirmText: '删除', danger: true,
    });
    if (!okGo) return;
    const prev = filters;
    const out = await commitFilters(filters.filter((x) => x.id !== f.id));
    if (!out.ok) { s.toast('删除失败：' + out.error, false); return; }
    setSheet(null);
    s.toast('过滤规则已删除', true, {
      actionText: '撤销', ms: 6000,
      action: () => restoreFilters(prev, '已恢复规则'),
    });
  };

  const toggleFilter = async (f, on) => {
    const prev = filters;
    const out = await commitFilters(filters.map((x) => (x.id === f.id ? Object.assign({}, x, { on }) : x)));
    if (!out.ok) { s.toast('保存失败：' + out.error, false); return; }
    s.toast(`${f.pattern || '过滤规则'} 已${on ? '启用' : '停用'}`, true, {
      actionText: '撤销', ms: 6000,
      action: () => restoreFilters(prev, '已撤销'),
    });
  };

  /* ---------- Webhook / 关注保留天数：失焦即提交 ---------- */

  const commitWebhook = async () => {
    const next = webhook.trim();
    if (next === savedWebhook) { setWebhook(savedWebhook); return; }
    setBusy('webhook');
    try {
      const data = await postPrefs({ webhookUrl: next });
      const w = typeof data.webhookUrl === 'string' ? data.webhookUrl : '';
      const prev = savedWebhook;
      setWebhook(w);
      setSavedWebhook(w);
      s.toast(w ? 'Webhook 已保存，关注规则命中的新文章会推送到这个地址' : 'Webhook 已清空，不再推送通知', true, {
        actionText: '撤销', ms: 6000,
        action: async () => {
          try {
            const back = await postPrefs({ webhookUrl: prev });
            const pw = typeof back.webhookUrl === 'string' ? back.webhookUrl : '';
            setWebhook(pw);
            setSavedWebhook(pw);
            s.toast('已撤销');
          } catch (e) { s.toast('撤销失败：' + (e.message || e), false); }
        },
      });
    } catch (e) {
      setWebhook(savedWebhook);
      setResult({ ok: false, msg: 'Webhook 保存失败：' + (e.message || e) });
    } finally {
      setBusy('');
    }
  };

  const normalizeDays = (raw) => {
    const n = String(raw).trim() === '' ? 90 : Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(3650, Math.round(n))) : 90;
  };

  const commitExpire = async () => {
    const days = normalizeDays(expireDays);
    setExpireDays(String(days));
    if (String(days) === savedExpireDays) return;
    setBusy('expire');
    try {
      const data = await postPrefs({ watchExpireDays: days });
      const nd = Number.isFinite(Number(data.watchExpireDays)) ? String(Number(data.watchExpireDays)) : String(days);
      const prev = Number(savedExpireDays);
      setExpireDays(nd);
      setSavedExpireDays(nd);
      s.toast(`关注保留 ${Number(nd) === 0 ? '永久' : nd + ' 天'}`, true, {
        actionText: '撤销', ms: 6000,
        action: async () => {
          try {
            const back = await postPrefs({ watchExpireDays: prev });
            const bd = Number.isFinite(Number(back.watchExpireDays)) ? String(Number(back.watchExpireDays)) : String(prev);
            setExpireDays(bd);
            setSavedExpireDays(bd);
            s.toast('已撤销');
          } catch (e) { s.toast('撤销失败：' + (e.message || e), false); }
        },
      });
    } catch (e) {
      setExpireDays(savedExpireDays);
      setResult({ ok: false, msg: '保存失败：' + (e.message || e) });
    } finally {
      setBusy('');
    }
  };

  /* ---------- 渲染 ---------- */

  const renderRuleRow = (r) => {
    const on = r.on !== false;
    const blocked = r.act === 'block';
    return (
      <div className={'sl-row' + (on ? '' : ' is-off')} key={r.id} data-rule-id={r.id}
        role="button" tabIndex={0} aria-label={`编辑规则「${ruleName(r)}」`}
        onClick={() => openRule(r, false)}
        onKeyDown={(ev) => {
          if (ev.target !== ev.currentTarget) return;
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openRule(r, false); }
        }}>
        <span className={'sl-ava' + (blocked ? ' danger' : '')}>
          <svg className="ico" aria-hidden="true" focusable="false"><use href={blocked ? '#i-block' : '#i-eye'} /></svg>
        </span>
        <div className="sl-main">
          <div className="sl-name">{ruleName(r)}</div>
          <div className="sl-sub">{ruleSummary(r)}</div>
        </div>
        <span className="sl-side" onClick={(ev) => ev.stopPropagation()}>
          <span className={'sl-badge' + (blocked ? ' block' : '')}>{actText(r.act)}</span>
          <span className="switch">
            <input type="checkbox" data-rule-on={r.id} aria-label={`启用规则「${ruleName(r)}」`}
              checked={on} disabled={busy === 'rules'}
              onChange={(ev) => toggleRule(r, ev.target.checked)} />
            <span className="switch-slider" />
          </span>
        </span>
        <svg className="ico feed-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
      </div>
    );
  };

  const renderFilterRow = (f) => {
    const on = f.on !== false;
    return (
      <div className={'sl-row' + (on ? '' : ' is-off')} key={f.id} data-fid={f.id}
        role="button" tabIndex={0} aria-label={`编辑过滤规则「${f.pattern || '未命名'}」`}
        onClick={() => openFilter(f, false)}
        onKeyDown={(ev) => {
          if (ev.target !== ev.currentTarget) return;
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openFilter(f, false); }
        }}>
        <span className="sl-ava">
          <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-filter" /></svg>
        </span>
        <div className="sl-main">
          <div className="sl-name">{f.pattern || '未填写模式'}</div>
          <div className="sl-sub">{filterSummary(f)}</div>
        </div>
        <span className="sl-side" onClick={(ev) => ev.stopPropagation()}>
          <span className={'sl-badge' + (f.act === 'allow' ? '' : ' block')}>{filterActText(f.act)}</span>
          <span className="switch">
            <input type="checkbox" data-filter-on={f.id} aria-label={`启用过滤规则「${f.pattern || '未命名'}」`}
              checked={on} disabled={busy === 'filters'}
              onChange={(ev) => toggleFilter(f, ev.target.checked)} />
            <span className="switch-slider" />
          </span>
        </span>
        <svg className="ico feed-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
      </div>
    );
  };

  const notifySub = `${webhook ? 'Webhook 已配置' : '未配置 Webhook'} · 关注保留 ${Number(expireDays) === 0 ? '永久' : expireDays + ' 天'}`;
  const sheetBusy = busy === 'rules' || busy === 'filters';

  return (
    <div className="tab-pane" data-pane="watch" ref={paneRef}>
      <div className="pane-scroll">
        {prefsError ? (
          <div className="hint pane-msg lg" role="alert">
            {prefsError}，规则和过滤暂时不能编辑
            <button type="button" className="btn btn-ghost btn-sm ml-3" onClick={() => loadPrefs()}>重试</button>
          </div>
        ) : null}
        <Section secKey="watch-rules" title="关注 / 屏蔽规则" open
          sub={rules.length ? `${rules.length} 条` : '未配置'}>
          <div className="sl-toolbar">
            <button className="btn btn-ghost btn-sm" id="addWatchRuleBtn" type="button"
              disabled={busy === 'rules' || rules.length >= 30 || !!prefsError} onClick={() => openRule(null, true)}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-plus" /></svg>
              添加规则
            </button>
            <button className="btn btn-ghost btn-sm" id="applyWatchBtn" type="button"
              disabled={busy === 'apply' || !rules.length || !!prefsError}
              title="按当前规则重新判定全部已有文章" onClick={onApply}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-refresh" /></svg>
              {busy === 'apply' ? '回溯中…' : '应用到已有文章'}
            </button>
            <span className="sl-toolbar-note">只对之后新抓取的文章生效</span>
          </div>

          {rules.length ? (
            <div className="sl-list">{rules.map(renderRuleRow)}</div>
          ) : prefsError ? (
            <div className="sl-empty">规则读取失败，点上方「重试」后再编辑</div>
          ) : (
            <div className="sl-empty">还没有规则。点「添加规则」新建一条，比如把标题含「OpenAI」的文章加入关注。</div>
          )}

          <small className="form-tip">
            每行一个关键词，标题、摘要或正文中出现即命中（不区分大小写）。同一篇文章同时命中关注和屏蔽规则时，以「屏蔽」为准。
            点行可编辑；行上的开关即改即存，误操作可在提示条里撤销。
          </small>
          <Result id="watchResult" result={result} />
        </Section>

        <Section secKey="watch-notify" title="通知与保留" sub={notifySub}>
          <div className="form-row">
            <label htmlFor="watchWebhook">Webhook 通知地址（可选）</label>
            <input id="watchWebhook" type="url" placeholder="https://…" spellCheck="false" autoComplete="off"
              value={webhook}
              onChange={(ev) => setWebhook(ev.target.value)}
              onBlur={commitWebhook}
              onKeyDown={blurOnEnter} />
            <small className="form-tip">
              新抓取的文章命中关注规则时，向该地址 POST 一条 JSON；同一轮多条合并成一条。留空则不推送。改完自动保存。
            </small>
          </div>

          <div className="form-row form-row-inline">
            <label htmlFor="watchExpireDays">关注保留天数</label>
            <input id="watchExpireDays" type="number" inputMode="numeric" min="0" max="3650" step="1"
              style={{ width: '6.5em', flex: '0 0 auto' }}
              value={expireDays}
              onChange={(ev) => setExpireDays(ev.target.value)}
              onBlur={commitExpire}
              onKeyDown={blurOnEnter} />
            <span className="muted">天后自动取消关注（0 表示永久保留，默认 90 天）</span>
            <small className="form-tip">
              只取消「关注」标记，文章仍留在原频道，已读 / 收藏状态不变；屏蔽不受影响。改完自动保存。
            </small>
          </div>
        </Section>

        <Section secKey="watch-filters" title="入库前过滤" open
          sub={!loaded ? '读取中…' : (filters.length ? `${filters.length} 条` : '未配置')}>
          <div className="sl-toolbar">
            <button className="btn btn-ghost btn-sm" id="addFilterBtn" type="button"
              disabled={busy === 'filters' || filters.length >= 50 || !!prefsError} onClick={() => openFilter(null, true)}>
              <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-plus" /></svg>
              添加过滤规则
            </button>
            <span className="sl-toolbar-note">写入数据库之前过滤</span>
          </div>

          {!loaded ? <div className="sl-empty">正在读取规则…</div>
            : prefsError ? <div className="sl-empty">规则读取失败，点上方「重试」后再编辑</div>
              : !filters.length ? <div className="sl-empty">还没有规则。点「添加过滤规则」试试，比如丢弃标题含「广告」的文章。</div>
              : <div className="sl-list">{filters.map(renderFilterRow)}</div>}

          <small className="form-tip">
            只影响之后新抓的文章，已入库的历史文章不动。<br />
            <b>丢弃</b>：命中即不入库；<b>只收</b>：只保留命中的文章（白名单）。两者同时存在时，先丢弃、再只收。<br />
            关键词不区分大小写；范围「全部」= 标题 + 摘要 + 正文；非法正则在保存时会被忽略。
          </small>
        </Section>
      </div>

      {sheet && sheet.type === 'rule' ? (
        <RuleSheet key={'rule-' + sheet.value.id} rule={sheet.value} isNew={sheet.isNew} busy={sheetBusy}
          feeds={feedsList} groupOrder={groupOrder}
          onClose={() => setSheet(null)} onSave={saveRuleDraft} onDelete={deleteRule} />
      ) : null}
      {sheet && sheet.type === 'filter' ? (
        <FilterSheet key={'filter-' + sheet.value.id} filter={sheet.value} isNew={sheet.isNew} busy={sheetBusy}
          feeds={feedsList} groupOrder={groupOrder}
          onClose={() => setSheet(null)} onSave={saveFilterDraft} onDelete={deleteFilter} />
      ) : null}
    </div>
  );
}
