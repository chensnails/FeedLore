/* 条目过滤规则单测（node:test，纯函数零依赖）。
 *
 * 覆盖 lib/filter.js 的匹配语义与 lib/prefs.js 的 sanitizeFilters 清洗：
 * allow 优先 / 大小写 / 正则非法丢弃 / id 兜底等「改错一行就出事」的边角。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { applyFilters, ruleHit } = require('../../lib/filter');
const { sanitizeFilters } = require('../../lib/prefs');

const item = (title, description = '', content = '') => ({ title, description, content });

/* ---------- sanitizeFilters ---------- */

test('sanitizeFilters：合法规则原样入，字段/动作非法回落默认', () => {
  const out = sanitizeFilters([
    { id: 'a', on: true, act: 'block', field: 'title', kind: 'kw', pattern: '广告' },
    { id: 'b', act: 'allow', field: 'bad-field', kind: 'kw', pattern: 'sk-' },
    { id: 'c', act: 'wat', field: 'desc', kind: 'kw', pattern: 'x' },
    { id: 'd', field: 'all', kind: 'kw', pattern: 'y', on: false },
  ]);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { id: 'a', on: true, act: 'block', field: 'title', kind: 'kw', pattern: '广告' });
  assert.equal(out[1].field, 'all');        // 非法 field 回落 all
  assert.equal(out[1].act, 'allow');
  assert.equal(out[2].act, 'block');        // 非法 act 回落 block
  assert.equal(out[3].on, false);           // on=false 保留（停用不丢规则）
});

test('sanitizeFilters：非法正则整条丢弃，合法正则保留', () => {
  const out = sanitizeFilters([
    { id: 'r1', act: 'block', field: 'title', kind: 're', pattern: '(' },        // 编译不过
    { id: 'r2', act: 'block', field: 'title', kind: 're', pattern: 'a+b' },      // 合法
    { id: 'r3', act: 'block', field: 'title', kind: 'kw', pattern: '' },         // 空模式
    { id: 'r4', act: 'block', field: 'title', kind: 'kw', pattern: '   ' },     // 纯空白
    { act: 'block', field: 'title', kind: 'kw', pattern: 'no-id' },             // 无 id
    { id: 'dup', act: 'block', field: 'title', kind: 'kw', pattern: 'first' },
    { id: 'dup', act: 'block', field: 'title', kind: 'kw', pattern: 'second' }, // id 撞车
  ]);
  assert.equal(out.length, 4);
  assert.equal(out[0].id, 'r2');
  assert.equal(out[1].id, 'f2');            // 无 id → 序号兜底
  assert.equal(out[2].id, 'dup');
  assert.equal(out[3].id, 'f4');            // id 撞车 → 序号兜底（不丢规则）
});

test('sanitizeFilters：超长模式丢弃，上限 50 条', () => {
  const long = 'x'.repeat(201);
  const out = sanitizeFilters([{ id: 'l1', act: 'block', field: 'title', kind: 'kw', pattern: long }]);
  assert.equal(out.length, 0);
  const many = Array.from({ length: 60 }, (_, i) => ({ id: 'm' + i, act: 'block', field: 'title', kind: 'kw', pattern: 'p' + i }));
  assert.equal(sanitizeFilters(many).length, 50);
});

test('sanitizeFilters：非数组 / null 一律空数组', () => {
  assert.deepEqual(sanitizeFilters(null), []);
  assert.deepEqual(sanitizeFilters('x'), []);
  assert.deepEqual(sanitizeFilters({}), []);
});

/* ---------- applyFilters ---------- */

test('applyFilters：无规则原样返回（同引用）', () => {
  const items = [item('a'), item('b')];
  assert.equal(applyFilters(items, []), items);
  assert.equal(applyFilters(items, [{ on: false, act: 'block', field: 'title', kind: 'kw', pattern: 'a' }]), items);
});

test('applyFilters：屏蔽规则命中即丢弃（大小写不敏感）', () => {
  const items = [item('正常文章'), item('Another AD here')];
  const rules = [{ id: 'r', on: true, act: 'block', field: 'title', kind: 'kw', pattern: 'ad' }];
  const out = applyFilters(items, rules);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, '正常文章');   // 'Another AD here' 的大写 AD 也命中
});

test('applyFilters：只配「只收」= 白名单，没中的全丢', () => {
  const items = [item('sk-abc'), item('普通')];
  const rules = [{ id: 'r', on: true, act: 'allow', field: 'title', kind: 'kw', pattern: 'sk-' }];
  const out = applyFilters(items, rules);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'sk-abc');
});

test('applyFilters：先拉黑再拉白（混合时 block 是硬约束）', () => {
  const items = [item('广告 sk-1'), item('广告 other'), item('正常 sk-2'), item('普通')];
  const rules = [
    { id: 'a', on: true, act: 'allow', field: 'title', kind: 'kw', pattern: 'sk-' },
    { id: 'b', on: true, act: 'block', field: 'title', kind: 'kw', pattern: '广告' },
  ];
  const out = applyFilters(items, rules);
  // '广告 sk-1'：命中 block → 丢；'广告 other'：命中 block → 丢；
  // '正常 sk-2'：未命中 block、命中 allow → 留；'普通'：未命中 block、有 allow 但没中 → 丢
  assert.deepEqual(out.map((i) => i.title), ['正常 sk-2']);
});

test('applyFilters：field 决定匹配范围（desc/content/all）', () => {
  const it = item('干净标题', '摘要里有关键词', '正文里也有');
  assert.equal(ruleHit({ field: 'title', kind: 'kw', pattern: '关键词' }, it), false);
  assert.equal(ruleHit({ field: 'desc', kind: 'kw', pattern: '关键词' }, it), true);
  assert.equal(ruleHit({ field: 'content', kind: 'kw', pattern: '正文' }, it), true);
  assert.equal(ruleHit({ field: 'all', kind: 'kw', pattern: '干净标题' }, it), true);
  const out = applyFilters([it], [{ id: 'r', on: true, act: 'block', field: 'content', kind: 'kw', pattern: '正文' }]);
  assert.equal(out.length, 0);
});

test('applyFilters：正则匹配（大小写不敏感）', () => {
  const items = [item('Beta v1.2'), item('Release 3')];
  const rules = [{ id: 'r', on: true, act: 'block', field: 'title', kind: 're', pattern: 'v\\d+\\.\\d+' }];
  assert.equal(applyFilters(items, rules).length, 1);
  const rulesCI = [{ id: 'r', on: true, act: 'block', field: 'title', kind: 're', pattern: 'beta' }];
  assert.equal(applyFilters(items, rulesCI).length, 1);
});

test('applyFilters：停用的规则不生效；非法正则视为不命中', () => {
  const items = [item('anything')];
  assert.equal(applyFilters(items, [{ id: 'r', on: false, act: 'block', field: 'title', kind: 'kw', pattern: 'anything' }]).length, 1);
  // 非法正则直接进 applyFilters（绕过 sanitize）也不能炸
  assert.equal(applyFilters(items, [{ id: 'r', on: true, act: 'block', field: 'title', kind: 're', pattern: '(' }]).length, 1);
});

test('applyFilters：不改入参，返回新数组', () => {
  const items = [item('a'), item('b')];
  const out = applyFilters(items, [{ id: 'r', on: true, act: 'block', field: 'title', kind: 'kw', pattern: 'a' }]);
  assert.equal(items.length, 2);
  assert.notEqual(out, items);
});
