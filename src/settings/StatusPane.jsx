/* 设置弹层「状态」面板（v1.6.0 起 React 化，原 app.js 的 renderStatus/loadStatusForm 迁移至此，P2d）。
 *
 * 迁移说明（对照旧实现）：
 * - 只读体检页，数据来自 GET /api/status 一次快照；停留时每 30s 自动拉一次，
 *   「已运行时长」在本地每秒递增（不必每秒发请求）；
 * - 轮询与递增定时器随组件挂载 / 卸载自洽启停（旧 startStatusPolling/stopStatusPolling 退役）；
 * - 「复制诊断」把快照拍平成纯文本（buildDiagnostics 迁移），带剪贴板降级兜底；
 * - 异常频道「重试」逐个抓取并刷新快照；
 * - 状态页每 30s 重绘，重绘后重新套上可折叠分组的展开态（经桥 bindSections 复用旧机制）；
 * - 类名与旧 DOM 完全一致，样式零改动。
 */

import { core } from '@core';
import React, { useEffect, useRef, useState } from 'react';

const S = () => core;   // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

/* ---------- 纯格式化（自旧 app.js 迁移，纯函数、不依赖 DOM） ---------- */

/** 秒 → 粗粒度时长：3 天 4 小时 / 2 小时 5 分 / 42 秒 */
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/** 字节 → MB / GB */
function fmtBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '—';
  const mb = b / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return mb.toFixed(mb >= 100 ? 0 : 1) + ' MB';
}

/** 相对时间。dir='past' → 「12 分钟前」；dir='future' → 「约 12 分钟后」 */
function fmtRel(ts, dir) {
  if (!ts) return '';
  const diff = dir === 'future'
    ? new Date(ts).getTime() - Date.now()
    : Date.now() - new Date(ts).getTime();
  const s = Math.abs(Math.round(diff / 1000));
  let txt;
  if (s < 60) txt = `${s} 秒`;
  else if (s < 3600) txt = `${Math.round(s / 60)} 分钟`;
  else if (s < 86400) txt = `${Math.round(s / 3600)} 小时`;
  else txt = `${Math.round(s / 86400)} 天`;
  return dir === 'future' ? `约 ${txt}后` : `${txt}前`;
}

