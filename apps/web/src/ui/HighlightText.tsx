/* 搜索命中高亮：只切文本节点，不拼 HTML。
 * 用户词直接进 RegExp 会出灾难性回溯 / 语法错误；dangerouslySetInnerHTML
 * 更是现成的 XSS 面（RSS 标题本来就不可信）。这里只做 indexOf，安全且够快。 */

import type { ReactNode } from 'react';

export interface HighlightTextProps {
  text: string | null | undefined;
  query: string | null | undefined;
}

export function HighlightText({ text, query }: HighlightTextProps): ReactNode {
  const hay = text == null ? '' : String(text);
  const needle = String(query ?? '').trim();
  if (!needle || !hay) return hay;
  const lowerHay = hay.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  let at = lowerHay.indexOf(lowerNeedle);
  while (at >= 0) {
    if (at > from) out.push(hay.slice(from, at));
    out.push(
      <mark className="hl" key={at}>
        {hay.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
    at = lowerHay.indexOf(lowerNeedle, from);
  }
  if (from < hay.length) out.push(hay.slice(from));
  return out;
}
