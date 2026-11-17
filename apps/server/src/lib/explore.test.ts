import test from 'node:test';
import assert from 'node:assert/strict';
import { exploreKeywords, historyToMessages } from './aiTasks';

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

test('exploreKeywords: 纯虚词 → 空数组（调用方据此直接召回近期池）', () => {
  assert.deepEqual(exploreKeywords('最近有什么'), []);
  assert.deepEqual(exploreKeywords('？？？'), []);
});

test('exploreKeywords: 去重且不超过 8 个', () => {
  const kws = exploreKeywords('人工智能 机器学习 深度学习 服务器 羊毛 好剧 电影 科技 财经');
  assert.equal(new Set(kws).size, kws.length, '不该有重复');
  assert.ok(kws.length <= 8, `实际 ${kws.length} 个`);
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
