/**
 * 1.7.x（legacy）→ v2 数据迁移。
 *
 * 这是「切换」里唯一会碰到真实数据的一步，所以三条纪律：
 * 1. **幂等**：可以反复跑。用户按 username 复用、feeds 按 (owner, url) 复用、
 *    entries 撞 (feed_id, guid) 跳过、digests 按 (owner, date) 覆盖。
 *    切换当天跑三遍和跑一遍结果一样。
 * 2. **不搬密码哈希**。legacy 用 `scryptSync(pwd, salt, 64)`（Node 默认 r=8），
 *    better-auth 的 scrypt 参数是 r=16 —— 拼不进同一个校验路径。硬兼容等于在生产里
 *    永久保留第二套密码校验代码，为一次迁移而永久扩大攻击面，不值得。
 *    改为：新账号生成一次性随机密码并**只打印一次**，登录后各自去改。
 *    已在 v2 存在的账号（比如 seed 出来的 admin）密码完全不动。
 * 3. **不搬图片缓存**。`image_cache` 是纯缓存（丢了会回源重建），
 *    几十万行 BYTEA 搬过去既慢又占空间。要保留就单独拿 pg_dump。
 *
 * 用法：
 *   LEGACY_DATABASE_URL=postgres://... DATABASE_URL=postgres://... \
 *     pnpm --filter @feedlore/server migrate:legacy --dry-run
 *   ...（去掉 --dry-run 才真写）
 *
 * 可选：
 *   --only=users,feeds,entries,digests,prefs   只跑其中几段（排查用）
 *   LEGACY_SCHEMA=legacy                        legacy 表所在 schema（演练时用）
 */

import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createDb, createPool, digests, entries, feeds, userLlm, users } from '@feedlore/db';
import { getAuth } from '../src/auth';

/* ============================ 参数 ============================ */

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = new Set(
  (onlyArg?.slice('--only='.length).split(',') ?? ['users', 'feeds', 'entries', 'digests', 'prefs'])
    .map((s) => s.trim())
    .filter(Boolean),
);

const LEGACY_URL = process.env.LEGACY_DATABASE_URL ?? '';
const V2_URL = process.env.DATABASE_URL ?? '';
/* schema 名直接拼进 SQL，必须白名单校验（否则就是注入点） */
const LEGACY_SCHEMA = /^[a-z_][a-z0-9_]*$/.test(process.env.LEGACY_SCHEMA ?? '') ? (process.env.LEGACY_SCHEMA as string) : 'public';

if (!LEGACY_URL) {
  console.error('[migrate] 缺少 LEGACY_DATABASE_URL（1.7.x 的库）');
  process.exit(1);
}
if (!V2_URL) {
  console.error('[migrate] 缺少 DATABASE_URL（v2 的库）');
  process.exit(1);
}
if (LEGACY_URL === V2_URL && LEGACY_SCHEMA === 'public') {
  // 同库同 schema 迁移会把 v2 的表当 legacy 读（users 表名相同但列不同），结果一定是错的。
  // 但「同库不同 schema」是合法的：演练时就在同一个实例的 legacy schema 里造数据。
  console.error('[migrate] 源库与目标库是同一个连接串且 schema=public —— 拒绝执行');
  process.exit(1);
}

/* ============================ 工具 ============================ */

const T = (name: string): string => `${LEGACY_SCHEMA}.${name}`;
const now = (): string => new Date().toISOString().slice(11, 19);

function log(...a: unknown[]): void {
  console.log(`[${now()}]`, ...a);
}

/** 一次性随机密码：用户登录后自行修改（迁移不搬 legacy 哈希，见文件头第 2 条）。 */
function randomPassword(): string {
  return crypto.randomBytes(12).toString('base64url'); // 16 字符，够强且能手打
}

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const bool = (v: unknown): boolean => v === true;
const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/* ============================ 主流程 ============================ */

interface Stats {
  users: { reused: number; created: number; skipped: number };
  feeds: { inserted: number; reused: number; skipped: number };
  entries: { inserted: number; existed: number; skipped: number };
  digests: { upserted: number; skipped: number };
  prefs: { updated: number; llm: number };
}

