import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatUsage, modelsEndpoint, parseModelList } from '@feedlore/ai';
import { shiftDate } from './aiUsage';

/* ---------------- usage 解析（上游不返回时必须是 null，且不能抛） ---------------- */

test('parseChatUsage: 标准 OpenAI 字段', () => {
  assert.deepEqual(
    parseChatUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }),
    { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
  );
});

test('parseChatUsage: 缺 total 时用两者之和补齐', () => {
  assert.deepEqual(
    parseChatUsage({ prompt_tokens: 10, completion_tokens: 5 }),
    { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  );
});

test('parseChatUsage: 全空 / 非对象 / 全零 → null（不记 token 但不影响调用）', () => {
  assert.equal(parseChatUsage(undefined), null);
  assert.equal(parseChatUsage(null), null);
  assert.equal(parseChatUsage('oops'), null);
  assert.equal(parseChatUsage({}), null);
  assert.equal(parseChatUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), null);
});

test('parseChatUsage: 负数与非数字按 0 处理，不产生负用量', () => {
  assert.deepEqual(
    parseChatUsage({ prompt_tokens: -5, completion_tokens: 'x', total_tokens: 7 }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 7 },
  );
});

/* ---------------- 日期位移（统计窗口的边界） ---------------- */

test('shiftDate: 跨月/跨年都按日历算', () => {
  assert.equal(shiftDate('2026-11-15', -6), '2026-11-09');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDate('2026-11-15', 0), '2026-11-15');
});

test('shiftDate: 非法输入原样返回（不抛）', () => {
  assert.equal(shiftDate('not-a-date', -1), 'not-a-date');
});

/* ---------------- 上游模型列表（设置 · 模型 → 模型名称自动获取） ---------------- */

test('modelsEndpoint: base / /v1 / 完整对话路径都落到同一个 /models', () => {
  assert.equal(modelsEndpoint('https://api.example.com'), 'https://api.example.com/v1/models');
  assert.equal(modelsEndpoint('https://api.example.com/'), 'https://api.example.com/v1/models');
  assert.equal(modelsEndpoint('https://api.example.com/v1'), 'https://api.example.com/v1/models');
  assert.equal(modelsEndpoint('https://api.example.com/v1/'), 'https://api.example.com/v1/models');
  assert.equal(modelsEndpoint('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/models');
  assert.throws(() => modelsEndpoint(''));
});

test('parseModelList: OpenAI 的 {data:[{id}]}', () => {
  assert.deepEqual(
    parseModelList({ object: 'list', data: [{ id: 'b-model' }, { id: 'a-model' }] }),
    ['a-model', 'b-model'],
  );
});

test('parseModelList: {models:[...]} / 裸数组 / 纯字符串都能认', () => {
  assert.deepEqual(parseModelList({ models: ['m1', { name: 'm2' }] }), ['m1', 'm2']);
  assert.deepEqual(parseModelList(['m1', { id: 'm2' }]), ['m1', 'm2']);
  assert.deepEqual(parseModelList([{ model: 'm3' }]), ['m3']);
});

test('parseModelList: 去重 + 丢掉空值；完全不认识就返回空数组（让上层报「列表为空」）', () => {
  assert.deepEqual(parseModelList([{ id: 'x' }, { id: 'x' }, '', { id: '' }, 42, null]), ['x']);
  assert.deepEqual(parseModelList({ foo: 1 }), []);
  assert.deepEqual(parseModelList(null), []);
  assert.deepEqual(parseModelList('oops'), []);
});
