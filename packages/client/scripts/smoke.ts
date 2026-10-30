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

  // 10) 登出
  try {
    const r = await api.logout();
    if (!r.ok) throw new Error('登出返回 ok=false');
    ok('POST /api/logout');
  } catch (e) {
    bad('POST /api/logout', e);
  }

  // 11) 登出后必须失效
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
