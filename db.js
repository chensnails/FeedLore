'use strict';

/**
 * PostgreSQL 数据层
 * 五张表：users（账号）、settings（站点级设置）、feeds（RSS 订阅，按用户隔离）、
 * entries（条目）、digests（每日摘要，按用户隔离）
 * 全部状态都落库，进程内不再持有任何持久化数据。
 *
 * 多用户模型：每个用户拥有自己的订阅源（feeds.owner_id）→ 条目、已读/收藏
 * 天然跟着 feed 走，彼此隔离；日报（digests.owner_id）也按用户各存一份。
 * 站点级设置（LLM / 采集 / 日报调度）仍存 settings 表，只有管理员能改。
 */

const pg = require('pg');

// id / count / 长度都在安全整数范围内，统一按 Number 取，省去满屏的 Number() 转换
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));    // int8
pg.types.setTypeParser(23, (v) => (v === null ? null : Number(v)));    // int4
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));  // numeric

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 账号：多用户。role = 'admin'（可管全局设置与用户）/ 'user'（只读 + 管自己的源）
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  salt          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  -- 每用户偏好（目前只有 groupOrder），放 JSONB 免得为每个小设置加列
  prefs         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feeds (
  id              BIGSERIAL PRIMARY KEY,
  -- 归属用户；每个用户只看得到自己的订阅源（老库升级时统一归给首个管理员）
  owner_id        BIGINT REFERENCES users(id) ON DELETE CASCADE,
  -- 同一 URL 允许多个用户各自订阅；唯一性由 (owner_id, url) 唯一索引保证
  url             TEXT NOT NULL,
  title           TEXT,
  site_url        TEXT,
  description     TEXT,
  icon_url        TEXT,
  -- enabled      = 采集开关：是否定时抓取这个频道
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  -- card_enabled = 卡片开关：是否在「卡片」页展示这个频道的条目
  card_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  -- 分组名，NULL / '' 都表示未分组
  group_name      TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  etag            TEXT,
  last_modified   TEXT,
  last_status     TEXT,
  last_error      TEXT,
  last_fetched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 「每用户内 URL 唯一」写成表级约束（Postgres 会自动建同名唯一索引 feeds_owner_id_url_key），
  -- 这样 addFeed 的 ON CONFLICT (owner_id, url) 才有约束可匹配（单独 CREATE UNIQUE INDEX 在部分实现下不被识别）
  UNIQUE (owner_id, url)
);

CREATE TABLE IF NOT EXISTS entries (
  id           BIGSERIAL PRIMARY KEY,
  feed_id      BIGINT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid         TEXT NOT NULL,
  title        TEXT NOT NULL,
  link         TEXT,
  pwd          TEXT,
  description  TEXT,
  content      TEXT,
  size         TEXT,
  tags         TEXT[] NOT NULL DEFAULT '{}',
  image        TEXT,
  source_url   TEXT,
  published_at TIMESTAMPTZ,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (feed_id, guid)
);

CREATE TABLE IF NOT EXISTS digests (
  date       DATE NOT NULL,
  owner_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload    JSONB NOT NULL,
  model      TEXT,
  fallback   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, date)
);

