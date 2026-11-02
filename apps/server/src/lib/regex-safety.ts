/**
 * 用户自定义正则的安全闸门。
 *
 * Node 的 RegExp 跑在主线程上，且没有超时机制：一条灾难性回溯的正则
 * （如 `(a+)+$`）配上几 KB 正文就能把整个事件循环卡死。用户在过滤规则里
 * 可以自由填正则，所以保存时和匹配时都要过这道静态检查。
 */

import safeRegex from 'safe-regex2';

const MAX_REPEAT = 1_000;
const CACHE_MAX = 1_000;
const cache = new Map<string, boolean>();

/** `\1`..`\9` / `\k<name>`：反向引用会让回溯状态爆炸，直接禁掉。 */
function hasBackreference(pattern: string): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1] ?? '';
      if (!inClass && (/[1-9]/.test(next) || next === 'k')) return true;
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') inClass = true;
  }
  return false;
}

/** 组后面的量词是否让它「无界或大范围」重复（`{2}` / `{2,3}` 这种小上界不算）。 */
function repeatsAtLeastTwice(pattern: string, at: number): boolean {
  const ch = pattern[at];
  if (ch === '*' || ch === '+') return true;
  if (ch !== '{') return false;
  const m = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(at));
  if (!m) return false;
  if (m[2] === undefined) return Number(m[1]) > 100; // {n}：小范围有限次允许
  if (m[2] === '') return true; // {m,} 无上界
  return Number(m[2]) > 100;
}

/**
 * `(a|aa)+` / `(a|a?)+` 这类「带歧义分支的组又被重复」是经典指数回溯。
 * safe-regex2 只看嵌套量词，识别不了交替分支，这里补一层。
 */
function hasQuantifiedAlternation(pattern: string): boolean {
  const groups: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      groups.push(false);
      continue;
    }
    if (ch === '|') {
      if (groups.length) groups[groups.length - 1] = true;
      continue;
    }
    if (ch === ')') {
      const hasAlt = groups.pop() ?? false;
      if (hasAlt && repeatsAtLeastTwice(pattern, i + 1)) return true;
    }
  }
  return false;
}

/** `a{999999}` 这类超大重复即使不回溯也会长时间占住事件循环。 */
function hasHugeRepeat(pattern: string): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '{') {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
      if (m) {
        const min = Number(m[1]);
        const max = m[2] === undefined || m[2] === '' ? min : Number(m[2]);
        if (min > MAX_REPEAT || max > MAX_REPEAT) return true;
      }
    }
  }
  return false;
}

/** 非法正则、嵌套量词、歧义交替、反向引用等高风险写法一律判为不安全。 */
export function isSafeRegex(pattern: string): boolean {
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;

  let safe = false;
  try {
    safe =
      safeRegex(pattern) &&
      !hasBackreference(pattern) &&
      !hasQuantifiedAlternation(pattern) &&
      !hasHugeRepeat(pattern);
  } catch {
    safe = false;
  }

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(pattern, safe);
  return safe;
}

/** 单条规则最多扫描的文本长度：给漏判留下一个有界的最坏耗时。 */
export const FILTER_MAX_TEXT = 8_000;
