import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertFeedUrl, isBlockedIp } from './net';

/**
 * 出网闸门的判定函数（SSRF 的第一道门）。
 *
 * 这里每一条断言都对应一次线上事故或一次差点出事：
 * - 拦少了 → 用户能让服务端去读云元数据（169.254.169.254）或内网服务；
 * - 拦多了 → 全站订阅被判「内网地址」，一台机器都抓不到（1.7.2 的真实故障）。
 *
 * ⚠️ 所以 198.18.0.0/15 必须**放行**：Clash / Surge 的 fake-ip 把所有域名解析成
 * 198.18.x.x。拦了它，用代理的用户全部订阅失败。
 */

test('内网 / 回环 / 链路本地一律拦', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.254',
    '169.254.169.254', // 云元数据
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    'localhost',
    'foo.local',
    '::1',
    'fc00::1',
    'fe80::1',
  ]) {
    assert.equal(isBlockedIp(ip), true, `${ip} 应该被拦`);
  }
});

test('公网地址放行（包括 172.32、公网 IPv6）', () => {
  for (const ip of [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1', // 紧邻私网段之外
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
  ]) {
    assert.equal(isBlockedIp(ip), false, `${ip} 不该被拦`);
  }
});

test('198.18.0.0/15 必须放行（Clash / Surge 的 fake-ip）', () => {
  assert.equal(isBlockedIp('198.18.0.1'), false);
  assert.equal(isBlockedIp('198.19.255.254'), false);
});

test('非 IP 字面量（域名）交给解析阶段判，不在这里拦', () => {
  assert.equal(isBlockedIp('example.com'), false);
});

test('空值视为不安全', () => {
  assert.equal(isBlockedIp(''), true);
  assert.equal(isBlockedIp(undefined as unknown as string), true);
});

test('订阅地址只接受 http(s)，且要求像样的主机名', () => {
  assert.equal(assertFeedUrl('https://example.com/feed'), 'https://example.com/feed');
  assert.equal(assertFeedUrl('  http://a.com/rss  '), 'http://a.com/rss');
  // 归一化：URL 会补尾斜杠
  assert.equal(assertFeedUrl('https://example.com'), 'https://example.com/');

  assert.throws(() => assertFeedUrl('ftp://example.com/feed'), /http/i);
  assert.throws(() => assertFeedUrl('file:///etc/passwd'), /http/i);
  assert.throws(() => assertFeedUrl('not a url'), /格式/);
  // 没有点的单段主机名（在很多网络里会被搜成内部域名）
  assert.throws(() => assertFeedUrl('http://intranet/feed'), /主机名/);
});
