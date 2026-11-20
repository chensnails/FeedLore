/* 状态面板的展示组件：从 StatusPane.tsx 抽出，DOM / 类名 / 文案逐字对齐。 */

import type { ReactNode } from 'react';
import { PaneFoot, Section } from './primitives.tsx';
import type { StatusController } from './StatusPane.controller.ts';
import type { StatusSnapshot } from './StatusPane.types.ts';
import { fmtBytes, fmtDuration, fmtFull, fmtNum, fmtRel, S } from './StatusPane.utils.ts';

const StatCard = ({
  label,
  value,
  sub,
}: {
  label?: ReactNode;
  value?: ReactNode;
  sub?: ReactNode;
}) => (
  <div className="stat-card">
    <p className="stat-label">{label}</p>
    <p className="stat-value">{value}</p>
    {sub ? <p className="stat-sub">{sub}</p> : null}
  </div>
);

const StatRow = ({ k, v }: { k?: ReactNode; v?: ReactNode }) => (
  <div className="stat-row">
    <span className="stat-k">{k}</span>
    <span className="stat-v">{v}</span>
  </div>
);

/** 一个折叠分组（见 primitives.jsx；open 只是首次默认值，之后以目录记住的状态为准） */
const StatSection = Section;

/* ---------- 页脚（三个分支共用一份，id 不重复） ---------- */
export function StatusFoot({ c }: { c: StatusController }) {
  // 无快照时正文已给出「读取失败：原因」，页脚不再复制一遍，改成行动引导
  const footLead = c.data && '__error' in c.data ? '读取失败，点「刷新」重试' : c.hint;
  return (
    <PaneFoot
      lead={
        <span className="hint" id="statusHint">
          {footLead}
        </span>
      }
    >
      <button
        type="button"
        className="btn btn-ghost"
        id="statusCopyBtn"
        onClick={c.copyDiagnostics}
      >
        复制诊断
      </button>
      <button
        type="button"
        className="btn btn-primary"
        id="statusRefreshBtn"
        onClick={c.refreshStatus}
        disabled={c.busy}
        aria-busy={c.busy ? 'true' : undefined}
        title="重试读取运行状态"
      >
        {c.busy ? '刷新中…' : '刷新'}
      </button>
    </PaneFoot>
  );
}

/* ---------- 加载中 / 读取失败 两个早退分支 ---------- */
export function StatusLoading({ c }: { c: StatusController }) {
  return (
    <div className="tab-pane" data-pane="status" ref={c.paneRef}>
      <div className="status-body" id="statusBody">
        <p className="stat-loading">正在读取运行状态…</p>
      </div>
      <StatusFoot c={c} />
    </div>
  );
}

export function StatusErrorPane({ c, error }: { c: StatusController; error: string }) {
  return (
    <div className="tab-pane" data-pane="status" ref={c.paneRef}>
      <div className="status-body" id="statusBody">
        <p className="stat-error">读取失败：{error}</p>
      </div>
      <StatusFoot c={c} />
    </div>
  );
}

