/**
 * 账号导入 / 整站还原的落库逻辑（与 `exportData.ts` 对称）。
 *
 * 两种导入的语义完全不同，不能共用一条路：
 * - 账号导入是**合并**：按频道 URL、文章 (feed, guid)、日报 (owner, date) 去重，
 *   只补库里没有的行。已存在的文章**不改**已读 / 收藏 / 关注（用户在界面上选的
 *   「保留现状」）；偏好只在该账号还是空偏好时套用。可以重复执行，不会越导越乱。
 * - 整站还原是**替换**：管理员上传整站备份，事务内清空业务表再按原 id 写回，
 *   并清掉登录会话（备份本来就不含）与短信验证记录。任何一步失败整笔回滚。
 *
 * 两个入口都默认包是「我们自己导出的」但**不信任包内容**：字段逐个收窄、时间统一
 * 转 Date、非法行直接判定整包无效，避免把脏数据写进库后再由页面炸出来。
 */

import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { sql } from 'drizzle-orm';
import {
  accounts,
  articleCache,
  digests,
  entries,
  feeds,
  imageCache,
  settings,
  userLlm,
  users,
  type Db,
  type NewEntry,
  type NewFeed,
} from '@feedlore/db';
import { ApiException } from './apiError';

const FORMAT = 'feedlore-backup';
const FORMAT_VERSION = 1;
const ENTRY_BATCH = 200;
const IMAGE_BATCH = 10;

export interface ImportCount {
  inserted: number;
  skipped: number;
}

export interface UserImportResult {
  ok: true;
  kind: 'user';
  feeds: ImportCount;
  entries: ImportCount;
  digests: ImportCount;
  prefs: boolean;
}

export interface SiteRestoreResult {
  ok: true;
  kind: 'site';
  counts: {
    users: number;
    accounts: number;
    feeds: number;
    entries: number;
    digests: number;
    images: number;
    articles: number;
  };
}

type Raw = Record<string, unknown>;

const invalid = (message: string): ApiException =>
  new ApiException('E_IMPORT_INVALID', { message: `Invalid export archive: ${message}` });

const asRecord = (v: unknown): Raw | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arrStr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const intOr = (v: unknown, fallback: number): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : fallback;
};
const intOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : null;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const boolOr = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;
const dateOrNull = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
const dateOr = (v: unknown, fallback: Date): Date => dateOrNull(v) ?? fallback;
const isHttpUrl = (v: string): boolean => {
  if (!v || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

async function readManifest(dir: string): Promise<Raw> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'manifest.json'), 'utf8');
  } catch {
    throw invalid('manifest.json is missing');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid('manifest.json is not valid JSON');
  }
  const obj = asRecord(parsed);
  if (!obj) throw invalid('manifest.json must be an object');
  if (obj.format !== FORMAT) throw invalid('unknown archive format');
  if (obj.formatVersion !== FORMAT_VERSION) {
    throw invalid(`unsupported formatVersion ${String(obj.formatVersion)}`);
  }
  return obj;
}

async function readJson(dir: string, name: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(join(dir, name), 'utf8');
  } catch {
    throw invalid(`${name} is missing`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw invalid(`${name} is not valid JSON`);
  }
}

async function readOptionalJson(dir: string, name: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(join(dir, name), 'utf8');
  } catch {
    return null; // 文件不存在 = 可选文件没导出
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw invalid(`${name} is not valid JSON`);
  }
}

function asArray(v: unknown, name: string): Raw[] {
  if (!Array.isArray(v)) throw invalid(`${name} must be an array`);
  return v.map((row, i) => {
    const r = asRecord(row);
    if (!r) throw invalid(`${name}[${i}] is not an object`);
    return r;
  });
}

async function listBatches(dir: string, pattern: RegExp): Promise<string[]> {
  const names = await readdir(dir, { withFileTypes: true });
  return names
    .filter((n) => n.isFile() && pattern.test(n.name))
    .map((n) => n.name)
    .sort();
}

