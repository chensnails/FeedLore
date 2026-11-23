import assert from 'node:assert/strict';
import test from 'node:test';
import { imageEtag } from './img';

test('图片 ETag：内容键 + 刷新时间戳，刷新后必变', () => {
  const a = imageEtag('abc123', 1_700_000_000_000);
  const b = imageEtag('abc123', 1_700_000_000_000);
  const c = imageEtag('abc123', 1_700_000_000_001);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^"abc123-[0-9a-z]+"$/);
});
