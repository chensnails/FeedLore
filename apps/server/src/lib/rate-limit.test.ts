import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGIN_RATE_LIMIT,
  pickClientIp,
  takeLoginAttempt,
  resetLoginAttempts,
} from './rate-limit';

test('登录限流：同一 IP 超过上限后拒绝，窗口过后恢复', () => {
  resetLoginAttempts();
  const t0 = 1_000_000;
  for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
    assert.equal(takeLoginAttempt('login:1.2.3.4', t0).allowed, true, `第 ${i + 1} 次应放行`);
  }
  const blocked = takeLoginAttempt('login:1.2.3.4', t0);
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) assert.ok(blocked.retryAfter > 0);

  resetLoginAttempts();
  assert.equal(takeLoginAttempt('login:1.2.3.4', t0 + LOGIN_RATE_LIMIT.windowMs).allowed, true);
});

test('登录限流：不同 IP 互不影响（不再是全站共享桶）', () => {
  resetLoginAttempts();
  const t0 = 2_000_000;
  for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
    takeLoginAttempt('login:10.0.0.1', t0);
  }
  assert.equal(takeLoginAttempt('login:10.0.0.1', t0).allowed, false);
  assert.equal(takeLoginAttempt('login:10.0.0.2', t0).allowed, true);
});

test('客户端 IP：未开 TRUST_PROXY 时忽略伪造的 XFF，只认 TCP 对端', () => {
  assert.equal(
    pickClientIp({
      trustProxy: false,
      forwardedFor: '8.8.8.8',
      realIp: '9.9.9.9',
      remoteAddress: '::ffff:192.168.1.9',
    }),
    '192.168.1.9',
  );
});

test('客户端 IP：开了 TRUST_PROXY 时取反代追加的最后一跳', () => {
  assert.equal(
    pickClientIp({
      trustProxy: true,
      forwardedFor: '6.6.6.6, 203.0.113.7',
      realIp: '203.0.113.7',
      remoteAddress: '::1',
    }),
    '203.0.113.7',
  );
  // 没有 x-real-ip 时从 XFF 链尾往前找第一个合法地址
  assert.equal(
    pickClientIp({
      trustProxy: true,
      forwardedFor: '6.6.6.6, 203.0.113.8',
      remoteAddress: '::1',
    }),
    '203.0.113.8',
  );
});

test('客户端 IP：取不到时落到 unknown 桶而不是报错', () => {
  assert.equal(pickClientIp({ trustProxy: false }), 'unknown');
});
