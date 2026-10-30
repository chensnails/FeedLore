/**
 * 管理端路由（契约 `admin` 分组 + `auth` 分组里的 status / version / update）。
 *
 * 这一组是「换掉 legacy 的最后一块」：没有它，v2 就只有阅读功能，管理员无法调采集参数、
 * 加账号、看状态。
 *
 * 三条原则：
 * 1. **密码/会话一律交给 better-auth**：`setUserPassword` / `verifyPassword` / `changePassword`
 *    都由库自己算哈希与校验，本项目不手写密码学（legacy 手写 scrypt + salt）。
 * 2. **状态页在数据库不可用时也必须出内容**：它存在的意义正是「告诉你数据库为什么挂了」，
 *    如果它自己也 503，管理员什么都看不到。
 * 3. **不假装有功能**：AI 日报的自动调度还没落地（P7），`digest.nextRunAt` 就返回 null，
 *    而不是编一个时间出来。
 *
 * ⚠️ 拆成 6 个工厂函数分别挂载（而不是一条 13 个端点的长链）：见 status.ts 顶部注释，
 *    单模块类型过重会让 Hono 的路由 schema 静默推成空。
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import type { AuthInstance } from '@feedlore/auth';
import { imageCache, users, type Db } from '@feedlore/db';
import {
  accountBody,
  admin as adminSpec,
  auth as authSpec,
  configPatchBody,
  userCreateBody,
  userPatchBody,
  type VersionCheck,
} from '@feedlore/contract';
import { assertResponse, BadRequest } from '../lib/validate';
import { requireAuth, type AppEnv } from '../middleware/auth';
import { getSource, saveSource } from '../lib/settings';
import { GITHUB_REPO, VERSION_TTL_MS, buildStatus, compareVersion } from '../lib/status';
import { resetImageCache } from './img';
import { safeFetch } from '../lib/net';
import { APP_VERSION } from '../env';

/** 原始 SQL 的行结果（drizzle `execute` 的 rows 是 unknown[]）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/* ============================================================================
 * 版本 / 更新
 * ==========================================================================*/

let versionCache: { at: number; data: VersionCheck } | null = null;

