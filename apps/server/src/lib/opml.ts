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

/* ============================ 导出 ============================ */

export interface OpmlOut {
  title: string;
  url: string;
  siteUrl: string | null;
  /** 空串 = 未分组，直接挂在 body 下 */
  groupName: string;
}

/**
 * 生成 OPML 2.0 文本。
 *
 * 与 `parseOpml` 是同一套字段：`xmlUrl` 必填、`text/title` 二选一、`groupName` 用嵌套
 * `<outline>` 表达 —— 这样导出的文件能被自己原样导回（也是「换服务器」的迁移路径）。
 *
 * ⚠️ 三个属性都必须转义：频道标题里出现 `&` 或 `"` 是常事（「少数派 & 派早报」），
 * 不转义会生成一个**语法上就坏掉**的 XML，导入时连报错的位置都指不准。
 */
export function buildOpml(items: OpmlOut[]): string {
  const esc = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const line = (f: OpmlOut): string => {
    const attrs = [
      `text="${esc(f.title)}"`,
      `title="${esc(f.title)}"`,
      `type="rss"`,
      `xmlUrl="${esc(f.url)}"`,
      ...(f.siteUrl ? [`htmlUrl="${esc(f.siteUrl)}"`] : []),
    ];
    return `      <outline ${attrs.join(' ')} />`;
  };

  const groups = new Map<string, OpmlOut[]>();
  for (const f of items) {
    const g = f.groupName || '';
    const arr = groups.get(g) ?? [];
    arr.push(f);
    groups.set(g, arr);
  }

  const body: string[] = [];
  for (const [g, list] of groups) {
    if (!g) {
      body.push(...list.map(line));
    } else {
      body.push(`    <outline text="${esc(g)}" title="${esc(g)}">`);
      body.push(...list.map(line));
      body.push('    </outline>');
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>笺川 · 订阅源导出</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${body.join('\n')}
  </body>
</opml>
`;
}
