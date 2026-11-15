import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, normalizeLink, dedupKeyFor } from './dedup';

test('normalizeTitle: 小写 + 去空白与 ASCII 标点', () => {
  assert.equal(normalizeTitle('  Hello, World! 2026  '), 'helloworld2026');
});

test('normalizeTitle: 去常见中文标点，保留中文与字母数字', () => {
  assert.equal(normalizeTitle('【重磅】锂电：2026 年展望！'), '重磅锂电2026年展望');
});

test('normalizeTitle: 空值安全', () => {
  assert.equal(normalizeTitle(''), '');
  assert.equal(normalizeTitle(null as unknown as string), '');
});

test('normalizeLink: 去 query/hash 与末尾斜杠并小写', () => {
  assert.equal(normalizeLink('https://Example.com/a/b/?utm_source=x#top'), 'https://example.com/a/b');
  assert.equal(normalizeLink(''), '');
  assert.equal(normalizeLink(null), '');
});

test('dedupKeyFor: 有标题用标题，标题空退回链接', () => {
  assert.equal(dedupKeyFor('A B', 'https://x/y'), 'ab');
  assert.equal(dedupKeyFor('', 'https://Example.com/p/?utm=1#f'), 'https://example.com/p');
});

test('dedupKeyFor: 标点/空格不同但文字相同 → 同 key（跨源转载常见形态）', () => {
  const a = dedupKeyFor('锂电行业：2026 展望！', null);
  const b = dedupKeyFor('锂电行业 2026 展望', null);
  assert.equal(a, b);
  assert.equal(a, '锂电行业2026展望');
});
