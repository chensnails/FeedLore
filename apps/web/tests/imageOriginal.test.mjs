import assert from 'node:assert/strict';
import test from 'node:test';
import { originalImageDownloadSrc, originalImageSrc } from '../src/core/imageOriginal.ts';

const U = 'https://cdn.example.com/a/b.png?token=1';

test('原图地址：代理压缩图去档位 / 重试参数，改走 /api/img/raw', () => {
  const cur = '/api/img?u=' + encodeURIComponent(U) + '&w=960&r=1';
  assert.equal(originalImageSrc(cur), '/api/img/raw?u=' + encodeURIComponent(U));
  assert.equal(originalImageDownloadSrc(cur), '/api/img/raw?u=' + encodeURIComponent(U) + '&dl=1');
});

test('原图地址：currentSrc 绝对地址不会把代理地址再包一层', () => {
  const cur = 'http://172.26.1.2:3210/api/img?u=' + encodeURIComponent(U) + '&w=960';
  assert.equal(originalImageSrc(cur), '/api/img/raw?u=' + encodeURIComponent(U));
});

test('原图地址：原始外链也走同源代理，避免防盗链 / 混合内容', () => {
  assert.equal(originalImageSrc(U), '/api/img/raw?u=' + encodeURIComponent(U));
});

test('原图地址：已是 raw 的不重复包一层', () => {
  const raw = '/api/img/raw?u=' + encodeURIComponent(U);
  assert.equal(originalImageSrc(raw), raw);
});

test('原图地址：data URI / 空值 / 非 http 协议没有原图链接', () => {
  assert.equal(originalImageSrc('data:image/png;base64,AAA'), '');
  assert.equal(originalImageSrc(''), '');
  assert.equal(originalImageSrc('/relative/a.png'), '');
  assert.equal(originalImageDownloadSrc('data:image/png;base64,AAA'), '');
});
