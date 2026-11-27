/* 服务端错误码 → 中文文案的回归（node --test）
 *
 * 这里守的是「界面语言」这条线：服务端只回错误码，一旦某个码在这里漏了，
 * 界面会掉到英文；测试跑的是真实响应形状，不改服务端任何东西。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { AI_INTERNAL_ERROR_CODES, API_ERROR_CODES } from '../../../packages/contract/src/errors.ts';
import { errorText } from '../src/core/errorText.ts';

test('命中的错误码出中文', () => {
  assert.equal(
    errorText({ error: 'E_DB_NOT_READY', message: 'Database is not ready', status: 503 }),
    '数据库未就绪',
  );
  assert.equal(
    errorText({ error: 'E_READONLY_CREDENTIAL', status: 403 }),
    '只读账户不能修改用户名或密码，请联系管理员',
  );
});

test('导入 / 整站还原的错误码出中文', () => {
  assert.equal(
    errorText('E_IMPORT_INVALID'),
    '上传的文件不是有效的导出包或备份包，请检查是否选错了文件',
  );
  assert.equal(errorText('E_IMPORT_TOO_LARGE'), '上传的文件太大，请检查是否选错了包');
  assert.equal(
    errorText({ error: 'E_RESTORE_IN_PROGRESS', status: 409 }),
    '已经有一份整站还原在进行，等它完成后再试',
  );
  // 传错入口：告诉用户该去哪里，而不是笼统的「文件无效」
  assert.equal(
    errorText('E_ARCHIVE_IS_USER_EXPORT'),
    '这是账号导出包，不能用于整站还原；请到「数据导入」上传',
  );
  assert.equal(
    errorText('E_ARCHIVE_IS_SITE_BACKUP'),
    '这是整站备份，不能用于账号导入；请到「整站还原」上传',
  );
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

test('模型调用的稳定码出中文（E_AI_*）', () => {
  assert.equal(
    errorText('E_AI_TIMEOUT'),
    '模型响应超时（上游一直没回），可以重试或换一个更快的模型',
  );
  assert.equal(
    errorText({ error: 'E_AI_AUTH', status: 401 }),
    '模型拒绝鉴权：API Key 无效或没有调用权限',
  );
  assert.equal(errorText('E_AI_HTTP:502 bad gateway'), '模型接口返回错误：502 bad gateway');
  assert.equal(errorText('E_AI_NOT_CONFIGURED'), '模型未配置完整：地址、API Key、模型名都要填好');
});

test('Error 实例的 message 里带码也能翻译（二次 errText 不再吐裸码）', () => {
  // 调用方常见写法：throw new Error(errText(data)) → 再 errText(err) 一次
  assert.equal(errorText(new Error('E_AI_NO_MODELS')), '上游没有返回任何模型，请手动填写模型名称');
  assert.equal(
    errorText(new Error('E_AI_TIMEOUT: no response within 180s')),
    '模型响应超时（上游一直没回），可以重试或换一个更快的模型：no response within 180s',
  );
  // 不是码的普通 Error 仍然原样透出，不能被词典吞掉
  assert.equal(
    errorText(new Error('signal is aborted without reason')),
    'signal is aborted without reason',
  );
});

test('96 个已知错误码全部有中文文案（快照）', () => {
  const codes = [...API_ERROR_CODES, ...AI_INTERNAL_ERROR_CODES];
  assert.equal(codes.length, 96, `码表数量变了：${codes.length}（快照需同步）`);
  const missing = [];
  const snapshot = {};
  for (const code of codes) {
    const text = errorText({ error: code, message: 'Upstream error' });
    if (text === code || /^Upstream/.test(text)) missing.push(code);
    snapshot[code] = text;
  }
  assert.deepEqual(missing, [], '这些码掉回英文/裸码：' + missing.join(', '));
  // 固化一批关键码的文案，误改即红灯
  for (const [code, expected] of Object.entries({
    E_DB_NOT_READY: '数据库未就绪',
    E_RATE_LIMITED: '登录尝试过于频繁，请稍后再试',
    E_PASSWORD_CHANGE_REQUIRED: '请先修改初始密码，改完才能继续使用',
    E_AI_NO_MODELS: '上游没有返回任何模型，请手动填写模型名称',
  })) {
    assert.equal(snapshot[code], expected, `${code} 文案漂移：${snapshot[code]}`);
  }
});

test('没在码表里的值按原样回退', () => {
  // 网关 HTML / 旧数据里的中文串：原样显示，不能变成裸码
  assert.equal(errorText('拿不到该地址的 feed'), '拿不到该地址的 feed');
  // 码表之外但长得像码：退回英文 message
  assert.equal(
    errorText({ error: 'E_NOT_IN_TABLE', message: 'Upstream said no' }),
    'Upstream said no',
  );
  // 完全没有码也没有文案：用调用方的中文兜底
  assert.equal(errorText({}, '保存失败'), '保存失败');
  assert.equal(errorText(null, '添加失败'), '添加失败');
});
