import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMG_FAIL_MAX,
  IMG_FAIL_TTL_MS,
  clearImgFail,
  imgFailKey,
  isImgFailed,
  markImgFailed,
} from '../src/imgFail.js';

test('imgFailKey: 去掉宽度、重试标记与 hash，srcset 变体归一到同一 key', () => {
  const base = '/api/img?u=https%3A%2F%2Fimg.example%2Fa.png';
  assert.equal(imgFailKey(base + '&w=320'), base);
  assert.equal(imgFailKey(base + '&w=960&r=1'), base);
  assert.equal(imgFailKey(base + '&r=1#frag'), base);
  assert.equal(imgFailKey('https://img.example/a.png#x'), 'https://img.example/a.png');
});

test('imgFailKey: 空值 / data URI 记空，非代理地址原样', () => {
  assert.equal(imgFailKey(''), '');
  assert.equal(imgFailKey(null), '');
  assert.equal(imgFailKey(undefined), '');
  assert.equal(imgFailKey('data:image/png;base64,xxx'), '', 'base64 不能塞进内存表');
  assert.equal(imgFailKey('/local.png'), '/local.png');
});

test('mark / is: TTL 内命中，过期后自动失效（反向断言）', () => {
  clearImgFail();
  const at = 1_000_000;
  markImgFailed('/api/img?u=a', at);
  assert.equal(isImgFailed('/api/img?u=a&w=320', at + 1), true, '宽度变体应共享失败记忆');
  assert.equal(isImgFailed('/api/img?u=a', at + IMG_FAIL_TTL_MS - 1), true);
  assert.equal(isImgFailed('/api/img?u=a', at + IMG_FAIL_TTL_MS), false, '到 TTL 必须失效');
});

test('mark: 未记录过的地址永远不算失败', () => {
  clearImgFail();
  assert.equal(isImgFailed('/api/img?u=never'), false);
});

test('mark: 空值 / data URI 之外的普通地址可记；空值不产生条目', () => {
  clearImgFail();
  markImgFailed('');
  assert.equal(isImgFailed(''), false);
});

test('clearImgFail: 手动刷新后所有图重新尝试', () => {
  clearImgFail();
  markImgFailed('/api/img?u=a');
  markImgFailed('/api/img?u=b');
  clearImgFail();
  assert.equal(isImgFailed('/api/img?u=a'), false);
  assert.equal(isImgFailed('/api/img?u=b'), false);
});

test('mark: 离线时不记录（断网失败不是图片本身的问题）', () => {
  const original = globalThis.navigator;
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
    clearImgFail();
    markImgFailed('/api/img?u=offline');
    assert.equal(isImgFailed('/api/img?u=offline'), false);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
  }
});

test('mark: 条目上限生效，最旧的先被淘汰', () => {
  clearImgFail();
  const at = 2_000_000;
  for (let i = 0; i < IMG_FAIL_MAX + 10; i += 1) markImgFailed('/api/img?u=' + i, at);
  assert.equal(isImgFailed('/api/img?u=0', at + 1), false, '最旧的应被淘汰');
  assert.equal(isImgFailed('/api/img?u=' + (IMG_FAIL_MAX + 9), at + 1), true, '最新的应保留');
  assert.equal(isImgFailed('/api/img?u=' + (IMG_FAIL_MAX - 1), at + 1), true);
});
