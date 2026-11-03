import assert from 'node:assert/strict';
import test from 'node:test';
import { imageCacheKey, imageVariantKey, normalizeImageWidth } from './image';

test('normalizeImageWidth: 只接受 320/640/960 三个档位', () => {
  assert.equal(normalizeImageWidth('320'), 320);
  assert.equal(normalizeImageWidth('640'), 640);
  assert.equal(normalizeImageWidth(960), 960);
  for (const bad of [undefined, null, '', '0', '-320', '321', '640px', 'abc', '1e3']) {
    assert.equal(normalizeImageWidth(bad), 0, `应忽略 ${String(bad)}`);
  }
});

test('imageVariantKey: 变体独立成键，默认图沿用原键', () => {
  const url = 'https://img.example/a.png';
  const base = imageCacheKey(url);
  assert.equal(imageVariantKey(url, 0), base);
  assert.notEqual(imageVariantKey(url, 320), base);
  assert.notEqual(imageVariantKey(url, 320), imageVariantKey(url, 640));
  // 重试参数 r 不进键：同一档位的重试必须命中同一份缓存
  assert.equal(imageVariantKey(url + '?r=1', 320), imageVariantKey(url, 320));
  // fragment 同样不影响
  assert.equal(imageVariantKey(url + '#x', 320), imageVariantKey(url, 320));
});
