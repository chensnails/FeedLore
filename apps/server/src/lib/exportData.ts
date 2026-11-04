/**
 * 数据导出 / 整站备份的取数逻辑。
 *
 * 两种包共用同一套约定：
 * - `manifest.json` 放格式版本、时间、条数与「包里有什么、没有什么」；
 * - 大表一律 **keyset 分页**写成 `xxx-0001.jsonl` 批次，每行一条记录。这样内存
 *   占用只跟一批的大小有关，不会因为一个账号攒了几万篇文章而把进程撑爆；
 * - `sessions` / `verifications` 永远不导出（会话令牌就是登录凭据）；
 * - 时间字段交给 JSON.stringify 序列化成 ISO 8601。
 *
 * 账号导出（kind=user）只含本人数据与偏好，供换机或长期留存；
 * 整站备份（kind=site）额外含 users/accounts（密码哈希）、settings 与图片缓存，
 * 是管理员级、需要妥善保管的敏感文件，恢复也由运维手工完成。
 */

import { and, asc, eq, gt, sql } from 'drizzle-orm';
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
} from '@feedlore/db';
import { getCryptoSecret, resolveUserLlm } from '@feedlore/ai';
import { APP_VERSION } from '../env';
import type { TarGzArchive } from './tar';

const FORMAT = 'feedlore-backup';
const FORMAT_VERSION = 1;
const ENTRY_BATCH = 100;
const ARTICLE_BATCH = 50;
const IMAGE_BATCH = 10;

const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';
const jsonl = (rows: unknown[]): string =>
  rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
const isoNow = (): string => new Date().toISOString();

async function countOf(q: Promise<Array<{ n: number }>>): Promise<number> {
  return Number((await q)[0]?.n ?? 0);
}

export interface UserExportInput {
  db: Db;
  userId: string;
  username: string;
  includeLlm: boolean;
}

/**
 * 写一份账号导出包（manifest / feeds / entries-*.jsonl / digests / prefs / llm）。
 * 返回实际写出的条目数，供调用方决定是否打印日志。
 */
export async function writeUserExport(ar: TarGzArchive, input: UserExportInput): Promise<void> {
  const { db, userId, username, includeLlm } = input;

  const feedRows = await db
    .select()
    .from(feeds)
    .where(eq(feeds.ownerId, userId))
    .orderBy(asc(feeds.sortOrder), asc(feeds.id));
  const feedUrl = new Map(feedRows.map((f) => [f.id, f.url]));

  const entryWhere = eq(feeds.ownerId, userId);
  const counts = {
    feeds: feedRows.length,
    entries: await countOf(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(entries)
        .innerJoin(feeds, eq(feeds.id, entries.feedId))
        .where(entryWhere),
    ),
    digests: await countOf(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(digests)
        .where(eq(digests.ownerId, userId)),
    ),
  };

  await ar.add('manifest.json', json({
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    kind: 'user',
    appVersion: APP_VERSION,
    createdAt: isoNow(),
    username,
    counts,
    includes: { llm: includeLlm, feeds: true, entries: true, digests: true, prefs: true },
    notes: [
      'entries-*.jsonl 每行一篇文章，feedUrl 对应 feeds.json 里的订阅地址。',
      '不含登录会话、图片缓存与全文抓取缓存；模型配置默认不含，导出时勾选才会写入 llm.json。',
      '已读 / 收藏 / 关注标记都在每行文章记录里，换机后可按需要恢复。',
    ],
  }));

  await ar.add('feeds.json', json(feedRows));

  let cursor = 0;
  let batch = 0;
  for (;;) {
    const rows = await db
      .select({
        feedId: entries.feedId,
        guid: entries.guid,
        title: entries.title,
        link: entries.link,
        pwd: entries.pwd,
        description: entries.description,
        content: entries.content,
        size: entries.size,
        tags: entries.tags,
        image: entries.image,
        images: entries.images,
        sourceUrl: entries.sourceUrl,
        publishedAt: entries.publishedAt,
        fetchedAt: entries.fetchedAt,
        isRead: entries.isRead,
        readAt: entries.readAt,
        isFavorite: entries.isFavorite,
        favoritedAt: entries.favoritedAt,
        bodyJson: entries.bodyJson,
        bodyVersion: entries.bodyVersion,
        links: entries.links,
        watchState: entries.watchState,
        watchRule: entries.watchRule,
        watchTaggedAt: entries.watchTaggedAt,
        id: entries.id,
      })
      .from(entries)
      .innerJoin(feeds, eq(feeds.id, entries.feedId))
      .where(and(entryWhere, gt(entries.id, cursor)))
      .orderBy(asc(entries.id))
      .limit(ENTRY_BATCH);
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.id;
    batch += 1;
    const lines = rows.map(({ feedId, id: _id, ...rest }) => ({
      feedUrl: feedUrl.get(feedId) ?? null,
      ...rest,
    }));
    await ar.add(`entries-${String(batch).padStart(4, '0')}.jsonl`, jsonl(lines));
  }

  const digestRows = await db
    .select()
    .from(digests)
    .where(eq(digests.ownerId, userId))
    .orderBy(asc(digests.date));
  await ar.add('digests.json', json(digestRows));

  const [me] = await db
    .select({ prefs: users.prefs })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  await ar.add('prefs.json', json(me?.prefs ?? {}));

  if (includeLlm) {
    const [row] = await db
      .select({
        encryptedKey: userLlm.encryptedKey,
        baseUrl: userLlm.baseUrl,
        model: userLlm.model,
        temperature: userLlm.temperature,
        thinking: userLlm.thinking,
        thinkingDepth: userLlm.thinkingDepth,
      })
      .from(userLlm)
      .where(eq(userLlm.userId, userId))
      .limit(1);
    let payload: Record<string, unknown> | null = null;
    if (row) {
      const llm = resolveUserLlm(row, await getCryptoSecret(db));
      payload = {
        baseUrl: llm.baseUrl,
        model: llm.model,
        temperature: llm.temperature,
        thinking: llm.thinking,
        thinkingDepth: llm.thinkingDepth,
        // 勾选导出才解密；文件落到本机后请自行保管
        apiKey: llm.apiKey,
      };
    }
    await ar.add('llm.json', json(payload));
  }
}

