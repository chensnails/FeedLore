import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMG_NEG_MAX,
  IMG_NEG_TTL_MS,
  negativeCacheDelete,
  negativeCacheGet,
  negativeCacheSet,
  negativeCacheSize,
  resetNegativeCache,
} from './imgNegative';

test('negativeCache: 404 / 410 命中，TTL 到点失效', () => {
  resetNegativeCache();
  const at = 1_000_000;
  negativeCacheSet('k404', 404, at);
  negativeCacheSet('k410', 410, at);
  assert.equal(negativeCacheGet('k404', at + 1), 404);
  assert.equal(negativeCacheGet('k410', at + 1), 410);
  assert.equal(negativeCacheGet('k404', at + IMG_NEG_TTL_MS - 1), 404);
  assert.equal(negativeCacheGet('k404', at + IMG_NEG_TTL_MS), null, '到 TTL 必须失效');
  assert.equal(negativeCacheSize(), 1, '过期条目在读取时被清掉，410 仍有效');
});

test('negativeCache: 403 / 429 / 5xx / 504 一律不缓存（反向断言）', () => {
  resetNegativeCache();
  for (const status of [400, 401, 403, 429, 500, 502, 504]) {
    negativeCacheSet('k' + status, status);
    assert.equal(negativeCacheGet('k' + status), null, `${status} 不应进入负缓存`);
  }
  assert.equal(negativeCacheSize(), 0);
});

test('negativeCache: 未命中与删除', () => {
  resetNegativeCache();
  assert.equal(negativeCacheGet('nope'), null);
  negativeCacheSet('gone', 404);
  assert.equal(negativeCacheGet('gone'), 404);
  negativeCacheDelete('gone');
  assert.equal(negativeCacheGet('gone'), null, '真图写入后必须能解除 404');
});

test('negativeCache: 上限生效，最旧的先被淘汰', () => {
  resetNegativeCache();
  const at = 2_000_000;
  for (let i = 0; i < IMG_NEG_MAX + 5; i += 1) negativeCacheSet('k' + i, 404, at);
  assert.equal(negativeCacheGet('k0', at + 1), null, '最旧的应被淘汰');
  assert.equal(negativeCacheGet('k' + (IMG_NEG_MAX + 4), at + 1), 404);
  assert.equal(negativeCacheSize(), IMG_NEG_MAX);
});

test('negativeCache: reset 清空（管理端清空图片缓存 / 测试复用）', () => {
  resetNegativeCache();
  negativeCacheSet('a', 404);
  negativeCacheSet('b', 410);
  resetNegativeCache();
  assert.equal(negativeCacheSize(), 0);
  assert.equal(negativeCacheGet('a'), null);
});
