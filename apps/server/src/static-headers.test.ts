/* 静态托管的缓存头 —— 必须走真 HTTP 栈才能守住。
 *
 * Hono 在响应 finalized 之后调 `c.header()` 会重建 Response；compress 只要响应 ≥1KB
 * 就会补 `Vary: Accept-Encoding`，这一重建会把「先 next() 再往 c.res.headers 补头」
 * 的 Cache-Control 丢掉。用 app.request() 测不出来（不经过 @hono/node-server 的
 * 响应写出），所以这里起一个真端口。
 *
 * 首页带账号外观注入，缓存住就是「A 的偏好发给 B」，必须是 no-cache。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';

test('静态文件按档设缓存，且 compress 不会吞掉 Cache-Control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feedlore-webroot-'));
  await mkdir(join(root, 'assets'));
  // 首页要 >1KB，否则 compress 直接跳过，测不到「Vary 重建」这条路径
  await writeFile(
    join(root, 'index.html'),
    '<html><head><meta name="theme-color" content="#ffffff"></head><body>' +
      '<p>' + 'x'.repeat(2048) + '</p></body></html>',
  );
  await writeFile(join(root, 'login.html'), '<html><body>' + 'y'.repeat(2048) + '</body></html>');
  await writeFile(join(root, 'manifest.json'), '{"name":"t"}');
  await writeFile(join(root, 'sw.js'), '/* sw */' + 'z'.repeat(300));
  await writeFile(join(root, 'assets', 'a.js'), 'console.log(1);');

  /* WEB_ROOT 在 app.ts 加载时读取，所以必须先设环境变量再动态 import。 */
  process.env.WEB_ROOT = root;
  const { createApp } = await import('./app.js');
  const app = createApp({ db: null, auth: null });

  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  try {
    const cases: Array<[string, string]> = [
      ['/', 'no-cache'],
      ['/login.html', 'no-cache'],
      ['/sw.js', 'no-cache'],
      ['/manifest.json', 'public, max-age=3600'],
      ['/assets/a.js', 'public, max-age=31536000, immutable'],
    ];
    for (const [path, expected] of cases) {
      const res = await fetch(base + path, { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(res.status, 200, `${path} 状态码`);
      assert.equal(res.headers.get('cache-control'), expected, `${path} 的 Cache-Control`);
      await res.arrayBuffer();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
