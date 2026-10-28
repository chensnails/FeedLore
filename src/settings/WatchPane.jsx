import { core } from '@core';
import { useState, useEffect } from 'react';

/**
 * 规则面板（v1.6.0-test5）：关注 / 屏蔽规则 + webhook 通知。
 *
 * 规则存 users.prefs.watchRules（整组替换），关键字一行一个、子串匹配不分大小写；
 * 保存只影响「以后新抓的文章」，点「应用到已有文章」才回溯存量条目（/api/watch/apply）。
 * webhook 一条全局地址，每条关注规则单独决定要不要推送（屏蔽规则没有通知的意义）。
 */

const S = () => core;

let uidSeq = 0;
const newId = () => 'w' + Date.now().toString(36) + (++uidSeq).toString(36);
const blankRule = () => ({ id: newId(), name: '', keywords: '', act: 'watch', notify: false, on: true });

/* 服务端数组 → 表单（keywords 摊成多行文本，便于直接编辑） */
function fromServer(list) {
  return (Array.isArray(list) ? list : []).map((r) => ({
    id: r.id,
    name: r.name || '',
    keywords: (r.keywords || []).join('\n'),
    act: r.act === 'block' ? 'block' : 'watch',
    notify: r.notify === true,
    on: r.on !== false,
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
  }));
}

export function WatchPane() {
  const s = S();
  const [rules, setRules] = useState([]);
  const [webhook, setWebhook] = useState('');
  const [savedRules, setSavedRules] = useState('');   // JSON 指纹，用来算「改过没」
  const [savedWebhook, setSavedWebhook] = useState('');
  const [busy, setBusy] = useState('');               // save | apply | webhook | ''
  const [result, setResult] = useState(null);         // { ok, msg } | null

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await s.apiFetch('/api/prefs');
        const d = await res.json();
        if (!alive) return;
        const r = fromServer(d.watchRules);
        const w = typeof d.webhookUrl === 'string' ? d.webhookUrl : '';
        setRules(r);
        setWebhook(w);
        setSavedRules(JSON.stringify(r));
        setSavedWebhook(w);
      } catch (err) {
        if (alive) setResult({ ok: false, msg: '读取失败：' + String((err && err.message) || err) });
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rulesDirty = JSON.stringify(rules) !== savedRules;
  const webhookDirty = webhook !== savedWebhook;

  const patchRule = (id, patch) => {
    setRules((rs) => rs.map((r) => (r.id === id ? Object.assign({}, r, patch) : r)));
  };

  const onSaveRules = async () => {
    setBusy('save');
    try {
      const res = await s.apiFetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watchRules: toServer(rules) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setResult({ ok: false, msg: data.error || '保存失败' }); return; }
      const next = fromServer(data.watchRules);
      setRules(next);
      setSavedRules(JSON.stringify(next));
      // 服务端清洗会丢掉非法规则，数量对不上要如实说
      const dropped = rules.length - next.length;
      setResult({ ok: true, msg: dropped > 0
        ? `已保存 ${next.length} 条规则（${dropped} 条因没有有效关键字被忽略）。只对之后新抓取的文章生效。`
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
      desc: '会按当前规则重新判定全部文章：命中的打上关注 / 屏蔽标记，屏蔽的自动标为已读。',
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

  return (
    <div className="tab-pane" data-pane="watch">
      <div className="form">
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
            <button className="btn btn-ghost btn-sm" type="button" disabled={busy === 'webhook'}
              onClick={onSaveWebhook}>
              {busy === 'webhook' ? '保存中…' : '保存'}
            </button>
          </div>
          <small className="form-tip">
            关注规则命中「新抓取的文章」时向该地址 POST 一条 JSON（同一轮抓取的多条合并成一条消息）；留空 = 不推送。
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
            关键字一行一个，出现在标题、摘要或正文里即命中（不分大小写）；一条文章同时命中关注与屏蔽时按屏蔽处理。
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
              <div className="watch-rule-act" role="radiogroup" aria-label="规则动作">
                <button type="button" className={'watch-act-btn' + (r.act === 'watch' ? ' active' : '')}
                  aria-pressed={r.act === 'watch' ? 'true' : 'false'}
                  title="命中后收进「关注」视图"
                  onClick={() => patchRule(r.id, { act: 'watch' })}>
                  <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-eye" /></svg>关注
                </button>
                <button type="button" className={'watch-act-btn is-block' + (r.act === 'block' ? ' active' : '')}
                  aria-pressed={r.act === 'block' ? 'true' : 'false'}
                  title="命中后收进「屏蔽」视图并自动标为已读"
                  onClick={() => patchRule(r.id, { act: 'block', notify: false })}>
                  <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-block" /></svg>屏蔽
                </button>
              </div>
            </div>
            <textarea
              className="watch-rule-kw" rows="3" spellCheck="false"
              placeholder={'关键字，一行一个，例如：\nOpenAI\nGPT-5'}
              aria-label="关键字（每行一个）"
              value={r.keywords}
              onChange={(ev) => patchRule(r.id, { keywords: ev.target.value })}
            />
            <div className="watch-rule-foot">
              {r.act === 'watch' ? (
                <label className="watch-check">
                  <input type="checkbox" checked={r.notify}
                    onChange={(ev) => patchRule(r.id, { notify: ev.target.checked })} />
                  命中新文章时推送 Webhook
                </label>
              ) : (
                <span className="watch-check muted">屏蔽的文章会自动标为已读</span>
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
          <div className="watch-empty">还没有规则。点上方「添加规则」创建第一条。</div>
        ) : null}

        <div className="watch-actions">
          <button className="btn btn-primary" type="button" disabled={busy === 'save' || !rulesDirty}
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
    </div>
  );
}
