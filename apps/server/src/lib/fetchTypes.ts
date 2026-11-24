import type { feeds } from '@feedlore/db';

export type FeedRow = typeof feeds.$inferSelect;

export interface GroupResult {
  url: string;
  notModified?: boolean;
  added: number;
  total?: number;
  filtered?: number;
  error?: string | null;
  autoDisabled?: number;
  feeds: number;
  skipped?: 'too-recent' | 'in-flight';
}

export interface RefreshSummary {
  at: Date;
  added: number;
  failed: Array<{ url: string; error: string }>;
  skipped: number;
  autoDisabled: number;
  filtered: number;
  pruned: number;
  results: GroupResult[];
}
