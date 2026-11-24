import { createSchedulerMetrics } from './metrics';

let lastRefreshAt: Date | null = null;
let lastRun: LastRunStat | null = null;
let currentRun: { label: string; total: number; done: number; startedAt: number } | null = null;
let activeFlights = 0;

export interface LastRunStat {
  at: Date;
  added: number;
  pruned: number;
  skipped: number;
  failed: number;
  autoDisabled: number;
  filtered: number;
  durationMs: number;
}

export interface RefreshProgress {
  running: boolean;
  label: string;
  total: number;
  done: number;
  startedAt: string | null;
}

export const getLastRefreshAt = (): Date | null => lastRefreshAt;
export const getLastRun = (): LastRunStat | null => lastRun;
export const inFlightCount = (): number => activeFlights;
export const rssSchedulerMetrics = createSchedulerMetrics();

export function beginRefreshRun(label: string, total: number, startedAt: number): void {
  currentRun = { label, total, done: 0, startedAt };
}

export function advanceRefreshRun(): void {
  if (currentRun) currentRun.done += 1;
}

export function endRefreshRun(): void {
  currentRun = null;
}

export function recordRefreshRun(stat: LastRunStat): Date {
  lastRefreshAt = stat.at;
  lastRun = stat;
  return stat.at;
}

export function flightStarted(): void {
  activeFlights += 1;
}

export function flightFinished(): void {
  activeFlights -= 1;
}

export function getRefreshProgress(): RefreshProgress {
  if (!currentRun) return { running: false, label: '', total: 0, done: 0, startedAt: null };
  return {
    running: true,
    label: currentRun.label,
    total: currentRun.total,
    done: currentRun.done,
    startedAt: new Date(currentRun.startedAt).toISOString(),
  };
}