-- 图片永久缓存（与 articles 同库）：把压缩后的图片字节按 URL 哈希存下来，
-- 避免重复回源上游（Telegram CDN 等）。L1 内存缓存加速热图，这里做持久层（L2）。
-- key = sha256(归一化 URL)，data = 压缩后的 WebP 字节（栅格图）或原图字节（svg/ico 等不重编码的）。
CREATE TABLE IF NOT EXISTS image_cache (
  key          TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data         BYTEA NOT NULL,
  width        INTEGER,
  height       INTEGER,
  orig_size    INTEGER,
  size         INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS image_cache_created_idx ON image_cache (created_at);
`;

// 索引单独执行：表建完再建，且 pg_trgm 缺失时只需跳过最后一条
const INDEXES = `
-- 多用户：订阅源「每用户内 URL 唯一」、日报「每用户每天一份」
-- 注意 feeds 的唯一性已由 SCHEMA 的表级约束（自动索引 feeds_owner_id_url_key）保证；
-- 这里复用同名索引，只对「老库」补建（老库的 CREATE TABLE IF NOT EXISTS 不会补约束），新库 IF NOT EXISTS 直接跳过。
CREATE UNIQUE INDEX IF NOT EXISTS feeds_owner_id_url_key ON feeds (owner_id, url);
CREATE UNIQUE INDEX IF NOT EXISTS digests_owner_date_key ON digests (owner_id, date);
-- 按用户列订阅源（卡片页 / 未读计数 / 列表）是高频路径
CREATE INDEX IF NOT EXISTS feeds_owner_idx      ON feeds (owner_id, sort_order, id);
CREATE INDEX IF NOT EXISTS entries_pub_idx      ON entries (published_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS entries_feed_pub_idx ON entries (feed_id, published_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS entries_tags_idx     ON entries USING GIN (tags);
-- 未读是高频筛选（侧栏徽标、未读列表），收藏量小但排序用得上，两个都走部分索引
CREATE INDEX IF NOT EXISTS entries_unread_idx   ON entries (feed_id) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS entries_fav_idx      ON entries (favorited_at DESC NULLS LAST, id DESC) WHERE is_favorite = TRUE;
`;

const TRGM_INDEX = `CREATE INDEX IF NOT EXISTS entries_title_trgm ON entries USING GIN (title gin_trgm_ops);`;

// 增量迁移：CREATE TABLE IF NOT EXISTS 只对「表不存在」生效，给已存在的表补列必须单独 ALTER。
// 每条都用 IF NOT EXISTS，重复执行安全。新增字段一律往这里加一条，不要改上面的 SCHEMA 就完事。
const MIGRATIONS = [
  // v10：阅读页要展开全文，正文单独存一列（列表查询不带它，展开时按 id 单独取）
  `ALTER TABLE entries ADD COLUMN IF NOT EXISTS content TEXT`,
  // v11：频道拆成两个开关 —— enabled 管采集，card_enabled 管卡片页展示
  `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS card_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
  // v11：频道分组（NULL / '' 表示未分组）
  `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS group_name TEXT`,
  // v12：抓取频率支持按频道单独设置（NULL = 跟随全局设置）
  `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS refresh_minutes INTEGER`,
  // v13：文章已读 / 收藏标记。收藏的条目会被保留策略豁免（见 pruneEntries / pruneEntriesByAge）
  `ALTER TABLE entries ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE entries ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ`,
  `ALTER TABLE entries ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE entries ADD COLUMN IF NOT EXISTS favorited_at TIMESTAMPTZ`,
  // v14：频道显示名支持自定义（custom_title 优先于抓取来的 title；刷新不会覆盖它）
  `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS custom_title TEXT`,
  // v15：文章配图全部存下来（多图文章），TEXT[]；单图 image 仍沿用第一张给卡片/缩略图
  `ALTER TABLE entries ADD COLUMN IF NOT EXISTS images TEXT[]`,
  // v16：正文按「图文原始顺序」拆成的块 JSON（[{t:'p',text},{t:'img',src}]），阅读页内联渲染
  `ALTER TABLE entries ADD COLUMN IF NOT EXISTS body_json TEXT`,
  // v17：文章内所有可复制的链接（主链接优先），前端「复制」按钮多选用
  `ALTER TABLE entries ADD COLUMN IF NOT EXISTS links TEXT[]`,
  // v18：多用户 —— feeds / digests 加归属列（老库升级时由 bootstrapOwnership 回填给首个管理员）
  `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE`,
  `ALTER TABLE digests ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE`,
  // 去掉旧的「全局唯一」：url 改为每用户唯一、digests 主键改为 (owner_id, date)
  `ALTER TABLE feeds DROP CONSTRAINT IF EXISTS feeds_url_key`,
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                WHERE t.relname = 'digests' AND c.conname = 'digests_pkey'
                  AND pg_get_constraintdef(c.oid) NOT LIKE '%owner_id%')
     THEN ALTER TABLE digests DROP CONSTRAINT digests_pkey; END IF;
   END $$`,
  // v19：抓取连续失败计数（达到上限自动停用采集；抓取成功清零，手动恢复也清零）
  `ALTER TABLE feeds ADD COLUMN IF NOT EXISTS fail_streak SMALLINT NOT NULL DEFAULT 0`,
];


module.exports = function createDb({ connectionString, log = console.log }) {
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
  });

  pool.on('error', (e) => log('[db] 空闲连接异常：' + (e.message || e)));

  let ready = false;
  let lastError = null;
  let stopped = false;
  const readyHooks = [];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (text, params) => pool.query(text, params);

  /* ---------------- 迁移 ---------------- */
  async function migrate() {
    await q(SCHEMA);
    for (const sql of MIGRATIONS) await q(sql);
    await q(INDEXES);
    // 模糊搜索加速：扩展装不上就跳过（功能不受影响，只是大表下慢一点）
    try {
      await q('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await q(TRGM_INDEX);
    } catch (e) {
      log('[db] pg_trgm 不可用，跳过模糊搜索索引：' + (e.message || e));
    }
  }

  /** 后台连接 + 重试，不阻塞 HTTP 服务启动 */
  function start() {
    (async () => {
      let n = 0;
      while (!ready && !stopped) {
        n += 1;
        try {
          await migrate();
          ready = true;
          lastError = null;
          log('[db] PostgreSQL 已连接，schema 就绪');
          for (const fn of readyHooks.splice(0)) {
            try { await fn(); } catch (e) { log('[db] onReady 回调失败：' + (e.message || e)); }
          }
        } catch (e) {
          lastError = (e && e.message) || String(e);
          if (n === 1 || n % 6 === 0) log(`[db] 连接失败（第 ${n} 次）：${lastError}`);
          await sleep(Math.min(1000 * n, 6000));
        }
      }
    })();
  }

  function onReady(fn) {
    if (ready) { Promise.resolve().then(fn).catch(() => {}); return; }
    readyHooks.push(fn);
  }
  function status() { return { ready, error: lastError }; }

  async function close() {
    stopped = true;
    await pool.end().catch(() => {});
  }

  /* ============================================================
   * settings
   * ============================================================ */
  async function getSettings() {
    const { rows } = await q('SELECT key, value FROM settings');
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  async function setSettings(patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const k of keys) {
        await c.query(
          `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [k, JSON.stringify(patch[k])]
        );
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  const setSetting = (key, value) => setSettings({ [key]: value });

  /* ============================================================
   * users（多用户账号）
   * ============================================================ */
  const USER_SELECT = `SELECT id, username, role, prefs, created_at, updated_at FROM users`;

  /** 用户列表（不含密码）—— 用于会话解析缓存与「用户管理」界面 */
  const listUsers = async () =>
    (await q(`${USER_SELECT} ORDER BY id`)).rows;

  const getUserById = async (id) =>
    (await q(`${USER_SELECT} WHERE id = $1`, [id])).rows[0] || null;

  /** 登录用：带盐与密码哈希（只在服务端内部使用，绝不外发） */
  const getUserByName = async (username) =>
    (await q(`SELECT id, username, role, salt, password_hash, prefs, created_at FROM users WHERE username = $1`,
      [String(username || '').trim()])).rows[0] || null;

  const countUsers = async () => Number((await q('SELECT count(*) AS n FROM users')).rows[0].n || 0);

  async function createUser({ username, salt, passwordHash, role = 'user', prefs = {} }) {
    const { rows } = await q(
      `INSERT INTO users (username, salt, password_hash, role, prefs)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
      [String(username || '').trim(), salt, passwordHash, role === 'admin' ? 'admin' : 'user',
        JSON.stringify(prefs || {})]
    );
    return getUserById(rows[0].id);
  }

  const setUserPassword = (id, salt, passwordHash) =>
    q(`UPDATE users SET salt = $2, password_hash = $3, updated_at = now() WHERE id = $1`,
      [id, salt, passwordHash]);

  const setUserRole = (id, role) =>
    q(`UPDATE users SET role = $2, updated_at = now() WHERE id = $1`,
      [id, role === 'admin' ? 'admin' : 'user']);

  const setUsername = (id, username) =>
    q(`UPDATE users SET username = $2, updated_at = now() WHERE id = $1`,
      [id, String(username || '').trim()]);

  /** 每用户偏好（groupOrder 等）整块覆盖写 */
  const setUserPrefs = (id, prefs) =>
    q(`UPDATE users SET prefs = $2::jsonb, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(prefs || {})]);

  const deleteUser = async (id) => (await q('DELETE FROM users WHERE id = $1', [id])).rowCount > 0;

  /**
   * 老库升级：把还没有归属的 feeds / digests 归给第一个管理员，并收紧约束。
   * 幂等——每次启动都能安全跑一遍。
   */
  async function bootstrapOwnership() {
    const admin = (await q(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)).rows[0];
    if (admin) {
      await q('UPDATE feeds SET owner_id = $1 WHERE owner_id IS NULL', [admin.id]);
      await q('UPDATE digests SET owner_id = $1 WHERE owner_id IS NULL', [admin.id]);
    }
    // owner 必填：没有归属的行会从任何用户视角里「消失」，所以能收紧就收紧
    await q('ALTER TABLE feeds ALTER COLUMN owner_id SET NOT NULL').catch((e) => log('[db] feeds.owner_id SET NOT NULL 跳过：' + (e.message || e)));
    await q('ALTER TABLE digests ALTER COLUMN owner_id SET NOT NULL').catch((e) => log('[db] digests.owner_id SET NOT NULL 跳过：' + (e.message || e)));
  }

  /* ============================================================
   * feeds
   * ============================================================ */
  const FEED_SELECT = `
    SELECT f.id, f.url, f.title, f.site_url, f.description, f.icon_url,
           f.enabled, f.card_enabled, f.group_name, f.custom_title, f.refresh_minutes,
           f.sort_order, f.last_status, f.last_error, f.last_fetched_at, f.fail_streak,
           f.owner_id, f.created_at, COALESCE(e.n, 0) AS entry_count,
           COALESCE(u.n, 0) AS unread_count
    FROM feeds f
    LEFT JOIN (SELECT feed_id, count(*) AS n FROM entries GROUP BY feed_id) e
      ON e.feed_id = f.id
    LEFT JOIN (SELECT feed_id, count(*) AS n FROM entries WHERE is_read = FALSE GROUP BY feed_id) u
      ON u.feed_id = f.id`;

  const listFeeds = async (ownerId) =>
    (await q(`${FEED_SELECT} WHERE f.owner_id = $1 ORDER BY f.sort_order, f.id`, [ownerId])).rows;

  const getFeed = async (id, ownerId) =>
    (await q(`${FEED_SELECT} WHERE f.id = $1 AND f.owner_id = $2`, [id, ownerId])).rows[0] || null;

  async function addFeed(ownerId, url, patch = {}) {
    const { rows } = await q(
      `INSERT INTO feeds (owner_id, url, title, site_url, description, icon_url,
                          enabled, card_enabled, group_name, custom_title, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               COALESCE((SELECT max(sort_order) + 1 FROM feeds WHERE owner_id = $1), 0))
       ON CONFLICT (owner_id, url) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [ownerId, url, patch.title || null, patch.siteUrl || null, patch.description || null,
        patch.iconUrl || null, patch.enabled !== false, patch.cardEnabled !== false,
        patch.groupName || null, patch.customTitle || null]
    );
    return getFeed(rows[0].id, ownerId);
  }

  async function updateFeed(id, patch, ownerId) {
    const sets = [];
    const vals = [];
    const map = {
      title: 'title', siteUrl: 'site_url', description: 'description',
      iconUrl: 'icon_url', enabled: 'enabled', cardEnabled: 'card_enabled',
      groupName: 'group_name', sortOrder: 'sort_order', customTitle: 'custom_title',
      // 抓取频率：正整数 = 该频道单独设置（分钟）；null = 跟随全局
      refreshMinutes: 'refresh_minutes',
    };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${col} = $${vals.length}`); }
    }
    if (!sets.length) return getFeed(id, ownerId);
    vals.push(id);
    const pId = vals.length;
    vals.push(ownerId);
    const pOwner = vals.length;
    await q(`UPDATE feeds SET ${sets.join(', ')}, updated_at = now() WHERE id = $${pId} AND owner_id = $${pOwner}`, vals);
    return getFeed(id, ownerId);
  }

  /** 批量重排：items = [{ id, sortOrder, groupName }]，单语句 UPDATE...FROM VALUES 一次性落地。
   *  sort_order 是「本用户内」的排序轴（组内顺序由它决定），group_name 可在此一并改（跨组移动）。 */
  async function reorderFeeds(ownerId, items) {
    const arr = Array.isArray(items) ? items.filter((it) => it && it.id != null).slice(0, 2000) : [];
    if (!arr.length) return 0;
    const vals = [];
    const rowsSql = arr.map((it, i) => {
      const id = Number(it.id);
      const so = Number.isFinite(Number(it.sortOrder)) ? Number(it.sortOrder) : 0;
      let gn = String(it.groupName != null ? it.groupName : (it.group_name != null ? it.group_name : '') || '').trim().slice(0, 40);
      gn = gn || null;
      vals.push(id, so, gn);
      return `($${i * 3 + 1}::bigint, $${i * 3 + 2}::int, $${i * 3 + 3}::text)`;
    }).join(',');
    vals.push(ownerId);
    const pOwner = vals.length;
    await q(`UPDATE feeds AS f SET sort_order = v.so, group_name = v.gn
             FROM (VALUES ${rowsSql}) AS v(id, so, gn)
             WHERE f.id = v.id AND f.owner_id = $${pOwner}`, vals);
    return arr.length;
  }

  /** 记录一次抓取结果（成功时同时写入 feed 元信息与条件请求头） */
  async function saveFeedMeta(id, meta) {
    // meta.failStreak：传数字（含 0）时直接覆写失败计数（ok 路径传 0 清零）；
    // 不传则保持原值（error 路径另行 bumpFeedFailStreak 累加）
    const vals = [
      id, meta.title || null, meta.siteUrl || null, meta.description || null,
      meta.iconUrl || null, meta.etag || null, meta.lastModified || null,
      meta.status || 'ok', meta.error || null,
    ];
    let streakSql = '';
    if (Number.isFinite(meta.failStreak)) {
      vals.push(Math.max(0, Number(meta.failStreak) | 0));
      streakSql = `, fail_streak = $${vals.length}`;
    }
    await q(
      `UPDATE feeds SET title = COALESCE($2, title),
         site_url = COALESCE($3, site_url),
         description = COALESCE($4, description),
         icon_url = COALESCE($5, icon_url),
         etag = $6, last_modified = $7,
         last_status = $8, last_error = $9${streakSql},
         last_fetched_at = now(), updated_at = now()
       WHERE id = $1`,
      vals
    );
  }

  /** 失败计数 +1 并返回新值（极简 UPDATE...RETURNING，与 saveFeedMeta 分开以免两条 SQL 竞争） */
  async function bumpFeedFailStreak(id) {
    const { rows } = await q(
      'UPDATE feeds SET fail_streak = fail_streak + 1, updated_at = now() WHERE id = $1 RETURNING fail_streak',
      [id]
    );
    return rows[0] ? Number(rows[0].fail_streak) : 0;
  }

  /** 失败计数清零（用户手动恢复采集 / 重试成功时调用） */
  const resetFeedFailStreak = async (id, ownerId) => {
    await q('UPDATE feeds SET fail_streak = 0, updated_at = now() WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  };

  /** 直接置采集开关（自动停用 / 自动恢复用，不校验 owner——调用方是服务端内部逻辑） */
  const setFeedEnabled = async (id, enabled) => {
    await q('UPDATE feeds SET enabled = $2, updated_at = now() WHERE id = $1', [id, !!enabled]);
  };

  const deleteFeed = async (id, ownerId) =>
    (await q('DELETE FROM feeds WHERE id = $1 AND owner_id = $2', [id, ownerId])).rowCount > 0;

  /** 采集开关打开的频道 —— 该用户的定时抓取与「日报」采集范围 */
  const enabledFeedIds = async (ownerId) =>
    (await q('SELECT id FROM feeds WHERE owner_id = $1 AND enabled ORDER BY sort_order, id', [ownerId]))
      .rows.map((r) => r.id);

  /** 卡片开关打开的频道 —— 「卡片」页默认展示的范围 */
  const cardFeedIds = async (ownerId) =>
    (await q('SELECT id FROM feeds WHERE owner_id = $1 AND card_enabled ORDER BY sort_order, id', [ownerId]))
      .rows.map((r) => r.id);

  /** 所有「已开启采集」的频道（跨用户）—— 定时抓取 tick 用，一次抓全站 */
  const allEnabledFeeds = async () =>
    (await q(`${FEED_SELECT} WHERE f.enabled = TRUE ORDER BY f.owner_id, f.sort_order, f.id`)).rows;

  /** 全部频道（跨用户）—— 管理员状态页统计用 */
  const allFeeds = async () =>
    (await q(`${FEED_SELECT} ORDER BY f.owner_id, f.sort_order, f.id`)).rows;

  /** 所有用户 id（日报调度按用户各生成一份） */
  const allUserIds = async () => (await q('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);

  /* ============================================================
   * 统计（状态页用）
   * ============================================================ */
  /** 四张表各有多少行 —— 一条 SQL 拿全，避免四次往返 */
  async function tableCounts() {
    const { rows } = await q(`
      SELECT (SELECT count(*) FROM users)    AS users,
             (SELECT count(*) FROM feeds)    AS feeds,
             (SELECT count(*) FROM entries)  AS entries,
             (SELECT count(*) FROM digests)  AS digests,
             (SELECT count(*) FROM settings) AS settings`);
    const r = rows[0] || {};
    return {
      users: Number(r.users || 0),
      feeds: Number(r.feeds || 0),
      entries: Number(r.entries || 0),
      digests: Number(r.digests || 0),
      settings: Number(r.settings || 0),
    };
  }

  /** 条目时间窗：最早/最新发布时间 + 近 24 小时新入库条数 */
  async function entryWindow() {
    const { rows } = await q(`
      SELECT min(published_at) AS oldest,
             max(published_at) AS newest,
             count(*) FILTER (WHERE fetched_at >= now() - interval '24 hours') AS added24h
      FROM entries`);
    const r = rows[0] || {};
    return {
      oldest: r.oldest ? new Date(r.oldest).toISOString() : null,
      newest: r.newest ? new Date(r.newest).toISOString() : null,
      added24h: Number(r.added24h || 0),
    };
  }

  /** 往返延迟（毫秒）—— 拿最轻的一条查询探一下，状态页用来判断库是否「活着但很慢」 */
  async function ping() {
    const t = Date.now();
    await q('SELECT 1');
    return Date.now() - t;
  }

  /* ============================================================
   * entries
   * ============================================================ */
  /** 批量写入条目，返回新增条数（按 (feed_id, guid) 去重，已存在则更新） */
  async function upsertEntries(feedId, items) {
    if (!items.length) return 0;
    const c = await pool.connect();
    let inserted = 0;
    try {
      await c.query('BEGIN');
      for (const it of items) {
        const r = await c.query(
          `INSERT INTO entries
             (feed_id, guid, title, link, pwd, description, content, size, tags, image, source_url, images, body_json, links, published_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (feed_id, guid) DO UPDATE SET
             title = EXCLUDED.title, link = EXCLUDED.link, pwd = EXCLUDED.pwd,
             description = EXCLUDED.description,
             -- 正文用 COALESCE 兜底：某次抓取拿不到正文时不要把已经存好的覆盖成 NULL
             content = COALESCE(EXCLUDED.content, entries.content),
             size = EXCLUDED.size,
             tags = EXCLUDED.tags, image = EXCLUDED.image, images = EXCLUDED.images,
             body_json = COALESCE(EXCLUDED.body_json, entries.body_json),
             links = EXCLUDED.links,
             source_url = EXCLUDED.source_url, published_at = EXCLUDED.published_at
           RETURNING (xmax = 0) AS is_new`,
          [feedId, it.guid, it.title, it.link, it.pwd, it.description, it.content,
            it.size, it.tags, it.image, it.sourceUrl, it.images, it.bodyJson, it.links, it.publishedAt]
        );
        if (r.rows[0] && r.rows[0].is_new) inserted += 1;
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    return inserted;
  }

  function buildFilter({ ownerId, feedIds, q: kw, tag, unread, favorite }) {
    const where = [];
    const vals = [];
    // 用户隔离：只碰「归属当前用户」的频道下的条目（用子查询，SELECT / UPDATE 都适用）
    if (ownerId != null) {
      vals.push(ownerId);
      where.push(`e.feed_id IN (SELECT id FROM feeds WHERE owner_id = $${vals.length})`);
    }
    if (Array.isArray(feedIds)) {
      if (!feedIds.length) return { where: ['FALSE'], vals: [] };
      vals.push(feedIds);
      where.push(`e.feed_id = ANY($${vals.length})`);
    }
    if (tag) {
      vals.push(tag);
      where.push(`$${vals.length} = ANY(e.tags)`);
    }
    if (kw) {
      vals.push('%' + kw + '%');
      const p = `$${vals.length}`;
      // v2.6.0：全文检索覆盖正文 content（此前只搜标题/描述/标签，正文里出现的关键词搜不到）。
      // 实测（线上 4.1 万条 / 234MB，EXPLAIN ANALYZE + API 计时）：命中场景走 entries_pub_idx
      // 倒序 + 提前 LIMIT，DB 层约 24ms；稀有词零命中最坏扫全表读 content detoast，
      // DB 层约 1.4s、API 层约 2.7s —— 单用户自用可接受，故不建
      // content 的 trgm 索引（长正文 trgm 索引体积会是 title 索引的几十倍，不成比例）。
      // 等 entries 上到数十万级再重新评估 trgm / tsvector。
      where.push(`(e.title ILIKE ${p} OR e.description ILIKE ${p}
        OR e.content ILIKE ${p}
        OR EXISTS (SELECT 1 FROM unnest(e.tags) t WHERE t ILIKE ${p}))`);
    }
    // 未读 / 收藏是「额外收窄」，可以与频道、分组、关键词叠加
    if (unread) where.push('e.is_read = FALSE');
    if (favorite) where.push('e.is_favorite = TRUE');
    return { where: where.length ? where : ['TRUE'], vals };
  }

  const ENTRY_SELECT = `
    SELECT e.id, e.feed_id, e.title, e.link, e.pwd, e.description, e.size, e.tags,
           e.image, e.images, e.links, e.source_url, e.published_at,
           e.is_read, e.is_favorite, e.favorited_at, f.title AS feed_name
    FROM entries e JOIN feeds f ON f.id = e.feed_id`;

  // 只比 ENTRY_SELECT 多一个 content（以及 body_json），供单条读取用
  const ENTRY_FULL_SELECT = `
    SELECT e.id, e.feed_id, e.title, e.link, e.pwd, e.description, e.content,
           e.size, e.tags, e.image, e.images, e.links, e.body_json, e.source_url, e.published_at,
           e.is_read, e.is_favorite, e.favorited_at, f.title AS feed_name
    FROM entries e JOIN feeds f ON f.id = e.feed_id`;

  /* 排序：new/old 按发布时间；fav 按「收藏时刻」，让最近收藏的排在前面 */
  const ENTRY_ORDER = {
    new: 'e.published_at DESC NULLS LAST, e.id DESC',
    old: 'e.published_at ASC NULLS LAST, e.id ASC',
    fav: 'e.favorited_at DESC NULLS LAST, e.id DESC',
  };

  async function queryEntries({ ownerId, feedIds, q: kw, tag, unread, favorite, order = 'new', limit = 50, offset = 0 }) {
    const { where, vals } = buildFilter({ ownerId, feedIds, q: kw, tag, unread, favorite });
    const pLimit = vals.length + 1;
    const pOffset = vals.length + 2;
    const { rows } = await q(
      `${ENTRY_SELECT} WHERE ${where.join(' AND ')}
       ORDER BY ${ENTRY_ORDER[order] || ENTRY_ORDER.new}
       LIMIT $${pLimit} OFFSET $${pOffset}`,
      [...vals, limit + 1, offset]
    );
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  async function countEntries({ ownerId, feedIds, q: kw, tag, unread, favorite }) {
    const { where, vals } = buildFilter({ ownerId, feedIds, q: kw, tag, unread, favorite });
    const { rows } = await q(`SELECT count(*) AS n FROM entries e WHERE ${where.join(' AND ')}`, vals);
    return rows[0].n;
  }

  /**
   * 单条打标记：只改传进来的字段，没传的保持原样。
   * 时间戳跟着布尔一起写：标已读记 read_at，取消收藏把 favorited_at 清空。
   */
  async function setEntryFlags(id, { isRead, isFavorite } = {}, ownerId) {
    const sets = [];
    const vals = [];
    if (isRead !== undefined) {
      vals.push(!!isRead);
      sets.push(`is_read = $${vals.length}`, `read_at = ${isRead ? 'now()' : 'NULL'}`);
    }
    if (isFavorite !== undefined) {
      vals.push(!!isFavorite);
      sets.push(`is_favorite = $${vals.length}`, `favorited_at = ${isFavorite ? 'now()' : 'NULL'}`);
    }
    if (!sets.length) return null;
    vals.push(id);
    const pId = vals.length;
    vals.push(ownerId);
    const pOwner = vals.length;
    const { rows } = await q(
      `UPDATE entries SET ${sets.join(', ')}
        WHERE id = $${pId} AND feed_id IN (SELECT id FROM feeds WHERE owner_id = $${pOwner})
       RETURNING id, is_read, read_at, is_favorite, favorited_at`, vals
    );
    return rows[0] || null;
  }

  /**
   * 按当前筛选条件批量标为已读（「全部标为已读」用）。
   * 条件与 queryEntries 完全一致，所以「屏幕上看到的」和「被标掉的」是同一批。
   */
  async function markEntriesRead({ ownerId, feedIds, q: kw, tag, unread, favorite } = {}) {
    const { where, vals } = buildFilter({ ownerId, feedIds, q: kw, tag, unread, favorite });
    vals.push(true);
    const r = await q(
      `UPDATE entries e SET is_read = $${vals.length}, read_at = now()
        WHERE ${where.join(' AND ')} AND e.is_read = FALSE`, vals
    );
    return r.rowCount;
  }

  /** 侧栏徽标：该用户「全部 / 未读 / 收藏」三个计数；ownerId 传 null 表示全站（管理员状态页） */
  async function entryFlagCounts(ownerId) {
    const where = ownerId == null ? '' : 'WHERE e.feed_id IN (SELECT id FROM feeds WHERE owner_id = $1)';
    const vals = ownerId == null ? [] : [ownerId];
    const { rows } = await q(
      `SELECT count(*)                                  AS total,
              count(*) FILTER (WHERE is_read = FALSE)    AS unread,
              count(*) FILTER (WHERE is_favorite = TRUE) AS favorite
         FROM entries e ${where}`, vals
    );
    const r = rows[0] || {};
    return {
      total: Number(r.total || 0),
      unread: Number(r.unread || 0),
      favorite: Number(r.favorite || 0),
    };
  }

  /** 阅读页展开全文时按 id 单独取正文：列表查询不带 content，避免 50 条 × 几千字把响应撑大 */
  const getEntry = async (id, ownerId) =>
    (await q(`${ENTRY_FULL_SELECT} WHERE e.id = $1 AND f.owner_id = $2`, [id, ownerId])).rows[0] || null;

  async function tagCounts(ownerId, feedIds) {
    const vals = [];
    const conds = [];
    if (ownerId != null) {
      vals.push(ownerId);
      conds.push(`e.feed_id IN (SELECT id FROM feeds WHERE owner_id = $${vals.length})`);
    }
    if (Array.isArray(feedIds)) {
      if (!feedIds.length) return [];
      vals.push(feedIds);
      conds.push(`e.feed_id = ANY($${vals.length})`);
    }
    const filter = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return (await q(
      `SELECT t AS tag, count(*) AS n
       FROM entries e, unnest(e.tags) t ${filter}
       GROUP BY t ORDER BY n DESC, t LIMIT 80`, vals
    )).rows;
  }

  /**
   * 只保留每个频道最新的 keepPerFeed 条，返回删除条数。
   * **收藏的条目一律豁免**：排名窗口只统计未收藏的，所以收藏再多也不会挤掉普通条目，
   * 普通条目也不会因为「收藏占了名额」被提前删掉。
   */
  async function pruneEntries(keepPerFeed) {
    // 0（或负数）=「无条数上限」：不按数量清理；想要限制请走 pruneEntriesByAge
    const k = Number(keepPerFeed);
    if (!Number.isFinite(k) || k <= 0) return 0;
    const r = await q(
      `DELETE FROM entries WHERE id IN (
         SELECT id FROM (
           SELECT id, row_number() OVER (
             PARTITION BY feed_id ORDER BY published_at DESC NULLS LAST, id DESC
           ) AS rn FROM entries WHERE is_favorite = FALSE
         ) x WHERE x.rn > $1
       )`, [k]
    );
    return r.rowCount;
  }

  /**
   * 按时间清理：删掉发布时间早于 N 天前的条目（keepDays <= 0 表示不限，直接跳过）。
   * 与 pruneEntries 的「每频道保留 N 条」是**并且**关系，两个上限谁先命中谁生效。
   * published_at 为 NULL 的条目无法判断年龄，一律保留；**收藏的条目同样豁免**。
   */
  async function pruneEntriesByAge(keepDays) {
    const days = Number(keepDays);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const r = await q(
      `DELETE FROM entries
        WHERE is_favorite = FALSE
          AND published_at IS NOT NULL
          AND published_at < now() - make_interval(days => $1::int)`,
      [Math.floor(days)]
    );
    return r.rowCount;
  }

  /** 摘要用：取该用户时间窗内的条目 */
  async function entriesSince({ ownerId, feedIds, sinceMs, limit = 3000 }) {
    const vals = [new Date(sinceMs)];
    const conds = ['e.published_at >= $1'];
    if (ownerId != null) {
      vals.push(ownerId);
      conds.push(`e.feed_id IN (SELECT id FROM feeds WHERE owner_id = $${vals.length})`);
    }
    if (Array.isArray(feedIds)) {
      if (!feedIds.length) return [];
      vals.push(feedIds);
      conds.push(`e.feed_id = ANY($${vals.length})`);
    }
    vals.push(limit);
    return (await q(
      `SELECT e.id, e.feed_id, e.title, e.link, e.pwd, e.description, e.size,
              e.tags, e.image, e.images, e.links, e.source_url, e.published_at, f.title AS feed_name
       FROM entries e JOIN feeds f ON f.id = e.feed_id
       WHERE ${conds.join(' AND ')}
       ORDER BY e.published_at DESC NULLS LAST, e.id DESC
       LIMIT $${vals.length}`, vals
    )).rows;
  }

  /* ============================================================
   * digests
   * ============================================================ */
  async function saveDigest(ownerId, date, payload, model, fallback) {
    await q(
      `INSERT INTO digests (owner_id, date, payload, model, fallback, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, now())
       ON CONFLICT (owner_id, date) DO UPDATE SET
         payload = EXCLUDED.payload, model = EXCLUDED.model,
         fallback = EXCLUDED.fallback, created_at = now()`,
      [ownerId, date, JSON.stringify(payload), model || null, !!fallback]
    );
  }

  const readDigest = async (ownerId, date) =>
    ((await q('SELECT payload FROM digests WHERE owner_id = $1 AND date = $2', [ownerId, date])).rows[0] || {}).payload || null;

  const listDigestDates = async (ownerId, limit = 120) =>
    (await q(`SELECT to_char(date, 'YYYY-MM-DD') AS d FROM digests
               WHERE owner_id = $1 ORDER BY date DESC LIMIT $2`, [ownerId, limit]))
      .rows.map((r) => r.d);

  /** 该用户某天是否已有日报（调度器用来判断「今天是否已生成」） */
  const hasDigest = async (ownerId, date) =>
    ((await q('SELECT 1 FROM digests WHERE owner_id = $1 AND date = $2', [ownerId, date])).rowCount) > 0;

  /** 全站日报概览（管理员状态页）：总条数 / 最早日期 / 最新一份内容 */
  async function digestStatsAll() {
    const { rows } = await q(`SELECT count(*) AS n, min(date) AS oldest, max(date) AS newest FROM digests`);
    const r = rows[0] || {};
    let latest = null;
    if (r.newest) latest = ((await q('SELECT payload FROM digests ORDER BY date DESC LIMIT 1')).rows[0] || {}).payload || null;
    return {
      count: Number(r.n || 0),
      oldestDate: r.oldest ? new Date(r.oldest).toISOString().slice(0, 10) : null,
      latest,
    };
  }

  /** 只保留该用户最近 keepDays 天的日报 */
  async function pruneDigests(ownerId, keepDays) {
    const r = await q(
      `DELETE FROM digests
        WHERE owner_id = $1
          AND date < (SELECT max(date) FROM digests WHERE owner_id = $1) - ($2::int - 1)`,
      [ownerId, Math.max(1, keepDays)]
    );
    return r.rowCount;
  }

  /* ============================================================
   * 图片永久缓存（image_cache 表）
   * ============================================================ */
  /** 取缓存图片；命中返回 { contentType, data(Buffer), createdAt }，未命中返回 null */
  async function getImageCache(key) {
    const r = await q('SELECT content_type, data, created_at FROM image_cache WHERE key = $1', [key]);
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return { contentType: row.content_type, data: row.data, createdAt: row.created_at };
  }

  /** 写入/覆盖缓存图片（key = sha256 归一化 URL） */
  async function setImageCache({ key, contentType, data, width, height, origSize }) {
    await q(
      `INSERT INTO image_cache (key, content_type, data, width, height, orig_size, size, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (key) DO UPDATE SET
         content_type = EXCLUDED.content_type, data = EXCLUDED.data,
         width = EXCLUDED.width, height = EXCLUDED.height,
         orig_size = EXCLUDED.orig_size, size = EXCLUDED.size, created_at = now()`,
      [key, contentType, data, width || null, height || null, origSize || null, data.length]
    );
  }

  /** 清理超过 keepDays 天的缓存图片；返回删除行数 */
  async function pruneImageCache(days) {
    const keep = Math.max(1, Number(days) || 90);
    const r = await q(
      `DELETE FROM image_cache WHERE created_at < now() - ($1::int || ' days')::interval`,
      [keep]
    );
    return r.rowCount || 0;
  }

  /** 手动清空图片缓存（设置里「清空图片缓存」用）；返回删除行数 */
  async function clearImageCache() {
    const r = await q('DELETE FROM image_cache');
    return r.rowCount || 0;
  }

  /** 图片缓存统计：{ count, bytes } */
  async function imageCacheStats() {
    const r = await q('SELECT count(*)::int AS n, COALESCE(sum(size), 0)::bigint AS bytes FROM image_cache');
    return { count: r.rows[0].n, bytes: Number(r.rows[0].bytes) };
  }

  /** 数据库体积（字节）——状态页展示，防entries无限增长悄悄拖慢查询 */
  async function pgDatabaseSize() {
    const { rows } = await q('SELECT pg_database_size(current_database()) AS bytes');
    return Number(rows[0] ? rows[0].bytes : 0);
  }

  return {
    pool, q, start, onReady, status, close, migrate,
    getSettings, setSetting, setSettings,
    listUsers, getUserById, getUserByName, countUsers, createUser,
    setUserPassword, setUserRole, setUsername, setUserPrefs, deleteUser, bootstrapOwnership,
    listFeeds, getFeed, addFeed, updateFeed, saveFeedMeta, deleteFeed, reorderFeeds,
    enabledFeedIds, cardFeedIds, allEnabledFeeds, allFeeds, allUserIds,
    bumpFeedFailStreak, resetFeedFailStreak, setFeedEnabled,
    upsertEntries, queryEntries, getEntry, countEntries, tagCounts, pruneEntries, pruneEntriesByAge, entriesSince,
    setEntryFlags, markEntriesRead, entryFlagCounts,
    tableCounts, entryWindow, ping, pgDatabaseSize,
    saveDigest, readDigest, listDigestDates, hasDigest, digestStatsAll, pruneDigests,
    getImageCache, setImageCache, pruneImageCache, clearImageCache, imageCacheStats,
  };
};
