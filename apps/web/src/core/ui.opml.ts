/* OPML 导出与同源下载。从 ui.ts 抽出（深度重组），ui.ts 通过 export * 保持外部链不变。 */

import { state } from './state.ts';
import type { Feed } from './types.ts';
import { feedTitle, toast } from './util.ts';

/* OPML 导出：把当前账号的订阅源整理成标准 OPML（分组作为文件夹），浏览器下载 */
export function exportOpml() {
  const feeds = state.feedList || [];
  if (!feeds.length) {
    toast('没有可导出的订阅源', false);
    return;
  }
  const esc = (s: unknown) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const feedOutline = (f: Feed) => {
    const title = feedTitle(f) || f.url || '未命名订阅源';
    const xml = f.url || '';
    const html = f.siteUrl || '';
    return (
      '    <outline type="rss" text="' +
      esc(title) +
      '" title="' +
      esc(title) +
      '" xmlUrl="' +
      esc(xml) +
      '" htmlUrl="' +
      esc(html) +
      '"/>'
    );
  };
  // 按分组归类；未分组的放在顶层
  const groups: Record<string, Feed[]> = {};
  const ungrouped: Feed[] = [];
  for (const f of feeds) {
    const g = String(f.groupName || '').trim();
    if (g) (groups[g] = groups[g] || []).push(f);
    else ungrouped.push(f);
  }
  let body = '';
  for (const g of Object.keys(groups).sort((a, b) => a.localeCompare(b, 'zh'))) {
    body +=
      '  <outline text="' +
      esc(g) +
      '" title="' +
      esc(g) +
      '">\n' +
      groups[g]!.map(feedOutline).join('\n') +
      '\n' +
      '  </outline>\n';
  }
  body += ungrouped.map(feedOutline).join('\n') + (ungrouped.length ? '\n' : '');
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<opml version="2.0">\n' +
    '  <head><title>FeedLore 订阅导出</title></head>\n' +
    '  <body>\n' +
    body +
    '  </body>\n</opml>\n';
  const blob = new Blob([xml], { type: 'text/x-opml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'feedlore-subscriptions-' + new Date().toISOString().slice(0, 10) + '.opml';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出 ' + feeds.length + ' 个订阅源');
}

/**
 * 触发一次同源 GET 下载。服务端用 Content-Disposition 给文件名，所以不给 download
 * 属性（给了浏览器会覆盖掉服务端命名）。临时锚点即点即弃，不打断当前页面。
 */
export function downloadUrl(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
