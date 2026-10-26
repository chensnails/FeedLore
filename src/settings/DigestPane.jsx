/* 设置弹层「日报」面板：日报的账号级全部配置。
 *
 * 从 v1.4.0 起，日报不再有站点级/管理员那一层：调度时间、采集范围、条数上限、
 * 风格要求都存在这个账号自己的 users.prefs.digest 里（服务端 lib/prefs.js sanitizeDigest 清洗）。
 * 「使用日报」这一项例外，它在 prefs.layout.digestEnabled —— 因为首屏注入要读它来决定
 * 顶栏要不要画日报入口，放进 digest 组就得为一次首屏渲染多等一个请求。
 *
 * 保存走一次 POST /api/prefs（digest 整组 + 风格在同一条），开关单独走 core.setDigestEnabled
 * 让顶栏立刻收到 shell tick；服务端会保留 lastAuto（调度器独占字段），这里不用回传。 */

import { core } from '@core';
import React, { useEffect, useState } from 'react';

const S = () => core;

// 与服务端 lib/prefs.js 的 DIGEST_PROMPT_MAX 同值：前端只是提前把字数摆出来，
// 真正的截断在服务端（这里写小了也不会坏，只是提示不够准）
const PROMPT_MAX = 2000;

const EMPTY = {
  auto: false, time: '08:00', mode: 'enabled', feeds: [],
  maxPerFeed: '20', maxTotal: '150', keepDays: '30', style: '',
};