async function* jsonlRows(dir: string, name: string): AsyncGenerator<Raw> {
  const rl = createInterface({
    input: createReadStream(join(dir, name), { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid(`bad JSON line in ${name}`);
    }
    const row = asRecord(parsed);
    if (!row) throw invalid(`bad record in ${name}`);
    yield row;
  }
}

/* ============================================================================
 * 账号导入（合并）
 * ==========================================================================*/

/** 频道配置原样带回，但抓取状态（etag / 失败计数等）必须重置，否则新站点会顶着旧游标抓不到东西。 */
function mapUserFeed(raw: Raw, ownerId: string): NewFeed | null {
  const url = str(raw.url);
  if (!isHttpUrl(url)) return null;
  const now = new Date();
  return {
    ownerId,
    url,
    title: strOrNull(raw.title),
    siteUrl: strOrNull(raw.siteUrl),
    description: strOrNull(raw.description),
    iconUrl: strOrNull(raw.iconUrl),
    enabled: boolOr(raw.enabled, true),
    cardEnabled: boolOr(raw.cardEnabled, true),
    groupName: strOrNull(raw.groupName),
    customTitle: strOrNull(raw.customTitle),
    sortOrder: intOr(raw.sortOrder, 0),
    refreshMinutes: intOrNull(raw.refreshMinutes),
    fullText: boolOr(raw.fullText, false),
    createdAt: dateOr(raw.createdAt, now),
    updatedAt: dateOr(raw.updatedAt, now),
  };
}

function mapUserEntry(raw: Raw, feedId: number): NewEntry | null {
  const guid = str(raw.guid);
  const title = str(raw.title);
  if (!guid || !title) return null;
  return {
    feedId,
    guid,
    title,
    link: strOrNull(raw.link),
    pwd: strOrNull(raw.pwd),
    description: strOrNull(raw.description),
    content: strOrNull(raw.content),
    size: strOrNull(raw.size),
    tags: arrStr(raw.tags),
    image: strOrNull(raw.image),
    images: Array.isArray(raw.images) ? arrStr(raw.images) : null,
    sourceUrl: strOrNull(raw.sourceUrl),
    publishedAt: dateOrNull(raw.publishedAt),
    fetchedAt: dateOr(raw.fetchedAt, new Date()),
    isRead: raw.isRead === true,
    readAt: dateOrNull(raw.readAt),
    isFavorite: raw.isFavorite === true,
    favoritedAt: dateOrNull(raw.favoritedAt),
    bodyJson: strOrNull(raw.bodyJson),
    bodyVersion: intOr(raw.bodyVersion, 1),
    links: Array.isArray(raw.links) ? arrStr(raw.links) : null,
    watchState:
      raw.watchState === 'watch' || raw.watchState === 'block' ? raw.watchState : null,
    watchRule: strOrNull(raw.watchRule),
    watchTaggedAt: dateOrNull(raw.watchTaggedAt),
  };
}

export async function importUserArchive(
  db: Db,
  userId: string,
  dir: string,
): Promise<UserImportResult> {
  const manifest = await readManifest(dir);
  if (manifest.kind === 'site') throw new ApiException('E_ARCHIVE_IS_SITE_BACKUP');
  if (manifest.kind !== 'user') throw invalid(`unknown archive kind "${String(manifest.kind)}"`);

  const feedRows = asArray(await readJson(dir, 'feeds.json'), 'feeds.json');
  const digestRows = asArray(await readJson(dir, 'digests.json'), 'digests.json');
  const prefsRaw = asRecord(await readOptionalJson(dir, 'prefs.json'));
  const entryFiles = await listBatches(dir, /^entries-\d{4}\.jsonl$/);

  const feedCount: ImportCount = { inserted: 0, skipped: 0 };
  const entryCount: ImportCount = { inserted: 0, skipped: 0 };
  const digestCount: ImportCount = { inserted: 0, skipped: 0 };
  let prefsImported = false;

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: feeds.id, url: feeds.url })
      .from(feeds)
      .where(sql`${feeds.ownerId} = ${userId}`);
    const byUrl = new Map(existing.map((f) => [f.url, f.id]));

    for (const raw of feedRows) {
      const row = mapUserFeed(raw, userId);
      if (!row) {
        feedCount.skipped += 1;
        continue;
      }
      if (byUrl.has(row.url)) {
        feedCount.skipped += 1;
        continue;
      }
      const inserted = await tx
        .insert(feeds)
        .values(row)
        .onConflictDoNothing({ target: [feeds.ownerId, feeds.url] })
        .returning({ id: feeds.id });
      const id = inserted[0]?.id;
      if (id === undefined) {
        feedCount.skipped += 1;
      } else {
        byUrl.set(row.url, id);
        feedCount.inserted += 1;
      }
    }

    let batch: NewEntry[] = [];
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const inserted = await tx
        .insert(entries)
        .values(batch)
        .onConflictDoNothing()
        .returning({ id: entries.id });
      entryCount.inserted += inserted.length;
      entryCount.skipped += batch.length - inserted.length;
      batch = [];
    };

    for (const name of entryFiles) {
      for await (const raw of jsonlRows(dir, name)) {
        const feedId = byUrl.get(str(raw.feedUrl));
        if (feedId === undefined) {
          entryCount.skipped += 1;
          continue;
        }
        const row = mapUserEntry(raw, feedId);
        if (!row) {
          entryCount.skipped += 1;
          continue;
        }
        batch.push(row);
        if (batch.length >= ENTRY_BATCH) await flush();
      }
    }
    await flush();

    for (const raw of digestRows) {
      const date = str(raw.date);
      const payload = raw.payload;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || payload === undefined || payload === null) {
        digestCount.skipped += 1;
        continue;
      }
      const inserted = await tx
        .insert(digests)
        .values({
          ownerId: userId,
          date,
          payload: payload as Record<string, unknown>,
          model: strOrNull(raw.model),
          fallback: boolOr(raw.fallback, false),
          createdAt: dateOr(raw.createdAt, new Date()),
        })
        .onConflictDoNothing({ target: [digests.ownerId, digests.date] })
        .returning({ date: digests.date });
      if (inserted.length) digestCount.inserted += 1;
      else digestCount.skipped += 1;
    }

    if (prefsRaw && Object.keys(prefsRaw).length) {
      const [me] = await tx
        .select({ prefs: users.prefs })
        .from(users)
        .where(sql`${users.id} = ${userId}`)
        .limit(1);
      const current = me?.prefs ?? {};
      if (Object.keys(current).length === 0) {
        await tx
          .update(users)
          .set({ prefs: prefsRaw, updatedAt: new Date() })
          .where(sql`${users.id} = ${userId}`);
        prefsImported = true;
      }
    }
  });

  return {
    ok: true,
    kind: 'user',
    feeds: feedCount,
    entries: entryCount,
    digests: digestCount,
    prefs: prefsImported,
  };
}

