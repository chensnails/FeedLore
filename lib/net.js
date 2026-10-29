'use strict';

/**
 * 出网校验（v1.7.2-test2）——把「服务端替用户去访问一个地址」的入口统一收口。
 *
 * 背景（见《质量与安全测试报告-2026-10-29》S-02 / S-06）：
 *   订阅地址、Webhook、日报模型 baseUrl 三处只校验了协议前缀，`isPrivateHost`
 *   仅在图片代理里用过。于是在云主机上可以：
 *     - 让服务器去读 169.254.169.254 的实例元数据（AK/SK）
 *     - 把 webhook 存成 http://127.0.0.1:8080/xxx，当成内网 POST 探针
 *     - 把模型地址指到本站 /api/session，服务器自己打自己
 *
 * 这里做三件事：
 *   1. 主机名校验：字面量内网地址直接拒；域名先解析，任一条 A/AAAA 落在内网段也拒
 *      （防「域名指向 127.0.0.1」）。
 *   2. IP 钉定：把已校验的 IP 塞进 undici 的 connect.lookup，连接时不再二次解析
 *      （防 DNS rebinding 的 TOCTOU）。
 *   3. 逐跳校验重定向：`redirect: 'manual'` 自己跟，每一跳都重新过 1、2
 *      （否则 302 到 127.0.0.1 就绕过了前面的检查）。
 *
 * 逃生口：真的要让服务器访问内网（自建 FreshRSS、本机 Ollama / vLLM），
 * 给进程设 `ALLOW_PRIVATE_HOSTS=1` 即可整体放行。
 */

const dns = require('dns');
const { Agent } = require('undici');
const { HttpError } = require('./http');

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 3;

const allowPrivate = () => process.env.ALLOW_PRIVATE_HOSTS === '1';
const stripBrackets = (h) => String(h || '').replace(/^\[/, '').replace(/\]$/, '');

/** IPv6：只拦环回 / 链路本地 / ULA / 组播 / IPv4-mapped 内网。
 *  注意：lib/util.isPrivateHost 那套是「凡 IPv6 一律拒绝」，对 URL 字面量够用，
 *  但用在这里会把所有带 AAAA 记录的正常站点（含 example.com）一起毙掉 —— 第一次
 *  上线就把 46 个订阅全判成内网。所以这里单独按前缀判。 */
function isBlockedIpv6(h) {
  if (h === '::' || h === '::1') return true;
  if (/^fe[89ab]/.test(h)) return true;   // fe80::/10 链路本地
  if (/^f[cd]/.test(h)) return true;      // fc00::/7 唯一本地
  if (/^ff/.test(h)) return true;         // ff00::/8 组播
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIp(mapped[1]);
  return false;
}

/** 内网 / 保留地址判定（IPv4 在 lib/util.isPrivateHost 的规则上再补几段保留网段） */
function isBlockedIp(ip) {
  const s = stripBrackets(String(ip || '').toLowerCase());
  if (!s) return true;
  if (s.includes(':')) return isBlockedIpv6(s);
  if (s === 'localhost' || s.endsWith('.localhost') || s.endsWith('.local')) return true;
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;                    // 链路本地（云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64.0.0/10
  /* 注意：**不要**拦 198.18.0.0/15。Clash / Surge 这类代理的 fake-ip 模式正是把
   * 所有域名解析成 198.18.x.x 再在本地转发；拦了它，用户 46 个订阅会全部被判成
   * 「内网地址」（本项目实测踩过：example.com → 198.18.0.98 → 全站抓取失败）。 */
  if (a === 192 && b === 0 && Number(m[3]) === 0) return true; // IETF 192.0.0.0/24
  if (a >= 224) return true;                                   // 组播 / 保留
  return false;
}

const PRIVATE_MSG = '不允许访问内网 / 回环地址（确需访问请给服务端设 ALLOW_PRIVATE_HOSTS=1）';

/**
 * 校验一个出网地址是否允许访问。
 * @returns {Promise<{url:string, host:string, ips:string[]}>}
 * @throws {HttpError} 400 —— 地址非法 / 协议不支持 / 解析失败 / 落在内网段
 * @param {{ resolve?: boolean, lookup?: Function }} opts resolve=false 时只做字面量判定（走代理时用）
 */
