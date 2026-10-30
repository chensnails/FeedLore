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

  // 14) 新增频道（公网地址，不抓取只落库）→ 改分组/开关 → 重排 → 删除
  let tmpFeedId: string | null = null;
  try {
    const created = await api.feeds.create({
      url: 'https://example.com/feed.xml',
      groupName: 'smoke 测试组',
      enabled: true,
      cardEnabled: false,
    });
    tmpFeedId = created.feed.id;
    if (created.added !== 0) throw new Error('抓取器未接入时 added 应为 0');
    ok(
      'POST /api/feeds 新增',
      `id=${created.feed.id} existed=${created.existed} group=${created.feed.groupName} added=${created.added}`,
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

  // 17) 登出
  try {
    const r = await api.logout();
    if (!r.ok) throw new Error('登出返回 ok=false');
    ok('POST /api/logout');
  } catch (e) {
    bad('POST /api/logout', e);
  }

  // 18) 登出后必须失效
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
