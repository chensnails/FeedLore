/* 关注 / 屏蔽规则单测（node:test，纯函数零依赖）。
 *
 * 覆盖 lib/watch.js 的判定语义与 lib/prefs.js 的 sanitizeWatchRules / sanitizeWebhook：
 * 大小写、子串、屏蔽优先、停用跳过、多行拆分去重、block 不通知、webhook 只收 http(s)。
 * 这些语义「改错一行就出事」—— 比如屏蔽优先反了，用户会看到自己屏蔽过的内容出现在关注里。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { entryText, matchRule, decide, classify, notifyRuleNames } = require('../../lib/watch');
const { sanitizeWatchRules, sanitizeWebhook, normalizeKeywords } = require('../../lib/prefs');

const item = (title, description = '', content = '') => ({ title, description, content });
const R = (over) => Object.assign({ id: 'w1', name: 'AI', keywords: ['openai'], act: 'watch', notify: false, on: true }, over);

test('entryText：标题 + 描述 + 正文拼接并小写', () => {
  const t = entryText(item('OpenAI 发布', 'GPT-5 来了', '正文里也有 OpenAI'));
  assert.equal(t, 'openai 发布\ngpt-5 来了\n正文里也有 openai');
});

test('entryText：空值不产生多余空行', () => {
  assert.equal(entryText(item('只有标题')), '只有标题');
  assert.equal(entryText({}), '');
});

test('matchRule：子串匹配且大小写不敏感', () => {
  const text = entryText(item('OpenAI 新模型'));
  assert.equal(matchRule(R(), text), true);
  assert.equal(matchRule(R({ keywords: ['GPT'] }), text), false);
});

test('matchRule：任一关键字命中即算', () => {
  const text = entryText(item('小米发布新车'));
  assert.equal(matchRule(R({ keywords: ['华为', '小米'] }), text), true);
});

test('decide：屏蔽优先于关注（同一句同时命中时按屏蔽）', () => {
  const text = entryText(item('剧透：OpenAI 新模型'));
  const rules = [
    R({ id: 'a', keywords: ['openai'], act: 'watch' }),
    R({ id: 'b', keywords: ['剧透'], act: 'block' }),
  ];
  assert.deepEqual(decide(rules, text), { state: 'block', rule: 'b' });
});

test('decide：未命中返回 null', () => {
  assert.equal(decide([R({ keywords: ['不存在的词'] })], entryText(item('随便'))), null);
});

test('decide：停用规则不参与判定', () => {
  const text = entryText(item('OpenAI'));
  assert.equal(decide([R({ on: false })], text), null);
});

test('decide：多条关注规则命中时取第一条', () => {
  const text = entryText(item('OpenAI 与 小米'));
  const rules = [R({ id: 'x', keywords: ['小米'] }), R({ id: 'y', keywords: ['openai'] })];
  assert.deepEqual(decide(rules, text), { state: 'watch', rule: 'x' });
});

test('classify：只返回命中条目，带 id 与来源规则', () => {
  const rows = [
    { id: 1, title: 'OpenAI 发布' },
    { id: 2, title: '无关内容' },
    { id: 3, title: '剧透贴' },
  ];
  const rules = [R({ id: 'a', keywords: ['openai'] }), R({ id: 'b', keywords: ['剧透'], act: 'block' })];
  assert.deepEqual(classify(rules, rows), [
    { id: 1, state: 'watch', rule: 'a' },
    { id: 3, state: 'block', rule: 'b' },
  ]);
});

test('notifyRuleNames：只收 watch + notify + 启用的规则', () => {
  const names = notifyRuleNames([
    R({ id: 'a', name: 'AI 动态', notify: true }),
    R({ id: 'b', name: '不通知', notify: false }),
    R({ id: 'c', name: '屏蔽的', act: 'block', notify: true }),
    R({ id: 'd', name: '停用的', notify: true, on: false }),
  ]);
  assert.deepEqual(names, { a: 'AI 动态' });
});

/* ---------------- 清洗 ---------------- */

test('normalizeKeywords：按行拆分、去首尾空格、忽略空行、大小写去重', () => {
  assert.deepEqual(normalizeKeywords('OpenAI\n  GPT-5 \n\n  \nopenai'), ['OpenAI', 'GPT-5']);
});

test('normalizeKeywords：接受数组形式', () => {
  assert.deepEqual(normalizeKeywords([' A ', 'a', 'B']), ['A', 'B']);
});

test('normalizeKeywords：单行超长截断到 60 字', () => {
  const long = 'x'.repeat(80);
  assert.equal(normalizeKeywords(long)[0].length, 60);
});

test('sanitizeWatchRules：空关键字规则被丢弃', () => {
  const out = sanitizeWatchRules([{ keywords: '', act: 'watch' }, { keywords: 'ok' }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].keywords, ['ok']);
});

test('sanitizeWatchRules：非法 act 回落 watch', () => {
  const out = sanitizeWatchRules([{ keywords: 'x', act: '乱写' }]);
  assert.equal(out[0].act, 'watch');
});

test('sanitizeWatchRules：屏蔽规则一律不通知', () => {
  const out = sanitizeWatchRules([{ keywords: 'x', act: 'block', notify: true }]);
  assert.equal(out[0].notify, false);
});

test('sanitizeWatchRules：id 缺失或撞车时兜底且唯一', () => {
  const out = sanitizeWatchRules([{ id: 'dup', keywords: 'a' }, { id: 'dup', keywords: 'b' }, { keywords: 'c' }]);
  const ids = out.map((r) => r.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], 'dup');
});

test('sanitizeWatchRules：名称缺失时按动作给默认名', () => {
  const out = sanitizeWatchRules([{ keywords: 'a', act: 'block' }]);
  assert.ok(out[0].name.indexOf('屏蔽') === 0);
});

test('sanitizeWatchRules：非数组输入返回空数组', () => {
  assert.deepEqual(sanitizeWatchRules(null), []);
  assert.deepEqual(sanitizeWatchRules('x'), []);
});

test('sanitizeWatchRules：最多 30 条', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ keywords: 'k' + i }));
  assert.equal(sanitizeWatchRules(many).length, 30);
});

test('sanitizeWebhook：只收 http(s)，其余清空', () => {
  assert.equal(sanitizeWebhook('https://example.com/hook'), 'https://example.com/hook');
  assert.equal(sanitizeWebhook('http://example.com/hook'), 'http://example.com/hook');
  assert.equal(sanitizeWebhook('javascript:alert(1)'), '');
  assert.equal(sanitizeWebhook('ftp://example.com'), '');
  assert.equal(sanitizeWebhook('   '), '');
  assert.equal(sanitizeWebhook(null), '');
});
