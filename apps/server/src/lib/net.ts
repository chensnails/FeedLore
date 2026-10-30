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
 * ⚠️ `pinnedLookup` / `safeFetch` 一度是「等 P5 再接」的，现在都在本文件里：
 * 抓取器、webhook、图片代理、模型 baseUrl 全部走 `safeFetch`。
 * 它做三件事：逐跳（含重定向）重新校验、直连时把连接钉到已校验 IP、可选出网代理。
 */

import dns from 'node:dns';
import { createRequire } from 'node:module';
import { Agent, ProxyAgent } from 'undici';
import { HTTPException } from 'hono/http-exception';

/** 读 npm undici 的实际版本（ESM 里 import JSON 还要 import assertion，不如 createRequire 稳）。 */
const nodeRequire = createRequire(import.meta.url);
let undiciPkg: { version?: string } = {};
try {
  undiciPkg = nodeRequire('undici/package.json') as { version?: string };
} catch {
  /* 没装就说明走的是内置 fetch，版本检查自然通过 */
}

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

/* ============================================================================
 * IP 钉定 + 逐跳校验的 fetch（P5 抓取器接入时补上）
 * ==========================================================================*/

/**
 * undici 版本对齐检查。
 *
 * ⚠️ `dispatcher` 只在内置 undici 与 npm undici **同大版本**时可用。内置 fetch
 * 用的是 Node 自带那份 undici，npm 包跨大版本（Node 22 内置 6.x 而装了 8.x）时，
 * dispatch 阶段直接抛 `invalid onRequestStart method`，表现是**所有出网请求 fetch failed**
 * ——1.7.4「全站频道抓取失败」就是它把真正的错盖住了。
 *
 * 所以：① package.json 精确锁 6.x；② 启动时喊出来；③ 真出问题时有兜底（见 safeFetch）。
 */
/** 取内置与依赖的 undici 版本（给启动日志用）。 */
export const undiciVersions = (): { builtin: string; installed: string } => ({
  builtin: String(process.versions.undici ?? '?'),
  installed: String(undiciPkg.version ?? '?'),
});

export function undiciVersionMismatch(): boolean {
  const builtin = String(process.versions.undici ?? '').split('.')[0];
  let installed = '';
  try {
    installed = String(undiciPkg.version ?? '');
  } catch {
    return false;
  }
  const major = installed.split('.')[0];
  return Boolean(builtin) && major !== builtin;
}

/**
 * 生成「钉定到某个已校验 IP」的 lookup。
 *
 * ⚠️ 必须同时兼容三种调用形态，少一种就是全站抓取失败（1.7.3 线上事故）：
 *   - `(host, { all: true }, cb)` —— undici 内部解析走这条，Node 要求回**数组**
 *   - `(host, opts, cb)`         —— 普通解析，回 `(err, address, family)`
 *   - `(host, cb)`               —— 两参调用（部分版本 / 直连 net.connect）
 */
export function pinnedLookup(ip: string) {
  const key = String(ip);
  const family = key.includes(':') ? 6 : 4;

  type Cb = (
    err: NodeJS.ErrnoException | null,
    address: string | Array<{ address: string; family: number }>,
    fam?: number,
  ) => void;

  return (hostname: string, opts: unknown, cb?: Cb): void => {
    void hostname;
    // 两参调用：(host, cb)
    if (typeof opts === 'function') {
      (opts as Cb)(null, key, family);
      return;
    }
    // { all: true } 必须回数组
    if (opts && typeof opts === 'object' && (opts as { all?: boolean }).all) {
      cb?.(null, [{ address: key, family }]);
      return;
    }
    cb?.(null, key, family);
  };
}

const pinnedAgents = new Map<string, Agent>();
const PINNED_MAX = 64;

/** 取一个把连接钉到已校验 IP 的 dispatcher（连接阶段不再二次解析，防 DNS rebinding）。 */
export function pinnedDispatcher(ip: string): Agent {
  const key = String(ip);
  const hit = pinnedAgents.get(key);
  if (hit) return hit;

  const agent = new Agent({
    /* `lookup` 的形状由 undici 内部调用约定决定（见 pinnedLookup 注释），
     * 而其 TS 类型是 node:net 的 LookupFunction（无 `{all:true}` 数组形态），
     * 两者必然不匹配 —— 这里按运行期约定断言，不迁就类型。 */
    connect: { lookup: pinnedLookup(key) as never },
    keepAliveTimeout: 10_000,
    connections: 8,
  });
  pinnedAgents.set(key, agent);

  if (pinnedAgents.size > PINNED_MAX) {
    const oldest = pinnedAgents.keys().next();
    if (!oldest.done) {
      const old = pinnedAgents.get(oldest.value);
      pinnedAgents.delete(oldest.value);
      try {
        old?.destroy();
      } catch {
        /* 连接池回收失败不影响请求 */
      }
    }
  }
  return agent;
}

/** 测试用：清掉钉定缓存 */
export function resetPinned(): void {
  for (const a of pinnedAgents.values()) {
    try {
      a.destroy();
    } catch {
      /* noop */
    }
  }
  pinnedAgents.clear();
}

