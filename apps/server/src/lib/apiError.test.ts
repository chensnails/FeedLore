/**
 * 错误码工具的单测：响应形状、状态码兜底、以及落库用的 `E_CODE:补充信息` 标识。
 *
 * 这三件事分别是前端词典、HTTP 语义与「抓取失败原因」展示的地基，
 * 改坏了不会报错，只会让界面掉到英文或让tooltip 变成裸码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiErrorBody, apiErrorKey, ApiException, isApiErrorCode } from './apiError';

test('apiErrorBody 用码表默认文案与状态码', () => {
  assert.deepEqual(apiErrorBody('E_DB_NOT_READY'), {
    error: 'E_DB_NOT_READY',
    message: 'Database is not ready',
    status: 503,
  });
});

test('detail 同时进英文说明和 params，供前端词典插值', () => {
  const body = apiErrorBody('E_MODEL_URL_UNREACHABLE', { detail: 'connect ECONNREFUSED' });
  assert.equal(body.message, 'Model base URL is not reachable: connect ECONNREFUSED');
  assert.deepEqual(body.params, { detail: 'connect ECONNREFUSED' });
});

test('params 与 detail 合并，显式 status 覆盖默认值', () => {
  const body = apiErrorBody('E_USER_NOT_FOUND', { status: 401, params: { name: 'bob' } });
  assert.equal(body.status, 401);
  assert.deepEqual(body.params, { name: 'bob' });
});

test('ApiException 带着码与状态抛出，onError 原样序列化', () => {
  const e = new ApiException('E_FEED_URL_DUPLICATE', { params: { name: '例子星球' } });
  assert.equal(e.status, 409);
  assert.equal(e.code, 'E_FEED_URL_DUPLICATE');
  assert.equal(apiErrorKey(e), 'E_FEED_URL_DUPLICATE');
});

test('apiErrorKey：有码存码，带补充信息用冒号，没码存英文原文', () => {
  assert.equal(apiErrorKey(new ApiException('E_FETCH_TIMEOUT')), 'E_FETCH_TIMEOUT');
  assert.equal(
    apiErrorKey(new ApiException('E_FETCH_HTTP_STATUS', { detail: 403 })),
    'E_FETCH_HTTP_STATUS:403',
  );
  // 非契约错误（系统异常）：原样保留，前端词典会退回这串文本
  assert.equal(apiErrorKey(new Error('socket hang up')), 'socket hang up');
  assert.equal(apiErrorKey('boom'), 'boom');
});

test('未知字符串不会被误认成错误码', () => {
  assert.equal(isApiErrorCode('E_NOT_IN_THE_TABLE'), false);
  assert.equal(isApiErrorCode('数据库未就绪'), false);
  assert.equal(apiErrorKey({ message: '数据库未就绪' }), '数据库未就绪');
});
