/**
 * 出网校验（移植自 apps/legacy/lib/net.js，1.7.2 起的安全铁律）
 *
 * 为什么单列一层：凡是「服务端替用户去访问某个地址」的入口，都必须走这里。
 * 目前有三个：
 *   1. `POST /api/feeds` / `PATCH /api/feeds/:id` —— 新增或改订阅地址；
 *   2. `POST /api/prefs` 的 `webhookUrl` —— 命中关注规则后每次都会向它 POST；
 *   3. （P5）模型 baseUrl —— 服务端会带着 API Key 向它发请求。
 * 少一个就是 SSRF：让服务器去读 169.254.169.254 的实例元数据，或把内网当探针。
 *
 * 本文件只做**判定**，不做请求。判定分两步：
 *   ① 字面量：主机名本身就是内网/保留地址 → 直接拒（不打 DNS，够快够狠）；
 *   ② 解析：域名先查 A/AAAA，任一条落在内网段也拒（防「域名指向 127.0.0.1」）。
 *
 * ⚠️ 刻意**没有**移植 legacy 的 `pinnedLookup` / `safeFetch`：
 * 那是「IP 钉定 + 逐跳重定向校验」，只有真正的抓取器才需要，且依赖 undici 的
 * dispatcher（还要求 npm undici 与 Node 内置**同大版本**，1.7.3 的全站抓取失败就栽在这）。
 * 等 P5 接抓取器时连同 undici 版本锁一起加，届时本文件补 `safeFetch`。
 * 现在没有出网请求，先引入就等于引入一个没人验证过的连接层。
 */

import dns from 'node:dns';
import { HTTPException } from 'hono/http-exception';

/** 逃生口：自建 FreshRSS / 本机 Ollama 这类需求，给进程设 ALLOW_PRIVATE_HOSTS=1 整体放行。 */
export const allowPrivate = (): boolean => process.env.ALLOW_PRIVATE_HOSTS === '1';

const stripBrackets = (h: string): string => String(h || '').replace(/^\[/, '').replace(/\]$/, '');

/**
 * IPv6 判定：只拦环回 / 链路本地 / ULA / 组播 / IPv4-mapped 内网。
 *
 * ⚠️ 不能「凡 IPv6 一律拒」：那样所有带 AAAA 记录的正常站点（含 example.com）都会被毙，
 * 1.7.2 第一次上线就把 46 个订阅全判成内网。按前缀判。
 */
function isBlockedIpv6(h: string): boolean {
  if (h === '::' || h === '::1') return true;
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 链路本地
  if (/^f[cd]/.test(h)) return true; // fc00::/7 唯一本地
  if (/^ff/.test(h)) return true; // ff00::/8 组播
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped && mapped[1]) return isBlockedIp(mapped[1]);
  return false;
}

/** 内网 / 保留地址判定。 */
export function isBlockedIp(ip: string): boolean {
  const s = stripBrackets(String(ip || '').toLowerCase());
  if (!s) return true;
  if (s.includes(':')) return isBlockedIpv6(s);
  if (s === 'localhost' || s.endsWith('.localhost') || s.endsWith('.local')) return true;

  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // 不是 IP 字面量（是域名），交给解析阶段判
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地（云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  /* ⚠️ **不要**拦 198.18.0.0/15：Clash / Surge 的 fake-ip 模式正是把所有域名解析成
   * 198.18.x.x 再本地转发。拦了它，用户全部订阅会被判成「内网地址」——线上实测踩过。 */
  if (a === 192 && b === 0 && c === 0) return true; // IETF 192.0.0.0/24
  if (a >= 224) return true; // 组播 / 保留
  return false;
}

const PRIVATE_MSG =
  '不允许访问内网 / 回环地址（确需访问请给服务端设 ALLOW_PRIVATE_HOSTS=1）';

export interface PublicHostInfo {
  /** 规范化后的 URL（`new URL().toString()`） */
  url: string;
  host: string;
  /** 解析到的 IP；逃生口或 resolve:false 时为空数组 */
  ips: string[];
}

export interface AssertPublicHostOptions {
  /** false = 只做字面量判定、不打 DNS（走代理由代理解析时用） */
  resolve?: boolean;
  /** 测试注入，默认 dns.promises.lookup */
  lookup?: (host: string, opts: { all: true }) => Promise<Array<{ address: string; family: number }>>;
}

/**
 * 校验出网地址是否允许访问；不合规直接抛 400（message 面向用户可读）。
 */
export async function assertPublicHost(
  urlStr: string,
  { resolve = true, lookup }: AssertPublicHostOptions = {},
): Promise<PublicHostInfo> {
  let u: URL;
  try {
    u = new URL(String(urlStr || '').trim());
  } catch {
    throw new HTTPException(400, { message: '地址格式不正确' });
  }
  if (!/^https?:$/.test(u.protocol)) {
    throw new HTTPException(400, { message: '只支持 http:// 或 https:// 地址' });
  }
  const host = stripBrackets(u.hostname);
  if (!host) throw new HTTPException(400, { message: '地址缺少主机名' });

  // 逃生口：整体放行（不解析），交给系统 DNS
  if (allowPrivate()) return { url: u.toString(), host, ips: [] };

  if (isBlockedIp(host)) throw new HTTPException(400, { message: PRIVATE_MSG });
  if (!resolve) return { url: u.toString(), host, ips: [] };

  const doLookup = lookup
    ?? ((h: string, o: { all: true }) =>
      dns.promises.lookup(h, o) as Promise<Array<{ address: string; family: number }>>);

  let rows: Array<{ address: string; family: number }>;
  try {
    rows = await doLookup(host, { all: true });
  } catch {
    throw new HTTPException(400, { message: '域名解析失败，请检查地址拼写' });
  }
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) throw new HTTPException(400, { message: '域名解析失败，请检查地址拼写' });
  if (list.some((r) => isBlockedIp(r.address))) {
    throw new HTTPException(400, { message: PRIVATE_MSG });
  }
  return { url: u.toString(), host, ips: list.map((r) => r.address) };
}

/**
 * 订阅地址归一化 + 基础校验（对齐 legacy `rss.assertFeedUrl`）。
 *
 * 只做「形状」检查：协议、主机名看着像域名。真正的安全判定是 assertPublicHost。
 * 归一化用 `new URL().toString()`（补尾斜杠、小写 host），这样「同一地址不同写法」
 * 在 feeds(owner_id, url) 唯一索引上才会撞成重复而不是新增一条。
 */
export function assertFeedUrl(raw: unknown): string {
  let u: URL;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new HTTPException(400, { message: 'RSS 地址格式不正确' });
  }
  if (!/^https?:$/.test(u.protocol)) {
    throw new HTTPException(400, { message: 'RSS 地址需以 http:// 或 https:// 开头' });
  }
  if (!u.hostname.includes('.')) {
    throw new HTTPException(400, { message: 'RSS 地址的主机名看起来不合法' });
  }
  return u.toString();
}
