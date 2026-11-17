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
import { on, EVENT } from '../kernel/events.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { OverflowMenu } from '../ui/OverflowMenu.jsx';
import { ViewNav } from '../ui/ViewNav.jsx';
import { useTopbarHeight } from '../shell/useTopbarHeight.js';
import { widthVariant } from '../imgSrc.js';
import { isImgFailed, markImgFailed } from '../imgFail.js';
import { Icon } from '../ui/Icon.jsx';
import { StateBlock } from '../ui/StateBlock.jsx';
import { CopyIconButton, safeHref } from '../ui/EntryActions.jsx';
import { ExplorePane } from './ExplorePane.jsx';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

function shanghaiToday() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** 日报里的一条条目 */
function DgItem({ it }) {
  const e = it.item || {};
  const [imgFailed, setImgFailed] = useState(false);
  const thumb = (e.image && !imgFailed && !isImgFailed(e.image))
    ? <img className="dg-item-thumb" loading="lazy" src={widthVariant(e.image, 320) || e.image} alt=""
      onLoad={(ev) => ev.currentTarget.classList.add('img-ready')}
      onError={() => { markImgFailed(e.image); setImgFailed(true); }} />
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
          {e.link ? <CopyIconButton url={e.link} /> : null}
          {safeHref(e.link) ? <a className="icon-btn" title="打开原文章" aria-label="打开原文章" href={safeHref(e.link)} target="_blank" rel="noopener noreferrer"><Icon n="external" /></a> : null}
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
            <span className="dg-warn">模型调用失败，已降级为规则摘要：{S().errText(d.error)}</span>
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
        <StateBlock className="dg-empty" icon="inbox">
          <p>没有可展示的条目</p>
        </StateBlock>
      )}
    </>
  );
}