async function main(): Promise<void> {
  log(`模式：${DRY ? '干跑（不写库）' : '写入'}　legacy schema=${LEGACY_SCHEMA}`);

  const legacyPool = createPool(LEGACY_URL);
  const db = createDb(V2_URL);
  const auth = getAuth(db);

  const stats: Stats = {
    users: { reused: 0, created: 0, skipped: 0 },
    feeds: { inserted: 0, reused: 0, skipped: 0 },
    entries: { inserted: 0, existed: 0, skipped: 0 },
    digests: { upserted: 0, skipped: 0 },
    prefs: { updated: 0, llm: 0 },
  };
  /** legacy bigint id → v2 id（feeds 是 bigint，users 是 cuid 字符串） */
  const userIdMap = new Map<number, string>();
  const feedIdMap = new Map<number, number>();
  const newCredentials: Array<{ username: string; password: string }> = [];

  try {
    /* ---------------- 1. 用户 ---------------- */
    if (ONLY.has('users')) {
      const { rows } = await legacyPool.query<Row>(`select id, username, role, prefs from ${T('users')} order by id`);
      log(`legacy 用户 ${rows.length} 个`);

      for (const u of rows) {
        const legacyId = Number(u.id);
        const username = String(u.username ?? '').trim();
        if (!username) {
          stats.users.skipped += 1;
          continue;
        }

        const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
        if (existing) {
          userIdMap.set(legacyId, existing.id);
          stats.users.reused += 1;
          // 角色仍按 legacy 对齐：v2 里被手工降权过的账号会被这里改回来，
          // 但迁移只跑一次，且「以源库为准」是更可解释的语义
          if (!DRY && u.role === 'admin') {
            await db.update(users).set({ role: 'admin' }).where(eq(users.id, existing.id));
          }
          continue;
        }

        if (DRY) {
          userIdMap.set(legacyId, `dry-${legacyId}`);
          stats.users.created += 1;
          continue;
        }

        const password = randomPassword();
        // username 插件把 username 加进 signUpEmail 的 body，类型未覆盖 → cast
        await auth.api.signUpEmail({
          body: { email: `${username}@example.com`, password, name: username, username } as never,
        });
        const [created] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
        if (!created) throw new Error(`创建 v2 用户失败：${username}`);

        if (u.role === 'admin') {
          await db.update(users).set({ role: 'admin' }).where(eq(users.id, created.id));
        }
        userIdMap.set(legacyId, created.id);
        newCredentials.push({ username, password });
        stats.users.created += 1;
      }

      log(`用户：复用 ${stats.users.reused} / 新建 ${stats.users.created} / 跳过 ${stats.users.skipped}`);
      if (newCredentials.length) {
        // 密码只在这一次输出。脚本幂等，但**密码不会再打印第二次**（用户已建好）
        console.log('\n===== 新账号的一次性密码（登录后请立即修改） =====');
        for (const c of newCredentials) console.log(`  ${c.username}\t${c.password}`);
        console.log('==================================================\n');
      }
    } else {
      // 只跑部分段时必须先拿到映射，否则所有 owner_id 都会丢
      const { rows } = await legacyPool.query<Row>(`select id, username from ${T('users')}`);
      for (const u of rows) {
        const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, String(u.username))).limit(1);
        if (existing) userIdMap.set(Number(u.id), existing.id);
      }
      log(`用户段已跳过，仅读取映射 ${userIdMap.size} 条`);
    }

    /* ---------------- 2. 频道 ---------------- */
    if (ONLY.has('feeds')) {
      const { rows } = await legacyPool.query<Row>(`select * from ${T('feeds')} order by id`);
      log(`legacy 频道 ${rows.length} 个`);

      for (const f of rows) {
        const ownerId = userIdMap.get(Number(f.owner_id));
        const url = String(f.url ?? '').trim();
        if (!ownerId || !url) {
          // owner_id 为空是 legacy 早期数据（bootstrapOwnership 没跑到的），没法归给谁
          stats.feeds.skipped += 1;
          continue;
        }

        const [existing] = await db
          .select({ id: feeds.id })
          .from(feeds)
          .where(and(eq(feeds.ownerId, ownerId), eq(feeds.url, url)))
          .limit(1);
        if (existing) {
          feedIdMap.set(Number(f.id), existing.id);
          stats.feeds.reused += 1;
          continue;
        }

        if (DRY) {
          feedIdMap.set(Number(f.id), -Number(f.id));
          stats.feeds.inserted += 1;
          continue;
        }

        const [created] = await db
          .insert(feeds)
          .values({
            ownerId,
            url,
            title: str(f.title),
            siteUrl: str(f.site_url),
            description: str(f.description),
            iconUrl: str(f.icon_url),
            enabled: f.enabled !== false,
            cardEnabled: f.card_enabled !== false,
            groupName: str(f.group_name),
            customTitle: str(f.custom_title),
            sortOrder: num(f.sort_order) ?? 0,
            refreshMinutes: num(f.refresh_minutes),
            etag: str(f.etag),
            lastModified: str(f.last_modified),
            lastStatus: str(f.last_status),
            lastError: str(f.last_error),
            failStreak: num(f.fail_streak) ?? 0,
            lastFetchedAt: f.last_fetched_at ? new Date(String(f.last_fetched_at)) : null,
            createdAt: f.created_at ? new Date(String(f.created_at)) : new Date(),
            updatedAt: f.updated_at ? new Date(String(f.updated_at)) : new Date(),
          })
          .returning({ id: feeds.id });
        if (!created) throw new Error(`插入频道失败：${url}`);
        feedIdMap.set(Number(f.id), created.id);
        stats.feeds.inserted += 1;
      }

      log(`频道：新建 ${stats.feeds.inserted} / 复用 ${stats.feeds.reused} / 跳过 ${stats.feeds.skipped}`);
    } else {
      const { rows } = await legacyPool.query<Row>(`select id, owner_id, url from ${T('feeds')}`);
      for (const f of rows) {
        const ownerId = userIdMap.get(Number(f.owner_id));
        if (!ownerId) continue;
        const [existing] = await db
          .select({ id: feeds.id })
          .from(feeds)
          .where(and(eq(feeds.ownerId, ownerId), eq(feeds.url, String(f.url))))
          .limit(1);
        if (existing) feedIdMap.set(Number(f.id), existing.id);
      }
      log(`频道段已跳过，仅读取映射 ${feedIdMap.size} 条`);
    }

    /* ---------------- 3. 条目 ---------------- */
    if (ONLY.has('entries')) {
      /* keyset 分页而不是 offset：几十万行时 offset 会越来越慢（每页都要扫前面所有行），
       * 而且源库在迁移期间仍在写入，offset 分页可能漏行/重行 —— keyset 两个问题都没有。 */
      let lastId = 0;
      const BATCH = 2000;
      for (;;) {
        const { rows } = await legacyPool.query<Row>(
          `select * from ${T('entries')} where id > $1 order by id limit $2`,
          [lastId, BATCH],
        );
        if (!rows.length) break;
        lastId = Number(rows[rows.length - 1]!.id);

        const values = rows
          .map((e) => {
            const feedId = feedIdMap.get(Number(e.feed_id));
            /* 只判 falsy：真库里 id 从 1 起（bigserial），0/undefined 都表示「这个频道没迁过来」。
             * ⚠️ 不要在这里判 `feedId < 0` —— 干跑时新建频道用负 id 占位，
             * 一旦拒掉负数，干跑会把所有条目都算成「跳过」，数字全错（踩过）。 */
            if (!feedId) {
              stats.entries.skipped += 1;
              return null;
            }
            return {
              feedId,
              guid: String(e.guid ?? ''),
              title: String(e.title ?? ''),
              link: str(e.link),
              pwd: str(e.pwd),
              description: str(e.description),
              content: str(e.content),
              size: str(e.size),
              tags: arr(e.tags),
              image: str(e.image),
              images: Array.isArray(e.images) ? (e.images as string[]) : null,
              sourceUrl: str(e.source_url),
              publishedAt: e.published_at ? new Date(String(e.published_at)) : null,
              fetchedAt: e.fetched_at ? new Date(String(e.fetched_at)) : new Date(),
              isRead: bool(e.is_read),
              readAt: e.read_at ? new Date(String(e.read_at)) : null,
              isFavorite: bool(e.is_favorite),
              favoritedAt: e.favorited_at ? new Date(String(e.favorited_at)) : null,
              bodyJson: str(e.body_json),
              links: Array.isArray(e.links) ? (e.links as string[]) : null,
              watchState: str(e.watch_state),
              watchRule: str(e.watch_rule),
            };
          })
          .filter((v): v is NonNullable<typeof v> => v !== null && Boolean(v.guid));

        if (!values.length) continue;
        if (DRY) {
          stats.entries.inserted += values.length;
          continue;
        }

        /* 一次多行插入 + onConflictDoNothing：撞 (feed_id, guid) 就跳过。
         * 用 returning 的数拿「本批真插进去几条」—— onConflictDoNothing 时它只返回插入的行，
         * 所以 inserted.length 就是新增数。之前想用「前后 count(*) 相减」，那既要多查两次全表，
         * 还会被同一时刻正在抓取的写入干扰。 */
        const inserted = await db
          .insert(entries)
          .values(values)
          .onConflictDoNothing({ target: [entries.feedId, entries.guid] })
          .returning({ id: entries.id });
        stats.entries.inserted += inserted.length;
        stats.entries.existed += values.length - inserted.length;
        process.stdout.write(`\r  条目已处理 id≤${lastId}　新增 ${stats.entries.inserted}`);
      }
      process.stdout.write('\n');
      log(
        `条目：新增 ${stats.entries.inserted} / 已存在 ${stats.entries.existed} / 跳过（频道缺失）${stats.entries.skipped}`,
      );
    }

    /* ---------------- 4. 日报 ---------------- */
    if (ONLY.has('digests')) {
      const { rows } = await legacyPool.query<Row>(`select * from ${T('digests')} order by date`);
      log(`legacy 日报 ${rows.length} 份`);

      for (const d of rows) {
        const ownerId = userIdMap.get(Number(d.owner_id));
        if (!ownerId) {
          stats.digests.skipped += 1;
          continue;
        }
        if (DRY) {
          stats.digests.upserted += 1;
          continue;
        }
        // payload 原样搬：v2 的 Digest 形状是照 legacy 定的（P1 契约），
        // 读的时候 readDigest 还会过一遍 safeParse 兜格式
        await db
          .insert(digests)
          .values({
            date: String(d.date).slice(0, 10),
            ownerId,
            payload: (d.payload ?? {}) as Record<string, unknown>,
            model: str(d.model),
            fallback: bool(d.fallback),
            createdAt: d.created_at ? new Date(String(d.created_at)) : new Date(),
          })
          .onConflictDoUpdate({
            target: [digests.ownerId, digests.date],
            set: {
              payload: (d.payload ?? {}) as Record<string, unknown>,
              model: str(d.model),
              fallback: bool(d.fallback),
            },
          });
        stats.digests.upserted += 1;
      }
      log(`日报：写入 ${stats.digests.upserted} / 跳过 ${stats.digests.skipped}`);
    }

    /* ---------------- 5. 偏好与模型配置 ---------------- */
    if (ONLY.has('prefs')) {
      const { rows } = await legacyPool.query<Row>(`select id, prefs from ${T('users')}`);
      for (const u of rows) {
        const ownerId = userIdMap.get(Number(u.id));
        if (!ownerId) continue;
        const prefs = (u.prefs ?? {}) as Record<string, unknown>;
        const llm = (prefs.llm ?? {}) as Record<string, unknown>;

        /* legacy 把模型配置塞在 prefs.llm 里，v2 拆到 user_llm 侧表。
         * apiKeyEnc 原样搬 —— 只要 v2 读到同一个 cryptoSecret（同名同格式），
         * 密文就能解；否则该账号表现为「存过但解不开」，界面提示重填。 */
        const prefsWithoutLlm: Record<string, unknown> = { ...prefs };
        delete prefsWithoutLlm.llm;
        if (DRY) {
          stats.prefs.updated += 1;
          if (Object.keys(llm).length) stats.prefs.llm += 1;
          continue;
        }

        await db.update(users).set({ prefs: prefsWithoutLlm, updatedAt: new Date() }).where(eq(users.id, ownerId));
        stats.prefs.updated += 1;

        if (Object.keys(llm).length) {
          const depth = llm.thinkingDepth === 'low' ? 1 : llm.thinkingDepth === 'high' ? 3 : 2;
          const set = {
            encryptedKey: str(llm.apiKeyEnc),
            baseUrl: str(llm.baseUrl),
            model: str(llm.model),
            temperature: typeof llm.temperature === 'number' ? llm.temperature : null,
            thinking: llm.thinking === true,
            thinkingDepth: depth,
          };
          await db
            .insert(userLlm)
            .values({ userId: ownerId, ...set })
            .onConflictDoUpdate({ target: userLlm.userId, set: { ...set, updatedAt: new Date() } });
          stats.prefs.llm += 1;
        }
      }
      log(`偏好：写入 ${stats.prefs.updated} 个账号，其中模型配置 ${stats.prefs.llm} 份`);
    }

    /* ---------------- 汇总 ---------------- */
    console.log('\n===== 迁移汇总 =====');
    console.log(`用户   复用 ${stats.users.reused} / 新建 ${stats.users.created} / 跳过 ${stats.users.skipped}`);
    console.log(`频道   新建 ${stats.feeds.inserted} / 复用 ${stats.feeds.reused} / 跳过 ${stats.feeds.skipped}`);
    console.log(`条目   新增 ${stats.entries.inserted} / 已存在 ${stats.entries.existed} / 跳过 ${stats.entries.skipped}`);
    console.log(`日报   写入 ${stats.digests.upserted} / 跳过 ${stats.digests.skipped}`);
    console.log(`偏好   账号 ${stats.prefs.updated} / 模型 ${stats.prefs.llm}`);
    if (DRY) console.log('\n（干跑：以上数字均为预计值，未写入任何数据）');
    console.log('\n⚠️ 图片缓存（image_cache）不在迁移范围内：要保留请单独 pg_dump 这两张表。');
  } finally {
    await legacyPool.end().catch(() => {});
    // drizzle 的连接池由 createDb 内部持有，进程退出时自然关闭
  }
}

main().catch((e) => {
  console.error('[migrate] 失败：', (e as Error)?.message ?? e);
  process.exit(1);
});