export function DigestPane() {
  const [enabled, setEnabled] = useState(true);
  const [form, setForm] = useState(EMPTY);
  // saved：服务端当前值（字符串化后比较，用来判断「有没有没保存的改动」）
  const [saved, setSaved] = useState(JSON.stringify(EMPTY));
  const [feedsList, setFeedsList] = useState([]);
  const [result, setResult] = useState(null);   // { ok, msg } | null
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const res = await S().apiFetch('/api/prefs');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const d = data.digest || {};
      const next = {
        auto: d.auto === true,
        time: typeof d.time === 'string' ? d.time : '08:00',
        mode: ['enabled', 'all', 'custom'].indexOf(d.mode) >= 0 ? d.mode : 'enabled',
        feeds: Array.isArray(d.feeds) ? d.feeds.map(Number) : [],
        maxPerFeed: String(d.maxPerFeed == null ? 20 : d.maxPerFeed),
        maxTotal: String(d.maxTotal == null ? 150 : d.maxTotal),
        keepDays: String(d.keepDays == null ? 30 : d.keepDays),
        style: typeof d.style === 'string' ? d.style : '',
      };
      setForm(next);
      setSaved(JSON.stringify(next));
      setEnabled((data.layout && data.layout.digestEnabled) !== false);
    } catch (err) {
      setResult({ ok: false, msg: '读取日报设置失败：' + String((err && err.message) || err) });
    }
    // 频道清单只有「自定义范围」用得到，按需再拉，避免每次开面板都多一个请求
    try {
      const data = await S().loadFeeds();
      setFeedsList((data && data.feeds) || []);
    } catch (_) { /* 列表拿不到时自定义区显示占位文案 */ }
  }

  const setField = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }));

  const onToggle = (ev) => {
    const on = ev.target.checked;
    setEnabled(on);
    // 关掉时如果正停在日报页，桥里会把人带回文章页（入口没了页面还杵着最怪）
    S().setDigestEnabled(on);
    S().toast(on ? '已开启日报，顶栏恢复入口' : '已关闭日报，顶栏不再显示入口');
  };

  const onToggleFeed = (fid, on) => {
    setForm((f) => {
      const set = new Set(f.feeds);
      if (on) set.add(fid); else set.delete(fid);
      return Object.assign({}, f, { feeds: [...set] });
    });
  };

  const onSave = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await S().apiFetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          digest: {
            auto: form.auto,
            time: form.time || '08:00',
            mode: form.mode,
            feeds: form.mode === 'custom' ? form.feeds : [],
            maxPerFeed: form.maxPerFeed,
            maxTotal: form.maxTotal,
            keepDays: form.keepDays,
            style: form.style.trim(),
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setResult({ ok: false, msg: data.error || '保存失败' }); return; }
      // 用服务端回包重建表单：脏值被 clamp 后界面要显示的是真正落库的值
      const d = (data.digest) || {};
      const next = {
        auto: d.auto === true,
        time: d.time || '08:00',
        mode: ['enabled', 'all', 'custom'].indexOf(d.mode) >= 0 ? d.mode : 'enabled',
        feeds: Array.isArray(d.feeds) ? d.feeds.map(Number) : [],
        maxPerFeed: String(d.maxPerFeed),
        maxTotal: String(d.maxTotal),
        keepDays: String(d.keepDays),
        style: typeof d.style === 'string' ? d.style : '',
      };
      setForm(next);
      setSaved(JSON.stringify(next));
      setResult({ ok: true, msg: '日报设置已保存，下次生成生效' });
      S().toast('日报设置已保存');
    } catch (err) {
      setResult({ ok: false, msg: '保存失败：' + String((err && err.message) || err) });
    } finally {
      setBusy(false);
    }
  };

  // 「恢复默认」是清掉自定义风格这一项（其余参数各有内置默认，交给服务端夹回）
  const onResetStyle = () => {
    if (!form.style && !JSON.parse(saved).style) { setResult({ ok: true, msg: '本来就没写自定义风格' }); return; }
    setForm((f) => Object.assign({}, f, { style: '' }));
  };

  const dirty = JSON.stringify(form) !== saved;
  const hintScope = form.mode === 'all' ? '全部频道'
    : form.mode === 'custom' ? `自定义 ${form.feeds.length} 个频道`
      : '仅「采集」开启的频道';

  return (
    <div className="tab-pane" data-pane="digest">
      <div className="form">
        <div className="form-row">
          <label className="form-row-head">
            <span>使用日报</span>
            <span className="switch">
              <input id="digEnable" type="checkbox" checked={enabled} onChange={onToggle} />
              <span className="switch-slider" />
            </span>
          </label>
          <small className="form-tip">
            关掉后顶栏不再有「日报」入口，命令面板里也搜不到；到点的自动生成会跳过你这个账号（不再消耗模型额度）。
            已生成的历史日报不会删，重新开启就能看到。
          </small>
        </div>

        <div className="form-row">
          <label className="form-row-head">
            <span>每天自动生成</span>
            <span className="switch">
              <input id="digAuto" type="checkbox" checked={form.auto}
                onChange={(ev) => setField('auto', ev.target.checked)} />
              <span className="switch-slider" />
            </span>
          </label>
          <small className="form-tip">
            默认关：开一次就每天烧一份模型额度，所以得你主动拨开。
            {form.auto ? `已开启，每天 ${form.time}（北京时间）· ${hintScope}` : '关闭时随时可在「日报」页手动生成'}
          </small>
        </div>

        <div className="form-row" hidden={!form.auto}>
          <label htmlFor="digTime">生成时间（北京时间）</label>
          <input id="digTime" type="time" value={form.time}
            onChange={(ev) => setField('time', ev.target.value)} />
          <small className="form-tip">服务进程得在那个点活着才会跑；错过一次不补，第二天照常</small>
        </div>

        <div className="form-row" hidden={!form.auto}>
          <label htmlFor="digMode">摘要范围</label>
          <select id="digMode" className="select" value={form.mode}
            onChange={(ev) => setField('mode', ev.target.value)}>
            <option value="enabled">仅「采集」开启的频道</option>
            <option value="all">全部频道</option>
            <option value="custom">自定义频道</option>
          </select>
          <small className="form-tip">「采集」开关在「设置 → 数据源」页，按频道单独控制</small>
        </div>

        {form.auto && form.mode === 'custom' && (
          <div className="form-row form-row-block">
            <label>纳入日报的频道</label>
            <div className="feed-pick">
              {feedsList.length ? feedsList.map((f) => {
                const fid = Number(f.id);
                const checked = form.feeds.includes(fid);
                return (
                  <label key={f.id} className={'feed-pick-row' + (checked ? ' on' : '')}>
                    <input type="checkbox" checked={checked}
                      onChange={(ev) => onToggleFeed(fid, ev.target.checked)} />
                    <span className="feed-pick-name">{f.customTitle || f.title || f.url}</span>
                    {!f.enabled ? <span className="feed-pick-off">采集关闭</span> : null}
                  </label>
                );
              }) : <div className="feed-pick-empty">加载频道列表中…</div>}
            </div>
            <small className="form-tip">一个都没勾时，日报会提示「没有可展示的条目」</small>
          </div>
        )}

        <div className="form-grid form-grid-2">
          <div className="form-row">
            <label htmlFor="digMaxPerFeed">每频道条数上限</label>
            <input id="digMaxPerFeed" type="number" min="1" max="100" value={form.maxPerFeed}
              onChange={(ev) => setField('maxPerFeed', ev.target.value)} />
          </div>
          <div className="form-row">
            <label htmlFor="digMaxTotal">总条数上限</label>
            <input id="digMaxTotal" type="number" min="10" max="500" value={form.maxTotal}
              onChange={(ev) => setField('maxTotal', ev.target.value)} />
          </div>
          <div className="form-row">
            <label htmlFor="digKeepDays">摘要保留天数</label>
            <input id="digKeepDays" type="number" min="1" max="365" value={form.keepDays}
              onChange={(ev) => setField('keepDays', ev.target.value)} />
            <small className="form-tip">超期的日报由生成时顺带清理，只影响你自己的历史</small>
          </div>
        </div>

        <div className="form-row">
          <label htmlFor="digPrompt">风格要求（可选）</label>
          <textarea
            id="digPrompt"
            rows={6}
            spellCheck="false"
            maxLength={PROMPT_MAX}
            placeholder={'例：侧重新版影视和音乐，技术教程只挑对我有用的；语气随意些，别用「赋能」「抓手」这类词；概览压到两句话。'}
            value={form.style}
            onChange={(ev) => setField('style', ev.target.value)}
          />
          <small className="form-tip">
            {form.style.length} / {PROMPT_MAX} 字 · 这段会作为「额外要求」附在日报提示词后面，
            只影响选材、语气和篇幅；简报的 JSON 结构、点评长度上限等由系统固定，写了也不会打乱生成
          </small>
        </div>

        {result && (
          <div className={'test-result show ' + (result.ok ? 'ok' : 'err')} id="digResult" role="status">
            {result.msg}
          </div>
        )}
      </div>
      <div className="pane-foot">
        <span className="hint">这些设置只对你的账号生效；模型地址与 Key 在「设置 → 模型」里单独配</span>
        <div className="pane-foot-btns">
          <button className="btn btn-ghost" id="digResetBtn" type="button"
            disabled={busy || !form.style} onClick={onResetStyle}>清空风格</button>
          <button className="btn btn-primary" id="digSaveBtn" type="button"
            disabled={busy || !dirty} onClick={onSave}>
            {busy ? '保存中…' : '保存日报设置'}
          </button>
        </div>
      </div>
    </div>
  );
}
