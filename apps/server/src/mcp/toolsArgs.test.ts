/**
 * MCP 入参宽容化与失败响应形态的单测。
 *
 * 背景（2026-11-08 实测）：LLM / Shell 拼出的 JSON 常把数字、布尔写成字符串，
 * 而 list_entries 返回的 id 本来就是字符串。严格 zod 会在 SDK 内部抛
 * `Input validation error: ...` —— HTTP 200 + isError:true + **英文纯文本**，
 * 客户端 JSON.parse 失败后当成「查到 0 条」，看起来像 list 接口时好时坏。
 * 这些用例守的是「参数一定能进 handler、失败一定是结构化 JSON」这两条铁律。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looseNumber,
  looseBoolean,
  looseId,
  looseBool,
  looseInt,
  errorResult,
} from './tools';

test('looseNumber：数字字符串转成数字，其余原样交回 zod 处理', () => {
  assert.equal(looseNumber('859978'), 859978);
  assert.equal(looseNumber(' 5 '), 5);
  assert.equal(looseNumber(7), 7);
  assert.equal(looseNumber('abc'), 'abc');
  assert.equal(looseNumber(''), '');
  assert.equal(looseNumber(null), null);
});

test('looseBoolean："false" 必须是 false —— 不能用 z.coerce.boolean()', () => {
  for (const v of ['true', 'TRUE', '1', 'yes', 'on', 1, true]) {
    assert.equal(looseBoolean(v), true, String(v));
  }
  for (const v of ['false', 'FALSE', '0', 'no', 'off', '', 0, false]) {
    assert.equal(looseBoolean(v), false, String(v));
  }
  assert.equal(looseBoolean('maybe'), 'maybe');
  assert.equal(looseBoolean(undefined), undefined);
});

test('looseId：接受 list_entries 返回的字符串 id', () => {
  assert.equal(looseId.safeParse('859978').data, 859978);
  assert.equal(looseId.safeParse(859978).data, 859978);
});

test('looseId：畸形值落到 0 而不是抛校验错误（handler 会回结构化 E_MCP_BAD_ARGUMENTS）', () => {
  for (const v of ['abc', '', -3, 0, 1.5, null]) {
    const r = looseId.safeParse(v);
    assert.equal(r.success, true, String(v));
    assert.equal(r.data, 0, String(v));
  }
});

test('looseBool / looseInt：字符串参数可解析，越界或畸形落到默认值', () => {
  assert.equal(looseBool.safeParse('false').data, false);
  assert.equal(looseBool.safeParse('true').data, true);
  assert.equal(looseBool.safeParse('wat').data, false);
  const limit = looseInt(1, 50, 20);
  assert.equal(limit.safeParse('5').data, 5);
  assert.equal(limit.safeParse(49).data, 49);
  assert.equal(limit.safeParse('999').data, 20);
  assert.equal(limit.safeParse('abc').data, 20);
  const offset = looseInt(0, 100_000, 0);
  assert.equal(offset.safeParse('0').data, 0);
  assert.equal(offset.safeParse('-1').data, 0);
});

test('errorResult：失败响应是 isError + 可 JSON.parse 的正文，不会被误读成空数据', () => {
  const r = errorResult('E_MCP_TOOL_FAILED', 'db timeout', { account: 'demo' });
  assert.equal(r.isError, true);
  assert.equal(r.content.length, 1);
  const block = r.content[0]!;
  assert.equal(block.type, 'text');
  if (block.type !== 'text') throw new Error('错误响应必须是 text');
  const body = JSON.parse(block.text);
  assert.equal(body.error, 'E_MCP_TOOL_FAILED');
  assert.equal(body.message, 'db timeout');
  assert.equal(body.account, 'demo');
  assert.equal(body.entries, undefined, '错误响应绝不能伪装成空列表');
});
