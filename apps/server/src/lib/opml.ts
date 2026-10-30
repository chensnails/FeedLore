/**
 * OPML 解析（移植自 apps/legacy/lib/opml.js，无依赖）
 *
 * 从订阅管理软件导出的 .opml 里抽出订阅源与分组路径。用正则而非 XML 解析器是刻意的：
 * 各家导出的 OPML 常常不合法（未转义的 &、缺闭合标签），宽松匹配反而更实用。
 */

export interface OpmlFeed {
  url: string;
  title: string;
  /** 嵌套文件夹用 ' / ' 连接；无分组为 null */
  group: string | null;
}

/** 抽出一段标签属性串里的键值对（键统一小写） */
export function parseOpmlAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out[(m[1] ?? '').toLowerCase()] = m[2] ?? '';
  return out;
}

/**
 * 解析 OPML 文本。
 *  - outline 有 xmlUrl/url → 订阅源；只有 title/text → 文件夹（压栈记录路径）
 *  - 自闭合的空文件夹立即弹栈，不会污染后面的订阅
 */
export function parseOpml(text: string): OpmlFeed[] {
  const feeds: OpmlFeed[] = [];
  const groups: Array<string | null> = []; // 当前嵌套分组栈
  const tagRe = /<(\/?)(outline|opml|head|body)\b([^>]*?)(\/?)>/gi;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(text)) !== null) {
    const closing = m[1] === '/';
    const name = (m[2] ?? '').toLowerCase();
    const attrs = m[3] ?? '';
    const selfClose = m[4] === '/';

    if (closing) {
      if (name === 'outline') groups.pop();
      continue;
    }
    if (name !== 'outline') continue;

    const a = parseOpmlAttrs(attrs);
    const xmlUrl = (a.xmlurl || a.url || '').trim();

    if (xmlUrl) {
      const title = (a.title || a.text || '').trim();
      feeds.push({
        url: xmlUrl,
        title,
        group: groups.filter((g): g is string => Boolean(g)).join(' / ') || null,
      });
      if (!selfClose) groups.push(null); // 占位，等它自己的 </outline> 弹出
    } else {
      const folder = (a.title || a.text || '').trim();
      if (folder) {
        groups.push(folder);
        if (selfClose) groups.pop(); // 空文件夹，立即弹回
      }
    }
  }
  return feeds;
}
