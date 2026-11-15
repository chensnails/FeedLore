import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTagList, AI_TAG_MAX, suggestEntryTags, type ResolvedLlm } from '@feedlore/ai';

/**
 * 智能标签的纯函数与模型调用（mock fetch）测试。
 * 落库/调度依赖真实 PG，放在测试机冒烟；这里只守「解析容错」与「调用链」。
 */

test('parseTagList: 标准 JSON {tags:[...]}', () => {
  assert.deepEqual(parseTagList('{"tags":["锂电","新能源"]}'), ['锂电', '新能源']);
});

test('parseTagList: 去 markdown 代码块包裹', () => {
  assert.deepEqual(parseTagList('```json\n{"tags":["财报","政策"]}\n```'), ['财报', '政策']);
});

test('parseTagList: 裸 JSON 数组', () => {
  assert.deepEqual(parseTagList('["市场","技术"]'), ['市场', '技术']);
});

test('parseTagList: 退化逗号/顿号分隔', () => {
  assert.deepEqual(parseTagList('锂电, 新能源、财报'), ['锂电', '新能源', '财报']);
});

test('parseTagList: 去 # 前缀', () => {
  assert.deepEqual(parseTagList('{"tags":["#锂电","#新能源"]}'), ['锂电', '新能源']);
});

test('parseTagList: 超过上限只保留前 AI_TAG_MAX 个', () => {
  const many = Array.from({ length: 12 }, (_, i) => 't' + i);
  const r = parseTagList(JSON.stringify({ tags: many }));
  assert.equal(r.length, AI_TAG_MAX);
  assert.deepEqual(r, many.slice(0, AI_TAG_MAX));
});

test('parseTagList: 大小写去重', () => {
  assert.deepEqual(parseTagList('{"tags":["Tag","tag","标签"]}'), ['Tag', '标签']);
});

test('parseTagList: 空输入返回空数组', () => {
  assert.deepEqual(parseTagList(''), []);
  assert.deepEqual(parseTagList('   '), []);
});

const fakeLlm = {
  baseUrl: 'http://example.test/v1',
  model: 'fake-model',
  apiKey: 'k',
  temperature: 0,
} as unknown as ResolvedLlm;

const openAiFetch = async (_url: string, _init?: unknown): Promise<Response> =>
  new Response(JSON.stringify({ choices: [{ message: { content: '{"tags":["a","b","c"]}' } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('suggestEntryTags: 调用 fetch 并解析标签', async () => {
  const r = await suggestEntryTags('一篇关于锂电的文章', '正文……', fakeLlm, openAiFetch as unknown as typeof fetch);
  assert.deepEqual(r.tags, ['a', 'b', 'c']);
  assert.ok(typeof r.raw === 'string' && r.raw.length > 0);
});
