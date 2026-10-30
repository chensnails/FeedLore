import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { SourceConfig } from '@feedlore/contract';
import { api } from '../lib/api';
import { qk } from '../lib/query';
import {
  useCheckVersion,
  useClearImageCache,
  useCreateUser,
  useDeleteUser,
  usePatchUser,
  useSaveSourceConfig,
  useUpdateApp,
} from '../lib/mutations';
import { AccountForm } from './AccountForm';
import { useUi } from '../store/ui';

/**
 * 管理面板（仅管理员可见）。
 *
 * 三个页签对应三类完全不同的操作，所以拆开而不是堆成一页：
 * - 状态：只读，10s 轮询一次，用来回答「为什么没在抓」「为什么变慢了」；
 * - 采集参数：写库，保存即生效（服务端会 invalidate 配置快照）；
 * - 用户：账号增删改，密码一律由 better-auth 处理，界面只负责传明文。
 *
 * 刻意做成覆盖层而不是独立路由：v2 前端还没有路由（单页 + 覆盖层），
 * 引入路由会把「刷新后回到哪个视图」这个新问题一起引进来，当前不值得。
 */

type Tab = 'status' | 'config' | 'users' | 'about';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'status', label: '状态' },
  { id: 'config', label: '采集参数' },
  { id: 'users', label: '用户' },
  { id: 'about', label: '关于' },
];

/** 采集参数的定义表：一处维护「标签 / 单位 / 提示」，界面与提交都从这里读。 */
const FIELDS: Array<{ key: keyof SourceConfig; label: string; unit?: string; hint?: string }> = [
  { key: 'refreshMinutes', label: '全局采集间隔', unit: '分钟', hint: '5–1440；单个频道可另设' },
  { key: 'autoRefreshMinutes', label: '前端自动刷新', unit: '分钟', hint: '0 = 关闭；只影响界面' },
  { key: 'timeoutSeconds', label: '抓取超时', unit: '秒', hint: '5–120' },
  { key: 'concurrency', label: '抓取并发', unit: '个', hint: '1–10，按 URL 组计' },
  { key: 'keepPerFeed', label: '每频道保留', unit: '条', hint: '0 = 不限；收藏的不清' },
  { key: 'keepDays', label: '条目保留', unit: '天', hint: '0 = 不限' },
  { key: 'feedFailLimit', label: '失败自动停用', unit: '次', hint: '2–20，成功一次即清零' },
  { key: 'imgTtlDays', label: '图片回源窗口', unit: '天', hint: '超过此期限先返旧图再后台刷新' },
  { key: 'imgKeepDays', label: '图片保留', unit: '天', hint: '超期由定时清理删除' },
  { key: 'imgMaxDim', label: '图片长边上限', unit: 'px', hint: '320–4096，只缩不放' },
  { key: 'imgQuality', label: 'WebP 质量', unit: '', hint: '30–100' },
];

function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
  return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 小时`;
}

const fmtTime = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—';

export function AdminPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('status');

  // Esc 关闭：与阅读层一致，键盘用户不该只能去找那个叉
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="reader-backdrop" onClick={onClose} role="presentation">
      <section className="admin-sheet" onClick={(e) => e.stopPropagation()}>
        <button className="reader-close btn ghost" onClick={onClose} aria-label="关闭">
          ✕
        </button>

        <h2 className="admin-title">管理</h2>
        <div className="admin-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`chip${tab === t.id ? ' on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'status' && <StatusTab />}
        {tab === 'config' && <ConfigTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'about' && <AboutTab />}
      </section>
    </div>
  );
}

/* ============================ 状态 ============================ */

