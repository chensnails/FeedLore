/* AI 视图（v1.7.0 起 React 化，原 index.html 的 #aiView 内联 DOM + app.js 的日报/日报设置逻辑迁移至此，P3a）。
 *
 * 迁移说明（对照旧实现）：
 * - 视图容器仍是 index.html 的 `<div class="wrap" id="aiView">`（switchView 负责显隐），
 *   内容整体由本组件渲染到其内的 `#aiRoot` 挂载点；顶栏 #viewNav / #stat 不属本视图，仍在旧代码。
 * - 子页：日报（展示 / 生成 / 日期选择）、日报设置（仅管理员，/api/config 的 digest 段）。
 * - 子页光标按账号持久化（users.prefs.layout.aiPage），经桥 getAiPage/setAiPage 读写；
 *   进入视图时经 `__viewChanged` 事件感知（React 常驻挂载，但只在切到 AI 页时拉数据）。
 * - 日报展示由 innerHTML 字符串拼接改为 JSX；条目复制按钮 / 图片兜底改由 React 处理。
 * - 类名 / ID / data 属性与旧 DOM 一致，样式零改动；设置页可折叠分组复用桥 bindSections。
 */

import { core } from '@core';
import React, { useEffect, useMemo, useRef, useState } from 'react';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）
const AI_PAGES = ['digest', 'settings'];

const Icon = ({ n }) => (
  <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + n} /></svg>
);

function shanghaiToday() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* 降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}

/** 复制链接按钮（替代旧 bindCardActions 的 [data-copy] 分支） */
function CopyLink({ url }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const ok = await copyToClipboard(url);
    if (!ok) { S().toast('复制失败，请手动选择链接', false); return; }
    setCopied(true);
    S().toast('已复制：' + (S().linkLabel ? S().linkLabel(url) : url));
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button type="button" className={'btn-copy' + (copied ? ' copied' : '')} onClick={onCopy}>
      {copied ? <><Icon n="check" /> 已复制</> : <><Icon n="link" /> 复制链接</>}
    </button>
  );
}

