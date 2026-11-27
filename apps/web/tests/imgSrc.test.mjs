import assert from 'node:assert/strict';
import test from 'node:test';
import { widthSrcSet, widthVariant, withRetryParam } from '../src/imgSrc.ts';

test('widthVariant: 代理地址追加档位，外链先补代理', () => {
  assert.equal(widthVariant('/api/img?u=a%2Fb.png', 320), '/api/img?u=a%2Fb.png&w=320');
  assert.equal(
    widthVariant('https://img.example/a.png?v=1', 640),
    '/api/img?u=' + encodeURIComponent('https://img.example/a.png?v=1') + '&w=640',
  );
});

test('widthVariant: data / 空值 / 其它协议不做变体', () => {
  for (const bad of [
    '',
    null,
    undefined,
    'data:image/png;base64,xx',
    'javascript:alert(1)',
    '/local.png',
  ]) {
    assert.equal(widthVariant(bad, 320), '', `应跳过 ${String(bad)}`);
  }
});

test('widthSrcSet: 生成 w 描述符，不可代理时返回 undefined', () => {
  const set = widthSrcSet('/api/img?u=x', [320, 640, 960]);
  assert.equal(set, '/api/img?u=x&w=320 320w, /api/img?u=x&w=640 640w, /api/img?u=x&w=960 960w');
  assert.equal(widthSrcSet('', [320]), undefined);
});

test('withRetryParam: 首错重试加 r=1，data URI 原样返回', () => {
  assert.equal(withRetryParam('/api/img?u=x'), '/api/img?u=x&r=1');
  assert.equal(withRetryParam('/api/img?u=x&w=320'), '/api/img?u=x&w=320&r=1');
  assert.equal(withRetryParam('/local.png'), '/local.png?r=1');
  assert.equal(withRetryParam('data:image/png;base64,xx'), 'data:image/png;base64,xx');
  assert.equal(withRetryParam(''), '');
});
