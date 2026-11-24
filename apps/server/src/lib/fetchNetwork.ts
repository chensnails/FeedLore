import type { ApiErrorCode } from '@feedlore/contract';
import { FETCH_TIMEOUT_MS } from '../env';
import { apiErrorBody } from './apiError';
import { classifyCond, condHost, noteCond } from './feedCond';
import { safeFetch } from './net';
import { type NormalizedItem, normalizeItem, parseFeed } from './rss';

const UA = 'Mozilla/5.0 (compatible; FeedLore/2.8; +RSS reader)';
const MAX_BYTES = 12 * 1024 * 1024;
const RETRY_MAX = 3;
const RETRY_BASE_MS = 800;
const RETRY_FACTOR = 2.4;
const RETRY_EXTRA_MS = 8_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function retryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

class FeedError extends Error {
  readonly code: ApiErrorCode;
  readonly detail?: string;
  status?: number;
  permanent?: boolean;
  constructor(
    code: ApiErrorCode,
    opts: { detail?: string | number; status?: number; permanent?: boolean } = {},
  ) {
    super(apiErrorBody(code, { detail: opts.detail }).message);
    this.code = code;
    this.detail =
      opts.detail === undefined || opts.detail === null ? undefined : String(opts.detail);
    this.status = opts.status;
    this.permanent = opts.permanent;
  }
}

export interface FetchOnce {
  notModified: boolean;
  body?: string;
  etag?: string | null;
  lastModified?: string | null;
  finalUrl?: string;
  status?: number;
}

export async function fetchFeedRaw(
  url: string,
  {
    etag,
    lastModified,
    timeoutMs,
  }: { etag?: string | null; lastModified?: string | null; timeoutMs?: number } = {},
): Promise<FetchOnce> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept:
      'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : FETCH_TIMEOUT_MS;
  const deadline = Date.now() + budget + RETRY_EXTRA_MS;
  const host = condHost(url);
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) throw lastErr ?? new FeedError('E_FETCH_TIMEOUT');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(budget, left));
    try {
      const resp = await safeFetch(url, { headers, signal: ctl.signal });
      if (resp.status === 304) {
        noteCond(host, 'hit');
        return { notModified: true, status: 304, finalUrl: url };
      }

      if (!resp.ok) {
        const status = resp.status;
        throw new FeedError('E_FETCH_HTTP_STATUS', {
          detail: status,
          status,
          permanent: !retryableStatus(status),
        });
      }

      const len = Number(resp.headers.get('content-length') ?? 0);
      if (len && len > MAX_BYTES) throw new FeedError('E_FETCH_TOO_LARGE', { permanent: false });

      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new FeedError('E_FETCH_TOO_LARGE', { permanent: false });

      const ct = resp.headers.get('content-type') ?? '';
      const cs = /charset=([\w-]+)/i.exec(ct)?.[1];
      let body: string;
      if (cs && !/utf-?8/i.test(cs)) {
        try {
          body = new TextDecoder(cs).decode(buf);
        } catch {
          body = buf.toString('utf8');
        }
      } else {
        body = buf.toString('utf8');
      }

      const resEtag = resp.headers.get('etag');
      const resLast = resp.headers.get('last-modified');
      noteCond(
        host,
        classifyCond(
          { etag, lastModified },
          { status: resp.status, etag: resEtag, lastModified: resLast },
        ),
      );
      return {
        notModified: false,
        status: resp.status,
        body,
        etag: resEtag,
        lastModified: resLast,
        finalUrl: resp.url || url,
      };
    } catch (e) {
      lastErr = e;
      if ((e as Error)?.name === 'AbortError') {
        lastErr = new FeedError('E_FETCH_TIMEOUT', { permanent: false });
      }
      const err = lastErr as FeedError;
      if (err?.status !== undefined && err.status >= 400 && err.status < 500) err.permanent = true;

      const permanent = err?.permanent === true;
      const msg = String(err?.message ?? err);
      const maybeTransient =
        err?.permanent === false ||
        err?.code === 'E_FETCH_TIMEOUT' ||
        err?.code === 'E_FETCH_TOO_LARGE' ||
        /ECONN|EAI_|fetch failed|socket hang up|network/i.test(msg);
      if (permanent || attempt >= RETRY_MAX || !maybeTransient) throw lastErr;
      const backoff = Math.round(RETRY_BASE_MS * RETRY_FACTOR ** (attempt - 1));
      if (Date.now() + backoff >= deadline) throw lastErr;
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new FeedError('E_FETCH_FAILED');
}

export interface LoadedFeed {
  notModified: boolean;
  title: string | null;
  siteUrl: string | null;
  description: string | null;
  iconUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  items: NormalizedItem[];
}

export async function loadFeed(
  url: string,
  cond: { etag?: string | null; lastModified?: string | null; timeoutMs?: number } = {},
): Promise<LoadedFeed> {
  const res = await fetchFeedRaw(url, cond);
  if (res.notModified) {
    return {
      notModified: true,
      title: null,
      siteUrl: null,
      description: null,
      iconUrl: null,
      etag: cond.etag ?? null,
      lastModified: cond.lastModified ?? null,
      items: [],
    };
  }
  const parsed = parseFeed(res.body ?? '');
  if (!parsed.items.length && !parsed.title) {
    throw new FeedError('E_FETCH_NOT_FEED', { permanent: true });
  }
  return {
    notModified: false,
    title: parsed.title || null,
    siteUrl: parsed.siteUrl || null,
    description: parsed.description || null,
    iconUrl: parsed.iconUrl || null,
    etag: res.etag ?? null,
    lastModified: res.lastModified ?? null,
    items: parsed.items.map((it) => normalizeItem(it, parsed.title, { siteUrl: parsed.siteUrl })),
  };
}
