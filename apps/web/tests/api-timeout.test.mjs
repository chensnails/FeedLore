/* 请求超时的两条线（node --test）
 *
 * 1) 超时之后用户看到的话必须是人话。踩过的坑：超时分支先 abort 再 reject，
 *    abort 让 fetch 立刻抛底层英文（Chrome: `signal is aborted without reason`），
 *    它抢在中文提示前面，界面上就是这句天书（用户截图反馈过）。
 * 2) AI 类长任务不能吃 30s 写超时 —— 服务端一次模型调用允许 180s，
 *    实测出现「前端 30s 报错、服务端 99s 才成功」。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  apiFetch,
  NET_AI_TIMEOUT_MS,
  NET_RETRY_AFTER_MAX_MS,
  NET_TIMEOUT_MS,
  NET_WRITE_TIMEOUT_MS,
  parseRetryAfter,
} from '../src/core/util.ts';

/** 模拟「上游一直不回」：只有 abort 时才 reject，且抛的是浏览器那句底层英文。 */
function installHangingFetch(holder) {
  const real = globalThis.fetch;
  globalThis.fetch = (_url, opts) =>
    new Promise((_, reject) => {
      const sig = opts && opts.signal;
      if (!sig) return; // 永不 settle
      if (sig.aborted)
        return reject(
          sig.reason ?? new DOMException('signal is aborted without reason', 'AbortError'),
        );
      sig.addEventListener(
        'abort',
        () => {
          reject(sig.reason ?? new DOMException('signal is aborted without reason', 'AbortError'));
        },
        { once: true },
      );
    });
  holder.restore = () => {
    globalThis.fetch = real;
  };
}

test('超时文案是中文，不漏底层 abort 英文', async () => {
  const h = {};
  installHangingFetch(h);
  try {
    await assert.rejects(
      () => apiFetch('/api/entry/1/ai', { method: 'POST', body: '{}', timeoutMs: 1200 }),
      (err) => {
        assert.match(err.message, /网络请求超时（1 秒）/);
        assert.doesNotMatch(err.message, /signal is aborted/i);
        assert.doesNotMatch(err.message, /without reason/i);
        return true;
      },
    );
  } finally {
    h.restore();
  }
});

test('AI 长任务的上限要覆盖服务端的 180s', () => {
  assert.ok(NET_AI_TIMEOUT_MS >= 180_000, `AI 超时太短：${NET_AI_TIMEOUT_MS}`);
  assert.ok(NET_AI_TIMEOUT_MS > NET_WRITE_TIMEOUT_MS, 'AI 超时不能小于写超时');
  // 其余请求维持原状：GET 8s、写 30s
  assert.equal(NET_TIMEOUT_MS, 8000);
  assert.equal(NET_WRITE_TIMEOUT_MS, 30000);
});

test('Retry-After 解析：秒数 / HTTP 日期 / 无效值 / 上限', () => {
  const now = Date.parse('2026-11-21T00:00:00Z');
  assert.equal(parseRetryAfter('2', now), 2000);
  assert.equal(parseRetryAfter(' 3 ', now), 3000);
  assert.equal(parseRetryAfter(new Date(now + 2000).toUTCString(), now), 2000);
  assert.equal(parseRetryAfter(new Date(now - 1000).toUTCString(), now), 0);
  assert.equal(parseRetryAfter('not-a-date', now), 0);
  assert.equal(parseRetryAfter(null, now), 0);
  assert.equal(parseRetryAfter('999', now), NET_RETRY_AFTER_MAX_MS);
});

/** 429 桩：第一次带 Retry-After，第二次 200；记录两次请求间隔。 */
function installRateLimitedFetch(holder, header) {
  const real = globalThis.fetch;
  let n = 0;
  let firstAt = 0;
  let gap = 0;
  globalThis.fetch = () => {
    n += 1;
    if (n === 1) {
      firstAt = Date.now();
      return Promise.resolve({
        status: 429,
        headers: { get: (k) => (String(k).toLowerCase() === 'retry-after' ? header : null) },
      });
    }
    gap = Date.now() - firstAt;
    return Promise.resolve({ status: 200, ok: true });
  };
  holder.restore = () => {
    globalThis.fetch = real;
  };
  holder.stats = () => ({ n, gap });
}

test('429 GET 重试采纳 Retry-After（秒数），但写操作仍不重试', async () => {
  const h = {};
  installRateLimitedFetch(h, '1');
  try {
    const res = await apiFetch('/api/entries');
    assert.equal(res.status, 200);
    const { n, gap } = h.stats();
    assert.equal(n, 2, '429 应重试一次');
    assert.ok(gap >= 900, `Retry-After=1s 未被采纳，实际只等了 ${gap}ms`);
  } finally {
    h.restore();
  }

  const w = {};
  installRateLimitedFetch(w, '0');
  try {
    const res = await apiFetch('/api/entries', { method: 'POST', body: '{}' });
    assert.equal(res.status, 429);
    assert.equal(w.stats().n, 1, '写操作绝不自动重试');
  } finally {
    w.restore();
  }
});