/** 完整时间戳 YYYY-MM-DD HH:mm */
function fmtFull(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const numFmt = new Intl.NumberFormat('zh-CN');
const fmtNum = (n) => numFmt.format(Number(n) || 0);

/* ---------- 小组件 ---------- */

const StatCard = ({ label, value, sub }) => (
  <div className="stat-card">
    <p className="stat-label">{label}</p>
    <p className="stat-value">{value}</p>
    {sub ? <p className="stat-sub">{sub}</p> : null}
  </div>
);

const StatRow = ({ k, v }) => (
  <div className="stat-row"><span className="stat-k">{k}</span><span className="stat-v">{v}</span></div>
);

/** 一个折叠分组。open 只是首次的默认值；用户改过之后以记住的状态为准（bindSections 接管） */
const StatSection = ({ secKey, title, sub, open, children }) => (
  <details className="sec" data-sec={secKey} open={open || undefined}>
    <summary className="sec-head">
      <svg className="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right" /></svg>
      <span className="sec-title">{title}</span>
      <span className="sec-sub">{sub}</span>
    </summary>
    <div className="sec-body">{children}</div>
  </details>
);

/* ---------- 诊断文本（拼好后贴到 issue / 聊天里） ---------- */
function buildDiagnostics(d) {
  const app = d.app || {}; const db = d.db || {}; const rss = d.rss || {}; const dg = d.digest || {};
  const f = rss.feeds || {}; const e = rss.entries || {}; const mem = app.memory || {};
  const L = [];
  L.push('笺川（Feedlore）诊断信息');
  L.push('生成时间: ' + fmtFull(app.now));
  L.push('');
  L.push('[运行实例]');
  L.push('版本 v' + app.version + ' | Node ' + app.node + ' | PID ' + app.pid);
  L.push('启动于 ' + fmtFull(app.startedAt) + ' | 已运行 ' + fmtDuration(app.uptimeSec));
  L.push('内存 RSS ' + fmtBytes(mem.rss) + ' | 堆 ' + fmtBytes(mem.heapUsed));
  if (app.container) {
    L.push('容器内存 ' + fmtBytes(app.container.memoryUsed)
      + (app.container.memoryLimit ? ' / ' + fmtBytes(app.container.memoryLimit) : '（未设上限）')
      + ' | 容器 CPU ' + (app.container.cpuPercent == null ? '—' : app.container.cpuPercent + '%'));
  }
  L.push('负载 ' + (app.loadavg || []).join(' / ') + '（' + app.cpuCount + ' 核）');
  L.push('');
  L.push('[数据库]');
  L.push('就绪: ' + (db.ready ? '是' : '否') + (db.error ? ' | 错误: ' + db.error : ''));
  L.push('往返延迟: ' + (db.latencyMs == null ? '—' : db.latencyMs + ' ms'));
  if (db.pool) L.push('连接池: ' + db.pool.total + '/' + db.pool.max + '（空闲 ' + db.pool.idle + '，等待 ' + db.pool.waiting + '）');
  if (db.tables) L.push('表行数: feeds ' + db.tables.feeds + ' | entries ' + db.tables.entries + ' | digests ' + db.tables.digests);
  if (db.sizeBytes) L.push('数据库体积: ' + fmtBytes(db.sizeBytes));
  L.push('');
  L.push('[RSS]');
  L.push('间隔: 全局每 ' + rss.refreshMinutes + ' 分钟 | 单独设置 ' + f.perFeedInterval + ' 个'
    + ' | 并发 ' + rss.concurrency + ' | 超时 ' + rss.timeoutSeconds + 's');
  L.push('保留: 每频道 ' + (rss.keepPerFeed > 0 ? rss.keepPerFeed + ' 条' : '无条数上限') + ' | ' + (rss.keepDays ? '最长 ' + rss.keepDays + ' 天' : '不限时长')
    + ' | 收藏条目不清理');
  L.push('自动停用阈值: 连续失败 ' + rss.feedFailLimit + ' 次' + (f.autoDisabled ? ' | 当前已停用 ' + f.autoDisabled + ' 个' : ''));
  L.push('上次抓取: ' + (rss.lastRefreshAt ? fmtFull(rss.lastRefreshAt) : '无'));
  L.push('下次抓取: ' + (rss.nextRefreshAt ? fmtFull(rss.nextRefreshAt) : '—')
    + (rss.dueCount ? ' | 已到期 ' + rss.dueCount + ' 个' : ''));
  if (rss.lastResult) {
    L.push('上次结果: 新增 ' + rss.lastResult.added + ' | 失败 ' + rss.lastResult.failed
      + (rss.lastResult.autoDisabled ? ' | 自动停用 ' + rss.lastResult.autoDisabled : '')
      + ' | 耗时 ' + rss.lastResult.durationMs + 'ms');
  }
  L.push('频道: 共 ' + f.total + ' | 采集中 ' + f.enabled + ' | 卡片 ' + f.cardEnabled
    + ' | 异常 ' + f.error + ' | 未抓过 ' + f.neverFetched);
  L.push('条目: 共 ' + e.total + ' | 未读 ' + e.unread + ' | 收藏 ' + e.favorite + ' | 近 24h 新增 ' + e.added24h);
  L.push('页面自动刷新: ' + (rss.autoRefreshMinutes ? '每 ' + rss.autoRefreshMinutes + ' 分钟' : '关闭'));
  (rss.problems || []).forEach((p) => L.push('  ! ' + p.title + (p.enabled === false ? '（已自动停用）' : '') + ' → ' + p.error));
  L.push('');
  L.push('[日报]');
  L.push('自动生成: ' + (dg.enabled ? '开 · ' + dg.time : '关') + ' | 存档 ' + dg.count + ' 份');
  if (dg.latest) L.push('最近一份: ' + dg.latest.date + ' | ' + (dg.latest.fallback ? '规则降级' : dg.latest.model));
  return L.join('\n');
}

export function StatusPane() {
  const s = S();
  const paneRef = useRef(null);
  const [data, setData] = useState(null);
  const [hint, setHint] = useState('');
  const [retrying, setRetrying] = useState({});
  const [, tick] = useState(0);          // 每秒重绘，驱动「已运行」本地递增
  const baseRef = useRef(null);          // { sec, at } 用于推算当前 uptime
  const dataRef = useRef(null);          // 供复制诊断读取最新快照
  const aliveRef = useRef(true);

  async function load() {
    try {
      const res = await s.apiFetch('/api/status');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (!aliveRef.current) return;
      baseRef.current = { sec: Number(j.app && j.app.uptimeSec) || 0, at: Date.now() };
      dataRef.current = j;
      setData(j);
      setHint('每 30 秒自动刷新 · 内存与 CPU 取自容器 cgroup');
    } catch (err) {
      if (!aliveRef.current) return;
      setHint('读取失败：' + String((err && err.message) || err));
      // 已有快照时保留旧内容（与旧实现一致：失败不清屏）
      if (!dataRef.current) setData({ __error: String((err && err.message) || err) });
    }
  }

  useEffect(() => {
    aliveRef.current = true;
    load();                                             // 进入即拉一次
    const poll = setInterval(() => { if (window.__settingsOpen) load(); }, 30000);
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => {
      aliveRef.current = false;
      clearInterval(poll);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 每次重绘后重新套上分组的展开态（新出现的异常频道分组也要绑上）
  useEffect(() => {
    if (s && s.bindSections && paneRef.current) s.bindSections(paneRef.current);
  });

  async function copyDiagnostics() {
    const snap = dataRef.current;
    if (!snap) { s.toast('还没有读到状态，稍等一下', false); return; }
    const text = buildDiagnostics(snap);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        s.toast('诊断信息已复制');
        return;
      }
      throw new Error('no clipboard');
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:absolute;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        s.toast(ok ? '诊断信息已复制' : '复制失败，请手动复制', ok);
      } catch (_e) {
        s.toast('复制失败，请手动复制', false);
      }
    }
  }

  async function retry(id) {
    setRetrying((r) => ({ ...r, [id]: true }));
    try {
      const res = await s.apiFetch('/api/feeds/' + id + '/refresh', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      const er = (d.result && d.result.error) || d.error;
      if (!res.ok || er) throw new Error(er || 'HTTP ' + res.status);
      s.toast('抓取成功，新增 ' + ((d.result && d.result.added) || 0) + ' 条');
      if (s.loadFeeds) await s.loadFeeds();
      await load();
    } catch (e) {
      s.toast('重试失败：' + ((e && e.message) || e), false);
    } finally {
      setRetrying((r) => { const n = { ...r }; delete n[id]; return n; });
    }
  }

  /* ---------- 渲染 ---------- */
  if (!data) {
    return (
      <div className="tab-pane" data-pane="status" ref={paneRef}>
        <div className="status-body" id="statusBody">
          <p className="stat-loading">正在读取运行状态…</p>
        </div>
        <div className="pane-foot">
          <span className="hint" id="statusHint">{hint}</span>
          <div className="pane-foot-btns">
            <button className="btn btn-ghost" id="statusCopyBtn" onClick={copyDiagnostics}>复制诊断</button>
            <button className="btn btn-primary" id="statusRefreshBtn" onClick={load}>刷新</button>
          </div>
        </div>
      </div>
    );
  }

  if (data.__error) {
    return (
      <div className="tab-pane" data-pane="status" ref={paneRef}>
        <div className="status-body" id="statusBody">
          <p className="stat-error">读取失败：{data.__error}</p>
        </div>
        <div className="pane-foot">
          <span className="hint" id="statusHint">{hint}</span>
          <div className="pane-foot-btns">
            <button className="btn btn-ghost" id="statusCopyBtn" onClick={copyDiagnostics}>复制诊断</button>
            <button className="btn btn-primary" id="statusRefreshBtn" onClick={load}>刷新</button>
          </div>
        </div>
      </div>
    );
  }

  const app = data.app || {};
  const db = data.db || {};
  const rss = data.rss || {};
  const dg = data.digest || {};
  const f = rss.feeds || {};
  const e = rss.entries || {};
  const last = rss.lastResult;
  const problems = rss.problems || [];
  const mem = app.memory || {};
  const ctn = app.container;

  const dbOk = !!db.ready;
  const hasErr = (f.error || 0) > 0;
  const rssState = !dbOk ? 'bad' : (hasErr ? 'warn' : 'ok');
  const headline = !dbOk
    ? '数据库未就绪' + (db.error ? '：' + db.error : '')
    : (hasErr ? `${f.error} 个频道抓取失败` : '运行正常');

  const uptime = baseRef.current
    ? fmtDuration(baseRef.current.sec + (Date.now() - baseRef.current.at) / 1000)
    : fmtDuration(app.uptimeSec);

  const load_ = app.loadavg || [];
  const cpuPct = ctn && ctn.cpuPercent != null ? ctn.cpuPercent + '%' : null;
  const memUsed = ctn && ctn.memoryUsed ? ctn.memoryUsed : mem.rss;

  const lastLine = last
    ? `${fmtFull(rss.lastRefreshAt)} · 新增 ${last.added} 条 · 耗时 ${(last.durationMs / 1000).toFixed(1)}s`
      + (last.failed ? ` · 失败 ${last.failed} 个` : '')
      + (last.pruned ? ` · 清理 ${last.pruned} 条` : '')
      + (last.skipped ? ` · 跳过 ${last.skipped} 个` : '')
    : '尚未抓取';

  const latest = dg.latest;
  const latestLine = latest
    ? `${latest.date} · ${latest.fallback ? '规则降级' : (latest.model || '未配置模型')}`
      + (latest.stats ? ` · 采集 ${latest.stats.collected} → 保留 ${latest.stats.kept} · ${latest.stats.feeds} 频道` : '')
      + (latest.error ? `（大模型失败：${latest.error}）` : '')
    : '还没有生成过';

  return (
    <div className="tab-pane" data-pane="status" ref={paneRef}>
      <div className="status-body" id="statusBody">
        {/* 健康条：常显 */}
        <div className="stat-health">
          <span className="stat-pill"><i className="stat-dot ok" />服务</span>
          <span className="stat-pill"><i className={'stat-dot ' + (dbOk ? 'ok' : 'bad')} />数据库</span>
          <span className="stat-pill"><i className={'stat-dot ' + rssState} />抓取</span>
          <span className={'stat-health-msg' + (dbOk && !hasErr ? '' : ' warn')}>{headline}</span>
        </div>

        <StatSection secKey="st-runtime" title="运行与数据库"
          sub={`${fmtDuration(app.uptimeSec)} · 内存 ${fmtBytes(memUsed)} · 数据库 ${dbOk ? db.latencyMs + ' ms' : '未就绪'}`}>
          <h3 className="stat-h">运行实例</h3>
          <div className="stat-grid">
            <StatCard label="已运行" value={<span id="statUptime">{uptime}</span>}
              sub={app.startedAt ? '启动于 ' + fmtFull(app.startedAt) : ''} />
            <StatCard label={ctn && ctn.memoryUsed ? '容器内存' : '内存占用'} value={fmtBytes(memUsed)}
              sub={ctn && ctn.memoryUsed
                ? `进程 RSS ${fmtBytes(mem.rss)}${ctn.memoryLimit ? ' · 上限 ' + fmtBytes(ctn.memoryLimit) : ''}`
                : `堆 ${fmtBytes(mem.heapUsed)}`} />
            <StatCard label="Node" value={String(app.node || '—')}
              sub={`应用 v${String(app.version || '—')} · PID ${String(app.pid || '—')}`} />
            <StatCard label="系统负载" value={String(load_[0] != null ? load_[0] : '—')}
              sub={`${cpuPct ? '容器 CPU ' + cpuPct + ' · ' : ''}${app.cpuCount || '—'} 核`} />
          </div>
          <h3 className="stat-h">数据库</h3>
          <div className="stat-grid">
            <StatCard label="状态" value={dbOk ? '已连接' : '未就绪'}
              sub={dbOk ? `往返 ${db.latencyMs} ms` : (db.error || '')} />
            <StatCard label="连接池" value={db.pool ? `${db.pool.total} / ${db.pool.max}` : '—'}
              sub={db.pool ? `空闲 ${db.pool.idle} · 等待 ${db.pool.waiting}` : ''} />
            <StatCard label="条目总数" value={fmtNum(db.tables && db.tables.entries)}
              sub={`近 24h 新增 ${fmtNum(e.added24h)}`} />
            <StatCard label="日报存档" value={fmtNum(db.tables && db.tables.digests)}
              sub={dg.oldestDate ? `最早 ${dg.oldestDate}` : ''} />
            <StatCard label="数据库体积" value={db.sizeBytes ? fmtBytes(db.sizeBytes) : '—'}
              sub="含索引 · 图片缓存另计" />
          </div>
        </StatSection>

        <StatSection secKey="st-collect" title="采集与条目"
          sub={`${f.total} 个频道 · ${fmtNum(e.total)} 条 · 未读 ${fmtNum(e.unread)} · 收藏 ${fmtNum(e.favorite)}`}>
          <div className="stat-list">
            <StatRow k="抓取间隔" v={`全局每 ${rss.refreshMinutes} 分钟`
              + (f.perFeedInterval ? ` · ${f.perFeedInterval} 个频道单独设置` : ' · 全部跟随全局')
              + ` · 并发 ${rss.concurrency} · 超时 ${rss.timeoutSeconds}s`} />
            <StatRow k="上次抓取" v={lastLine} />
            <StatRow k="下次抓取" v={rss.nextRefreshAt
              ? <>{fmtFull(rss.nextRefreshAt)} <span className="stat-muted">（{fmtRel(rss.nextRefreshAt, 'future')}{rss.dueCount ? ` · 已到期 ${rss.dueCount} 个待抓` : ''}）</span></>
              : '—'} />
            <StatRow k="在途抓取" v={rss.refreshing ? `${rss.refreshing} 个频道正在抓取` : '空闲'} />
            <StatRow k="频道" v={<>{`${f.total} 个 · 采集中 ${f.enabled} · 卡片展示 ${f.cardEnabled} · 未抓过 ${f.neverFetched}`}{f.error ? <> · <span className="stat-bad">异常 {f.error}</span></> : null}{f.autoDisabled ? <> · <span className="stat-warn">自动停用 {f.autoDisabled}</span></> : null}</>} />
            {f.autoDisabled ? <StatRow k="自动停用" v={<>{`${f.autoDisabled} 个频道连续失败 ≥ ${rss.feedFailLimit} 次已停止采集`}{' · '}<span className="stat-muted">在下方「异常频道」重试，成功会自动恢复采集</span></>} /> : null}
            <StatRow k="条目" v={`${fmtNum(e.total)} 条 · 近 24h 新增 ${fmtNum(e.added24h)} · 未读 ${fmtNum(e.unread)} · 收藏 ${fmtNum(e.favorite)}`} />
            <StatRow k="保留策略" v={<>{rss.keepPerFeed > 0 ? `每频道最多 ${fmtNum(rss.keepPerFeed)} 条` : '每频道不设条数上限'}{rss.keepDays ? ` · 最长 ${fmtNum(rss.keepDays)} 天` : ' · 不限时长'}{' · '}<span className="stat-muted">收藏的条目不参与清理</span></>} />
            <StatRow k="时间跨度" v={e.oldest && e.newest ? `${fmtFull(e.oldest)} → ${fmtFull(e.newest)}` : '—'} />
          </div>
        </StatSection>

        {/* 异常频道：只有失败时才出现，且默认展开 */}
        {problems.length > 0 && (
          <StatSection secKey="st-problems" title="异常频道" sub={`${problems.length} 个频道抓取失败`} open>
            <div className="stat-problems">
              {problems.map((p) => (
                <div className="stat-problem" key={p.feedId}>
                  <i className="stat-dot bad" />
                  <span className="stat-problem-name" title={p.title}>{p.title}</span>
                  {p.enabled === false && <span className="stat-problem-off" title={`连续失败已达上限，已自动停止采集；重试成功会自动恢复`}>已自动停用</span>}
                  <span className="stat-problem-err" title={p.error}>{p.error}</span>
                  <button className="btn btn-ghost btn-sm" data-retry={p.feedId}
                    disabled={!!retrying[p.feedId]} onClick={() => retry(p.feedId)}>
                    {retrying[p.feedId] ? '抓取中…' : (p.enabled === false ? '重试并恢复' : '重试')}
                  </button>
                </div>
              ))}
            </div>
          </StatSection>
        )}

        <StatSection secKey="st-digest" title="日报" sub={dg.enabled ? `已开启 · 每天 ${dg.time}` : '未开启'}>
          <div className="stat-list">
            <StatRow k="自动生成" v={dg.enabled ? `已开启 · 每天 ${dg.time}` : '未开启'} />
            <StatRow k="下次生成" v={dg.nextRunAt
              ? <>{fmtFull(dg.nextRunAt)} <span className="stat-muted">（{fmtRel(dg.nextRunAt, 'future')}）</span></>
              : '—'} />
            <StatRow k="摘要范围" v={dg.scope === 'all' ? '全部频道' : '仅「采集」开启的频道'} />
            <StatRow k="最近一份" v={latestLine} />
          </div>
        </StatSection>
      </div>

      <div className="pane-foot">
        <span className="hint" id="statusHint">{hint}</span>
        <div className="pane-foot-btns">
          <button className="btn btn-ghost" id="statusCopyBtn" onClick={copyDiagnostics}>复制诊断</button>
          <button className="btn btn-primary" id="statusRefreshBtn" onClick={load}>刷新</button>
        </div>
      </div>
    </div>
  );
}