/* ============================================================================
 * 出网代理（settings.source.proxyUrl）
 *
 * 为什么值得单独写一段：抓取器跑在境外/受限网络里时，没有代理就**整站抓不到**
 * （legacy 时代这是实际诉求，代理实现一直在用）。v2 到 P10 才补上，此前字段存了但不生效。
 *
 * 三条边界，改动前先读：
 * 1. **代理走的是 ProxyAgent，因此这一跳没有 IP 钉定**。钉定的前提是「我们自己解析、
 *    自己连那个 IP」；一旦交给代理，DNS 由代理重新解析。也就是说 `assertPublicHost`
 *    从「防 rebinding 的硬保证」降级为「校验时刻的判定」—— 这个损失是显式接受的
 *    （legacy 同样如此），但**内网地址依旧被拒**：判在前、发在后，不因为走代理就放行。
 * 2. **代理地址不做 `assertPublicHost`**：它天然是内网地址（`http://172.17.0.1:7890`），
 *    过一遍等于功能全灭。它来自部署者写的配置（settings/env），不是用户输入 ——
 *    与「一键更新」走内网 watchtower 是同一类豁免，不构成 SSRF 面。
 * 3. **只认 http/https**：undici 的 ProxyAgent 不支持 socks；配了 `socks5://` 就忽略并告警，
 *    不静默失败（否则表现为「全站抓取超时」，最难查）。
 * ==========================================================================*/

let outboundProxy = String(process.env.PROXY_URL ?? '').trim();

const proxyAgents = new Map<string, ProxyAgent>();

/** 规范化代理地址：非法/不支持的协议返回空串（= 不用代理）。 */
function normalizeProxy(raw: unknown): string {
  const t = String(raw ?? '').trim().slice(0, 500);
  if (!t) return '';
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      console.warn(`[net] ⚠️ 出网代理协议不受支持（${u.protocol}），已忽略：${t.slice(0, 80)}`);
      return '';
    }
    return u.toString();
  } catch {
    console.warn(`[net] ⚠️ 出网代理地址无法解析，已忽略：${t.slice(0, 80)}`);
    return '';
  }
}

/** 设置当前出网代理（空串 = 直连）。变更时销毁旧连接池，避免继续复用旧代理的连接。 */
export function setOutboundProxy(raw: unknown): void {
  const next = normalizeProxy(raw);
  if (next === outboundProxy) return;
  outboundProxy = next;
  for (const a of proxyAgents.values()) {
    try {
      a.destroy();
    } catch {
      /* noop */
    }
  }
  proxyAgents.clear();
}

export const currentOutboundProxy = (): string => outboundProxy;

/** 取（并缓存）某个代理地址的 dispatcher。 */
export function proxyDispatcher(url: string): ProxyAgent {
  const hit = proxyAgents.get(url);
  if (hit) return hit;
  const agent = new ProxyAgent({ uri: url, keepAliveTimeout: 10_000 });
  proxyAgents.set(url, agent);
  return agent;
}

/** 测试用：清掉代理连接池。 */
export function resetProxy(): void {
  for (const a of proxyAgents.values()) {
    try {
      a.destroy();
    } catch {
      /* noop */
    }
  }
  proxyAgents.clear();
}

let warnedPinFallback = false;

/** 钉定层自身失效（而不是目标站的问题）——可安全降级重试的特征。 */
function isPinningFailure(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /ERR_INVALID_IP_ADDRESS|invalid onRequestStart method|invalid lookup/i.test(msg);
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 3;

export interface SafeFetchOptions {
  maxHops?: number;
}

/**
 * 带出网校验的 fetch。与 `fetch` 基本一致，区别：
 *  - 每一跳（**含重定向**）都重新过 `assertPublicHost`（否则 302 到 127.0.0.1 就绕过了）；
 *  - 直连时把连接钉到已校验的 IP（防 DNS rebinding 的 TOCTOU）；
 *  - 重定向自己跟（最多 3 跳），所以 `resp.url` 是最终落点，与 `redirect:'follow'` 一致。
 *
 * 兜底：若**钉定本身**失效（undici 跨大版本等），降级为普通 fetch 重试一次并大声告警——
 * 宁可少一层「防 rebinding」的硬保证，也不要像 1.7.3 那样整个抓取功能全灭。
 */
export async function safeFetch(
  urlStr: string,
  init: RequestInit = {},
  { maxHops = MAX_HOPS }: SafeFetchOptions = {},
): Promise<Response> {
  let cur = String(urlStr);

  for (let hop = 0; ; hop += 1) {
    const info = await assertPublicHost(cur);
    const firstIp = info.ips[0];

    /* 配了代理就一律走代理（抓取场景下代理是「能不能出去」的前提，不能一半直连一半代理）；
     * 此时不再钉定 IP —— 见上文「出网代理」第 1 条。 */
    const proxy = outboundProxy;
    const pinning = !proxy && Boolean(firstIp);
    const dispatcher = proxy ? proxyDispatcher(proxy) : pinning ? pinnedDispatcher(firstIp as string) : undefined;

    const withDispatcher = {
      ...init,
      redirect: 'manual',
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit;

    let resp: Response;
    try {
      resp = await fetch(cur, withDispatcher);
    } catch (e) {
      // 只有「钉定层自己坏了」才降级重试；代理出错不能退回直连（那是另一条网络路径，结果会被误读）
      if (!pinning || !isPinningFailure(e)) throw e;
      if (!warnedPinFallback) {
        warnedPinFallback = true;
        console.warn(
          `[net] ⚠️ IP 钉定失效（内置 undici ${process.versions.undici ?? '?'} / 依赖 ${
            (undiciPkg as { version?: string }).version ?? '?'
          }），已降级为普通出网请求：${String((e as Error).message ?? e)}`,
        );
      }
      resp = await fetch(cur, { ...init, redirect: 'manual' } as RequestInit);
    }

    if (!REDIRECT_STATUS.has(resp.status)) return resp;

    const loc = resp.headers.get('location');
    if (!loc) return resp;
    try {
      await resp.body?.cancel();
    } catch {
      /* noop */
    }
    if (hop >= maxHops) throw new HTTPException(502, { message: '重定向层数过多' });
    cur = new URL(loc, cur).toString();
  }
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
