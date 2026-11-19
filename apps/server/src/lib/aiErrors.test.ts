/* 模型调用失败的判定与文案（node --test）
 *
 * 两件容易回归的事：
 * 1) 中断/超时的判定不能只比 `name === 'AbortError'` —— undici 会换着花样抛
 *    （TypeError: terminated、message 里带 "signal is aborted without reason"），
 *    漏判的结果就是底层英文原样漏到界面上（用户截图反馈过）。
 * 2) 失败原因必须带 `E_AI_*` 稳定码，中文由前端 core/errorText.js 负责。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { aiError, isAbortError } from '@feedlore/ai';

test('isAbortError：认 AbortError 的各种马甲', () => {
  assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isAbortError(new Error('signal is aborted without reason')), true);
  assert.equal(isAbortError(new Error('This operation was aborted')), true);
  assert.equal(isAbortError(new TypeError('terminated')), true);
  assert.equal(isAbortError(new Error('The request timed out')), true);
  assert.equal(isAbortError(Object.assign(new Error('x'), { code: 'ABORT_ERR' })), true);
  // cause 里包一层也要认（fetch failed → cause: AbortError）
  assert.equal(
    isAbortError(Object.assign(new Error('fetch failed'), { cause: { name: 'AbortError' } })),
    true,
  );
});

test('isAbortError：普通网络错误不误判', () => {
  assert.equal(isAbortError(new Error('connect ECONNREFUSED 127.0.0.1:1')), false);
  assert.equal(isAbortError(new Error('getaddrinfo ENOTFOUND api.example.com')), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError('aborted'), false); // 只认对象，字符串不当错误
});

test('aiError：稳定码 + 英文补充', () => {
  assert.equal(aiError('E_AI_TIMEOUT').message, 'E_AI_TIMEOUT');
  assert.equal(
    aiError('E_AI_TIMEOUT', 'no response within 180s').message,
    'E_AI_TIMEOUT: no response within 180s',
  );
});
