import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/* 跨包 bug 修复的源码契约守卫：这些回归藏在异步竞态 / 分支顺序里，
 * 行为测试难以稳定复现，用「真实代码形态」钉住修法，防止后续改动悄悄回退。 */
const ROOT = new URL('../../../', import.meta.url);
const read = (p) => readFileSync(fileURLToPath(new URL(p, ROOT)), 'utf8');

test('图片缓存：L2 过期即使 ETag 命中也必须转后台刷新（不许 fresh||hit 短路）', () => {
  const s = read('apps/server/src/routes/img.ts');
  assert.ok(s.includes('if (!fresh && !inFlight.has(key))'), '过期刷新的判据必须是 !fresh');
  assert.ok(
    !/if \(fresh \|\| hit\)/.test(s),
    '不能回到 fresh||hit 短路 —— 那会让过期图永远 304 不刷新',
  );
  const block = s.slice(s.indexOf('if (l2) {'), s.indexOf('// ③.5'));
  assert.match(block, /return hit \? notModified\(l2, key\) : imageResponse\(l2, key\);/);
});

test('命令面板：懒挂载用 pending 意图补开，不靠合成 keydown 竞态', () => {
  const mounts = read('apps/web/src/kernel/mounts.tsx');
  const bridge = read('apps/web/src/kernel/bridge.ts');
  const cmdk = read('apps/web/src/cmdk/CommandPalette.tsx');
  assert.ok(bridge.includes("cmdkPending: '__cmdkPending'"), '桥清单要登记 cmdkPending');
  assert.ok(mounts.includes("provide('cmdkPending', true)"), '入口要记下打开意图');
  assert.ok(
    !/new KeyboardEvent\('keydown'/.test(mounts),
    '不许再补发合成按键（早于 useEffect 监听）',
  );
  const effect = cmdk.slice(cmdk.indexOf('// 懒加载补开'), cmdk.indexOf('// 开合状态同步'));
  assert.ok(effect.includes("get('cmdkPending')"), '组件挂载后要主动消费 pending');
  assert.ok(effect.includes("revoke('cmdkPending')"), 'pending 只消费一次');
});

test('改密：session cookieCache 两个前缀名都过期，且用 append 不覆盖别的 Set-Cookie', () => {
  const s = read('apps/server/src/routes/admin.ts');
  assert.ok(s.includes("'better-auth.session_data'"), '无前缀名要清');
  assert.ok(s.includes("'__Secure-better-auth.session_data'"), 'HTTPS 前缀名也要清');
  const start = s.indexOf('const secure = new URL(c.req.url)');
  assert.ok(start > 0, '要找到改密清 cookie 的分支');
  const block = s.slice(start, start + 700);
  assert.ok(block.includes('{ append: true }'), '多条 Set-Cookie 必须 append');
  assert.ok(block.includes("name.startsWith('__Secure-')"), '带前缀的删除头必须带 Secure 属性');
});

test('阅读位置：顶边越线的条目整条滚出视口时直接 return，不挪到下一条算负偏移', () => {
  const s = read('apps/web/src/core/reader.articles.ts');
  assert.ok(
    /if \(pick && pick\.getBoundingClientRect\(\)\.bottom <= mainTop\) return;/.test(s),
    '整条在视口上方应直接放弃记录',
  );
  assert.ok(
    !/pick = at \+ 1 < items\.length/.test(s),
    '不能补偿挪到 at+1 —— 它顶边还在视口下方，offset 必为负会误清位置',
  );
});
