/**
 * MCP 令牌与限流的单测（纯函数，不需要数据库）。
 *
 * 这三条是 `/mcp` 鉴权的地基：哈希对了 token 才能对上库、前缀对设置页与日志
 * 才有辨认价值、限流桶漏了 AI 客户端一次失控循环就能打穿服务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bearerFromHeader,
  generateMcpToken,
  hashMcpToken,
  MCP_TOKEN_PREFIX,
  mcpRateLimit,
  mcpRateLimitResetForTest,
} from './mcpToken';

test('generateMcpToken：flm_ 前缀、哈希可复算、prefix 是明文前 12 字符', () => {
  const { secret, hash, prefix } = generateMcpToken();
  assert.ok(secret.startsWith(MCP_TOKEN_PREFIX));
  assert.equal(secret.length, MCP_TOKEN_PREFIX.length + 48); // 24 字节 = 48 hex
  assert.equal(hash, hashMcpToken(secret));
  assert.equal(prefix, secret.slice(0, 12));
  assert.notEqual(hash, secret, '库里绝不存明文');
});

test('generateMcpToken 两次生成不相等（熵足够）', () => {
  const a = generateMcpToken();
  const b = generateMcpToken();
  assert.notEqual(a.secret, b.secret);
  assert.notEqual(a.hash, b.hash);
});

test('bearerFromHeader：大小写不敏感、拒绝非 Bearer 形态', () => {
  assert.equal(bearerFromHeader('Bearer flm_abc'), 'flm_abc');
  assert.equal(bearerFromHeader('bearer  flm_abc '), 'flm_abc');
  assert.equal(bearerFromHeader('Basic flm_abc'), null);
  assert.equal(bearerFromHeader('Bearer'), null);
  assert.equal(bearerFromHeader(undefined), null);
  assert.equal(bearerFromHeader(''), null);
});

test('mcpRateLimit：未超限返回 0，超限返回剩余秒数，窗口重置后恢复', () => {
  mcpRateLimitResetForTest();
  const t0 = 1_000_000;
  for (let i = 0; i < 120; i += 1) {
    assert.equal(mcpRateLimit('tok-a', t0), 0, `第 ${i + 1} 次不应被限`);
  }
  const wait = mcpRateLimit('tok-a', t0 + 1_000);
  assert.ok(wait > 0 && wait <= 60, '超限后应给出窗口内剩余秒数');

  // 不同 token 各自独立
  assert.equal(mcpRateLimit('tok-b', t0), 0);

  // 窗口过后恢复
  assert.equal(mcpRateLimit('tok-a', t0 + 61_000), 0);
  mcpRateLimitResetForTest();
});
