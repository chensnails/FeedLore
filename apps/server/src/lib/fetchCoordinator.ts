import type { Db } from '@feedlore/db';
import { Client } from 'pg';
import { log } from './logger';

const LOCK_PREFIX = 'feedlore.fetch.';
export const RSS_SCHEDULER_LOCK_KEY = '__scheduler__';

export type FetchLockClaim<T> = { acquired: true; value: T } | { acquired: false };

const clients = new WeakMap<Db, Promise<Client>>();
const localKeys = new WeakMap<Db, Set<string>>();

function keysFor(db: Db): Set<string> {
  let keys = localKeys.get(db);
  if (!keys) {
    keys = new Set();
    localKeys.set(db, keys);
  }
  return keys;
}

async function clientFor(db: Db): Promise<Client> {
  const existing = clients.get(db);
  if (existing) return existing;

  const connectionString = db.$client.options.connectionString;
  if (!connectionString) throw new Error('Fetch coordinator requires a database connection string');

  // 独立连接：锁要跨整个回源过程，不能占用业务池连接，否则高并发时会互相等死。
  const pending = (async () => {
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 8_000,
      statement_timeout: db.$client.options.statement_timeout,
      application_name: 'feedlore-fetch-lock',
    });
    await client.connect();
    client.on('error', () => {
      if (clients.get(db) === pending) clients.delete(db);
    });
    return client;
  })();
  clients.set(db, pending);
  pending.catch(() => {
    if (clients.get(db) === pending) clients.delete(db);
  });
  return pending;
}

export async function tryFetchLock<T>(
  db: Db,
  key: string,
  run: () => Promise<T>,
): Promise<FetchLockClaim<T>> {
  const keys = keysFor(db);
  if (keys.has(key)) return { acquired: false };
  keys.add(key);

  const lockKey = LOCK_PREFIX + key;
  let client: Client;
  try {
    client = await clientFor(db);
    const result = await client.query(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
      [lockKey],
    );
    if (!result.rows[0]?.locked) {
      keys.delete(key);
      return { acquired: false };
    }
  } catch (e) {
    keys.delete(key);
    throw e;
  }

  try {
    return { acquired: true, value: await run() };
  } finally {
    try {
      await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
    } catch (e) {
      // 连接已坏时 PG 会自动释放 session lock；丢弃坏连接，下次重新握手。
      clients.delete(db);
      log.warn('[fetch] failed to release advisory lock:', (e as Error)?.message ?? e);
      void client.end().catch(() => {});
    } finally {
      keys.delete(key);
    }
  }
}

export async function closeFetchCoordinator(db: Db): Promise<void> {
  const pending = clients.get(db);
  clients.delete(db);
  localKeys.delete(db);
  if (!pending) return;
  try {
    const client = await pending;
    await client.end();
  } catch {
    /* 连接失败时没有需要关闭的资源 */
  }
}
