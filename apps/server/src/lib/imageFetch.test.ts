import assert from 'node:assert/strict';
import test from 'node:test';
import { IMAGE_FETCH_ATTEMPTS, imageFetchHeaders } from './imageFetch';

const URL = 'https://cdn.example.com/p/a.png?token=1';

test('图片回源：默认只带 bot UA，无 Referer', () => {
  const h = imageFetchHeaders(URL, 0, 'FeedLore/3.0');
  assert.equal(h['User-Agent'], 'FeedLore/3.0');
  assert.equal(h.Referer, undefined);
  assert.match(h.Accept ?? '', /image\//);
});

test('403 升级：先带 origin Referer，再换浏览器 UA', () => {
  const h1 = imageFetchHeaders(URL, 1, 'FeedLore/3.0');
  assert.equal(h1.Referer, 'https://cdn.example.com/');
  assert.equal(h1['User-Agent'], 'FeedLore/3.0');

  const h2 = imageFetchHeaders(URL, 2, 'FeedLore/3.0');
  assert.equal(h2.Referer, 'https://cdn.example.com/');
  assert.notEqual(h2['User-Agent'], 'FeedLore/3.0');
  assert.match(h2['User-Agent'] ?? '', /^Mozilla\/5\.0/);
  assert.ok(h2['Accept-Language']);
});

test('重试次数固定为 3，非法地址不再升级请求头', () => {
  assert.equal(IMAGE_FETCH_ATTEMPTS, 3);
  const h = imageFetchHeaders('not a url', 2, 'FeedLore/3.0');
  assert.equal(h.Referer, undefined);
  assert.equal(h['User-Agent'], 'FeedLore/3.0');
});