async function assertPublicHost(urlStr, { resolve = true, lookup } = {}) {
  let u;
  try { u = new URL(String(urlStr || '').trim()); }
  catch (_) { throw new HttpError(400, '地址格式不正确', 'BAD_URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, '只支持 http:// 或 https:// 地址', 'BAD_PROTOCOL');
  const host = stripBrackets(u.hostname);
  if (!host) throw new HttpError(400, '地址缺少主机名', 'BAD_HOST');

  // 逃生口：整体放行（不解析、不钉定），交给系统 DNS
  if (allowPrivate()) return { url: u.toString(), host, ips: [] };

  if (isBlockedIp(host)) throw new HttpError(400, PRIVATE_MSG, 'PRIVATE_HOST');
  if (!resolve) return { url: u.toString(), host, ips: [] };

  const doLookup = lookup || dns.promises.lookup;
  let rows;
  try { rows = await doLookup(host, { all: true }); }
  catch (_) { throw new HttpError(400, '域名解析失败，请检查地址拼写', 'DNS_FAIL'); }
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) throw new HttpError(400, '域名解析失败，请检查地址拼写', 'DNS_FAIL');
  if (list.some((r) => isBlockedIp(r.address))) throw new HttpError(400, PRIVATE_MSG, 'PRIVATE_HOST');
  return { url: u.toString(), host, ips: list.map((r) => r.address) };
}

/* ---------- IP 钉定：连接阶段不再做 DNS ---------- */
const agents = new Map();
const AGENT_MAX = 64;

function pinnedDispatcher(ip) {
  const key = String(ip);
  const hit = agents.get(key);
  if (hit) return hit;
  const family = key.includes(':') ? 6 : 4;
  const agent = new Agent({
    connect: {
      // net.connect / tls.connect 的 lookup：无论要解析什么主机名，一律给这个已校验过的 IP
      lookup: (_hostname, _opts, cb) => cb(null, key, family),
    },
    keepAliveTimeout: 10_000,
    connections: 8,
  });
  agents.set(key, agent);
  if (agents.size > AGENT_MAX) {
    const oldest = agents.keys().next();
    if (!oldest.done) {
      const old = agents.get(oldest.value);
      agents.delete(oldest.value);
      try { old.destroy(); } catch (_) { /* 忽略：连接池回收失败不影响请求 */ }
    }
  }
  return agent;
}

/** 测试用：清掉钉定缓存 */
function _resetPinned() {
  for (const a of agents.values()) { try { a.destroy(); } catch (_) { /* noop */ } }
  agents.clear();
}

/**
 * 带出网校验的 fetch。行为与 fetch 基本一致，区别：
 *  - 每一跳（含重定向）都过 assertPublicHost
 *  - 直连时把连接钉到已校验的 IP；调用方自带 dispatcher（出网代理）时只做字面量校验
 *  - 重定向自己跟（最多 3 跳），因此 `resp.url` 是最终落点，和 `redirect: 'follow'` 一致
 */
async function safeFetch(urlStr, opts = {}, { maxHops = MAX_HOPS } = {}) {
  let cur = String(urlStr);
  const viaProxy = !!opts.dispatcher;

  for (let hop = 0; ; hop += 1) {
    const info = await assertPublicHost(cur, { resolve: !viaProxy });
    const dispatcher = opts.dispatcher
      || (info.ips.length ? pinnedDispatcher(info.ips[0]) : undefined);

    const resp = await fetch(cur, Object.assign({}, opts, { redirect: 'manual', dispatcher }));
    if (!REDIRECT_STATUS.has(resp.status)) return resp;

    const loc = resp.headers.get('location');
    if (!loc) return resp;
    if (hop >= maxHops) {
      try { await resp.body.cancel(); } catch (_) { /* noop */ }
      throw new HttpError(502, '重定向层数过多', 'TOO_MANY_REDIRECTS');
    }
    try { await resp.body.cancel(); } catch (_) { /* noop */ }
    cur = new URL(loc, cur).toString();
  }
}

module.exports = { assertPublicHost, safeFetch, isBlockedIp, allowPrivate, _resetPinned };
