import test from 'node:test';
import assert from 'node:assert/strict';
import { exploreKeywords, exploreRelevance, exploreSampleByEra, historyToMessages } from './aiTasks';

/** 探索问答的关键词抽取：纯函数，守「口语化问题也能召回」与「虚词不进召回」。 */

test('exploreKeywords: 最近有好剧 → 去掉虚词、补 2-gram', () => {
  const kws = exploreKeywords('最近有好剧');
  assert.ok(kws.includes('好剧'), `应含 2-gram「好剧」，实际 ${JSON.stringify(kws)}`);
  assert.ok(!kws.includes('最近'), '虚词「最近」不该进召回');
});

test('exploreKeywords: 服务器羊毛 → 覆盖「羊毛」「服务器」', () => {
  const kws = exploreKeywords('最近有什么服务器羊毛');
  assert.ok(kws.includes('羊毛'), `实际 ${JSON.stringify(kws)}`);
  assert.ok(kws.includes('服务') || kws.includes('服务器'), `实际 ${JSON.stringify(kws)}`);
  assert.ok(!kws.includes('有什么'), '虚词不该进召回');
});

test('exploreKeywords: 英文与数字词保留', () => {
  const kws = exploreKeywords('有什么 RSS 羊毛 100');
  assert.ok(kws.includes('rss'), `实际 ${JSON.stringify(kws)}`);
  assert.ok(kws.includes('100'), `实际 ${JSON.stringify(kws)}`);
});

test('exploreKeywords: 纯虚词 → 空数组（调用方据此只用近期打底池）', () => {
  assert.deepEqual(exploreKeywords('最近有什么'), []);
  assert.deepEqual(exploreKeywords('？？？'), []);
});

test('exploreKeywords: 去重且不超过 8 个', () => {
  const kws = exploreKeywords('人工智能 机器学习 深度学习 服务器 羊毛 好剧 电影 科技 财经');
  assert.equal(new Set(kws).size, kws.length, '不该有重复');
  assert.ok(kws.length <= 8, `实际 ${kws.length} 个`);
});

/* ---- 全库召回的相关度排序 ---- */

const row = (title: string, description = '', tags: string[] = []) => ({ title, description, tags });

test('exploreRelevance: 标题权重3 > 描述2 > 标签1，命中多仍排前', () => {
  const terms = ['好剧', '电视剧', '追剧'];
  const triple = row('好剧推荐', '近期电视剧盘点', ['追剧']);
  const one = row('好剧推荐');
  const none = row('财经快讯');
  const rank = [none, one, triple]
    .map((r) => ({ r, score: exploreRelevance(r, terms) }))
    .sort((a, b) => b.score - a.score);
  assert.equal(exploreRelevance(triple, terms), 3 + 2 + 1, '标题3+描述2+标签1');
  assert.equal(exploreRelevance(one, terms), 3, '标题命中算 3 分');
  assert.equal(exploreRelevance(none, terms), 0);
  assert.equal(rank[0]!.r, triple, '命中三个字段的应排第一');
  assert.equal(rank[2]!.r, none, '零命中的近期打底排最后');
});

test('exploreRelevance: 字面词权重高于扩展泛词', () => {
  const literalHit = row('好剧清单');     // 只命中字面「好剧」
  const expandedHit = row('本周榜单');    // 只命中扩展「榜单」
  const lit = exploreRelevance(literalHit, ['好剧'], ['榜单']);
  const exp = exploreRelevance(expandedHit, ['好剧'], ['榜单']);
  assert.ok(lit > exp, `字面命中应比扩展命中分高：${lit} vs ${exp}`);
  assert.equal(lit, 3, '字面词标题命中 = 1×3');
  assert.ok(Math.abs(exp - 1.8) < 1e-9, `扩展词标题命中 = 0.6×3=1.8，实际 ${exp}`);
});

test('exploreRelevance: 同词同字段最多算 1 次，重复不刷分；大小写不敏感', () => {
  assert.equal(exploreRelevance(row('好剧好剧好剧', '又是好剧'), ['好剧']), 3 + 2, '标题与描述各算一次');
  assert.equal(exploreRelevance(row('AI 工具', '再说 AI'), ['ai']), 3 + 2, '英文大写命中小写词');
});