/* ============================================================================
 * 整站还原（替换）
 * ==========================================================================*/

function mapSiteFeed(raw: Raw): NewFeed {
  const id = intOrNull(raw.id);
  const ownerId = str(raw.ownerId);
  const url = str(raw.url);
  if (id === null || !ownerId || !isHttpUrl(url)) throw invalid('bad feeds.json record');
  const now = new Date();
  return {
    id,
    ownerId,
    url,
    title: strOrNull(raw.title),
    siteUrl: strOrNull(raw.siteUrl),
    description: strOrNull(raw.description),
    iconUrl: strOrNull(raw.iconUrl),
    enabled: boolOr(raw.enabled, true),
    cardEnabled: boolOr(raw.cardEnabled, true),
    groupName: strOrNull(raw.groupName),
    customTitle: strOrNull(raw.customTitle),
    sortOrder: intOr(raw.sortOrder, 0),
    refreshMinutes: intOrNull(raw.refreshMinutes),
    fullText: boolOr(raw.fullText, false),
    etag: strOrNull(raw.etag),
    lastModified: strOrNull(raw.lastModified),
    lastStatus: strOrNull(raw.lastStatus),
    lastError: strOrNull(raw.lastError),
    failStreak: intOr(raw.failStreak, 0),
    lastFetchedAt: dateOrNull(raw.lastFetchedAt),
    createdAt: dateOr(raw.createdAt, now),
    updatedAt: dateOr(raw.updatedAt, now),
  };
}

function mapSiteEntry(raw: Raw): NewEntry {
  const id = intOrNull(raw.id);
  const feedId = intOrNull(raw.feedId);
  const guid = str(raw.guid);
  const title = str(raw.title);
  if (id === null || feedId === null || !guid || !title) throw invalid('bad entry record');
  return { ...mapUserEntry(raw, feedId)!, id };
}

async function insertEntries(tx: Db, dir: string, files: string[]): Promise<number> {
  let total = 0;
  let batch: NewEntry[] = [];
  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    await tx.insert(entries).values(batch);
    total += batch.length;
    batch = [];
  };
  for (const name of files) {
    for await (const raw of jsonlRows(dir, name)) {
      batch.push(mapSiteEntry(raw));
      if (batch.length >= ENTRY_BATCH) await flush();
    }
  }
  await flush();
  return total;
}