/** 日报里的一条条目 */
function DgItem({ it }) {
  const e = it.item || {};
  const [imgFailed, setImgFailed] = useState(false);
  const thumb = (e.image && !imgFailed)
    ? <img className="dg-item-thumb" loading="lazy" src={e.image} alt=""
      onLoad={(ev) => ev.currentTarget.classList.add('img-ready')}
      onError={() => setImgFailed(true)} />
    : <div className="dg-item-thumb-fb"><Icon n="file" /></div>;
  return (
    <div className="dg-item">
      {thumb}
      <div className="dg-item-main">
        <div className="dg-item-top">
          {it.comment ? <span className="dg-comment">{it.comment}</span> : null}
          {e.feedName ? <span className="src-pill">{e.feedName}</span> : null}
        </div>
        <div className="dg-item-name">{e.name || '(无标题)'}</div>
        <div className="dg-item-foot">
          {e.link ? <CopyLink url={e.link} /> : null}
          {e.link ? <a className="btn-open" href={e.link} target="_blank" rel="noopener noreferrer">打开</a> : null}
          {e.size ? <span className="dg-item-size">{e.size}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** 日报正文（有数据时） */
function DigestView({ digest }) {
  const d = digest;
  const gen = d.generatedAt
    ? new Date(d.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '—';
  const highlights = d.highlights || [];
  const sections = d.sections || [];
  return (
    <>
      <div className="dg-card">
        <div className="dg-overview">
          {d.overview || '（无概览）'}
          {d.fallback ? <span className="dg-tag-fallback">规则摘要</span> : null}
        </div>
        <div className="dg-meta">
          <span><b>生成时间</b> {gen}</span>
          <span><b>模型</b> {d.model || '—'}</span>
          <span><b>采集</b> {(d.stats && d.stats.collected) || 0} 条 → 精选 {(d.stats && d.stats.kept) || 0} 条</span>
          <span><b>覆盖频道</b> {(d.stats && d.stats.feeds) || 0} 个</span>
          {d.usedMapReduce ? <span><b>模式</b> 分批汇总</span> : null}
        </div>
        {d.error ? (
          <div className="dg-meta" style={{ borderTop: 'none', paddingTop: 0 }}>
            <span style={{ color: '#b7791f' }}>模型调用失败，已降级为规则摘要：{d.error}</span>
          </div>
        ) : null}
      </div>

      {highlights.length ? (
        <div className="dg-card">
          <h3 className="dg-section-title">今日亮点<span className="cnt">{highlights.length} 条</span></h3>
          <div className="dg-hl-list">
            {highlights.map((h, i) => (
              <div className="dg-hl" key={i}>
                <div className="dg-hl-idx">{i + 1}</div>
                <div className="dg-hl-body">
                  <div className="dg-hl-text">{h.text || ''}</div>
                  {h.item && h.item.name ? <div className="dg-hl-name">{h.item.name}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {sections.length ? sections.map((s, i) => (
        <div className="dg-card" key={i}>
          <h3 className="dg-section-title">{s.title || '未分类'}<span className="cnt">{s.items.length} 条</span></h3>
          <div className="dg-items">{s.items.map((it, j) => <DgItem it={it} key={j} />)}</div>
        </div>
      )) : (
        <div className="dg-empty">
          <div className="dg-empty-ico"><Icon n="inbox" /></div>
          <p>没有可展示的条目</p>
        </div>
      )}
    </>
  );
}

export function AiView() {
  const s = S();
  const [admin] = useState(() => !!(s && s.isAdmin && s.isAdmin()));
  const [active, setActive] = useState(() => !!(s && s.state && s.state.tab === 'ai'));
  const [page, setPage] = useState(() => {
    const p = s && s.getAiPage ? s.getAiPage() : 'digest';
    return AI_PAGES.indexOf(p) >= 0 ? p : 'digest';
  });

  // 日报
  const [dates, setDates] = useState([]);
  const [selected, setSelected] = useState(shanghaiToday);
  const [view, setView] = useState({ kind: 'loading' });
  const [generating, setGenerating] = useState(false);
  const [feedsInfo, setFeedsInfo] = useState({ total: 0, enabled: 0 });
  const [cfgDigest, setCfgDigest] = useState(null);   // 管理员才有（/api/config 的 digest 段）

  // 日报设置
  const [form, setForm] = useState(null);
  const [settingsResult, setSettingsResult] = useState(null);
  const [savingDg, setSavingDg] = useState(false);
  const settingsRef = useRef(null);

  // 视图激活感知（React 常驻挂载，只在切到 AI 页时拉数据）
  useEffect(() => {
    const onView = (ev) => setActive(ev.detail === 'ai');
    window.addEventListener('__viewChanged', onView);
    return () => window.removeEventListener('__viewChanged', onView);
  }, []);

  // 激活或切换子页时加载对应数据（切到设置但非管理员则回落日报）
  useEffect(() => {
    if (!active) return;
    if (page === 'settings' && !admin) { setPage('digest'); return; }
    if (page === 'digest') loadDigest();
    else loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, page]);

  // 设置页可折叠分组：套上按账号记住的开合状态（复用桥 bindSections）
  useEffect(() => {
    if (page === 'settings' && admin && s && s.bindSections && settingsRef.current) {
      s.bindSections(settingsRef.current);
    }
  });

  const today = shanghaiToday();
  const dateOptions = useMemo(() => {
    const list = dates.slice();
    if (!list.includes(today)) list.unshift(today);
    return list;
  }, [dates, today]);

  const scope = (cfgDigest && cfgDigest.scope) || 'selected';
  const scopeLabel = scope === 'all' ? '全部频道' : '「采集」开启的频道';
  const subtitle = `把${scopeLabel}过去 24 小时的新条目整理成一份中文简报`
    + ` · 共 ${feedsInfo.total} 个频道，采集开启 ${feedsInfo.enabled} 个`;

  function goPage(name) {
    if (AI_PAGES.indexOf(name) < 0) name = 'digest';
    if (name === 'settings' && !admin) name = 'digest';
    setPage(name);
    if (s.setAiPage) s.setAiPage(name);
  }

  const applyCfg = (cfg) => {
    const dg = (cfg && cfg.digest) || {};
    setCfgDigest({
      enabled: !!dg.enabled, time: dg.time || '08:00', scope: dg.scope || 'selected',
      maxPerFeed: dg.maxPerFeed, maxTotal: dg.maxTotal, keepDays: dg.keepDays,
    });
    setForm({
      enabled: !!dg.enabled,
      time: dg.time || '08:00',
      scope: dg.scope || 'selected',
      maxPerFeed: String(dg.maxPerFeed == null ? 20 : dg.maxPerFeed),
      maxTotal: String(dg.maxTotal == null ? 150 : dg.maxTotal),
      keepDays: String(dg.keepDays == null ? 30 : dg.keepDays),
    });
  };

  async function loadDigest() {
    // 日期列表
    let ds = [];
    try { const r = await s.apiFetch('/api/digests'); const d = await r.json(); ds = d.dates || []; } catch (_) { ds = []; }
    setDates(ds);
    // 频道计数（副标题用）
    try {
      const data = await s.loadFeeds();
      const list = (data && data.feeds) || [];
      setFeedsInfo({ total: list.length, enabled: list.filter((f) => f.enabled).length });
    } catch (_) { /* 用已有缓存 */ }
    // 摘要范围（管理员才有权限读）
    if (admin) { try { applyCfg(await (await s.apiFetch('/api/config')).json()); } catch (_) { /* 忽略 */ } }
    const opts = ds.includes(today) ? ds : [today, ...ds];
    const cur = opts.includes(selected) ? selected : opts[0];
    await showDigest(cur);
  }

  async function showDigest(date) {
    setSelected(date);
    setView({ kind: 'loading' });
    try {
      const res = await s.apiFetch('/api/digest?date=' + encodeURIComponent(date));
      const data = await res.json();
      if (data && data.digest) setView({ kind: 'ready', digest: data.digest });
      else setView({ kind: 'empty', date });
    } catch (err) {
      setView({ kind: 'error', msg: String((err && err.message) || err) });
    }
  }

  async function generate(force) {
    setGenerating(true);
    setView({ kind: 'genLoading' });
    try {
      const res = await s.apiFetch('/api/digest/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: !!force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '生成失败');
      const d = data.digest;
      setDates((prev) => (prev.includes(d.date) ? prev : [d.date, ...prev]));
      setSelected(d.date);
      setView({ kind: 'ready', digest: d });
      s.toast(data.cached ? '已读取当日缓存摘要' : `摘要生成完成（${d.stats.kept} 条 / ${d.stats.feeds} 频道）`);
    } catch (err) {
      setView({ kind: 'genError', msg: String((err && err.message) || err) });
    } finally {
      setGenerating(false);
    }
  }

  async function loadSettings() {
    setSettingsResult(null);
    try {
      const res = await s.apiFetch('/api/config');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      applyCfg(await res.json());
    } catch (err) {
      setSettingsResult({ ok: false, msg: '读取配置失败：' + String((err && err.message) || err) });
    }
  }

  async function saveSettings() {
    if (!form) return;
    setSavingDg(true);
    setSettingsResult(null);
    try {
      const res = await s.apiFetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          digest: {
            enabled: form.enabled,
            time: form.time || '08:00',
            scope: form.scope,
            maxPerFeed: form.maxPerFeed,
            maxTotal: form.maxTotal,
            keepDays: form.keepDays,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) { setSettingsResult({ ok: false, msg: data.error || '保存失败' }); return; }
      setSettingsResult({ ok: true, msg: '日报设置已保存' });
      s.toast('日报设置已保存');
      setCfgDigest((prev) => ({ ...(prev || {}), ...form }));
    } catch (err) {
      setSettingsResult({ ok: false, msg: '保存失败：' + String((err && err.message) || err) });
    } finally {
      setSavingDg(false);
    }
  }

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const hintOn = form ? form.enabled : false;
  const hintTime = (form && form.time) || '08:00';
  const hintScope = form && form.scope === 'all' ? '全部频道' : '仅「采集」开启的频道';
  const autoSub = form ? (hintOn ? `每天 ${hintTime} · ${hintScope}` : '已关闭') : '';
  const limitsSub = form ? `每频道 ${form.maxPerFeed} 条 · 总计 ${form.maxTotal} 条 · 保留 ${form.keepDays} 天` : '';

  const pages = admin ? [['digest', '日报'], ['settings', '日报设置']] : [['digest', '日报']];

  let body = null;
  if (view.kind === 'loading') {
    body = <div className="dg-loading"><div className="dg-spinner" />读取中…</div>;
  } else if (view.kind === 'genLoading') {
    body = (
      <div className="dg-loading">
        <div className="dg-spinner" />
        正在采集过去 24 小时的新条目并生成摘要…
        <div className="hint" style={{ marginTop: 8 }}>首次生成约需 30~60 秒，请勿关闭页面</div>
      </div>
    );
  } else if (view.kind === 'error') {
    body = <div className="dg-error">读取失败：{view.msg}</div>;
  } else if (view.kind === 'genError') {
    body = (
      <div className="dg-error">
        <div className="dg-empty-ico"><Icon n="alert" /></div>
        <p>生成失败：{view.msg}</p>
        <p className="hint">请在「设置 → 模型」检查模型地址与 Key 是否正确</p>
      </div>
    );
  } else if (view.kind === 'empty') {
    body = (
      <div className="dg-empty">
        <div className="dg-empty-ico"><Icon n="calendar" /></div>
        <p><strong>{view.date}</strong> 还没有摘要</p>
        <p className="hint">点击右上角「生成摘要」，把所选频道过去 24 小时的新内容整理成简报</p>
      </div>
    );
  } else if (view.kind === 'ready') {
    body = <DigestView digest={view.digest} />;
  }

  return (
    <>
      <div className="ai-head">
        <h2>AI</h2>
        <nav className="ainav" id="aiNav" aria-label="AI 功能">
          {pages.map(([name, label]) => (
            <button
              key={name}
              type="button"
              className={'ainav-btn' + (page === name ? ' active' : '')}
              data-ai={name}
              aria-pressed={page === name ? 'true' : 'false'}
              onClick={() => goPage(name)}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      {page === 'digest' && (
        <section className="ai-pane" data-ai-pane="digest">
          <div className="digest-head">
            <p className="ai-sub" id="digestSub">{subtitle}</p>
            <div className="digest-actions">
              <select id="digestDate" className="select" title="选择日期" value={selected}
                onChange={(e) => showDigest(e.target.value)}>
                {dateOptions.map((d) => <option key={d} value={d}>{d === today ? '今天 · ' : ''}{d}</option>)}
              </select>
              <button className="btn btn-ghost" id="regenDigestBtn" type="button" title="忽略缓存，重新生成"
                disabled={generating} onClick={() => generate(true)}>重新生成</button>
              <button className="btn btn-primary" id="genDigestBtn" type="button"
                disabled={generating} onClick={() => generate(false)}>生成摘要</button>
            </div>
          </div>
          <div id="digestBody">{body}</div>
          <footer className="foot">
            摘要由大模型生成，可能存在偏差，请以原始条目为准
          </footer>
        </section>
      )}

      {page === 'settings' && admin && (
        <section className="ai-pane" data-ai-pane="settings" ref={settingsRef}>
          <div className={'test-result' + (settingsResult ? ' show ' + (settingsResult.ok ? 'ok' : 'err') : '')}>
            {settingsResult ? settingsResult.msg : ''}
          </div>

          {form && (
            <>
              <details className="sec" data-sec="dg-auto" open>
                <summary className="sec-head">
                  <svg className="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
                  <span className="sec-title">自动生成</span>
                  <span className="sec-sub">{autoSub}</span>
                </summary>
                <div className="sec-body">
                  <div className="form-row form-row-inline">
                    <label htmlFor="dgEnabled">每日自动生成</label>
                    <label className="switch">
                      <input id="dgEnabled" type="checkbox" checked={form.enabled}
                        onChange={(e) => setField('enabled', e.target.checked)} />
                      <span className="switch-slider" />
                    </label>
                    <small className="form-tip">开启后按下方时间自动生成，需保持服务运行</small>
                  </div>
                  <div className="form-row">
                    <label htmlFor="dgTime">生成时间（北京时间）</label>
                    <input id="dgTime" type="time" value={form.time}
                      onChange={(e) => setField('time', e.target.value)} />
                  </div>
                  <div className="form-row">
                    <label htmlFor="dgScope">摘要范围</label>
                    <select id="dgScope" className="select" value={form.scope}
                      onChange={(e) => setField('scope', e.target.value)}>
                      <option value="selected">仅「采集」开启的频道</option>
                      <option value="all">全部频道</option>
                    </select>
                    <small className="form-tip">「采集」开关在「设置 → 数据源」页，按频道单独控制</small>
                  </div>
                </div>
              </details>

              <details className="sec" data-sec="dg-limits" open>
                <summary className="sec-head">
                  <svg className="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
                  <span className="sec-title">条数与保留</span>
                  <span className="sec-sub">{limitsSub}</span>
                </summary>
                <div className="sec-body">
                  <div className="form-grid">
                    <div className="form-row">
                      <label htmlFor="dgMaxPerFeed">每频道条数上限</label>
                      <input id="dgMaxPerFeed" type="number" min="1" max="100" value={form.maxPerFeed}
                        onChange={(e) => setField('maxPerFeed', e.target.value)} />
                    </div>
                    <div className="form-row">
                      <label htmlFor="dgMaxTotal">总条数上限</label>
                      <input id="dgMaxTotal" type="number" min="10" max="500" value={form.maxTotal}
                        onChange={(e) => setField('maxTotal', e.target.value)} />
                    </div>
                    <div className="form-row">
                      <label htmlFor="dgKeepDays">摘要保留天数</label>
                      <input id="dgKeepDays" type="number" min="1" max="365" value={form.keepDays}
                        onChange={(e) => setField('keepDays', e.target.value)} />
                    </div>
                  </div>
                </div>
              </details>
            </>
          )}

          <div className="ai-foot">
            <span className="hint" id="dgHint">
              {form
                ? (hintOn
                  ? <>每天 <strong>{hintTime}</strong>（北京时间）自动生成 · 范围：{hintScope}</>
                  : '自动生成已关闭，可随时在「日报」页手动生成')
                : ''}
            </span>
            <button className="btn btn-primary" id="saveDgBtn" type="button"
              disabled={savingDg} onClick={saveSettings}>{savingDg ? '保存中…' : '保存日报设置'}</button>
          </div>
        </section>
      )}
    </>
  );
}