/* ---------- 正常快照的全部正文 ---------- */
export function StatusBody({ c, snapshot }: { c: StatusController; snapshot: StatusSnapshot }) {
  const s = S();
  const data = snapshot;
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
  const rssState = !dbOk ? 'bad' : hasErr ? 'warn' : 'ok';
  const headline = !dbOk
    ? '数据库未就绪' + (db.error ? '：' + s.errText(db.error) : '')
    : hasErr
      ? `${f.error} 个频道抓取失败`
      : '运行正常';

  const uptime = c.baseRef.current
    ? fmtDuration(c.baseRef.current.sec + (Date.now() - c.baseRef.current.at) / 1000)
    : fmtDuration(app.uptimeSec);

  const load_ = app.loadavg || [];
  const cpuPct = ctn && ctn.cpuPercent != null ? ctn.cpuPercent + '%' : null;
  const memUsed = ctn && ctn.memoryUsed ? ctn.memoryUsed : mem.rss;

  const lastLine = last
    ? `${fmtFull(rss.lastRefreshAt)} · 新增 ${last.added} 条 · 耗时 ${(last.durationMs / 1000).toFixed(1)}s` +
      (last.failed ? ` · 失败 ${last.failed} 个` : '') +
      (last.pruned ? ` · 清理 ${last.pruned} 条` : '') +
      (last.skipped ? ` · 跳过 ${last.skipped} 个` : '')
    : '尚未抓取';

  const latest = dg.latest;
  const latestLine = latest
    ? `${latest.date} · ${latest.fallback ? '规则降级' : latest.model || '未配置模型'}` +
      (latest.stats
        ? ` · 采集 ${latest.stats.collected} → 保留 ${latest.stats.kept} · ${latest.stats.feeds} 频道`
        : '') +
      (latest.error ? `（大模型失败：${s.errText(latest.error)}）` : '')
    : '还没有生成过';

  return (
    <>
      {/* 健康条：常显 */}
      <div className="stat-health">
        <span className="stat-pill">
          <i className="stat-dot ok" />
          服务
        </span>
        <span className="stat-pill">
          <i className={'stat-dot ' + (dbOk ? 'ok' : 'bad')} />
          数据库
        </span>
        <span className="stat-pill">
          <i className={'stat-dot ' + rssState} />
          抓取
        </span>
        <span className={'stat-health-msg' + (dbOk && !hasErr ? '' : ' warn')}>{headline}</span>
      </div>

      <StatSection
        secKey="st-runtime"
        title="运行与数据库"
        sub={`${fmtDuration(app.uptimeSec)} · 内存 ${fmtBytes(memUsed)} · 数据库 ${dbOk ? db.latencyMs + ' ms' : '未就绪'}`}
      >
        <h3 className="stat-h">运行实例</h3>
        <div className="stat-grid">
          <StatCard
            label="已运行"
            value={<span id="statUptime">{uptime}</span>}
            sub={app.startedAt ? '启动于 ' + fmtFull(app.startedAt) : ''}
          />
          <StatCard
            label={ctn && ctn.memoryUsed ? '容器内存' : '内存占用'}
            value={fmtBytes(memUsed)}
            sub={
              ctn && ctn.memoryUsed
                ? `进程 RSS ${fmtBytes(mem.rss)}${ctn.memoryLimit ? ' · 上限 ' + fmtBytes(ctn.memoryLimit) : ''}`
                : `堆 ${fmtBytes(mem.heapUsed)}`
            }
          />
          <StatCard
            label="Node"
            value={String(app.node || '—')}
            sub={`应用 v${String(app.version || '—')} · PID ${String(app.pid || '—')}`}
          />
          <StatCard
            label="系统负载"
            value={String(load_[0] != null ? load_[0] : '—')}
            sub={`${cpuPct ? '容器 CPU ' + cpuPct + ' · ' : ''}${app.cpuCount || '—'} 核`}
          />
        </div>
        <h3 className="stat-h">数据库</h3>
        <div className="stat-grid">
          <StatCard
            label="状态"
            value={dbOk ? '已连接' : '未就绪'}
            sub={dbOk ? `往返 ${db.latencyMs} ms` : s.errText(db.error)}
          />
          <StatCard
            label="连接池"
            value={db.pool ? `${db.pool.total} / ${db.pool.max}` : '—'}
            sub={db.pool ? `空闲 ${db.pool.idle} · 等待 ${db.pool.waiting}` : ''}
          />
          <StatCard
            label="条目总数"
            value={fmtNum(db.tables && db.tables.entries)}
            sub={`近 24h 新增 ${fmtNum(e.added24h)}`}
          />
          <StatCard
            label="日报存档"
            value={fmtNum(db.tables && db.tables.digests)}
            sub={dg.oldestDate ? `最早 ${dg.oldestDate}` : ''}
          />
          <StatCard
            label="数据库体积"
            value={db.sizeBytes ? fmtBytes(db.sizeBytes) : '—'}
            sub="含索引 · 图片缓存另计"
          />
        </div>
      </StatSection>

      <StatSection
        secKey="st-collect"
        title="采集与条目"
        sub={`${f.total} 个频道 · ${fmtNum(e.total)} 条 · 未读 ${fmtNum(e.unread)} · 收藏 ${fmtNum(e.favorite)}`}
      >
        <div className="stat-list">
          <StatRow
            k="抓取间隔"
            v={
              `全局每 ${rss.refreshMinutes} 分钟` +
              (f.perFeedInterval ? ` · ${f.perFeedInterval} 个频道单独设置` : ' · 全部跟随全局') +
              ` · 并发 ${rss.concurrency} · 超时 ${rss.timeoutSeconds}s`
            }
          />
          <StatRow k="上次抓取" v={lastLine} />
          <StatRow
            k="下次抓取"
            v={
              rss.nextRefreshAt ? (
                <>
                  {fmtFull(rss.nextRefreshAt)}{' '}
                  <span className="stat-muted">
                    （{fmtRel(rss.nextRefreshAt, 'future')}
                    {rss.dueCount ? ` · 已到期 ${rss.dueCount} 个待抓` : ''}）
                  </span>
                </>
              ) : (
                '—'
              )
            }
          />
          <StatRow k="在途抓取" v={rss.refreshing ? `${rss.refreshing} 个频道正在抓取` : '空闲'} />
          <StatRow
            k="频道"
            v={
              <>
                {`${f.total} 个 · 采集中 ${f.enabled} · 卡片展示 ${f.cardEnabled} · 未抓过 ${f.neverFetched}`}
                {f.error ? (
                  <>
                    {' '}
                    · <span className="stat-bad">异常 {f.error}</span>
                  </>
                ) : null}
                {f.autoDisabled ? (
                  <>
                    {' '}
                    · <span className="stat-warn">自动停用 {f.autoDisabled}</span>
                  </>
                ) : null}
              </>
            }
          />
          {f.autoDisabled ? (
            <StatRow
              k="自动停用"
              v={
                <>
                  {`${f.autoDisabled} 个频道连续失败 ≥ ${rss.feedFailLimit} 次已停止采集`}
                  {' · '}
                  <span className="stat-muted">在下方「异常频道」重试，成功会自动恢复采集</span>
                </>
              }
            />
          ) : null}
          <StatRow
            k="条目"
            v={`${fmtNum(e.total)} 条 · 近 24h 新增 ${fmtNum(e.added24h)} · 未读 ${fmtNum(e.unread)} · 收藏 ${fmtNum(e.favorite)}`}
          />
          <StatRow
            k="保留策略"
            v={
              <>
                {rss.keepPerFeed > 0
                  ? `每频道最多 ${fmtNum(rss.keepPerFeed)} 条`
                  : '每频道不设条数上限'}
                {rss.keepDays ? ` · 最长 ${fmtNum(rss.keepDays)} 天` : ' · 不限时长'}
                {' · '}
                <span className="stat-muted">收藏的条目不参与清理</span>
              </>
            }
          />
          <StatRow
            k="时间跨度"
            v={e.oldest && e.newest ? `${fmtFull(e.oldest)} → ${fmtFull(e.newest)}` : '—'}
          />
        </div>
      </StatSection>

      {/* 异常频道：只有失败时才出现，且默认展开 */}
      {problems.length > 0 && (
        <StatSection
          secKey="st-problems"
          title="异常频道"
          sub={`${problems.length} 个频道抓取失败`}
          open
        >
          <div className="stat-problems">
            {problems.map((p) => (
              <div className="stat-problem" key={p.feedId}>
                <i className="stat-dot bad" />
                <span className="stat-problem-name" title={p.title}>
                  {p.title}
                </span>
                {p.enabled === false && (
                  <span
                    className="stat-problem-off"
                    title={`连续失败已达上限，已自动停止采集；重试成功会自动恢复`}
                  >
                    已自动停用
                  </span>
                )}
                <span className="stat-problem-err" title={s.errText(p.error)}>
                  {s.errText(p.error)}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-retry={p.feedId}
                  disabled={!!c.retrying[p.feedId]}
                  aria-busy={c.retrying[p.feedId] ? 'true' : undefined}
                  onClick={() => c.retry(p.feedId)}
                >
                  {c.retrying[p.feedId] ? '抓取中…' : p.enabled === false ? '重试并恢复' : '重试'}
                </button>
              </div>
            ))}
          </div>
        </StatSection>
      )}

      <StatSection
        secKey="st-digest"
        title="日报"
        sub={
          dg.autoUsers || 0
            ? `${dg.autoUsers} 个账号开了自动生成（配置跟随账号）`
            : '没有账号开自动生成'
        }
      >
        <div className="stat-list">
          <StatRow k="自动生成" v={`${dg.autoUsers || 0} / ${dg.totalUsers || 0} 个账号`} />
          <StatRow
            k="最近一次到点"
            v={
              dg.nextRunAt ? (
                <>
                  {fmtFull(dg.nextRunAt)}{' '}
                  <span className="stat-muted">（{fmtRel(dg.nextRunAt, 'future')}）</span>
                </>
              ) : (
                '—'
              )
            }
          />
          <StatRow k="最近一份" v={latestLine} />
        </div>
      </StatSection>
    </>
  );
}
