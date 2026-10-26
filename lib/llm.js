'use strict';

/**
 * 笺川 · 每用户模型配置（LLM）
 *
 * 模型配置完全跟随账号：站点级 settings.llm 与「没配就回退站点默认」那条兜底链一起退场了
 * （v1.4.0），因为普通用户并不想让自己的日报跑在别人选的模型上，管理员也不该替所有人决定。
 * 内存里持有明文 apiKey；落库前换 apiKeyEnc；前端只见「是否设置 + 掩码」，绝不含明文 / 密文。
 */

const { clampNum } = require('./util');
const { encryptSecret, decryptSecret, maskSecret } = require('./crypto');

/* ---------- 思考模式（reasoning）参数 ----------
 * 三档深度映射成 thinking_budget（token）：给的是「让它想多久」的预算，不是温度那种软约束。
 * 上限 8192 是刻意收的——再往上日报这种小任务只会把定时调度拖到几分钟，收益递减。 */
const THINKING_DEPTHS = ['low', 'medium', 'high'];
const THINKING_BUDGET = { low: 512, medium: 2048, high: 8192 };
const THINKING_DEPTH_DEFAULT = 'medium';

const normDepth = (v) => (THINKING_DEPTHS.indexOf(v) >= 0 ? v : null);
const thinkingBudget = (depth) => THINKING_BUDGET[normDepth(depth) || THINKING_DEPTH_DEFAULT];

/** 校验并夹取用户写入的 llm 字段（落库前） */
function sanitizeUserLlm(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  out.baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : '';
  out.model = typeof raw.model === 'string' ? raw.model.trim() : '';
  out.temperature = clampNum(raw.temperature, 0.3, 0, 1.5);
  /* 思考两项只在「用户确实提交过」时才写键：没提交就留空，读的时候由 userLlm 兜默认，
   * 存一堆没人表过态的 false 只会让偏好里长满无意义的键。 */
  if (typeof raw.thinking === 'boolean') out.thinking = raw.thinking;
  const depth = normDepth(raw.thinkingDepth);
  if (depth) out.thinkingDepth = depth;
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
    thinking: l.thinking === true,
    thinkingDepth: normDepth(l.thinkingDepth) || THINKING_DEPTH_DEFAULT,
    apiKeySet: set,
    apiKeyHint: set ? maskSecret(decryptSecret(enc, cryptoSecret)) : '',
  };
}

/** 解析「当前用户的有效模型配置」。只有账号自己那一份——站点级兜底已经随 settings.llm 一起退场。 */
function userLlm(user, cryptoSecret) {
  const u = (user && user.prefs && user.prefs.llm) || {};
  const enc = typeof u.apiKeyEnc === 'string' ? u.apiKeyEnc : '';
  const thinking = u.thinking === true;
  const depth = normDepth(u.thinkingDepth) || THINKING_DEPTH_DEFAULT;
  return {
    baseUrl: typeof u.baseUrl === 'string' ? u.baseUrl : '',
    model: typeof u.model === 'string' ? u.model : '',
    temperature: typeof u.temperature === 'number' ? u.temperature : 0.3,
    // 解密失败（换过 cryptoSecret 的老数据）当「没配 Key」处理，别拿半截凭据去请求
    apiKey: enc ? (decryptSecret(enc, cryptoSecret) || '') : '',
    thinking,
    // 档位与折算后的预算一起给：调用方只管读预算，映射表留在这里一处
    thinkingDepth: depth,
    thinkingBudget: thinkingBudget(depth),
  };
}

/** 三项齐了才真能调模型；缺任何一项就不该排队生成，直接告诉用户去哪补 */
const llmComplete = (llm) => !!(llm && llm.baseUrl && llm.apiKey && llm.model);

module.exports = {
  sanitizeUserLlm, userLlmForStore, userLlmForView, userLlm, llmComplete,
  THINKING_DEPTHS, THINKING_BUDGET, THINKING_DEPTH_DEFAULT, thinkingBudget,
};
