/**
 * 单条目 AI 标签（Phase 2 · 智能标签）
 *
 * 这里只放「与模型对话」的部分：系统提示词 + 模型返回的 JSON 解析。
 * 调度、按账号隔离、落库、限流、SSRF 校验都在服务端 `lib/aiTag.ts` 完成——
 * 本文件不碰数据库，也不自己出网（fetch 由调用方注入 `safeFetch`）。
 */

import { type ChatMessage, type ChatUsage, chat, type FetchLike, type ResolvedLlm } from './llm';

/** 提示词版本：标签生成逻辑变了就 +1，落库以便之后按版本重算。 */
export const AI_TAG_PROMPT_VERSION = 1;

/** 单篇最多保留的标签数，防止模型刷一堆垃圾标签把列表撑爆。 */
export const AI_TAG_MAX = 8;

/** 喂给模型的正文上限（与单条目 AI 动作一致）。 */
const AI_TAG_MAX_CHARS = 24_000;

export function entryTagSystemPrompt(): string {
  return [
    '你是一个严谨的中文内容标签助手。请阅读下面这篇 RSS 文章（标题 + 正文），',
    `提炼 ${1}~${AI_TAG_MAX} 个最能代表其主题的中文标签。`,
    '要求：',
    '1. 每个标签是一个简短的中文词或短语（2~8 个字），不要带「#」号；',
    '2. 反映主题 / 领域 / 事件，避免「文章」「资讯」「日报」这类废词；',
    '3. 优先用已有常见分类词（如：锂电、新能源、财报、政策、技术、市场），必要时自造；',
    '4. 只输出一个 JSON，格式为 {"tags":["标签1","标签2",...]}，不要任何解释或前后缀。',
  ].join('\n');
}

/** 把模型返回的字符串解析成标签数组；容错：兼容 ```json 包裹、纯数组、逗号分隔退化。 */
export function parseTagList(raw: string): string[] {
  let s = (raw || '').trim();
  if (!s) return [];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();

  if (!s.startsWith('{')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return cleanTags(arr);
    } catch {
      /* 退化到按分隔符拆 */
    }
    return cleanTags(s.split(/[\n,，、]/).map((x) => x.trim()));
  }

  try {
    const obj = JSON.parse(s);
    if (obj && Array.isArray(obj.tags)) return cleanTags(obj.tags);
  } catch {
    /* 解析失败返回空 */
  }
  return [];
}

function cleanTags(input: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of input) {
    if (typeof x !== 'string') continue;
    const t = x.replace(/^#+/, '').trim().slice(0, 16);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= AI_TAG_MAX) break;
  }
  return out;
}

export interface SuggestTagsResult {
  tags: string[];
  raw: string;
  /** 本次调用的 token 用量（上游不返回 usage 时为 null），供「AI 用量」统计 */
  usage: ChatUsage | null;
}

/** 调用模型为单篇生成标签；模型失败直接抛出，由调用方降级（不 500）。 */
export async function suggestEntryTags(
  title: string,
  content: string,
  llm: ResolvedLlm,
  fetchImpl: FetchLike,
): Promise<SuggestTagsResult> {
  const cut = content.length > AI_TAG_MAX_CHARS ? content.slice(0, AI_TAG_MAX_CHARS) : content;
  const messages: ChatMessage[] = [
    { role: 'system', content: entryTagSystemPrompt() },
    { role: 'user', content: `文章标题：${title || '(无标题)'}\n\n正文：\n${cut}` },
  ];
  const { content: raw, usage } = await chat(messages, llm, { fetchImpl });
  return { tags: parseTagList(raw), raw, usage };
}