async function insertArticles(tx: Db, dir: string, files: string[]): Promise<number> {
  let total = 0;
  let batch: Array<typeof articleCache.$inferInsert> = [];
  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    await tx.insert(articleCache).values(batch);
    total += batch.length;
    batch = [];
  };
  for (const name of files) {
    for await (const raw of jsonlRows(dir, name)) {
      const url = str(raw.url);
      if (!url) throw invalid(`bad article record in ${basename(name)}`);
      batch.push({
        url,
        content: strOrNull(raw.content),
        bodyJson: strOrNull(raw.bodyJson),
        images: arrStr(raw.images),
        fetchedAt: dateOr(raw.fetchedAt, new Date()),
      });
      if (batch.length >= 50) await flush();
    }
  }
  await flush();
  return total;
}

async function insertImages(tx: Db, dir: string, metaRows: Raw[]): Promise<number> {
  const meta = new Map<string, Raw>();
  for (const raw of metaRows) {
    const key = str(raw.key);
    if (!key) throw invalid('bad image_cache.json record');
    meta.set(key, raw);
  }
  let files: string[];
  try {
    files = (await readdir(join(dir, 'images'), { withFileTypes: true }))
      .filter((n) => n.isFile())
      .map((n) => n.name)
      .sort();
  } catch {
    files = [];
  }
  const seen = new Set<string>();
  let total = 0;
  let batch: Array<typeof imageCache.$inferInsert> = [];

  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    await tx.insert(imageCache).values(batch);
    total += batch.length;
    batch = [];
  };

  for (const name of files) {
    const key = name;
    const info = meta.get(key);
    if (!info) continue;
    const data = await readFile(join(dir, 'images', name));
    seen.add(key);
    batch.push({
      key,
      contentType: str(info.contentType) || 'application/octet-stream',
      data,
      width: intOrNull(info.width),
      height: intOrNull(info.height),
      origSize: intOrNull(info.origSize),
      size: intOr(info.size, data.length),
      createdAt: dateOr(info.createdAt, new Date()),
    });
    if (batch.length >= IMAGE_BATCH) await flush();
  }
  await flush();

  for (const key of meta.keys()) {
    if (!seen.has(key)) throw invalid(`image file is missing for key "${key}"`);
  }
  return total;
}

