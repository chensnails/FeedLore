import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COND_MAX_FACTOR,
  classifyCond,
  condFactor,
  condHost,
  condPenalties,
  noteCond,
  resetCondForTest,
} from './feedCond';

test('condHost: 去端口、小写、协议与非法输入', () => {
  assert.equal(condHost('https://RSSHub.Example.com:8443/a?b=1'), 'rsshub.example.com');
  assert.equal(condHost('http://127.0.0.1/x'), '127.0.0.1');
  assert.equal(condHost('ftp://example.com/x'), '');
  assert.equal(condHost('not a url'), '');
});

test('classifyCond: 没条件头可带时不参与统计', () => {
  assert.equal(classifyCond({}, { status: 200, etag: 'x' }), 'skip');
  assert.equal(classifyCond({ etag: null, lastModified: null }, { status: 200 }), 'skip');
});

test('classifyCond: 304 一律算命中', () => {
  assert.equal(classifyCond({ etag: 'a' }, { status: 304, etag: 'a' }), 'hit');
  assert.equal(classifyCond({ lastModified: 'Tue' }, { status: 304 }), 'hit');
});

test('classifyCond: 200 且校验头没变 = 源站忽略条件请求（不能误判成正常更新）', () => {
  assert.equal(classifyCond({ etag: '"v1"' }, { status: 200, etag: '"v1"' }), 'ignored');
  assert.equal(
    classifyCond({ lastModified: 'Tue' }, { status: 200, lastModified: 'Tue' }),
    'ignored',
  );
  // 有头变了就是真更新，清计数
  assert.equal(classifyCond({ etag: '"v1"' }, { status: 200, etag: '"v2"' }), 'fresh');
  assert.equal(classifyCond({ etag: '"v1"' }, { status: 200, lastModified: 'Wed' }), 'fresh');
  // 一侧缺头无从比较，按正常处理，避免误伤
  assert.equal(classifyCond({ etag: '"v1"' }, { status: 200 }), 'fresh');
});

test('连续 3 次忽略才翻倍，上限 4 倍；一次 304 立即恢复', () => {
  resetCondForTest();
  const host = 'rsshub.example.com';
  noteCond(host, 'ignored');
  noteCond(host, 'ignored');
  assert.equal(condFactor(host), 1, '2 次还不降频，避免偶发抖动');
  noteCond(host, 'ignored');
  assert.equal(condFactor(host), 2);
  noteCond(host, 'ignored');
  noteCond(host, 'ignored');
  noteCond(host, 'ignored');
  assert.equal(condFactor(host), COND_MAX_FACTOR, '最多 4 倍，不能无限拉长');
  assert.equal(condPenalties().length, 1);
  noteCond(host, 'hit');
  assert.equal(condFactor(host), 1, '重新认条件头就恢复');
  assert.equal(condPenalties().length, 0);
});

test('fresh 也清计数；空 host 与 skip 静默忽略', () => {
  resetCondForTest();
  noteCond('', 'ignored');
  noteCond('a.example', 'skip');
  assert.equal(condFactor(''), 1);
  assert.equal(condFactor('a.example'), 1);
  noteCond('a.example', 'ignored');
  noteCond('a.example', 'ignored');
  noteCond('a.example', 'ignored');
  assert.equal(condFactor('a.example'), 2);
  noteCond('a.example', 'fresh');
  assert.equal(condFactor('a.example'), 1);
});
