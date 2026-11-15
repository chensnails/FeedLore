import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_DESC_LEN,
  MIN_LINK_LEN,
  dedupKeyFor,
  normalizeLink,
  normalizeTitle,
  sameContent,
} from './dedup';

/* ---------------- 标题归一化（白名单口径，必须与迁移 0010 的 SQL 一致） ---------------- */

test('normalizeTitle: 小写 + 去空白与 ASCII 标点', () => {
  assert.equal(normalizeTitle('  Hello, World! 2026  '), 'helloworld2026');
});

test('normalizeTitle: 去中文标点与全角标点（含 ～），保留中文与字母数字', () => {
  assert.equal(normalizeTitle('【重磅】锂电：2026 年展望！'), '重磅锂电2026年展望');
  assert.equal(normalizeTitle('测试～全角波浪'), '测试全角波浪');
  assert.equal(normalizeTitle('a·b…c—d'), 'abcd');
});

test('normalizeTitle: 去 emoji 与符号，不把它们当内容', () => {
  assert.equal(normalizeTitle('【开机提醒】有用户成功开机🎉'), '开机提醒有用户成功开机');
});

test('normalizeTitle: 全角字母按字母保留（只做小写，不剔除）', () => {
  assert.equal(normalizeTitle('ＡＢＣ'), 'ａｂｃ');
});

test('normalizeTitle: 空值安全', () => {
  assert.equal(normalizeTitle(''), '');
  assert.equal(normalizeTitle(null as unknown as string), '');
});

/* ---------------- 链接归一化：只去首尾空白 + 小写，不动 query ---------------- */

test('normalizeLink: 去首尾空白并小写，query 原样保留', () => {
  assert.equal(normalizeLink('  https://Example.com/A?b=1#c  '), 'https://example.com/a?b=1#c');
});

test('normalizeLink: 过短视为没有可用链接', () => {
  assert.equal(normalizeLink('https://a.b'), '');
  assert.equal(MIN_LINK_LEN, 12);
  assert.equal(normalizeLink(''), '');
  assert.equal(normalizeLink(null), '');
});

/* ---------------- 分组签名 ---------------- */

test('dedupKeyFor: 有标题用 t: 前缀，标点/空格不同但文字相同 → 同 key', () => {
  assert.equal(dedupKeyFor('A B', 'https://x/y'), 't:ab');
  assert.equal(
    dedupKeyFor('锂电行业：2026 展望！', null),
    dedupKeyFor('锂电行业 2026 展望', null),
  );
});

test('dedupKeyFor: 标题归一化后为空才退回链接（l: 前缀）', () => {
  assert.equal(dedupKeyFor('！！！', 'https://example.com/p/1'), 'l:https://example.com/p/1');
  assert.equal(dedupKeyFor('', 'https://a.b'), '');
});

/* ---------------- 内容判定：链接同 或 摘要同 ---------------- */

const LONG_DESC = '这是一段足够长的摘要，用来满足四十个字符的下限，确保参与比较。'.repeat(2);

test('sameContent: 链接完全相同 → 重复（摘要不同也算）', () => {
  assert.equal(
    sameContent(
      { link: 'https://example.com/a?p=1', description: '甲'.repeat(MIN_DESC_LEN) },
      { link: 'https://example.com/a?p=1', description: '乙'.repeat(MIN_DESC_LEN) },
    ),
    true,
  );
});

test('sameContent: 链接 query 不同 → 不算同一链接（防推广短链/剧集页误并）', () => {
  assert.equal(
    sameContent(
      { link: 'https://example.com/a?p=1', description: '甲'.repeat(MIN_DESC_LEN) },
      { link: 'https://example.com/a?p=2', description: '乙'.repeat(MIN_DESC_LEN) },
    ),
    false,
  );
});

test('sameContent: 摘要完全相同 → 重复（链接不同、跨源转载）', () => {
  assert.equal(
    sameContent(
      { link: 'https://a.example/1', description: LONG_DESC },
      { link: 'https://b.example/2', description: LONG_DESC },
    ),
    true,
  );
});

test('sameContent: 摘要过短不参与判定（避免空摘要全并）', () => {
  assert.equal(MIN_DESC_LEN, 40);
  assert.equal(
    sameContent({ link: 'https://a.example/1', description: '短' }, { link: 'https://b.example/2', description: '短' }),
    false,
  );
});

test('sameContent: 同名不同篇（摘要不同）→ 不是重复', () => {
  assert.equal(
    sameContent(
      { link: 'https://a.example/1', description: '《谷雨》第1-5集 2160p' .repeat(4) },
      { link: 'https://a.example/2', description: '《谷雨》第1-9集 2160p'.repeat(4) },
    ),
    false,
  );
});
