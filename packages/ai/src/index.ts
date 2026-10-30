/**
 * @feedlore/ai — 模型配置与 AI 日报
 *
 * 分三层，边界清楚：
 * - `crypto`：apiKey 的 AEAD 加解密（与 legacy 密文兼容，迁移不用重填 Key）；
 * - `llm`：每账号模型配置的视图/落库/调用（出网 fetch 由调用方注入，本包不做 SSRF 判定）；
 * - `digest`：采集 → 压缩 → 生成 → 落库的完整日报流程。
 *
 * 为什么出网要注入：`apps/server/src/lib/net.ts` 是 SSRF 唯一判定点（DNS 双段判定 +
 * 逐跳重定向 + IP 钉定）。若本包自己 `fetch(url)`，模型地址就成了一条绕过校验的暗路。
 */

export {
  ENCRYPTED_PREFIX,
  SECRET_SETTING_KEY,
  encryptSecret,
  decryptSecret,
  maskSecret,
  getCryptoSecret,
  resetCryptoSecretCache,
} from './crypto';

export {
  THINKING_DEPTH_DEFAULT,
  TEMPERATURE_DEFAULT,
  LLM_TIMEOUT_MS,
  normalizeThinkingDepth,
  thinkingBudget,
  clampTemperature,
  resolveUserLlm,
  userLlmForView,
  userLlmForStore,
  llmComplete,
  llmEndpoint,
  chat,
  extractJson,
  testLlm,
  type ChatMessage,
  type ChatOptions,
  type FetchLike,
  type LlmRow,
  type ResolvedLlm,
} from './llm';

export {
  shanghaiDate,
  generateDigest,
  readDigest,
  listDigestDates,
  pruneDigests,
  type GenerateInput,
  type GenerateResult,
} from './digest';