export function AiView() {
  const s = S();
  const writable = !!(s && s.isWritable ? s.isWritable() : true);
  const [active, setActive] = useState(() => !!(s && s.state && s.state.tab === 'ai'));
  /* 探索页两级：问答（默认，新的对话式检索）/ 日报（原能力，DOM 与 ID 原样保留）。
   * 放内存不落布局：刷新回到问答是探索页的默认入口，日报从 tab 一键切回。 */
  const [pane, setPane] = useState('ask');
  // 「新对话」：换 key 让 ExplorePane 重挂载，内存历史与轮询一起重置（任务在服务端继续）。
  const [sessionKey, setSessionKey] = useState(0);
  // 合并后第一行（标题 + ⋮）即吸顶条，由其写入 --topbar-h
  const headRef = useRef(null);

  // 日报
  const [dates, setDates] = useState([]);
  const [selected, setSelected] = useState(shanghaiToday);
  const [view, setView] = useState({ kind: 'loading' });
  /* 忙碌态按按钮区分（'regen' / 'gen'）：两个按钮共用一枚 boolean 时，点「重新生成」
     会让「生成摘要」也一起变成「生成中… ⟳」，看起来像同时在跑两个任务。 */
  const [genKey, setGenKey] = useState(null);
  const genBusy = useRef(false);
  /* 等待秒数：任务改成轮询后，界面需要一个「确实在跑」的证据。
     只显示转圈 + 一句「运行中」，用户很容易在 2 分钟里反复点。 */
  const [genElapsed, setGenElapsed] = useState(0);
  useEffect(() => {
    if (!genKey) { setGenElapsed(0); return undefined; }
    const t0 = Date.now();
    const iv = setInterval(() => setGenElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [genKey]);
  /* 请求代际：日期切换是「点第二个日期时第一个可能还在飞」，慢响应回来会盖掉新内容，
     日期选择器与正文对不上。回包时对不上代际就整包丢弃（与两页列表同一套做法）。 */
  const reqGen = useRef(0);
  const [feedsInfo, setFeedsInfo] = useState({ total: 0, enabled: 0 });
  // 摘要范围读本账号的 prefs.digest（v1.4.0 起不再有站点级那一份）
  const [scope, setScope] = useState({ mode: 'enabled', feeds: [] });

  // 视图激活感知（React 常驻挂载，只在切到 AI 页时拉数据）
  useEffect(() => {
    const onView = (ev) => setActive(ev.detail === 'ai');
    return on(EVENT.VIEW, onView);
  }, []);

  // 合并头部：本视图第一行即吸顶条，实测高度写入 --topbar-h（隐藏视图测得 0 高不写，避免覆盖）
  useTopbarHeight(headRef);

  useEffect(() => {
    if (active) loadDigest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 账号关掉日报后不能停在日报 tab（tab 按钮会隐藏），自动回到问答
  useEffect(() => {
    if (pane === 'digest' && s.digestIsEnabled && !s.digestIsEnabled()) setPane('ask');
  }, [pane]);

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
    const gen = ++reqGen.current;
    setSelected(date);
    setView({ kind: 'loading' });
    try {
      const res = await s.apiFetch('/api/digest?date=' + encodeURIComponent(date));
      const data = await res.json().catch(() => ({}));
      // 500 / 网关 HTML 不能当成「今天还没有摘要」，否则引导用户去点生成重试一个坏接口
      if (!res.ok) throw new Error(s.errText(data, '读取失败'));
      if (gen !== reqGen.current) return;          // 已有更新的请求，丢弃这一包
      if (data && data.digest) setView({ kind: 'ready', digest: data.digest });
      else setView({ kind: 'empty', date });
    } catch (err) {
      if (gen !== reqGen.current) return;          // 旧请求的失败不该盖掉新日期的加载态
      setView({ kind: 'error', msg: s.errText(err, '读取失败') });
    }
  }

  /* 日报生成已改异步：提交任务 → 轮询。请求从「挂 3 分钟」变成毫秒级，
   * 网关的 100 秒读超时不再生效；关掉页面任务也会在服务端跑完。 */
  async function generate(force, key) {
    if (genBusy.current) return;
    if (!s || typeof s.submitAiJob !== 'function') {
      setView({ kind: 'genError', msg: 'AI 功能当前不可用' });
      return;
    }
    genBusy.current = true;
    const gen = ++reqGen.current;                 // 生成期间切日期：以最后一次操作为准
    setGenKey(key || (force ? 'regen' : 'gen'));
    setView({ kind: 'genLoading', phase: 'queued' });
    try {
      const job = await s.submitAiJob({ kind: 'digest', force: !!force });
      if (gen !== reqGen.current) return;
      setView({ kind: 'genLoading', phase: job.status || 'queued' });
      const done = await s.pollAiJob(job.id, {
        onStatus: (j) => {
          // 期间切了日期 / 又发起一次生成：旧任务的状态不该盖掉新视图
          if (gen === reqGen.current) setView({ kind: 'genLoading', phase: j.status, at: j.createdAt });
        },
        isCancelled: () => gen !== reqGen.current,
      });
      if (gen !== reqGen.current) return;
      const r = (done && done.result) || {};
      const d = r.digest;
      if (!d) throw new Error('生成失败：任务完成但没有返回日报');
      setDates((prev) => (prev.includes(d.date) ? prev : [d.date, ...prev]));
      setSelected(d.date);
      setView({ kind: 'ready', digest: d });
      // 服务端偶尔不给 stats：不能在已经生成成功之后抛 TypeError 把 ready 态改写成「生成失败」
      const kept = (d.stats && d.stats.kept) || 0;
      const feeds = (d.stats && d.stats.feeds) || 0;
      s.toast(r.cached ? '已读取当日缓存摘要' : `摘要生成完成（${kept} 条 / ${feeds} 频道）`);
    } catch (err) {
      if (gen === reqGen.current) {
        setView({ kind: 'genError', msg: s.errText ? s.errText(err, '生成失败') : String((err && err.message) || err) });
      }
    } finally {
      genBusy.current = false;
      setGenKey(null);
    }
  }

  let body = null;
  if (view.kind === 'loading') {
    body = <StateBlock className="dg-loading" spinner>读取中…</StateBlock>;
  } else if (view.kind === 'genLoading') {
    body = (
      <StateBlock className="dg-loading" spinner>
        正在采集过去 24 小时的新条目并生成摘要…
        <div className="hint mt-2">
          {view.phase === 'queued' ? '任务已提交，排队中…' : `任务运行中 · 已等待 ${genElapsed}s`}
          <br />任务在服务端跑，可以先离开这个页面；回到「日报」时会读到结果
        </div>
      </StateBlock>
    );
  } else if (view.kind === 'error') {
    body = (
      <StateBlock className="dg-error" icon="alert" alert>
        <p>读取失败：{view.msg}</p>
        <button className="btn btn-ghost" type="button" onClick={() => showDigest(selected)}>重试</button>
      </StateBlock>
    );
  } else if (view.kind === 'genError') {
    body = (
      <StateBlock className="dg-error" icon="alert" alert>
        <p>生成失败：{view.msg}</p>
        <p className="hint">请在「设置 → 模型」检查模型地址与 Key 是否正确</p>
        {writable ? <button className="btn btn-ghost" type="button" onClick={() => generate(false)}>重新生成</button> : null}
      </StateBlock>
    );
  } else if (view.kind === 'empty') {
    body = (
      <StateBlock className="dg-empty" icon="calendar">
        <p><strong>{view.date}</strong> 还没有摘要</p>
        <p className="hint">{writable ? '把所选频道过去 24 小时的新内容整理成简报' : '只读账户不能手动生成摘要'}</p>
        {writable ? <button className="btn btn-primary" type="button" onClick={() => generate(false)}>生成摘要</button> : null}
      </StateBlock>
    );
  } else if (view.kind === 'ready') {
    body = <DigestView digest={view.digest} />;
  }

  return (
    <>
      {/* 顶栏与文章/卡片页同构：左端一枚图标按钮（探索=新对话，清掉内存历史重开），
          中间标题，右侧簇（视图导航 + ⋮）。AI 页无频道抽屉与搜索，不硬塞假功能。 */}
      <div className="ai-head page-head view-toolbar" ref={headRef}>
        {pane === 'ask' ? (
          <button className="btn btn-ghost btn-sm ai-new-btn vt-channel" id="exploreNewBtn" type="button"
            aria-label="开始新一轮对话" title="开始新一轮对话（清空当前会话）"
            onClick={() => setSessionKey((k) => k + 1)}>
            <svg className="ico" aria-hidden="true" focusable="false"><use href="#i-plus" /></svg>
          </button>
        ) : null}
        <div className="ai-head-text"><h2 className="page-title vt-title">探索</h2></div>
        <div className="head-right vt-tools">
          <ViewNav />
          <OverflowMenu view="ai" refreshLabel="刷新订阅"
            refreshHint="只更新订阅内容；重算日报请用「重新生成」" />
        </div>
      </div>
      <div className="ai-tabs" role="tablist" aria-label="探索页模式">
        <button type="button" role="tab" id="exploreTabAsk" aria-selected={pane === 'ask' ? 'true' : 'false'}
          className={'ai-tab' + (pane === 'ask' ? ' is-active' : '')} onClick={() => setPane('ask')}>问答</button>
        <button type="button" role="tab" id="exploreTabDigest" aria-selected={pane === 'digest' ? 'true' : 'false'}
          className={'ai-tab' + (pane === 'digest' ? ' is-active' : '')}
          hidden={s.digestIsEnabled && !s.digestIsEnabled()}
          onClick={() => setPane('digest')}>日报</button>
      </div>
      {pane === 'ask' ? <ExplorePane key={sessionKey} /> : null}
      <section className="ai-pane" data-ai-pane="digest" hidden={pane !== 'digest'}>
        {/* 说明行与操作行分层：标题 → 说明 → 日期/动作，窄屏操作行自己换行 */}
        <div className="digest-head">
          <p className="ai-sub" id="digestSub">{subtitle}</p>
        </div>
        <div className="digest-actions">
          <select id="digestDate" className="select" title="选择日期" value={selected}
            onChange={(e) => showDigest(e.target.value)}>
            {dateOptions.map((d) => <option key={d} value={d}>{d === today ? '今天 · ' : ''}{d}</option>)}
          </select>
          {writable ? (
            <>
              <button className="btn btn-ghost" id="regenDigestBtn" type="button" title="忽略缓存，重新生成"
                disabled={genKey !== null} aria-busy={genKey === 'regen' ? 'true' : undefined}
                onClick={() => generate(true, 'regen')}>{genKey === 'regen' ? '生成中…' : '重新生成'}</button>
              <button className="btn btn-primary" id="genDigestBtn" type="button"
                disabled={genKey !== null} aria-busy={genKey === 'gen' ? 'true' : undefined}
                onClick={() => generate(false, 'gen')}>{genKey === 'gen' ? '生成中…' : '生成摘要'}</button>
            </>
          ) : null}
        </div>
        <div id="digestBody">{body}</div>
        <footer className="foot">
          摘要由大模型生成，可能存在偏差，请以原始条目为准
        </footer>
      </section>
    </>
  );
}
