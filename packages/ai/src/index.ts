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
  decryptSecret,
  ENCRYPTED_PREFIX,
  encryptSecret,
  getCryptoSecret,
  maskSecret,
  resetCryptoSecretCache,
  SECRET_SETTING_KEY,
} from './crypto';
export {
  type AiUsageTotal,
  EMPTY_USAGE,
  fillDigestImages,
  type GenerateInput,
  type GenerateResult,
  generateDigest,
  listDigestDates,
  pruneDigests,
  readDigest,
  shanghaiDate,
} from './digest';
export {
  aiError,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type ChatUsage,
  chat,
  clampTemperature,
  extractJson,
  type FetchLike,
  isAbortError,
  LLM_TIMEOUT_MS,
  type LlmRow,
  listModels,
  llmComplete,
  llmEndpoint,
  modelsEndpoint,
  normalizeThinkingDepth,
  parseChatUsage,
  parseModelList,
  type ResolvedLlm,
  resolveUserLlm,
  TEMPERATURE_DEFAULT,
  THINKING_DEPTH_DEFAULT,
  testLlm,
  thinkingBudget,
  userLlmForStore,
  userLlmForView,
} from './llm';

export {
  AI_TAG_MAX,
  AI_TAG_PROMPT_VERSION,
  entryTagSystemPrompt,
  parseTagList,
  type SuggestTagsResult,
  suggestEntryTags,
} from './tagging';
