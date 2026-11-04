/* 服务端错误码 → 中文文案的回归（node --test）
 *
 * 这里守的是「界面语言」这条线：服务端只回错误码，一旦某个码在这里漏了，
 * 界面会掉到英文；测试跑的是真实响应形状，不改服务端任何东西。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { errorText } from '../src/core/errorText.js';

test('命中的错误码出中文', () => {
  assert.equal(
    errorText({ error: 'E_DB_NOT_READY', message: 'Database is not ready', status: 503 }),
    '数据库未就绪',
  );
  assert.equal(errorText({ error: 'E_READONLY_CREDENTIAL', status: 403 }), '只读账户不能修改用户名或密码，请联系管理员');
});

test('导入 / 整站还原的错误码出中文', () => {
  assert.equal(errorText('E_IMPORT_INVALID'), '上传的文件不是有效的导出包，请检查是否选错了文件');
  assert.equal(errorText('E_IMPORT_TOO_LARGE'), '上传的文件太大，请检查是否选错了包');
  assert.equal(errorText({ error: 'E_RESTORE_IN_PROGRESS', status: 409 }), '已经有一份整站还原在进行，等它完成后再试');
});

test('动态文案从 params 插值', () => {
  assert.equal(
    errorText({ error: 'E_RATE_LIMITED', status: 429, params: { retryAfter: 42 } }),
    '登录尝试过于频繁，请 42 秒后再试',
  );
  assert.equal(
    errorText({ error: 'E_FEED_URL_DUPLICATE', status: 409, params: { name: '例子星球' } }),
    '这个地址已经是你的另一个频道：例子星球',
  );
});

test('上游细节以 detail 附在中文后面', () => {
  assert.equal(
    errorText({
      error: 'E_MODEL_URL_UNREACHABLE',
      message: 'Model base URL is not reachable: connect ECONNREFUSED',
      status: 400,
      params: { detail: 'connect ECONNREFUSED 127.0.0.1:1' },
    }),
    '模型地址不可用：connect ECONNREFUSED 127.0.0.1:1',
  );
});

test('持久化的抓取失败：E_CODE:补充信息', () => {
  assert.equal(errorText('E_FETCH_TIMEOUT'), '抓取超时');
  assert.equal(errorText('E_FETCH_HTTP_STATUS:403'), '站点返回错误：403');
});

test('没在码表里的值按原样回退', () => {
  // 网关 HTML / 旧数据里的中文串：原样显示，不能变成裸码
  assert.equal(errorText('拿不到该地址的 feed'), '拿不到该地址的 feed');
  // 码表之外但长得像码：退回英文 message
  assert.equal(errorText({ error: 'E_NOT_IN_TABLE', message: 'Upstream said no' }), 'Upstream said no');
  // 完全没有码也没有文案：用调用方的中文兜底
  assert.equal(errorText({}, '保存失败'), '保存失败');
  assert.equal(errorText(null, '添加失败'), '添加失败');
});
