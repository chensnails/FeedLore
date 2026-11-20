/* 状态面板的纯格式化与诊断文本：从 StatusPane.tsx 抽出，行为逐字等价。 */

import { core } from '@core';
import type { StatusSnapshot } from './StatusPane.types.ts';

export const S = () => core; // 核心逻辑单例（@core，v2.0.0 起改为模块引用）

/* ---------- 纯格式化（自旧 app.js 迁移，纯函数、不依赖 DOM） ---------- */

/** 秒 → 粗粒度时长：3 天 4 小时 / 2 小时 5 分 / 42 秒 */
export function fmtDuration(sec: unknown) {
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
export function fmtBytes(n: unknown) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '—';
  const mb = b / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return mb.toFixed(mb >= 100 ? 0 : 1) + ' MB';
}

/** 相对时间。dir='past' → 「12 分钟前」；dir='future' → 「约 12 分钟后」 */
export function fmtRel(ts: unknown, dir?: string) {
  if (!ts) return '';
  const diff =
    dir === 'future'
      ? new Date(ts as string).getTime() - Date.now()
      : Date.now() - new Date(ts as string).getTime();
  const s = Math.abs(Math.round(diff / 1000));
  let txt: string;
  if (s < 60) txt = `${s} 秒`;
  else if (s < 3600) txt = `${Math.round(s / 60)} 分钟`;
  else if (s < 86400) txt = `${Math.round(s / 3600)} 小时`;
  else txt = `${Math.round(s / 86400)} 天`;
  return dir === 'future' ? `约 ${txt}后` : `${txt}前`;
}

/** 完整时间戳 YYYY-MM-DD HH:mm */
export function fmtFull(ts: unknown) {
  if (!ts) return '';
  const d = new Date(ts as string);
  const p = (n: unknown) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const numFmt = new Intl.NumberFormat('zh-CN');
export const fmtNum = (n: unknown) => numFmt.format(Number(n) || 0);

/* ---------- 诊断文本（拼好后贴到 issue / 聊天里） ---------- */
export function buildDiagnostics(d: StatusSnapshot) {
  const app = d.app || {};
  const db = d.db || {};
  const rss = d.rss || {};
  const dg = d.digest || {};
  const f = rss.feeds || {};
  const e = rss.entries || {};
  const mem = app.memory || {};
  const L = [];
  L.push('笺川（FeedLore）诊断信息');
  L.push('生成时间: ' + fmtFull(app.now));
  L.push('');
  L.push('[运行实例]');
  L.push('版本 v' + app.version + ' | Node ' + app.node + ' | PID ' + app.pid);
  L.push('启动于 ' + fmtFull(app.startedAt) + ' | 已运行 ' + fmtDuration(app.uptimeSec));
  L.push('内存 RSS ' + fmtBytes(mem.rss) + ' | 堆 ' + fmtBytes(mem.heapUsed));
  if (app.container) {
    L.push(
      '容器内存 ' +
        fmtBytes(app.container.memoryUsed) +
        (app.container.memoryLimit ? ' / ' + fmtBytes(app.container.memoryLimit) : '（未设上限）') +
        ' | 容器 CPU ' +
        (app.container.cpuPercent == null ? '—' : app.container.cpuPercent + '%'),
    );
  }
  L.push('负载 ' + (app.loadavg || []).join(' / ') + '（' + app.cpuCount + ' 核）');
  L.push('');
  L.push('[数据库]');
  L.push('就绪: ' + (db.ready ? '是' : '否') + (db.error ? ' | 错误: ' + db.error : ''));
  L.push('往返延迟: ' + (db.latencyMs == null ? '—' : db.latencyMs + ' ms'));
  if (db.pool)
    L.push(
      '连接池: ' +
        db.pool.total +
        '/' +
        db.pool.max +
        '（空闲 ' +
        db.pool.idle +
        '，等待 ' +
        db.pool.waiting +
        '）',
    );
  if (db.tables)
    L.push(
      '表行数: feeds ' +
        db.tables.feeds +
        ' | entries ' +
        db.tables.entries +
        ' | digests ' +
        db.tables.digests,
    );
  if (db.sizeBytes) L.push('数据库体积: ' + fmtBytes(db.sizeBytes));
  L.push('');
  L.push('[RSS]');
  L.push(
    '间隔: 全局每 ' +
      rss.refreshMinutes +
      ' 分钟 | 单独设置 ' +
      f.perFeedInterval +
      ' 个' +
      ' | 并发 ' +
      rss.concurrency +
      ' | 超时 ' +
      rss.timeoutSeconds +
      's',
  );
  L.push(
    '保留: 每频道 ' +
      (rss.keepPerFeed > 0 ? rss.keepPerFeed + ' 条' : '无条数上限') +
      ' | ' +
      (rss.keepDays ? '最长 ' + rss.keepDays + ' 天' : '不限时长') +
      ' | 收藏条目不清理',
  );
  L.push(
    '自动停用阈值: 连续失败 ' +
      rss.feedFailLimit +
      ' 次' +
      (f.autoDisabled ? ' | 当前已停用 ' + f.autoDisabled + ' 个' : ''),
  );
  L.push('上次抓取: ' + (rss.lastRefreshAt ? fmtFull(rss.lastRefreshAt) : '无'));
  L.push(
    '下次抓取: ' +
      (rss.nextRefreshAt ? fmtFull(rss.nextRefreshAt) : '—') +
      (rss.dueCount ? ' | 已到期 ' + rss.dueCount + ' 个' : ''),
  );
  if (rss.lastResult) {
    L.push(
      '上次结果: 新增 ' +
        rss.lastResult.added +
        ' | 失败 ' +
        rss.lastResult.failed +
        (rss.lastResult.autoDisabled ? ' | 自动停用 ' + rss.lastResult.autoDisabled : '') +
        ' | 耗时 ' +
        rss.lastResult.durationMs +
        'ms',
    );
  }
  L.push(
    '频道: 共 ' +
      f.total +
      ' | 采集中 ' +
      f.enabled +
      ' | 卡片 ' +
      f.cardEnabled +
      ' | 异常 ' +
      f.error +
      ' | 未抓过 ' +
      f.neverFetched,
  );
  L.push(
    '条目: 共 ' +
      e.total +
      ' | 未读 ' +
      e.unread +
      ' | 收藏 ' +
      e.favorite +
      ' | 近 24h 新增 ' +
      e.added24h,
  );
  L.push(
    '页面自动刷新: ' + (rss.autoRefreshMinutes ? '每 ' + rss.autoRefreshMinutes + ' 分钟' : '关闭'),
  );
  (rss.problems || []).forEach((p) =>
    L.push('  ! ' + p.title + (p.enabled === false ? '（已自动停用）' : '') + ' → ' + p.error),
  );
  L.push('');
  L.push('[日报]');
  L.push(
    '自动生成: ' +
      (dg.autoUsers || 0) +
      ' / ' +
      (dg.totalUsers || 0) +
      ' 个账号（配置跟随账号） | 存档 ' +
      dg.count +
      ' 份',
  );
  if (dg.latest)
    L.push(
      '最近一份: ' + dg.latest.date + ' | ' + (dg.latest.fallback ? '规则降级' : dg.latest.model),
    );
  return L.join('\n');
}
