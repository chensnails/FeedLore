/* 状态面板的数据视图类型：从 StatusPane.tsx 抽出，逐字等价。 */

/** /api/status 快照中本面板用到的字段（服务端 schema 的子集）。 */
export interface StatusSnapshot {
  app: {
    version: string;
    node: string;
    pid: number;
    uptimeSec: number;
    startedAt: string | null;
    now: string | null;
    memory: { rss: number; heapUsed: number };
    container: {
      memoryUsed: number | null;
      memoryLimit: number | null;
      cpuPercent: number | null;
    } | null;
    loadavg: number[];
    cpuCount: number;
  };
  db: {
    ready: boolean;
    error: string | null;
    latencyMs: number | null;
    pool: { total: number; idle: number; waiting: number; max: number } | null;
    tables: { feeds: number; entries: number; digests: number } | null;
    sizeBytes: number | null;
  };
  rss: {
    refreshMinutes: number;
    keepPerFeed: number;
    keepDays: number;
    concurrency: number;
    timeoutSeconds: number;
    feedFailLimit: number;
    lastRefreshAt: string | null;
    nextRefreshAt: string | null;
    dueCount: number;
    refreshing: number | null;
    autoRefreshMinutes: number;
    lastResult: {
      added: number;
      pruned: number;
      skipped: number;
      failed: number;
      autoDisabled: number;
      durationMs: number;
    } | null;
    feeds: {
      total: number;
      enabled: number;
      cardEnabled: number;
      error: number;
      neverFetched: number;
      perFeedInterval: number;
      autoDisabled: number;
    };
    entries: {
      total: number;
      unread: number;
      favorite: number;
      added24h: number;
      oldest: string | null;
      newest: string | null;
    };
    problems: {
      feedId: string;
      title: string;
      error: string;
      enabled: boolean;
    }[];
  };
  digest: {
    autoUsers: number;
    totalUsers: number;
    count: number;
    nextRunAt: string | null;
    oldestDate: string | null;
    latest: {
      date: string;
      model: string;
      fallback: boolean;
      error: string | null;
      stats: { collected: number; kept: number; feeds: number } | null;
    } | null;
  };
}
export interface StatusError {
  __error: string;
}
export type StatusView = StatusSnapshot | StatusError;
