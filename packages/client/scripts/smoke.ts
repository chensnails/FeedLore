/**
 * 类型化客户端冒烟：Node 下跑一遍「未登录 → 登录 → 取频道 → 登出 → 再访问」。
 *
 * 与 curl 自检的区别：这里走的是 `hc<AppType>` + 契约校验的真实客户端代码路径，
 * 路径拼错 / 响应结构漂移会直接失败（编译期或 ContractError），而不是"看着像成功"。
 *
 *   API_BASE=http://127.0.0.1:3211 ADMIN_USER=admin ADMIN_PASS=xxxx pnpm --filter @feedlore/client smoke
 */

import { createApiClient, ApiError } from '../src/index';
import { createCookieJarFetch } from '../src/node';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3211';
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASS ?? '';

let failed = 0;

function ok(label: string, extra = ''): void {
  console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`);
}

function bad(label: string, err: unknown): void {
  failed += 1;
  console.error(`  ✗ ${label} —`, err instanceof Error ? err.message : err);
}

async function main(): Promise<void> {
  if (!PASS) {
    console.error('缺少 ADMIN_PASS 环境变量');
    process.exit(2);
  }

  const jar = createCookieJarFetch();
  const api = createApiClient(BASE, { fetch: jar.fetch, credentials: 'omit' });

  console.log(`[smoke] ${BASE}`);

  // 1) 未登录
  try {
    const s = await api.session();
    if (s.authenticated) throw new Error('未登录却拿到已认证会话');
    ok('GET /api/session 未登录', `dbReady=${s.dbReady}`);
  } catch (e) {
    bad('GET /api/session 未登录', e);
  }

  // 2) 受保护端点应 401
  try {
    await api.feeds.list();
    bad('GET /api/feeds 未登录应 401', new Error('居然成功了'));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) ok('GET /api/feeds 未登录 → 401');
    else bad('GET /api/feeds 未登录 → 401', e);
  }

  // 3) 登录
  try {
    const r = await api.login({ username: USER, password: PASS });
    if (!r.ok) throw new Error('登录返回 ok=false');
    ok('POST /api/login', `role=${r.role} cookie=${jar.cookieHeader() ? '有' : '无'}`);
  } catch (e) {
    bad('POST /api/login', e);
    return;
  }

  // 4) 会话已建立
  try {
    const s = await api.session();
    if (!s.authenticated) throw new Error('登录后会话仍未建立');
    ok('GET /api/session 已登录', `user=${s.username} role=${s.role}`);
  } catch (e) {
    bad('GET /api/session 已登录', e);
  }

  // 5) 频道列表（契约类型直接可用：下面这些字段访问本身就是编译期证明）
  try {
    const { feeds, total, groups, flags } = await api.feeds.list();
    const first = feeds[0];
    ok(
      'GET /api/feeds',
      `total=${total} groups=${groups.length} unread=${flags.unread}` +
        (first ? ` first=${first.title}(${first.id}, unread=${first.unreadCount})` : ''),
    );
  } catch (e) {
    bad('GET /api/feeds', e);
  }

  // 6) 条目列表（契约类型直接可用：下面这些字段访问本身就是编译期证明）
  try {
    const { entries, total, hasMore, tags } = await api.entries.list({ limit: '10' });
    const first = entries[0];
    ok(
      'GET /api/entries',
      `total=${total} 本页=${entries.length} hasMore=${hasMore} tags=${tags.length}` +
        (first ? ` first=${first.name}(${first.id}, ${first.feedName})` : ''),
    );

    if (first) {
      const detail = await api.entries.detail(first.id);
      ok('GET /api/entries/:id', `content=${detail.content.length} 字, name=${detail.name}`);
    }
  } catch (e) {
    bad('GET /api/entries', e);
  }

  // 7) 条目徽标
  try {
    const flags = await api.entries.flags();
    ok('GET /api/entries/flags', `total=${flags.total} unread=${flags.unread} fav=${flags.favorite}`);
  } catch (e) {
    bad('GET /api/entries/flags', e);
  }

  // 8) 越权读：不存在的 id 必须 404（不是 500，也不是空对象）
  try {
    await api.entries.detail('999999999');
    bad('GET /api/entries/999999999 应 404', new Error('居然成功了'));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) ok('GET /api/entries/999999999 → 404');
    else bad('GET /api/entries/999999999 → 404', e);
  }

  /* ---------------- 图片代理 ----------------
   * 判据是「真的把一张外网图取回来」，不是「接口没报错」：
   * 拿列表里第一条带封面的条目（其 image 已被服务端改写成 /api/img?u=...），
   * 直接请求那个地址，校验状态 / Content-Type / 字节数 / 安全头。
   * 1.7.x 的教训——测试桩全绿、线上全挂，就是因为没走真实出网链路。 */
  let proxyPath: string | null = null;
  try {
    const { entries } = await api.entries.list({ limit: '50' });
    const withImg = entries.find((e) => e.image);
    proxyPath = withImg?.image ?? null;

    if (!proxyPath) {
      ok('GET /api/img', '跳过：当前库里没有带封面的条目');
    } else {
      const t0 = Date.now();
      const r1 = await jar.fetch(`${BASE}${proxyPath}`);
      const ct = r1.headers.get('content-type') ?? '';
      const buf = Buffer.from(await r1.arrayBuffer());
      if (!r1.ok) throw new Error(`HTTP ${r1.status}`);
      if (!/^image\//i.test(ct)) throw new Error(`content-type=${ct}`);
      if (buf.length === 0) throw new Error('空响应');

      // SVG 通过 <img> 不执行脚本，但「右键 → 新标签打开」就是同源文档。
      // 这两个头是把它锁进沙箱的唯一手段，缺了等于留一个 XSS 口子。
      const csp = r1.headers.get('content-security-policy') ?? '';
      if (!/sandbox/.test(csp)) throw new Error(`缺 CSP sandbox（${csp || '空'}）`);
      if (r1.headers.get('x-content-type-options') !== 'nosniff') throw new Error('缺 nosniff');

      ok('GET /api/img 回源成功', `${ct} ${(buf.length / 1024).toFixed(1)}KB ${Date.now() - t0}ms`);

      // 第二次必须走缓存：命中 L1/L2 时不该再解析压缩
      const t1 = Date.now();
      const r2 = await jar.fetch(`${BASE}${proxyPath}`);
      const buf2 = Buffer.from(await r2.arrayBuffer());
      if (!r2.ok || buf2.length !== buf.length) {
        throw new Error(`二次请求不一致：HTTP ${r2.status} ${buf2.length}B vs ${buf.length}B`);
      }
      ok('GET /api/img 二次命中缓存', `${Date.now() - t1}ms`);
    }
  } catch (e) {
    bad('GET /api/img', e);
  }

  // 图片代理也是出网入口：内网/云元数据地址必须在这一层被拦（否则就是个 SSRF 探针）
  for (const evil of ['http://127.0.0.1/a.png', 'http://169.254.169.254/latest/meta-data/']) {
    try {
      const r = await jar.fetch(`${BASE}/api/img?u=${encodeURIComponent(evil)}`);
      await r.body?.cancel();
      if (r.status === 400) ok('GET /api/img 拦内网地址 → 400', evil);
      else bad(`GET /api/img ${evil} 应 400`, new Error(`HTTP ${r.status}`));
    } catch (e) {
      bad(`GET /api/img ${evil} → 400`, e);
    }
  }

  // 未登录必须 401：代理不做鉴权等于给全网开了一个免费图床 + 探针
  if (proxyPath) {
    try {
      const r = await fetch(`${BASE}${proxyPath}`);
      await r.body?.cancel();
      if (r.status === 401) ok('GET /api/img 未登录 → 401');
      else bad('GET /api/img 未登录 → 401', new Error(`HTTP ${r.status}`));
    } catch (e) {
      bad('GET /api/img 未登录 → 401', e);
    }
  }

  // 9) 偏好
  try {
    const p = await api.prefs.get();
    ok(
      'GET /api/prefs',
      `theme=${p.appearance.theme} view=${p.layout.view} 分组顺序=${p.groupOrder.length} ` +
        `过滤=${p.filters.length} 关注=${p.watchRules.length} llm.key=${p.llm.apiKeySet}`,
    );
  } catch (e) {
    bad('GET /api/prefs', e);
  }

  /* ---------------- 写操作 ----------------
   * 原则：每条写都要能被自己撤回，跑完不改变测试库的可见状态。 */

  // 10) 单条标记：已读 → 撤回（时间戳跟随布尔是 legacy 的既定语义）
  let firstEntryId: string | null = null;
  try {
    const { entries } = await api.entries.list({ limit: '1' });
    firstEntryId = entries[0]?.id ?? null;
    if (firstEntryId) {
      const r1 = await api.entries.flagPatch(firstEntryId, { isRead: true });
      if (!r1.isRead) throw new Error('标记已读未生效');
      const r2 = await api.entries.flagPatch(firstEntryId, { isRead: false });
      if (r2.isRead) throw new Error('撤回已读未生效');
      ok('PATCH /api/entries/:id 已读 ↔ 撤回', `id=${firstEntryId}`);

      const f1 = await api.entries.flagPatch(firstEntryId, { isFavorite: true });
      if (!f1.isFavorite || !f1.favoritedAt) throw new Error('收藏未生效（或 favoritedAt 没写）');
      const f2 = await api.entries.flagPatch(firstEntryId, { isFavorite: false });
      if (f2.isFavorite || f2.favoritedAt) throw new Error('取消收藏未清 favoritedAt');
      ok('PATCH /api/entries/:id 收藏 ↔ 取消', 'favoritedAt 随布尔同步');
    } else {
      ok('PATCH /api/entries/:id', '跳过：库里没有条目');
    }
  } catch (e) {
    bad('PATCH /api/entries/:id', e);
  }

  // 11) 单条标记的负向用例：不存在的 id → 404；空 body → 400
  try {
    await api.entries.flagPatch('999999999', { isRead: true });
    bad('PATCH /api/entries/999999999 应 404', new Error('居然成功了'));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) ok('PATCH /api/entries/999999999 → 404');
    else bad('PATCH /api/entries/999999999 → 404', e);
  }
  try {
    if (firstEntryId) {
      await api.entries.flagPatch(firstEntryId, {});
      bad('PATCH 空 body 应 400', new Error('居然成功了'));
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) ok('PATCH 空 body → 400');
    else bad('PATCH 空 body → 400', e);
  }

  // 12) 全部已读：空 feeds 数组必须「一条都不标」（明确语义，防误伤全库）
  try {
    const r0 = await api.entries.readAll({ feeds: [] });
    if (r0.updated !== 0) throw new Error(`空 feeds 竟标了 ${r0.updated} 条`);
    // 不存在的频道 id 同理
    const r1 = await api.entries.readAll({ feeds: [999999999] });
    if (r1.updated !== 0) throw new Error(`不存在的频道竟标了 ${r1.updated} 条`);
    ok('POST /api/entries/read-all 边界', '空数组 / 非本用户频道 → updated=0');
  } catch (e) {
    bad('POST /api/entries/read-all 边界', e);
  }

  // 13) 新增频道：内网地址必须 400（这是 SSRF 的第一道闸）
  for (const evil of ['http://127.0.0.1:8080/feed', 'http://169.254.169.254/latest/meta-data/']) {
    try {
      await api.feeds.create({ url: evil });
      bad(`POST /api/feeds ${evil} 应 400`, new Error('居然成功了'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) ok(`POST /api/feeds 拦内网地址 → 400`, evil);
      else bad(`POST /api/feeds ${evil} → 400`, e);
    }
  }

  // 14) 新增频道（公网地址但**没有 RSS**）→ 改分组/开关 → 重排 → 删除
  let tmpFeedId: string | null = null;
  try {
    const created = await api.feeds.create({
      url: 'https://example.com/feed.xml',
      groupName: 'smoke 测试组',
      enabled: true,
      cardEnabled: false,
    });
    tmpFeedId = created.feed.id;
    /* P5 起新增会立即抓一次：example.com/feed.xml 是 404，
     * 所以这里 added=0 **且** status='error' —— 频道建成功、源站报错，两件事要同时成立。 */
    if (created.added !== 0) throw new Error(`404 地址竟抓到 ${created.added} 条`);
    if (created.feed.status !== 'error') throw new Error(`404 地址的 status 应为 error，实际 ${created.feed.status}`);
    ok(
      'POST /api/feeds 新增（源站 404）',
      `id=${created.feed.id} existed=${created.existed} added=${created.added} status=${created.feed.status}`,
    );

    // 同地址再建一次：existed=true，不产生第二条
    const again = await api.feeds.create({ url: 'https://example.com/feed.xml' });
    if (!again.existed || again.feed.id !== created.feed.id) {
      throw new Error('重复地址没有返回同一频道（existed 语义错）');
    }
    ok('POST /api/feeds 重复地址', `existed=true id=${again.feed.id}`);

    const patched = await api.feeds.patch(tmpFeedId, {
      groupName: 'smoke 已改',
      cardEnabled: true,
      refreshMinutes: 3, // 低于下限，应被夹到 5
    });
    if (patched.feed.groupName !== 'smoke 已改') throw new Error('分组未更新');
    if (!patched.feed.cardEnabled) throw new Error('卡片开关未更新');
    if (patched.feed.refreshMinutes !== 5) throw new Error(`频率未夹到 5，实际 ${patched.feed.refreshMinutes}`);
    ok('PATCH /api/feeds/:id', `group=${patched.feed.groupName} 频率夹取=5`);

    // 改成另一个已存在的地址 → 409
    const { feeds: mine } = await api.feeds.list();
    const other = mine.find((f) => f.id !== tmpFeedId);
    if (other) {
      try {
        await api.feeds.patch(tmpFeedId, { url: other.url });
        bad('PATCH 地址撞车应 409', new Error('居然成功了'));
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) ok('PATCH /api/feeds/:id 地址撞车 → 409');
        else bad('PATCH 地址撞车 → 409', e);
      }
    }

    const reordered = await api.feeds.reorder({
      feeds: [
        { id: Number(tmpFeedId), sortOrder: 0, groupName: 'smoke 首位' },
        { id: Number(other?.id ?? tmpFeedId), sortOrder: 1 },
      ],
    });
    if (!reordered.ok) throw new Error('重排返回 ok=false');
    ok('POST /api/feeds/reorder', `updated=${reordered.updated}`);

    const del = await api.feeds.remove(tmpFeedId);
    if (!del.ok) throw new Error('删除返回 ok=false');
    tmpFeedId = null;
    ok('DELETE /api/feeds/:id');
  } catch (e) {
    bad('频道写操作', e);
  } finally {
    // 兜底清理：中途失败也别在库里留测试频道
    if (tmpFeedId) {
      await api.feeds.remove(tmpFeedId).catch(() => undefined);
    }
  }

  // 14b) 真实源抓取（默认用用户给的两个测试源，可用 SMOKE_FEEDS 覆盖，逗号分隔）
  const realFeeds = (process.env.SMOKE_FEEDS ?? 'https://www.ithome.com/rss/,https://rsshub.9610000.xyz/telegram/channel/bdwpzhpd')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const realFeedIds: string[] = [];
  for (const url of realFeeds) {
    try {
      const created = await api.feeds.create({ url, groupName: 'smoke 真实源' });
      realFeedIds.push(created.feed.id);

      if (created.existed) {
        // 第二轮起是已存在：改用单频道刷新，仍然要求能拿到「成功」状态
        const r = await api.feeds.refreshOne(created.feed.id);
        if (!r.ok) throw new Error(`已存在的源刷新失败：${r.result.error ?? '未知'}`);
        ok(`POST /api/feeds/:id/refresh`, `${url} added=${r.result.added ?? 0}`);
      } else {
        if (created.added <= 0) throw new Error('新源首抓没有抓到任何条目');
        ok('POST /api/feeds 首抓', `${url} added=${created.added} status=${created.feed.status}`);
      }

      // 抓到的条目必须真的能按频道筛出来，并且详情带正文
      const page = await api.entries.list({ feeds: created.feed.id, limit: '3' });
      if (!page.entries.length) throw new Error('该频道筛不出条目');
      const detail = await api.entries.detail(page.entries[0]!.id);
      ok(
        '抓取结果可读',
        `${page.total} 条，首条「${detail.name.slice(0, 24)}」正文 ${detail.content.length} 字`,
      );
    } catch (e) {
      bad(`真实源 ${url}`, e);
    }
  }

  // 14c) 刷新全部（含刚加的两个真实源；只抓开启采集的频道）
  try {
    const r = await api.feeds.refreshAll();
    ok(
      'POST /api/feeds/refresh',
      `added=${r.added} skipped=${r.skipped} failed=${r.failed.length} 过滤=${r.filtered ?? 0}`,
    );
    if (r.failed.length) {
      console.log(`    失败源：${r.failed.map((f) => f.url + ' → ' + f.error).join('; ')}`);
    }
  } catch (e) {
    bad('POST /api/feeds/refresh', e);
  }

  // 15) 偏好保存：改主题必须保留未提交的键（合并语义，不是整份替换）
  try {
    const before = await api.prefs.get();
    const saved = await api.prefs.update({ appearance: { theme: 'dark' } });
    if (saved.appearance.theme !== 'dark') throw new Error('主题未保存');
    if (saved.appearance.accent !== before.appearance.accent) {
      throw new Error(`未提交的 accent 被冲掉了：${before.appearance.accent} → ${saved.appearance.accent}`);
    }
    const reread = await api.prefs.get();
    if (reread.appearance.theme !== 'dark') throw new Error('重新读取不是已保存的主题');
    ok('POST /api/prefs 合并语义', `theme=dark，accent 保持 ${saved.appearance.accent}`);

    // 测完还原，别把测试库的主题留在 dark
    await api.prefs.update({ appearance: { theme: before.appearance.theme } });
    ok('POST /api/prefs 还原');
  } catch (e) {
    bad('POST /api/prefs', e);
  }

  // 16) 偏好负向：内网 webhook 必须 400（S-06 出网口）
  try {
    await api.prefs.update({ webhookUrl: 'http://127.0.0.1:8080/hook' });
    bad('POST /api/prefs 内网 webhook 应 400', new Error('居然成功了'));
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) ok('POST /api/prefs 拦内网 webhook → 400');
    else bad('POST /api/prefs 内网 webhook → 400', e);
  }

  /* ============================ 管理端 ============================ */

  // 17) 状态聚合
  try {
    const st = await api.admin.status();
    if (!st.db.ready) throw new Error(`数据库不可用：${st.db.error ?? '未知'}`);
    if (!st.app.version) throw new Error('version 为空');
    if (st.rss.feeds.total < 0) throw new Error('频道计数异常');
    ok(
      'GET /api/status',
      `v${st.app.version} · db ${st.db.latencyMs}ms · 池 ${st.db.pool?.total ?? '-'}/${st.db.pool?.max ?? '-'} · ` +
        `频道 ${st.rss.feeds.total} · 条目 ${st.rss.entries.total} · 问题 ${st.rss.problems.length}`,
    );
  } catch (e) {
    bad('GET /api/status', e);
  }

  // 18) 采集参数：越界值必须被夹回区间（不是报错，也不是原样存进去）
  try {
    const cfg = await api.admin.config();
    if (cfg.username !== USER) throw new Error(`回显的 username 不符：${cfg.username}`);
    const origin = { refreshMinutes: cfg.source.refreshMinutes, keepPerFeed: cfg.source.keepPerFeed };

    await api.admin.saveConfig({ source: { refreshMinutes: 9999, keepPerFeed: -5 } });
    const clamped = await api.admin.config();
    if (clamped.source.refreshMinutes !== 1440) {
      throw new Error(`refreshMinutes 未夹到 1440，实际 ${clamped.source.refreshMinutes}`);
    }
    if (clamped.source.keepPerFeed !== 0) {
      throw new Error(`keepPerFeed 未夹到 0，实际 ${clamped.source.keepPerFeed}`);
    }
    ok('POST /api/config 越界值夹取', '9999 → 1440，-5 → 0');

    // 还原：下一轮抓取的间隔别被测试改掉
    await api.admin.saveConfig({ source: origin });
    const back = await api.admin.config();
    if (back.source.refreshMinutes !== origin.refreshMinutes) throw new Error('还原 refreshMinutes 失败');
    ok('POST /api/config 还原', `refreshMinutes=${back.source.refreshMinutes}`);
  } catch (e) {
    bad('POST /api/config', e);
  }

  // 19) 图片缓存统计
  try {
    const c = await api.admin.imageCache();
    if (typeof c.count !== 'number' || typeof c.bytes !== 'number') throw new Error('字段类型不对');
    ok('GET /api/image-cache', `${c.count} 张 · ${(c.bytes / 1024).toFixed(0)}KB`);
  } catch (e) {
    bad('GET /api/image-cache', e);
  }

  // 20) 用户列表
  try {
    const list = await api.admin.users.list();
    const me = list.find((u) => u.isSelf);
    if (!me) throw new Error('列表里找不到 isSelf 的那个用户');
    if (me.role !== 'admin') throw new Error('当前账号不是管理员');
    ok('GET /api/users', `${list.length} 个用户 · 自己 ${me.username} · 频道 ${me.feedCount}`);
  } catch (e) {
    bad('GET /api/users', e);
  }

  // 21) 用户 CRUD + 权限隔离（新建一个临时账号，最后删掉）
  const tempName = 'smoke_' + String(Date.now()).slice(-6);
  let tempId = '';
  try {
    const created = await api.admin.users.create({ username: tempName, password: 'smoke-pass-1', role: 'user' });
    tempId = created.user.id;
    if (created.user.role !== 'user') throw new Error('角色不对');
    ok('POST /api/users 创建', `${created.user.username} (${tempId})`);

    // 重复用户名必须 409（「已存在」是冲突，不是请求格式错）
    try {
      await api.admin.users.create({ username: tempName, password: 'smoke-pass-2' });
      throw new Error('重复用户名居然成功了');
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
      ok('POST /api/users 重名 → 409');
    }

    // 新账号必须能登录，但看不到管理端（权限在后端，不是靠前端藏按钮）
    const jar2 = createCookieJarFetch();
    const api2 = createApiClient(BASE, { fetch: jar2.fetch, credentials: 'omit' });
    const login2 = await api2.login({ username: tempName, password: 'smoke-pass-1' });
    if (login2.role !== 'user') throw new Error(`新账号角色成了 ${login2.role}`);
    try {
      await api2.admin.status();
      throw new Error('普通用户读到了 /api/status');
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 403) throw e;
      ok('普通用户访问 /api/status → 403');
    }

    // 改角色 + 重置密码（新密码要能真的登录，否则「重置」只是改了个字段）
    const promoted = await api.admin.users.patch(tempId, { role: 'admin' });
    if (promoted.user.role !== 'admin') throw new Error('提权失败');
    await api.admin.users.patch(tempId, { password: 'smoke-pass-9' });
    const jar3 = createCookieJarFetch();
    const api3 = createApiClient(BASE, { fetch: jar3.fetch, credentials: 'omit' });
    await api3.login({ username: tempName, password: 'smoke-pass-9' });
    ok('PATCH /api/users/:id', '角色改为 admin，重置后的新密码可登录');

    // 不能删自己
    const me = (await api.admin.users.list()).find((u) => u.isSelf);
    try {
      await api.admin.users.remove(me!.id);
      throw new Error('删掉了自己');
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 400) throw e;
      ok('DELETE /api/users/:id 删自己 → 400');
    }
  } catch (e) {
    bad('POST/PATCH /api/users', e);
  } finally {
    // 无论上面哪一步失败都要清掉临时账号，否则测试库会越积越多
    if (tempId) {
      try {
        await api.admin.users.remove(tempId);
        ok('DELETE /api/users/:id 清理临时账号');
      } catch (e) {
        bad('DELETE /api/users/:id 清理临时账号', e);
      }
    }
  }

  // 22) 账号：当前密码错必须 400（不区分「用户不存在」与「密码错」）
  try {
    await api.account({ currentPassword: 'definitely-not-the-password', newPassword: 'whatever-1' });
    throw new Error('错误密码居然通过了');
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) ok('POST /api/account 当前密码错 → 400');
    else bad('POST /api/account 当前密码错 → 400', e);
  }

  // 23) 版本：info 必成功；check 依赖外网，只断言形状
  try {
    const v = await api.version.info();
    if (!v.version || !v.repo) throw new Error('version/repo 为空');
    const c = await api.version.check();
    if (typeof c.ok !== 'boolean') throw new Error('check 缺 ok 字段');
    ok(
      'GET /api/version + check',
      c.ok
        ? `当前 ${v.version} / 最新 ${c.latest ?? '?'}（hasUpdate=${c.hasUpdate}）`
        : `当前 ${v.version} / 检查失败：${c.error ?? ''}`,
    );
  } catch (e) {
    bad('GET /api/version', e);
  }

  // 24) 登出
  try {
    const r = await api.logout();
    if (!r.ok) throw new Error('登出返回 ok=false');
    ok('POST /api/logout');
  } catch (e) {
    bad('POST /api/logout', e);
  }

  // 25) 登出后必须失效
  try {
    const s = await api.session();
    if (s.authenticated) throw new Error('登出后会话仍有效');
    ok('登出后 GET /api/session 为未登录');
  } catch (e) {
    bad('登出后 GET /api/session 为未登录', e);
  }

  console.log(failed === 0 ? '[smoke] 全部通过' : `[smoke] ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