/**
 * 写一份整站备份包（管理员）。含账号密码哈希、加密后的模型 Key 与站点设置，
 * 调用方必须在响应头与界面文案里提示这是敏感文件。
 */
export async function writeSiteExport(ar: TarGzArchive, db: Db): Promise<void> {
  const userRows = await db.select().from(users);
  const accountRows = await db.select().from(accounts);
  const feedRows = await db.select().from(feeds);
  const digestRows = await db.select().from(digests).orderBy(asc(digests.ownerId), asc(digests.date));
  const llmRows = await db.select().from(userLlm);
  const settingRows = await db.select().from(settings).orderBy(asc(settings.key));

  const counts = {
    users: userRows.length,
    feeds: feedRows.length,
    entries: await countOf(db.select({ n: sql<number>`count(*)::int` }).from(entries)),
    digests: digestRows.length,
    images: await countOf(db.select({ n: sql<number>`count(*)::int` }).from(imageCache)),
    articles: await countOf(db.select({ n: sql<number>`count(*)::int` }).from(articleCache)),
  };

  await ar.add('manifest.json', json({
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    kind: 'site',
    appVersion: APP_VERSION,
    createdAt: isoNow(),
    counts,
    includes: {
      users: true,
      accounts: true,
      feeds: true,
      entries: true,
      digests: true,
      llm: true,
      settings: true,
      images: true,
      articleCache: true,
      sessions: false,
    },
    notes: [
      '敏感文件：含账号密码哈希、加密后的模型 Key 与站点设置，请勿外传。',
      'images/<key> 是图片缓存原文件，键与 image_cache.json 一一对应；article_cache-*.jsonl 是全文抓取缓存。',
      '不含 sessions / verifications：恢复后所有人需要重新登录。',
      '恢复由运维手工完成（先跑结构迁移，再按表导入）；本包定位是「数据留底 + 换机搬运」，不是一键回滚。',
    ],
  }));

  await ar.add('users.json', json(userRows));
  await ar.add('accounts.json', json(accountRows));
  await ar.add('feeds.json', json(feedRows));
  await ar.add('digests.json', json(digestRows));
  await ar.add('user_llm.json', json(llmRows));
  await ar.add('settings.json', json(settingRows));

  let cursor = 0;
  let batch = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(entries)
      .where(gt(entries.id, cursor))
      .orderBy(asc(entries.id))
      .limit(ENTRY_BATCH);
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.id;
    batch += 1;
    await ar.add(`entries-${String(batch).padStart(4, '0')}.jsonl`, jsonl(rows));
  }

  let articleCursor = '';
  batch = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(articleCache)
      .where(gt(articleCache.url, articleCursor))
      .orderBy(asc(articleCache.url))
      .limit(ARTICLE_BATCH);
    if (!rows.length) break;
    articleCursor = rows[rows.length - 1]!.url;
    batch += 1;
    await ar.add(`article_cache-${String(batch).padStart(4, '0')}.jsonl`, jsonl(rows));
  }

  // 图片：先写元数据，再逐个写二进制；二进制条目不再重复压（WebP 已压过）
  const imageMeta = await db
    .select({
      key: imageCache.key,
      contentType: imageCache.contentType,
      width: imageCache.width,
      height: imageCache.height,
      origSize: imageCache.origSize,
      size: imageCache.size,
      createdAt: imageCache.createdAt,
    })
    .from(imageCache)
    .orderBy(asc(imageCache.key));
  await ar.add('image_cache.json', json(imageMeta));

  let imageCursor = '';
  for (;;) {
    const rows = await db
      .select({ key: imageCache.key, data: imageCache.data })
      .from(imageCache)
      .where(gt(imageCache.key, imageCursor))
      .orderBy(asc(imageCache.key))
      .limit(IMAGE_BATCH);
    if (!rows.length) break;
    imageCursor = rows[rows.length - 1]!.key;
    for (const row of rows) {
      await ar.add(`images/${row.key}`, Buffer.from(row.data));
    }
  }
}
