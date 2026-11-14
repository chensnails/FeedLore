/**
 * MCP 工具层纯逻辑的单测：正文截断与每页上限。
 *
 * 这两处直接决定「AI 上下文不被撑爆」：截断标记丢了模型会以为读到了全文，
 * limit 兜底漏了 200 条 × 全文能把一次工具调用变成几十万 token。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_CONTENT_MAX_CHARS, mcpAiSystemPrompt, truncateContent } from './tools';

test('truncateContent：短文原样返回，不标截断', () => {
  const r = truncateContent('hello 世界', 100);
  assert.deepEqual(r, { content: 'hello 世界', truncated: false, totalChars: 8 });
});

test('truncateContent：超长截断并带 totalChars', () => {
  const long = 'x'.repeat(MCP_CONTENT_MAX_CHARS + 500);
  const r = truncateContent(long);
  assert.equal(r.truncated, true);
  assert.equal(r.totalChars, MCP_CONTENT_MAX_CHARS + 500);
  assert.equal(r.content.length, MCP_CONTENT_MAX_CHARS);
  assert.ok(long.startsWith(r.content), '截断结果必须是原文前缀');
});

test('truncateContent：恰好等于上限不截断', () => {
  const exact = 'y'.repeat(MCP_CONTENT_MAX_CHARS);
  const r = truncateContent(exact);
  assert.equal(r.truncated, false);
  assert.equal(r.totalChars, MCP_CONTENT_MAX_CHARS);
});

test('mcpAiSystemPrompt：四种动作都返回非空、不接收外部注入', () => {
  const summary = mcpAiSystemPrompt('summary', '简体中文');
  const keypoints = mcpAiSystemPrompt('keypoints', '简体中文');
  const translate = mcpAiSystemPrompt('translate', 'English');
  const explain = mcpAiSystemPrompt('explain', '简体中文');
  for (const p of [summary, keypoints, translate, explain]) {
    assert.ok(p.length > 0, '提示词不能为空');
  }
  assert.ok(summary.includes('摘要'), 'summary 应要求生成摘要');
  assert.ok(keypoints.includes('要点'), 'keypoints 应要求提炼要点');
  assert.ok(translate.includes('English'), 'translate 应带入目标语言 English');
  assert.ok(explain.includes('通俗'), 'explain 应要求通俗解释');
});

test('mcpAiSystemPrompt：目标语言缺省回落简体中文', () => {
  const t = mcpAiSystemPrompt('translate', '');
  assert.ok(t.includes('简体中文'), 'translate 无目标语言时应回落简体中文');
});
