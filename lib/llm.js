'use strict';

/**
 * 笺川 · 每用户模型配置（LLM）
 *
 * 与站点级 settings.llm 同构，但跟随账号生效。用户自己配了就用用户的，否则回退站点默认。
 * 内存里持有明文 apiKey；落库前换 apiKeyEnc；前端只见「是否设置 + 掩码」，绝不含明文 / 密文。
 *
 * v2.2.0 起抽出到 lib/：站点默认由调用方传入（原本直接读模块级 settings）。
 */

const { clampNum } = require('./util');
const { encryptSecret, decryptSecret, maskSecret } = require('./crypto');

/** llm 组的「落库形态」：内存里持有明文 apiKey，写库前必须换成 apiKeyEnc */
function llmForStore(llm, cryptoSecret) {
  const src = llm || {};
  const out = Object.assign({}, src);
  delete out.apiKey;
  // 传了新的明文 Key 就重新加密；没传就沿用原有密文（万一解密失败也不会把 Key 抹掉）。
  // 要「清除 Key」时显式传 apiKeyEnc: ''，那样这里会写成空串。
  out.apiKeyEnc = src.apiKey ? encryptSecret(src.apiKey, cryptoSecret) : String(src.apiKeyEnc || '');
  return out;
}

/** 校验并夹取用户写入的 llm 字段（落库前） */
function sanitizeUserLlm(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  out.baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : '';
  out.model = typeof raw.model === 'string' ? raw.model.trim() : '';
  out.temperature = clampNum(raw.temperature, 0.3, 0, 1.5);
  return out;
}

/** 落库形态：明文 apiKey → 密文 apiKeyEnc；clearApiKey 则清空；否则沿用原密文 */
function userLlmForStore(raw, cryptoSecret) {
  const src = raw || {};
  const out = sanitizeUserLlm(src);
  if (src.clearApiKey) { out.apiKeyEnc = ''; return out; }
  out.apiKeyEnc = src.apiKey ? encryptSecret(src.apiKey, cryptoSecret) : String(src.apiKeyEnc || '');
  return out;
}

/** 读库后返回给前端的视图：含「是否设置 + 掩码」，绝不含明文 / 密文 */
function userLlmForView(prefs, cryptoSecret) {
  const l = (prefs && prefs.llm) || {};
  const enc = typeof l.apiKeyEnc === 'string' ? l.apiKeyEnc : '';
  const set = !!enc;
  return {
    baseUrl: typeof l.baseUrl === 'string' ? l.baseUrl : '',
    model: typeof l.model === 'string' ? l.model : '',
    temperature: typeof l.temperature === 'number' ? l.temperature : 0.3,
    apiKeySet: set,
    apiKeyHint: set ? maskSecret(decryptSecret(enc, cryptoSecret)) : '',
  };
}

/** 解析「当前用户的有效模型配置」：用户自己配的优先，未配回退站点默认 */
function resolveUserLlm(user, siteLlm, cryptoSecret) {
  const u = (user && user.prefs && user.prefs.llm) || {};
  const site = siteLlm || {};
  let apiKey = '';
  if (typeof u.apiKeyEnc === 'string' && u.apiKeyEnc) apiKey = decryptSecret(u.apiKeyEnc, cryptoSecret) || '';
  if (!apiKey) apiKey = site.apiKey || '';
  return {
    baseUrl: u.baseUrl || site.baseUrl || '',
    model: u.model || site.model || '',
    temperature: (typeof u.temperature === 'number') ? u.temperature
      : (typeof site.temperature === 'number' ? site.temperature : 0.3),
    apiKey,
  };
}

module.exports = { llmForStore, sanitizeUserLlm, userLlmForStore, userLlmForView, resolveUserLlm };