function StatusTab() {
  const statusQuery = useQuery({
    queryKey: qk.adminStatus,
    queryFn: () => api.admin.status(),
    // 状态页是「正在发生什么」，30s 的全局 staleTime 太钝；轮询也能顺带把容器 CPU 采到
    refetchInterval: 10_000,
    staleTime: 0,
  });
  const cacheQuery = useQuery({
    queryKey: qk.adminImageCache,
    queryFn: () => api.admin.imageCache(),
  });
  const clearCache = useClearImageCache();

  const s = statusQuery.data;
  if (statusQuery.isPending) return <p className="hint">读取状态…</p>;
  if (statusQuery.isError || !s) {
    return <p className="hint error-text">状态读取失败：{String((statusQuery.error as Error)?.message ?? '未知错误')}</p>;
  }

  return (
    <div className="admin-body">
      {!s.db.ready && (
        <p className="admin-alert">
          数据库不可用：{s.db.error ?? '未知原因'}。此时其余统计都是上一次的值或 0，先修数据库。
        </p>
      )}

      <h3 className="admin-h3">进程</h3>
      <dl className="admin-grid">
        <dt>版本</dt>
        <dd>{s.app.version}</dd>
        <dt>Node</dt>
        <dd>{s.app.node}</dd>
        <dt>运行时长</dt>
        <dd>{fmtDuration(s.app.uptimeSec)}（启动于 {fmtTime(s.app.startedAt)}）</dd>
        <dt>内存</dt>
        <dd>
          RSS {fmtBytes(s.app.memory.rss)} · 堆 {fmtBytes(s.app.memory.heapUsed)} / {fmtBytes(s.app.memory.heapTotal)}
        </dd>
        {s.app.container && (
          <>
            <dt>容器</dt>
            <dd>
              内存 {fmtBytes(s.app.container.memoryUsed)}
              {s.app.container.memoryLimit ? ` / ${fmtBytes(s.app.container.memoryLimit)}` : ''}
              {s.app.container.cpuPercent !== null ? ` · CPU ${s.app.container.cpuPercent}%` : ''}
            </dd>
          </>
        )}
        <dt>负载</dt>
        <dd>
          {s.app.loadavg.join(' / ')}（{s.app.cpuCount} 核）
        </dd>
      </dl>

      <h3 className="admin-h3">数据库</h3>
      <dl className="admin-grid">
        <dt>状态</dt>
        <dd>
          {s.db.ready ? `正常（往返 ${s.db.latencyMs ?? '—'} ms）` : `不可用：${s.db.error ?? '—'}`}
        </dd>
        <dt>连接池</dt>
        <dd>
          {s.db.pool
            ? `总 ${s.db.pool.total} · 空闲 ${s.db.pool.idle} · 等待 ${s.db.pool.waiting} · 上限 ${s.db.pool.max}`
            : '—'}
        </dd>
        <dt>体积</dt>
        <dd>{fmtBytes(s.db.sizeBytes)}</dd>
        <dt>行数</dt>
        <dd>
          {s.db.tables
            ? Object.entries(s.db.tables)
                .map(([k, v]) => `${k} ${v}`)
                .join(' · ')
            : '—'}
        </dd>
      </dl>

      <h3 className="admin-h3">采集</h3>
      <dl className="admin-grid">
        <dt>频道</dt>
        <dd>
          共 {s.rss.feeds.total} · 采集 {s.rss.feeds.enabled} · 卡片 {s.rss.feeds.cardEnabled} · 异常{' '}
          {s.rss.feeds.error} · 未抓过 {s.rss.feeds.neverFetched}
          {s.rss.feeds.autoDisabled > 0 ? ` · 自动停用 ${s.rss.feeds.autoDisabled}` : ''}
        </dd>
        <dt>条目</dt>
        <dd>
          共 {s.rss.entries.total} · 未读 {s.rss.entries.unread} · 收藏 {s.rss.entries.favorite} · 近 24h 新增{' '}
          {s.rss.entries.added24h}
        </dd>
        <dt>时间窗</dt>
        <dd>
          {fmtTime(s.rss.entries.oldest)} → {fmtTime(s.rss.entries.newest)}
        </dd>
        <dt>上次抓取</dt>
        <dd>{fmtTime(s.rss.lastRefreshAt)}</dd>
        <dt>下次抓取</dt>
        <dd>
          {fmtTime(s.rss.nextRefreshAt)}
          {s.rss.dueCount > 0 ? `（${s.rss.dueCount} 个频道已到期）` : ''}
          {s.rss.inFlight > 0 ? ` · 正在抓 ${s.rss.inFlight} 个` : ''}
        </dd>
        {s.rss.lastResult && (
          <>
            <dt>上一轮</dt>
            <dd>
              新增 {s.rss.lastResult.added} · 跳过 {s.rss.lastResult.skipped} · 失败 {s.rss.lastResult.failed} · 清理{' '}
              {s.rss.lastResult.pruned} · 耗时 {s.rss.lastResult.durationMs} ms
            </dd>
          </>
        )}
        <dt>参数</dt>
        <dd>
          {s.rss.refreshMinutes} 分钟 / 并发 {s.rss.concurrency} / 超时 {s.rss.timeoutSeconds}s / 保留{' '}
          {s.rss.keepPerFeed} 条
        </dd>
      </dl>

      {s.rss.problems.length > 0 && (
        <>
          <h3 className="admin-h3">有问题的频道（{s.rss.problems.length}）</h3>
          <ul className="admin-problems">
            {s.rss.problems.slice(0, 10).map((p) => (
              <li key={p.feedId}>
                <strong>{p.title}</strong>
                <span className="hint">
                  {' '}
                  连续失败 {p.failStreak} 次 · {p.enabled ? '仍在采集' : '已停用'} · {fmtTime(p.lastFetchedAt)}
                </span>
                <div className="error-text">{p.error}</div>
              </li>
            ))}
          </ul>
          {s.rss.problems.length > 10 && <p className="hint tiny">仅显示前 10 条</p>}
        </>
      )}

      <h3 className="admin-h3">图片缓存</h3>
      <dl className="admin-grid">
        <dt>已缓存</dt>
        <dd>
          {cacheQuery.data ? `${cacheQuery.data.count} 张 · ${fmtBytes(cacheQuery.data.bytes)}` : '读取中…'}
        </dd>
        <dt>操作</dt>
        <dd>
          <button
            className="btn ghost"
            onClick={() => clearCache.mutate()}
            disabled={clearCache.isPending}
            title="同时清空数据库与内存缓存；之后图片会在下次浏览时重新回源"
          >
            {clearCache.isPending ? '清空中…' : '清空缓存'}
          </button>
        </dd>
      </dl>

      <h3 className="admin-h3">日报</h3>
      <dl className="admin-grid">
        <dt>账号</dt>
        <dd>
          {s.digest.totalUsers} 个账号，其中 {s.digest.autoUsers} 个开了自动生成
        </dd>
        <dt>已生成</dt>
        <dd>
          {s.digest.count} 份
          {s.digest.oldestDate ? `（最早 ${s.digest.oldestDate}）` : ''}
        </dd>
        <dt>下次生成</dt>
        <dd>
          {s.digest.nextRunAt
            ? fmtTime(s.digest.nextRunAt)
            : s.digest.autoUsers > 0
              ? '等待下一轮调度'
              : '没有账号开启自动生成'}
        </dd>
      </dl>
    </div>
  );
}