/* ---- 分时段取样 ---- */

const eraRow = (id: number, daysAgo: number) => ({ id, publishedAt: new Date(NOW - daysAgo * 86_400_000) });
const NOW = Date.UTC(2026, 10, 17);

test('exploreSampleByEra: 近/中/老三段各留配额，老条目不被近期挤掉', () => {
  // 40 条近的 + 40 条中的 + 40 条老的，都按相关度排好（同段内 id 小=更相关）
  const ranked = [
    ...Array.from({ length: 40 }, (_, i) => eraRow(i, 10)),       // 近
    ...Array.from({ length: 40 }, (_, i) => eraRow(100 + i, 200)), // 中
    ...Array.from({ length: 40 }, (_, i) => eraRow(200 + i, 500)), // 老
  ];
  const sampled = exploreSampleByEra(ranked, 30, NOW);
  assert.equal(sampled.length, 30);
  assert.ok(sampled.some((r) => r.publishedAt!.getTime() < NOW - 365 * 86_400_000), '应包含老条目');
  assert.ok(sampled.some((r) => r.publishedAt!.getTime() >= NOW - 90 * 86_400_000), '应包含近期条目');
});

test('exploreSampleByEra: 命中全挤在近期时，空段配额顺延不浪费', () => {
  const ranked = Array.from({ length: 50 }, (_, i) => eraRow(i, 5)); // 全在近段
  const sampled = exploreSampleByEra(ranked, 30, NOW);
  assert.equal(sampled.length, 30, '近段 50 条足够填满 30 配额');
});

test('exploreSampleByEra: 空输入返回空数组', () => {
  assert.deepEqual(exploreSampleByEra([], 30, NOW), []);
});

/* ---- 多轮历史 ---- */

test('historyToMessages: [#n] 按该轮 refs 替换成《条目名》，避免跨轮编号错位', () => {
  const msgs = historyToMessages([{
    question: '最近有什么好剧？',
    answer: '先看 [#1]，另可看 [#2]。',
    refs: [
      { id: '10', name: '开年这三部剧值得追' },
      { id: '11', name: '本周口碑榜：悬疑剧回潮' },
    ],
  }]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.role, 'user');
  assert.equal(msgs[1]!.role, 'assistant');
  assert.ok(msgs[1]!.content.indexOf('《开年这三部剧值得追》') >= 0, msgs[1]!.content);
  assert.ok(msgs[1]!.content.indexOf('《本周口碑榜：悬疑剧回潮》') >= 0, msgs[1]!.content);
  assert.ok(!/\[#\d+\]/.test(msgs[1]!.content), '历史编号应全部替换掉');
});

test('historyToMessages: 越界编号保留原样，不臆造条目名', () => {
  const msgs = historyToMessages([{
    question: '有什么？', answer: '看 [#1] 和 [#9]。',
    refs: [{ id: '1', name: '甲' }],
  }]);
  assert.ok(msgs[1]!.content.indexOf('《甲》') >= 0);
  assert.ok(msgs[1]!.content.indexOf('[#9]') >= 0, '没有对应 ref 的编号不该被改写');
});

test('historyToMessages: 多轮按顺序展开，空答案不产生 assistant 消息', () => {
  const msgs = historyToMessages([
    { question: '第一问', answer: '', refs: [] },
    { question: '第二问', answer: '第二答', refs: [] },
  ]);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'user', 'assistant']);
  assert.equal(msgs[1]!.content, '第二问');
});

test('historyToMessages: 空历史 → 空数组；逐轮文本截断防 token 失控', () => {
  assert.deepEqual(historyToMessages([]), []);
  const msgs = historyToMessages([{ question: '问'.repeat(500), answer: '答'.repeat(5000), refs: [] }]);
  assert.equal(msgs[0]!.content.length, 300);
  assert.equal(msgs[1]!.content.length, 4000);
});
