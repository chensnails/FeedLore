/**
 * 正文分层纯函数（自 legacy `ViewReader.bodyParagraphs` 移植，逻辑等价）。
 *
 * 为什么需要分层：抓来的正文只有两种形态，而且**都不适合直接渲染**。
 *  1. `bodyJson` 块数组 `[{t:'p',text},{t:'img',src}]` —— 服务端已把 HTML 拆成
 *     有序图文块、图片走了代理（`buildBlocks`）。这是首选，顺序与原文一致。
 *  2. 没有块数组时只剩 `content` 纯文本 —— 源站没分段，整篇挤成一个字符串。
 *
 * 所以这里补第二层的「读起来不像墙」的处理：
 * - 源站不分段（整段几百字）→ 按句读切成 36~110 字的段；
 * - **不在 URL 内部切**（切在链接中间会让网址看起来坏掉，也没法整段复制）；
 * - 以句号/问号/叹号结尾的段标记 `is-prose`，CSS 给 2em 首行缩进；
 *   字段行（「营业总收入：94.14 万亿韩元」）不缩进 —— 缩进了反而像散文，读着别扭；
 * - 首行常是「名称：<标题>」与标题重复，去掉它。
 *
 * 纯函数放在 lib 里而不是组件里：这类「读起来是否通顺」的规则最容易在改动中悄悄退化，
 * 单独成文件才能在改动时看清它只依赖字符串。
 */

export type BodyBlock = { t: 'p'; text: string } | { t: 'img'; src: string };

/** 块数组解析结果：null 表示「没有块数据」，调用方应回退到纯文本分层。 */
export function parseBlocks(json: string | null | undefined): BodyBlock[] | null {
  if (!json) return null;
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    // 只认两种已知形状，畸形块直接丢 —— 库里可能躺着老版本写入的数据
    const out: BodyBlock[] = [];
    for (const b of arr as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object') continue;
      if (b.t === 'img' && typeof b.src === 'string' && b.src) out.push({ t: 'img', src: b.src });
      else if (b.t === 'p' && typeof b.text === 'string' && b.text.trim()) out.push({ t: 'p', text: b.text });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

const LONG_LINE = 110;
const MIN_SEG = 36;
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
const BREAK_RE = /(?<=[。！？；!])/g;
const TITLE_LINE_RE = /^\s*(?:名\s*称|标\s*题|主\s*题|题\s*目)\s*[：:]\s*(.*)$/;

/** 源站点没分段时按句读切；不在 URL 内部断 */
function splitLongLine(line: string): string[] {
  if (line.length < LONG_LINE) return [line];
  const spans: Array<[number, number]> = [];
  for (const m of line.matchAll(URL_RE)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const inUrl = (i: number): boolean => spans.some(([a, b]) => i >= a && i < b);

  const sentences: string[] = [];
  let last = 0;
  for (const m of line.matchAll(BREAK_RE)) {
    const at = m.index ?? 0;
    if (inUrl(at)) continue;
    sentences.push(line.slice(last, at));
    last = at;
  }
  sentences.push(line.slice(last));

  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (!s.trim()) continue;
    buf += s;
    if (buf.trim().length >= MIN_SEG) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [line];
}

export interface Paragraph {
  /** is-prose = 以句读结尾的散文段（CSS 首行缩进），字段行留空 */
  cls: string;
  text: string;
}

export function bodyParagraphs(text: string): Paragraph[] {
  const paras: Paragraph[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw.trim()) continue;
    for (const seg of splitLongLine(raw)) {
      const s = seg.trim();
      if (!s) continue;
      const prose = /[。！？；!?;]$/.test(s) || /[。！？；!?;][”’")）]*$/.test(s);
      paras.push({ cls: prose ? 'is-prose' : '', text: s });
    }
  }
  return paras;
}

export function isDuplicateTitleLine(txt: string, name: string | undefined): boolean {
  const m = String(txt ?? '').match(TITLE_LINE_RE);
  return Boolean(m && (m[1] ?? '').trim() === String(name ?? '').trim());
}

/**
 * 去掉与标题重复的首块。
 *
 * RSS 正文常见「名称：xxx」开头，而列表/标题已经显示了同一个 xxx，
 * 留着就是正文第一行重复标题 —— 用户第一眼看到重复内容会以为页面渲染错了。
 */
export function dropTitleEcho(blocks: BodyBlock[], name: string | undefined): BodyBlock[] {
  const first = blocks[0];
  if (first && first.t === 'p' && isDuplicateTitleLine(first.text, name)) return blocks.slice(1);
  return blocks;
}

/**
 * 正文纯文本的兜底来源。
 * 优先 `content`（完整正文），没有才用 `desc`（摘要）—— 摘要当正文很短，
 * 至少比「（无正文）」有用。
 */
export function fallbackText(content: string | undefined, desc: string | undefined): string {
  return String(content ?? '').trim() || String(desc ?? '').trim();
}
