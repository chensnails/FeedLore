export type SchedulerOutcome = 'success' | 'failure';

export interface SchedulerMetricSnapshot {
  runs: number;
  succeeded: number;
  failed: number;
  skipped: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  maxDurationMs: number;
  backlog: number | null;
}

export interface SchedulerMetrics {
  start(): number;
  finish(startedAt: number, outcome: SchedulerOutcome, backlog?: number | null): void;
  skipped(): void;
  snapshot(): SchedulerMetricSnapshot;
}

export function createSchedulerMetrics(): SchedulerMetrics {
  let runs = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let lastStartedAt: number | null = null;
  let lastFinishedAt: number | null = null;
  let lastDurationMs: number | null = null;
  let maxDurationMs = 0;
  let backlog: number | null = null;

  return {
    start() {
      const now = Date.now();
      lastStartedAt = now;
      return now;
    },
    finish(startedAt, outcome, nextBacklog = null) {
      const now = Date.now();
      const durationMs = Math.max(0, now - startedAt);
      runs += 1;
      if (outcome === 'success') succeeded += 1;
      else failed += 1;
      lastFinishedAt = now;
      lastDurationMs = durationMs;
      maxDurationMs = Math.max(maxDurationMs, durationMs);
      backlog = nextBacklog;
    },
    skipped() {
      skipped += 1;
    },
    snapshot() {
      return {
        runs,
        succeeded,
        failed,
        skipped,
        lastStartedAt: lastStartedAt === null ? null : new Date(lastStartedAt).toISOString(),
        lastFinishedAt: lastFinishedAt === null ? null : new Date(lastFinishedAt).toISOString(),
        lastDurationMs,
        maxDurationMs,
        backlog,
      };
    },
  };
}