export async function restoreSiteArchive(db: Db, dir: string): Promise<SiteRestoreResult> {
  const manifest = await readManifest(dir);
  if (manifest.kind === 'user') throw new ApiException('E_ARCHIVE_IS_USER_EXPORT');
  if (manifest.kind !== 'site') throw invalid(`unknown archive kind "${String(manifest.kind)}"`);

  const userRows = asArray(await readJson(dir, 'users.json'), 'users.json');
  const accountRows = asArray(await readJson(dir, 'accounts.json'), 'accounts.json');
  const feedRows = asArray(await readJson(dir, 'feeds.json'), 'feeds.json');
  const digestRows = asArray(await readJson(dir, 'digests.json'), 'digests.json');
  const llmRows = asArray(await readJson(dir, 'user_llm.json'), 'user_llm.json');
  const settingRows = asArray(await readJson(dir, 'settings.json'), 'settings.json');
  const imageRows = asArray(await readJson(dir, 'image_cache.json'), 'image_cache.json');
  const entryFiles = await listBatches(dir, /^entries-\d{4}\.jsonl$/);
  const articleFiles = await listBatches(dir, /^article_cache-\d{4}\.jsonl$/);

  if (!userRows.length) throw invalid('backup contains no users');

  const counts = await db.transaction(async (tx) => {
    await tx.execute(sql`
      truncate table users, sessions, accounts, verifications, feeds, entries,
        digests, user_llm, settings, image_cache, article_cache
      restart identity cascade
    `);

    const mappedUsers = userRows.map((raw) => {
      const id = str(raw.id);
      const email = str(raw.email);
      if (!id || !email) throw invalid('bad users.json record');
      const now = new Date();
      return {
        id,
        name: strOrNull(raw.name),
        username: strOrNull(raw.username),
        displayUsername: strOrNull(raw.displayUsername),
        email,
        emailVerified: boolOr(raw.emailVerified, false),
        image: strOrNull(raw.image),
        role: str(raw.role) || 'user',
        banned: boolOr(raw.banned, false),
        banReason: strOrNull(raw.banReason),
        banExpires: dateOrNull(raw.banExpires),
        prefs: asRecord(raw.prefs) ?? {},
        createdAt: dateOr(raw.createdAt, now),
        updatedAt: dateOr(raw.updatedAt, now),
      };
    });
    await tx.insert(users).values(mappedUsers);

    const mappedAccounts = accountRows.map((raw) => {
      const id = str(raw.id);
      const userId = str(raw.userId);
      const accountId = str(raw.accountId);
      const providerId = str(raw.providerId);
      if (!id || !userId || !accountId || !providerId) throw invalid('bad accounts.json record');
      const now = new Date();
      return {
        id,
        userId,
        accountId,
        providerId,
        accessToken: strOrNull(raw.accessToken),
        refreshToken: strOrNull(raw.refreshToken),
        idToken: strOrNull(raw.idToken),
        accessTokenExpiresAt: dateOrNull(raw.accessTokenExpiresAt),
        refreshTokenExpiresAt: dateOrNull(raw.refreshTokenExpiresAt),
        scope: strOrNull(raw.scope),
        password: strOrNull(raw.password),
        createdAt: dateOr(raw.createdAt, now),
        updatedAt: dateOr(raw.updatedAt, now),
      };
    });
    if (mappedAccounts.length) await tx.insert(accounts).values(mappedAccounts);

    const mappedFeeds = feedRows.map(mapSiteFeed);
    if (mappedFeeds.length) await tx.insert(feeds).values(mappedFeeds);

    const mappedDigests = digestRows.map((raw) => {
      const ownerId = str(raw.ownerId);
      const date = str(raw.date);
      if (!ownerId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || raw.payload == null) {
        throw invalid('bad digests.json record');
      }
      return {
        ownerId,
        date,
        payload: raw.payload as Record<string, unknown>,
        model: strOrNull(raw.model),
        fallback: boolOr(raw.fallback, false),
        createdAt: dateOr(raw.createdAt, new Date()),
      };
    });
    if (mappedDigests.length) await tx.insert(digests).values(mappedDigests);

    const mappedLlm = llmRows.map((raw) => {
      const userId = str(raw.userId);
      if (!userId) throw invalid('bad user_llm.json record');
      return {
        userId,
        encryptedKey: strOrNull(raw.encryptedKey),
        baseUrl: strOrNull(raw.baseUrl),
        model: strOrNull(raw.model),
        temperature: numOrNull(raw.temperature),
        thinking: boolOr(raw.thinking, false),
        thinkingDepth: intOr(raw.thinkingDepth, 0),
        updatedAt: dateOr(raw.updatedAt, new Date()),
      };
    });
    if (mappedLlm.length) await tx.insert(userLlm).values(mappedLlm);

    const mappedSettings = settingRows.map((raw) => {
      const key = str(raw.key);
      if (!key) throw invalid('bad settings.json record');
      return {
        key,
        value: raw.value as Record<string, unknown>,
        updatedAt: dateOr(raw.updatedAt, new Date()),
      };
    });
    if (mappedSettings.length) await tx.insert(settings).values(mappedSettings);

    const entryCount = await insertEntries(tx as unknown as Db, dir, entryFiles);
    const articleCount = await insertArticles(tx as unknown as Db, dir, articleFiles);
    const imageCount = await insertImages(tx as unknown as Db, dir, imageRows);

    /* bigserial 的序列被 truncate restart identity 归零，而上面是按原 id 显式插入的；
     * 不 setval 的话，下一条自动插入会从 1 开始撞主键。 */
    await tx.execute(sql`
      select setval(
        pg_get_serial_sequence('feeds', 'id'),
        coalesce((select max(id) from feeds), 1),
        (select max(id) from feeds) is not null
      )
    `);
    await tx.execute(sql`
      select setval(
        pg_get_serial_sequence('entries', 'id'),
        coalesce((select max(id) from entries), 1),
        (select max(id) from entries) is not null
      )
    `);

    return {
      users: mappedUsers.length,
      accounts: mappedAccounts.length,
      feeds: mappedFeeds.length,
      entries: entryCount,
      digests: mappedDigests.length,
      images: imageCount,
      articles: articleCount,
    };
  });

  return { ok: true, kind: 'site', counts };
}
