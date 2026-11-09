/* 图片失败负缓存（会话级，内存）。
 *
 * 为什么需要：卡片墙 / 文章列表 / 日报里的图大量来自已经失效的 CDN（Telegraph 等）。
 * 此前失败只记在组件本地 useState，切筛选、翻页、刷新列表一重挂载就清零，
 * 同一批死链会反复发起请求 —— 既拖慢真正要看的图，也让 404 在源站和 WAF 日志里刷屏。
 *
 * 语义约束：
 * - 只记「确认失败」（LazyImg 是重试也失败之后），不记还在加载的图；
 * - TTL 10 分钟：图片只是临时抖一下时，最多 10 分钟后会自动重试；
 * - 离线时不记：断网造成的失败不是图片本身的问题；
 * - 手动刷新（core/ui.js 的 refreshFeeds）与浏览器恢复联网时整体清空；
 * - key 归一到原始图片地址：srcset 的 `w=`、失败重试的 `r=`、hash 都不参与比较。
 */

export const IMG_FAIL_TTL_MS = 10 * 60 * 1000;
export const IMG_FAIL_MAX = 500;

const PROXY_PREFIX = '/api/img?';
const failed = new Map();   // key -> 过期时间戳（Map 插入序用于淘汰最旧的一条）

/** 归一化图片地址：去掉 srcset 宽度、重试标记与 hash；空值返回 ''。 */
export function imgFailKey(src) {
  const raw = String(src || '');
  // data URI 本身就是完整图片（可能是几十 KB 的 base64），不该塞进内存表
  if (!raw || /^data:/i.test(raw)) return '';
  const cut = raw.split('#')[0];
  if (!cut.startsWith(PROXY_PREFIX)) return cut;
  const params = new URLSearchParams(cut.slice(PROXY_PREFIX.length));
  params.delete('w');
  params.delete('r');
  return PROXY_PREFIX + params.toString();
}

/** 该地址是否在负缓存有效期内。 */
export function isImgFailed(src, now = Date.now()) {
  const key = imgFailKey(src);
  if (!key) return false;
  const expiresAt = failed.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    failed.delete(key);
    return false;
  }
  return true;
}

/** 记录一次失败。离线时不记 —— 那是网络问题，恢复后应当重新尝试。 */
export function markImgFailed(src, now = Date.now()) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const key = imgFailKey(src);
  if (!key) return;
  failed.delete(key);
  failed.set(key, now + IMG_FAIL_TTL_MS);
  while (failed.size > IMG_FAIL_MAX) {
    const oldest = failed.keys().next();
    if (oldest.done) break;
    failed.delete(oldest.value);
  }
}

/** 手动刷新 / 恢复联网时调用：清空后所有图重新尝试一次。 */
export function clearImgFail() {
  failed.clear();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', () => clearImgFail());
}