/* ============================ 采集参数 ============================ */

function ConfigTab() {
  const configQuery = useQuery({ queryKey: qk.adminConfig, queryFn: () => api.admin.config() });
  const save = useSaveSourceConfig();
  const [form, setForm] = useState<Record<string, string>>({});

  // 服务端值到达（或保存后刷新）时重置表单 —— 夹取后的真实值必须回填到界面
  useEffect(() => {
    const src = configQuery.data?.source;
    if (!src) return;
    const next: Record<string, string> = {};
    for (const f of FIELDS) next[f.key] = String(src[f.key] ?? '');
    next.proxyUrl = String(src.proxyUrl ?? '');
    setForm(next);
  }, [configQuery.data]);

  if (configQuery.isPending) return <p className="hint">读取参数…</p>;
  if (configQuery.isError || !configQuery.data) {
    return <p className="hint error-text">参数读取失败：{String((configQuery.error as Error)?.message ?? '未知错误')}</p>;
  }

  const submit = (): void => {
    const patch: Record<string, number | string> = {};
    for (const f of FIELDS) patch[f.key] = Number(form[f.key] ?? 0);
    patch.proxyUrl = form.proxyUrl ?? '';
    save.mutate(patch as never);
  };

  return (
    <div className="admin-body">
      <div className="admin-fields">
        {FIELDS.map((f) => (
          <label key={f.key} className="admin-field">
            <span className="admin-field-label">
              {f.label}
              {f.unit ? `（${f.unit}）` : ''}
            </span>
            <input
              type="number"
              value={form[f.key] ?? ''}
              onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
            />
            {f.hint && <span className="hint tiny">{f.hint}</span>}
          </label>
        ))}

        <label className="admin-field wide">
          <span className="admin-field-label">出网代理</span>
          <input
            type="text"
            placeholder="http://127.0.0.1:7890（留空 = 直连）"
            value={form.proxyUrl ?? ''}
            onChange={(e) => setForm((s) => ({ ...s, proxyUrl: e.target.value }))}
          />
          <span className="hint tiny">
            保存后立即生效（无需重启）。只支持 http/https；走代理时由代理解析域名，服务端不再钉定 IP，
            但内网地址依旧会被拒。
          </span>
        </label>
      </div>

      <div className="admin-actions">
        <button className="btn" onClick={submit} disabled={save.isPending}>
          {save.isPending ? '保存中…' : '保存'}
        </button>
        <span className="hint tiny">越界值会被服务端夹回合法区间，保存后下方会自动刷新为真实值。</span>
      </div>

    </div>
  );
}

