import test from 'node:test';
import assert from 'node:assert/strict';
import { exploreKeywords } from './aiTasks';

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