async function fetchGithubLatest(): Promise<VersionCheck> {
  const headers: Record<string, string> = {
    'User-Agent': 'feedlore-version-check',
    Accept: 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  // 走 safeFetch：这是服务端替自己出网，同样不该被 DNS rebinding 之类的手法带偏
  const rel = await safeFetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { headers });
  if (rel.ok) {
    const j = (await rel.json().catch(() => null)) as { tag_name?: string; html_url?: string; name?: string; published_at?: string } | null;
    if (j?.tag_name) {
      return {
        ok: true,
        latest: String(j.tag_name).replace(/^v/i, ''),
        releaseUrl: j.html_url ?? undefined,
        name: j.name ?? null,
        publishedAt: j.published_at ?? null,
        source: 'release',
      };
    }
  }

  const tagRes = await safeFetch(`https://api.github.com/repos/${GITHUB_REPO}/tags`, { headers });
  if (tagRes.ok) {
    const tags = (await tagRes.json().catch(() => null)) as Array<{ name?: string }> | null;
    if (Array.isArray(tags) && tags[0]?.name) {
      const latest = String(tags[0].name).replace(/^v/i, '');
      return {
        ok: true,
        latest,
        releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/v${latest}`,
        name: null,
        publishedAt: null,
        source: 'tag',
      };
    }
  }
  throw new Error('GitHub 上还没有任何发布');
}

/* ============================================================================
 * 路由
 * ==========================================================================*/

export function adminStatusRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- 状态 ---------------- */
    // 刻意不在开头就 `if (!db) 503`：库挂了正是这个页面要报的事
    .get(authSpec.status.path, requireAuth(auth, 'admin'), async (c) => c.json(await buildStatus(db)));
}

export function adminConfigRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- 采集参数 ---------------- */
    .get(adminSpec.configGet.path, requireAuth(auth, 'admin'), async (c) => {
      const me = c.get('user');
      const source = db ? await getSource(db) : await getSource(null);
      return c.json(
        assertResponse(adminSpec.configGet.response, { username: me.username, role: me.role, source }, 'GET /api/config'),
      );
    })
    .post(
      adminSpec.configPost.path,
      requireAuth(auth, 'admin'),
      zValidator('json', configPatchBody, (result) => {
        if (!result.success) throw new BadRequest('POST /api/config', result.error.issues);
      }),
      async (c) => {
        if (!db) return c.json({ error: '数据库未就绪' }, 503);
        const body = c.req.valid('json');
        if (!body.source || !Object.keys(body.source).length) {
          throw new BadRequest('POST /api/config', [{ path: ['source'], message: '没有可保存的字段' }]);
        }
        // 保存即刷新快照：抓取器下一轮、图片代理下一次请求就用新值（不用重启进程）
        const next = await saveSource(db, body.source);
        console.log(
          `[settings] 采集参数已更新：刷新 ${next.refreshMinutes} 分钟 / 并发 ${next.concurrency} / 保留 ${next.keepPerFeed} 条`,
        );
        if (next.proxyUrl) {
          // 生效是即时的（saveSource → setOutboundProxy），这里只留一行审计线索：
          // 代理一旦配错，表现是「全站抓取超时」，事后要知道是什么时候改的。
          console.log(`[settings] 出网代理已生效：${next.proxyUrl}`);
        }
        return c.json(assertResponse(adminSpec.configPost.response, { ok: true }, 'POST /api/config'));
      },
    );
}

export function adminImageCacheRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- 图片缓存 ---------------- */
    .get(adminSpec.imageCacheGet.path, requireAuth(auth, 'admin'), async (c) => {
      if (!db) return c.json({ error: '数据库未就绪' }, 503);
      const res = await db.execute(sql`select count(*)::int as n, coalesce(sum(size), 0) as bytes from image_cache`);
      const r = ((res.rows as unknown as Row[])[0] ?? {}) as Row;
      return c.json(
        assertResponse(
          adminSpec.imageCacheGet.response,
          { ok: true, count: Number(r.n ?? 0), bytes: Number(r.bytes ?? 0) },
          'GET /api/image-cache',
        ),
      );
    })
    .post(adminSpec.imageCacheClear.path, requireAuth(auth, 'admin'), async (c) => {
      if (!db) return c.json({ error: '数据库未就绪' }, 503);
      const before = await db.execute(sql`select count(*)::int as n from image_cache`);
      const n = Number((((before.rows as unknown as Row[])[0] ?? {}) as Row).n ?? 0);
      await db.execute(sql`delete from image_cache`);
      // ⚠️ L1 必须一起清：只删库的话，刚删掉的图还会从内存里命中，管理员以为没删掉
      resetImageCache();
      console.log(`[img] 图片缓存已手动清空：${n} 条`);
      return c.json(
        assertResponse(adminSpec.imageCacheClear.response, { ok: true, removed: n }, 'POST /api/image-cache/clear'),
      );
    });
}

export function adminUserRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- 用户管理 ---------------- */
    .get(adminSpec.usersList.path, requireAuth(auth, 'admin'), async (c) => {
      if (!db) return c.json({ error: '数据库未就绪' }, 503);
      const me = c.get('user');
      const rows = await db
        .select({ id: users.id, username: users.username, name: users.name, role: users.role, createdAt: users.createdAt })
        .from(users)
        .orderBy(users.createdAt);

      // 一次 group by 拿到全部频道数（legacy 是每用户查一次 = N+1）
      const cnt = await db.execute(sql`select owner_id, count(*)::int as n from feeds group by owner_id`);
      const perOwner = new Map<string, number>(
        (cnt.rows as unknown as Row[]).map((r) => [String(r.owner_id), Number(r.n)]),
      );

      const list = rows.map((u) => ({
        id: String(u.id),
        username: u.username || u.name || '',
        role: u.role === 'admin' ? ('admin' as const) : ('user' as const),
        createdAt: u.createdAt ? u.createdAt.toISOString() : null,
        feedCount: perOwner.get(String(u.id)) ?? 0,
        isSelf: String(u.id) === me.id,
      }));

      return c.json(assertResponse(adminSpec.usersList.response, { users: list }, 'GET /api/users'));
    })
    .post(
      adminSpec.userCreate.path,
      requireAuth(auth, 'admin'),
      zValidator('json', userCreateBody, (result) => {
        if (!result.success) throw new BadRequest('POST /api/users', result.error.issues);
      }),
      async (c) => {
        if (!db || !auth) return c.json({ error: '服务未就绪' }, 503);
        const body = c.req.valid('json');
        const username = body.username.trim();
        const role = body.role === 'admin' ? 'admin' : 'user';

        const dup = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
        if (dup.length) return c.json({ error: '用户名已存在' }, 409);

        // 走 better-auth 注册（密码哈希由库负责）；username 插件允许 signUpEmail 带 username
        try {
          await auth.api.signUpEmail({
            body: {
              email: `${username}@feedlore.local`,
              password: body.password,
              name: username,
              username,
            } as never,
          });
        } catch (e) {
          return c.json({ error: `创建失败：${(e as Error)?.message ?? e}` }, 400);
        }

        const created = await db
          .select({ id: users.id, username: users.username, role: users.role })
          .from(users)
          .where(eq(users.username, username))
          .limit(1);
        const row = created[0];
        if (!row) return c.json({ error: '创建失败：用户未落库' }, 500);

        if (role === 'admin') {
          await db.update(users).set({ role: 'admin' }).where(eq(users.id, row.id));
        }

        return c.json(
          assertResponse(
            adminSpec.userCreate.response,
            { ok: true, user: { id: String(row.id), username: row.username ?? username, role } },
            'POST /api/users',
          ),
        );
      },
    )
    .patch(
      adminSpec.userPatch.path,
      requireAuth(auth, 'admin'),
      zValidator('json', userPatchBody, (result) => {
        if (!result.success) throw new BadRequest('PATCH /api/users/:id', result.error.issues);
      }),
      async (c) => {
        if (!db || !auth) return c.json({ error: '服务未就绪' }, 503);
        const id = c.req.param('id');
        const body = c.req.valid('json');

        const target = await db
          .select({ id: users.id, username: users.username, role: users.role })
          .from(users)
          .where(eq(users.id, id))
          .limit(1);
        const row = target[0];
        if (!row) return c.json({ error: '用户不存在' }, 404);

        if (body.role !== undefined) {
          const nextRole = body.role === 'admin' ? 'admin' : 'user';
          if (row.role === 'admin' && nextRole !== 'admin') {
            const admins = await db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.role, 'admin'));
            if (admins.length <= 1) return c.json({ error: '至少要保留一个管理员' }, 400);
          }
          await db.update(users).set({ role: nextRole, updatedAt: new Date() }).where(eq(users.id, id));
        }

        if (body.password) {
          if (body.password.length < 4) return c.json({ error: '密码至少 4 位' }, 400);
          try {
            // 交给 better-auth：它自己取盐、算哈希，并处理「原本没有 credential 账号」的情况
            await auth.api.setUserPassword({
              body: { userId: id, newPassword: body.password },
              headers: c.req.raw.headers,
            });
          } catch (e) {
            return c.json({ error: `改密失败：${(e as Error)?.message ?? e}` }, 400);
          }
        }

        const fresh = await db
          .select({ id: users.id, username: users.username, role: users.role })
          .from(users)
          .where(eq(users.id, id))
          .limit(1);
        const f = fresh[0]!;
        return c.json(
          assertResponse(
            adminSpec.userPatch.response,
            {
              ok: true,
              user: { id: String(f.id), username: f.username ?? '', role: f.role === 'admin' ? 'admin' : 'user' },
            },
            'PATCH /api/users/:id',
          ),
        );
      },
    )
    .delete(adminSpec.userDelete.path, requireAuth(auth, 'admin'), async (c) => {
      if (!db) return c.json({ error: '数据库未就绪' }, 503);
      const id = c.req.param('id');
      const me = c.get('user');
      if (id === me.id) return c.json({ error: '不能删除当前登录的账号' }, 400);

      const target = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const row = target[0];
      if (!row) return c.json({ error: '用户不存在' }, 404);

      if (row.role === 'admin') {
        const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
        if (admins.length <= 1) return c.json({ error: '至少要保留一个管理员' }, 400);
      }

      // 外键链：feeds/digests/sessions/accounts/user_llm 全部 onDelete cascade，
      // entries 经 feeds 级联。一次 delete 清干净（legacy 也是靠级联）。
      await db.delete(users).where(eq(users.id, id));
      return c.json(assertResponse(adminSpec.userDelete.response, { ok: true }, 'DELETE /api/users/:id'));
    });
}

export function adminAccountRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- 账号（改自己的） ---------------- */
    .post(
      adminSpec.account.path,
      requireAuth(auth, 'user'),
      zValidator('json', accountBody, (result) => {
        if (!result.success) throw new BadRequest('POST /api/account', result.error.issues);
      }),
      async (c) => {
        if (!db || !auth) return c.json({ error: '服务未就绪' }, 503);
        const me = c.get('user');
        const body = c.req.valid('json');
        const newUser = (body.username ?? '').trim();

        if (!newUser && !body.newPassword) {
          return c.json({ error: '用户名和新密码至少填一项' }, 400);
        }

        // 当前密码校验：用 better-auth 自己的 verifyPassword（不手写哈希比较），
        // 且它不签发新会话，不会给 sessions 表留垃圾行
        try {
          await auth.api.verifyPassword({
            body: { password: body.currentPassword },
            headers: c.req.raw.headers,
          });
        } catch {
          return c.json({ error: '当前密码不正确' }, 400);
        }

        if (body.newPassword) {
          if (body.newPassword.length < 4) return c.json({ error: '新密码至少 4 位' }, 400);
          try {
            await auth.api.changePassword({
              body: { currentPassword: body.currentPassword, newPassword: body.newPassword, revokeOtherSessions: false },
              headers: c.req.raw.headers,
            });
          } catch (e) {
            return c.json({ error: `改密失败：${(e as Error)?.message ?? e}` }, 400);
          }
        }

        let username = me.username;
        if (newUser && newUser !== me.username) {
          const dup = await db.select({ id: users.id }).from(users).where(eq(users.username, newUser)).limit(1);
          if (dup.length) return c.json({ error: '用户名已被占用' }, 400);
          // username 插件按 username 列登录；display_username 只影响展示，两个一起改
          await db
            .update(users)
            .set({ username: newUser, displayUsername: newUser, updatedAt: new Date() })
            .where(eq(users.id, me.id));
          username = newUser;
        }

        return c.json(
          assertResponse(
            adminSpec.account.response,
            { ok: true, username, role: me.role },
            'POST /api/account',
          ),
        );
      },
    );
}

export function adminVersionRoutes(db: Db | null, auth: AuthInstance | null) {
  return new Hono<AppEnv>()
    /* ---------------- 版本 ---------------- */
    .get(authSpec.version.path, requireAuth(auth, 'user'), async (c) =>
      c.json(
        assertResponse(
          authSpec.version.response,
          {
            version: APP_VERSION,
            repo: GITHUB_REPO,
            updateEnabled: Boolean(process.env.UPDATE_WEBHOOK_URL && process.env.UPDATE_WEBHOOK_TOKEN),
          },
          'GET /api/version',
        ),
      ),
    )
    .post(authSpec.versionCheck.path, requireAuth(auth, 'user'), async (c) => {
      const now = Date.now();
      if (versionCache && now - versionCache.at < VERSION_TTL_MS) {
        return c.json(versionCache.data);
      }
      try {
        const info = await fetchGithubLatest();
        const data = assertResponse(
          authSpec.versionCheck.response,
          {
            ...info,
            current: APP_VERSION,
            hasUpdate: compareVersion(info.latest ?? '0', APP_VERSION) > 0,
          },
          'POST /api/version/check',
        );
        versionCache = { at: now, data };
        return c.json(data);
      } catch (e) {
        // 契约里这条是「查询结果」，失败也用 200 + ok:false（前端据此显示「检查失败」）
        return c.json(
          assertResponse(
            authSpec.versionCheck.response,
            { ok: false, error: String((e as Error)?.message ?? e) },
            'POST /api/version/check',
          ),
        );
      }
    })
    .post(authSpec.update.path, requireAuth(auth, 'admin'), async (c) => {
      const hookUrl = process.env.UPDATE_WEBHOOK_URL ?? '';
      const hookToken = process.env.UPDATE_WEBHOOK_TOKEN ?? '';
      if (!hookUrl || !hookToken) {
        return c.json({ error: '未配置更新通道（UPDATE_WEBHOOK_URL / UPDATE_WEBHOOK_TOKEN）' }, 501);
      }

      // ⚠️ 这里**刻意不用 safeFetch**：watchtower 基本都跑在同一台机器的内网网络里
      // （如 http://watchtower:8080），过内网判定会被一律 400，一键更新直接失效。
      // 这个地址来自**部署者写的环境变量**，不是用户输入，不构成 SSRF 面。
      const u = new URL(hookUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return c.json({ error: '更新通道地址协议非法' }, 400);
      }

      try {
        const resp = await fetch(hookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hookToken}` },
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) throw new Error(`watchtower HTTP ${resp.status}`);
        console.log('[update] 已触发 watchtower 更新');
        return c.json(assertResponse(authSpec.update.response, { ok: true }, 'POST /api/update'));
      } catch (e) {
        return c.json({ error: `触发更新失败：${(e as Error)?.message ?? e}` }, 502);
      }
    });
}