/* ============================ 用户 ============================ */

function UsersTab() {
  const usersQuery = useQuery({ queryKey: qk.adminUsers, queryFn: () => api.admin.users.list() });
  const askConfirm = useUi((s) => s.askConfirm);
  const create = useCreateUser();
  const patch = usePatchUser();
  const del = useDeleteUser();

  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  /** 正在重置密码的用户 id（行内输入框，避免用 prompt 弹窗打断流程） */
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState('');

  if (usersQuery.isPending) return <p className="hint">读取用户…</p>;
  if (usersQuery.isError) {
    return <p className="hint error-text">用户读取失败：{String((usersQuery.error as Error)?.message ?? '未知错误')}</p>;
  }

  const users = usersQuery.data;

  const submitCreate = (): void => {
    if (!name.trim() || pw.length < 4) return;
    create.mutate({ username: name.trim(), password: pw, role }, {
      onSuccess: () => {
        setName('');
        setPw('');
        setRole('user');
      },
    });
  };

  return (
    <div className="admin-body">
      <table className="admin-table">
        <thead>
          <tr>
            <th>用户名</th>
            <th>角色</th>
            <th>频道</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.username}
                {u.isSelf && <span className="hint tiny">（当前登录）</span>}
              </td>
              <td>
                <select
                  value={u.role}
                  onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value as 'user' | 'admin' } })}
                  disabled={patch.isPending}
                  aria-label={`${u.username} 的角色`}
                >
                  <option value="user">普通用户</option>
                  <option value="admin">管理员</option>
                </select>
              </td>
              <td>{u.feedCount}</td>
              <td className="hint tiny">{u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : '—'}</td>
              <td className="admin-row-actions">
                {resetFor === u.id ? (
                  <>
                    <input
                      type="password"
                      placeholder="新密码"
                      value={resetPw}
                      onChange={(e) => setResetPw(e.target.value)}
                      className="admin-inline-input"
                    />
                    <button
                      className="btn ghost"
                      disabled={resetPw.length < 4 || patch.isPending}
                      onClick={() =>
                        patch.mutate(
                          { id: u.id, body: { password: resetPw } },
                          {
                            onSuccess: () => {
                              setResetFor(null);
                              setResetPw('');
                            },
                          },
                        )
                      }
                    >
                      确认
                    </button>
                    <button className="btn ghost" onClick={() => setResetFor(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button className="btn ghost" onClick={() => setResetFor(u.id)}>
                    重置密码
                  </button>
                )}
                <button
                  className="btn ghost danger"
                  disabled={u.isSelf || del.isPending}
                  title={u.isSelf ? '不能删除当前登录的账号' : '删除该用户及其全部订阅'}
                  onClick={() => {
                    void (async () => {
                      const ok = await askConfirm({
                        title: `删除用户「${u.username}」？`,
                        body: '其订阅与条目会一起删除，不可恢复。',
                        okText: '删除',
                        danger: true,
                      });
                      if (ok) del.mutate(u.id);
                    })();
                  }}
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="admin-h3">新增用户</h3>
      <div className="admin-create">
        <input placeholder="用户名" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          placeholder="初始密码（至少 4 位）"
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <select value={role} onChange={(e) => setRole(e.target.value as 'user' | 'admin')} aria-label="新用户角色">
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
        <button className="btn" onClick={submitCreate} disabled={create.isPending || !name.trim() || pw.length < 4}>
          {create.isPending ? '创建中…' : '创建'}
        </button>
      </div>
      <p className="hint tiny">用户名可用字母、数字与 . _ - @，最长 40 位。登录用用户名，不用邮箱。</p>

      <h3 className="admin-h3">我的账号</h3>
      <AccountForm />
    </div>
  );
}


