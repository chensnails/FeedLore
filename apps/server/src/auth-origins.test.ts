/**
 * 零配置来源校验的回归：1.x 用户升级后不填任何域名，登录/登出的 Origin 白名单
 * 只能从请求的 Host 推出来。两条底线：
 * - http/https 两种协议都要认（反代的 TLS 终结在容器外，进程看不到真实协议）；
 * - 请求自带的 Origin **不能**成为白名单来源（否则跨站请求自己给自己发通行证）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameOriginCandidates } from './auth';

test('按请求 Host 生成 http/https 两种同源候选', () => {
  const list = sameOriginCandidates(new Request('http://feed.example:3210/api/login'));
  assert.deepEqual(new Set(list), new Set(['http://feed.example:3210', 'https://feed.example:3210']));
});

test('反代场景优先用 x-forwarded-host / x-forwarded-proto', () => {
  const req = new Request('http://127.0.0.1:3000/api/auth/sign-out', {
    headers: { 'x-forwarded-host': 'feed.example', 'x-forwarded-proto': 'https' },
  });
  assert.equal(sameOriginCandidates(req)[0], 'https://feed.example');
});

test('跨站 Origin 不会进白名单（Origin 不是可信来源）', () => {
  const req = new Request('http://feed.example/api/auth/sign-out', {
    headers: { origin: 'https://evil.example' },
  });
  const list = sameOriginCandidates(req);
  assert.ok(list.includes('http://feed.example'));
  assert.ok(!list.includes('https://evil.example'));
});

test('没有 request 时为空（createAuth 初始化阶段没有请求上下文）', () => {
  assert.deepEqual(sameOriginCandidates(), []);
});
