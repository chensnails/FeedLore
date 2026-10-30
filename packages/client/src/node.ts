/**
 * Node 侧辅助：给 fetch 套一个内存 Cookie Jar。
 *
 * 为什么需要：Node 的 fetch / undici **不带 Cookie 容器**（不像浏览器自动存/带），
 * 而 better-auth 的会话完全靠 Cookie。服务端渲染、CLI、冒烟脚本若不接管 Cookie，
 * 表现就是「登录返回 200 但下一次请求仍 401」——排查半天以为鉴权坏了。
 */

interface JarEntry {
  value: string;
  /** 0 表示会话级（不写 Expires 的 Cookie）。 */
  expiresAt: number;
}

function parseSetCookie(sc: string): { name: string; entry: JarEntry } | null {
  const first = sc.split(';', 1)[0] ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  let expiresAt = 0;
  for (const part of sc.split(';').slice(1)) {
    const [rawK, ...rest] = part.split('=');
    const k = (rawK ?? '').trim().toLowerCase();
    const v = rest.join('=').trim();
    if (k === 'max-age') {
      const sec = Number(v);
      if (Number.isFinite(sec)) expiresAt = sec <= 0 ? -1 : Date.now() + sec * 1000;
    } else if (k === 'expires' && v) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) expiresAt = t <= Date.now() ? -1 : t;
    }
  }
  return { name, entry: { value, expiresAt } };
}

export interface CookieJarFetch {
  /** 可直接传给 createApiClient({ fetch }) 的函数。 */
  fetch: typeof fetch;
  /** 当前 Cookie 头（调试用）。 */
  cookieHeader(): string;
  /** 清空。 */
  clear(): void;
}

export function createCookieJarFetch(inner: typeof fetch = globalThis.fetch): CookieJarFetch {
  const jar = new Map<string, JarEntry>();

  const live = (): string =>
    [...jar.entries()]
      .filter(([, e]) => e.expiresAt !== -1 && (e.expiresAt === 0 || e.expiresAt > Date.now()))
      .map(([k, e]) => `${k}=${e.value}`)
      .join('; ');

  const wrapped: typeof fetch = async (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const cookie = live();
    if (cookie) headers.set('cookie', cookie);

    const res = await inner(input, { ...init, headers });

    // Node 22 / undici 支持 getSetCookie()；老实现回退到单值头。
    const raw = res.headers as Headers & { getSetCookie?: () => string[] };
    const list = typeof raw.getSetCookie === 'function' ? raw.getSetCookie() : [];
    for (const sc of list) {
      const parsed = parseSetCookie(sc);
      if (!parsed) continue;
      if (parsed.entry.expiresAt === -1) jar.delete(parsed.name);
      else jar.set(parsed.name, parsed.entry);
    }
    return res;
  };

  return {
    fetch: wrapped,
    cookieHeader: live,
    clear: () => jar.clear(),
  };
}