/* ============================ 关于 / 版本 ============================ */

/**
 * 版本与更新通道。
 *
 * 为什么单独一页而不是塞进「状态」：状态页是**运行时**（正在抓什么、内存多少），
 * 10 秒轮询一次；版本是**部署态**，一分钟都不该变。混在一起会让状态页每次轮询
 * 都去问一次 GitHub（服务端虽有 10 分钟缓存，但前端请求次数白涨），
 * 更重要的是「检查更新」是个会改变服务器状态的入口，放在只读页里很危险。
 *
 * 更新通道的差别必须说清楚：镜像模式 + Watchtower 才有 `updateEnabled`，
 * 其它部署方式点了也没用 —— 那种「有个按钮但永远失败」的界面比没有按钮更糟。
 */
function AboutTab() {
  const infoQuery = useQuery({
    queryKey: qk.adminVersion,
    queryFn: () => api.version.info(),
    staleTime: 60_000,
  });
  const check = useCheckVersion();
  const update = useUpdateApp();
  const r = check.data;

  return (
    <div className="admin-body">
      <h3 className="admin-h3">版本</h3>
      <dl className="admin-grid">
        <dt>当前版本</dt>
        <dd>{infoQuery.data ? `v${infoQuery.data.version}` : '读取中…'}</dd>
        <dt>仓库</dt>
        <dd>{infoQuery.data?.repo ?? '—'}</dd>
        <dt>更新通道</dt>
        <dd>{infoQuery.data?.updateEnabled ? '已接入（Watchtower HTTP API）' : '未接入'}</dd>
      </dl>

      <p className="admin-actions">
        <button className="btn sm" disabled={check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? '检查中…' : '检查更新'}
        </button>
        {infoQuery.data?.updateEnabled && (
          <button className="btn ghost sm" disabled={update.isPending} onClick={() => update.mutate()}>
            {update.isPending ? '触发中…' : '立即更新'}
          </button>
        )}
      </p>

      {r && !r.ok && <p className="admin-alert">检查失败：{r.error ?? '无法访问更新源'}</p>}
      {r?.ok && r.hasUpdate && (
        <p className="admin-ok">
          发现新版本 <b>v{r.latest}</b>（当前 v{r.current}）
          {r.publishedAt ? ` · 发布于 ${r.publishedAt.slice(0, 10)}` : ''}
          {r.releaseUrl && (
            <>
              {' · '}
              <a href={r.releaseUrl} target="_blank" rel="noreferrer">
                发布说明
              </a>
            </>
          )}
        </p>
      )}
      {r?.ok && !r.hasUpdate && <p className="hint">已是最新版本（v{r.current ?? infoQuery.data?.version ?? '—'}）。</p>}

      <p className="hint tiny">
        检查会向 GitHub 查询最新的 Release / Tag，服务端缓存 10 分钟，不会频繁请求。
        {!infoQuery.data?.updateEnabled &&
          ' 当前部署未接入一键更新通道（仅「镜像 + Watchtower」支持）；检测到新版本后请手动更新容器。'}
      </p>
    </div>
  );
}
