'use strict';

/**
 * 代理支持：给抓 RSS / 代理图片 / 调 LLM 等所有出网请求统一配置 HTTP(S) 或 SOCKS5 代理。
 *
 * - 不需要 npm 装额外的代理包：直接用 undici 的 ProxyAgent（HTTP/HTTPS/SOCKS5 全支持）
 * - dispatcher 按 proxyUrl 缓存一份；proxyUrl 变了才重建（重启时也会重建）
 * - proxyUrl 为空 / null / undefined → 返回 undefined（走 Node 默认出网）
 *
 * 用法：
 *   const { getDispatcher } = require('./proxy.js');
 *   const resp = await fetch(url, { dispatcher: getDispatcher(proxyUrl) });
 */

const { ProxyAgent, Agent } = require('undici');

/** 校验：只接 http://, https://, socks://, socks5:// */
function isValidProxyUrl(u) {
  if (typeof u !== 'string') return false;
  const s = u.trim();
  if (!s) return false;
  return /^(https?|socks5?):\/\//i.test(s);
}

let cachedUrl = null;
let cachedDispatcher = null;

/** 拿当前 proxyUrl 对应的 undici dispatcher。proxyUrl 非法 / 为空 → 返回 undefined。 */
function getDispatcher(proxyUrl) {
  const u = (proxyUrl && String(proxyUrl).trim()) || '';
  if (!u) return undefined;
  if (!isValidProxyUrl(u)) return undefined;
  if (u === cachedUrl && cachedDispatcher) return cachedDispatcher;
  try {
    cachedDispatcher = new ProxyAgent({
      uri: u,
      // 给一个比较宽松的超时；具体请求级超时由调用方自己传
      connect: { timeout: 30_000 },
      bodyTimeout: 60_000,
      headersTimeout: 30_000,
    });
    cachedUrl = u;
    return cachedDispatcher;
  } catch (e) {
    // 代理 URL 解析失败 → 当作没设
    cachedDispatcher = null;
    cachedUrl = null;
    return undefined;
  }
}

/** 当前缓存的 proxyUrl（只读） */
function currentProxyUrl() { return cachedUrl; }

/** 测试用：清掉缓存 */
function _reset() { cachedUrl = null; cachedDispatcher = null; }

module.exports = { getDispatcher, currentProxyUrl, isValidProxyUrl, _reset };
