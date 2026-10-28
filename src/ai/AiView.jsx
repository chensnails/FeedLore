/* AI 视图（v1.7.0 起 React 化，原 index.html 的 #aiView 内联 DOM + app.js 的日报/日报设置逻辑迁移至此，P3a）。
 *
 * 迁移说明（对照旧实现）：
 * - 视图容器仍是 index.html 的 `<div class="wrap" id="aiView">`（switchView 负责显隐），
 *   内容整体由本组件渲染到其内的 `#aiRoot` 挂载点；顶栏 #viewNav / #stat 不属本视图，仍在旧代码。
 * - 只有一页：日报。「日报设置」在 v1.4.0 里整块搬进了「设置 → 日报」（改按账号配置后
 *   它就不再是管理员的站点设置，留在 AI 页会变成两个入口）；
 *   二级导航只剩「日报」一项，因此一并删掉——一条只有一个按钮的导航不传达任何信息。
 * - 日报展示由 innerHTML 字符串拼接改为 JSX；条目复制按钮 / 图片兜底改由 React 处理。
 * - 类名 / ID / data 属性与旧 DOM 一致，样式零改动。
 */

import { core } from '@core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { OverflowMenu } from '../ui/OverflowMenu.jsx';
import { useTopbarHeight } from '../shell/useTopbarHeight.js';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

const Icon = ({ n }) => (
  <svg className="ico" aria-hidden="true" focusable="false"><use href={'#i-' + n} /></svg>
);

function shanghaiToday() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** 复制链接：统一为图标按钮（i-link → 复制成功后 i-check） */
function CopyLink({ url }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const ok = await S().copyText(url);
    if (!ok) { S().toast('复制失败，请手动选择链接', false); return; }
    setCopied(true);
    S().toast('已复制：' + (S().linkLabel ? S().linkLabel(url) : url));
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button type="button" className={'icon-btn' + (copied ? ' ok' : '')} title="复制链接" onClick={onCopy}>
      <Icon n={copied ? 'check' : 'link'} />
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
          {e.link ? <a className="icon-btn" title="打开" href={e.link} target="_blank" rel="noopener noreferrer"><Icon n="external" /></a> : null}
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
          <svg className="ico dg-pin" aria-hidden="true" focusable="false"><use href="#i-pin" /></svg>
          <span>
            {d.overview || '（无概览）'}
            {d.fallback ? <span className="dg-tag-fallback">规则摘要</span> : null}
          </span>
        </div>
        <div className="dg-meta">
          <span><b>生成时间</b> {gen}</span>
          <span><b>模型</b> {d.model || '—'}</span>
          <span><b>采集</b> {(d.stats && d.stats.collected) || 0} 条 → 精选 {(d.stats && d.stats.kept) || 0} 条</span>
          <span><b>覆盖频道</b> {(d.stats && d.stats.feeds) || 0} 个</span>
          {d.usedMapReduce ? <span><b>模式</b> 分批汇总</span> : null}
        </div>
        {d.error ? (
          <div className="dg-meta is-plain">
            <span className="dg-warn">模型调用失败，已降级为规则摘要：{d.error}</span>
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
  const [active, setActive] = useState(() => !!(s && s.state && s.state.tab === 'ai'));
  // 合并后第一行（标题 + ⋮）即吸顶条，由其写入 --topbar-h
  const headRef = useRef(null);

  // 日报
  const [dates, setDates] = useState([]);
  const [selected, setSelected] = useState(shanghaiToday);
  const [view, setView] = useState({ kind: 'loading' });
  const [generating, setGenerating] = useState(false);
  const [feedsInfo, setFeedsInfo] = useState({ total: 0, enabled: 0 });
  // 摘要范围读本账号的 prefs.digest（v1.4.0 起不再有站点级那一份）
  const [scope, setScope] = useState({ mode: 'enabled', feeds: [] });

  // 视图激活感知（React 常驻挂载，只在切到 AI 页时拉数据）
  useEffect(() => {
    const onView = (ev) => setActive(ev.detail === 'ai');
    window.addEventListener('__viewChanged', onView);
    return () => window.removeEventListener('__viewChanged', onView);
  }, []);

  // 合并头部：本视图第一行即吸顶条，实测高度写入 --topbar-h（隐藏视图测得 0 高不写，避免覆盖）
  useTopbarHeight(headRef);

  useEffect(() => {
    if (active) loadDigest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const today = shanghaiToday();
  const dateOptions = useMemo(() => {
    const list = dates.slice();
    if (!list.includes(today)) list.unshift(today);
    return list;
  }, [dates, today]);

  const mode = scope.mode || 'enabled';
  const scopeLabel = mode === 'all' ? '全部频道'
    : mode === 'custom' ? `自定义的 ${scope.feeds.length} 个频道`
      : '「采集」开启的频道';
  const subtitle = `把${scopeLabel}过去 24 小时的新条目整理成一份中文简报`
    + ` · 共 ${feedsInfo.total} 个频道，采集开启 ${feedsInfo.enabled} 个`;

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
    // 摘要范围：本账号自己的日报配置
    try {
      const d = (await (await s.apiFetch('/api/prefs')).json()).digest || {};
      setScope({
        mode: ['all', 'enabled', 'custom'].indexOf(d.mode) >= 0 ? d.mode : 'enabled',
        feeds: Array.isArray(d.feeds) ? d.feeds.map(Number) : [],
      });
    } catch (_) { /* 拿不到就按默认范围显示 */ }
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

  let body = null;
  if (view.kind === 'loading') {
    body = <div className="dg-loading"><div className="dg-spinner" />读取中…</div>;
  } else if (view.kind === 'genLoading') {
    body = (
      <div className="dg-loading">
        <div className="dg-spinner" />
        正在采集过去 24 小时的新条目并生成摘要…
        <div className="hint mt-2">首次生成约需 30~60 秒，请勿关闭页面</div>
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
      {/* 二级导航随「日报设置」一起撤了：只剩一项的导航不传达信息。
          合并头部：标题 + 右侧 ⋮（视图切换 / 刷新 / 主题 / 设置）。AI 页无频道抽屉与搜索。 */}
      <div className="ai-head page-head view-toolbar" ref={headRef}>
        <div className="ai-head-text"><h2 className="page-title vt-title">AI</h2></div>
        <div className="head-right vt-tools">
          <OverflowMenu view="ai" />
        </div>
      </div>
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
    </>
  );
}
