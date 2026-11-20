/* V4 标准库地基的运行时契约（node --test）。
 *
 * 守三件事：
 * 1. React Router：matchViewHash 对产品所有 hash 格式给出与既有 parseHash 等价的
 *    { tab, artId }，viewHash 生成可回读的深链 —— 路由解析由标准库声明式接管；
 * 2. TanStack Query：query key 工厂稳定、drop/invalidate 后缓存确实清空 —— 服务端
 *    状态的去重与失效通道真在工作；
 * 3. Zustand：桥状态真源的读写 / 删除语义与旧 window 镜像一致 —— 跨 root UI 状态
 *    有了可订阅的单一来源。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { drop, invalidate, peek, qk, queryClient } from '../src/kernel/query.ts';
import { matchViewHash, ROUTES, viewHash } from '../src/kernel/router.ts';
import { bridgeDelete, bridgeGet, bridgeSet, bridgeStore } from '../src/kernel/store.ts';
import { appStore, readApp, state } from '../src/store/app.ts';

// ---- 1. React Router ----
test('V4.4/路由：声明式路由表覆盖全部视图', () => {
  const tabs = new Set(ROUTES.map((r) => r.tab));
  for (const t of ['reader', 'cards', 'ai']) assert.ok(tabs.has(t), '缺视图 ' + t);
  assert.ok(
    ROUTES.some((r) => r.art),
    '缺条目级深链',
  );
});

test('V4.4/路由：hash 解析与旧格式等价', () => {
  const cases = [
    ['#reader', 'reader', null],
    ['#cards', 'cards', null],
    ['#ai', 'ai', null],
    ['#digest', 'ai', null], // 老深链
    ['#reader/art/abc', 'reader', 'abc'],
    ['#/reader/art/abc', 'reader', 'abc'], // 带斜杠
    ['#/cards', 'cards', null],
  ];
  for (const [hash, tab, artId] of cases) {
    const m = matchViewHash(hash);
    assert.ok(m, '解析不到 ' + hash);
    assert.equal(m.tab, tab, hash + ' 的 tab');
    assert.equal(m.params?.artId ?? null, artId, hash + ' 的 artId');
  }
  assert.equal(matchViewHash('#unknown'), null);
});

test('V4.4/路由：生成的深链可回读', () => {
  assert.deepEqual(matchViewHash(viewHash('cards')).tab, 'cards');
  // 传原始 id：viewHash 编码一次，matchPath 解码一次，往返应还原原值。
  const back = matchViewHash(viewHash('reader', 'x y'));
  assert.equal(back.tab, 'reader');
  assert.equal(back.params.artId, 'x y');
});

// ---- 2. TanStack Query ----
test('V4.2/Query：query key 稳定且可区分', () => {
  assert.deepEqual(qk.feeds, ['feeds']);
  assert.deepEqual(qk.entries('cards', 0), ['entries', 'cards', 0]);
  assert.notDeepEqual(qk.entries('cards', 0), qk.entries('cards', 1));
});

test('V4.2/Query：drop 后缓存清空，invalidate 保留数据', async () => {
  const key = ['__test__', 'drop'];
  await queryClient.fetchQuery({ queryKey: key, queryFn: async () => ({ v: 1 }) });
  assert.deepEqual(peek(key), { v: 1 });
  await invalidate(key);
  assert.deepEqual(peek(key), { v: 1 }, 'invalidate 不清数据');
  await drop(key);
  assert.equal(peek(key), undefined, 'drop 清空缓存');
});

// ---- 3. Zustand ----
test('V4.3/Zustand：桥真源的读写与删除', () => {
  const key = '__test_bridge__';
  bridgeSet(key, { open: true });
  assert.deepEqual(bridgeGet(key), { open: true });
  bridgeDelete(key);
  assert.equal(bridgeGet(key), undefined);
  // 不影响无关键
  bridgeSet('__other__', 1);
  bridgeDelete(key);
  assert.equal(bridgeGet('__other__'), 1);
  bridgeDelete('__other__');
  assert.equal(Object.keys(bridgeStore.getState()).length, 0);
});

// ---- 4. Zustand 应用状态真源（V5）----
test('V5/状态真源：state 是 store 的 Proxy，读写共享同一真值', () => {
  const key = '__v5_probe__';
  state[key] = 42;
  assert.equal(
    readApp((s) => s[key]),
    42,
    '写 state 要落到 store',
  );
  appStore.setState({ [key]: 99 });
  assert.equal(state[key], 99, '写 store 要反映到 state');
  assert.ok(key in state, 'in 操作符转发到 store');
  delete appStore.getState()[key];
});

test('V5/状态真源：全部初始字段都在 store 里（真源单一，无散落定义）', () => {
  const s = appStore.getState();
  for (const k of [
    'entries',
    'feedList',
    'feedMeta',
    'tab',
    'role',
    'username',
    'rdEntries',
    'rdBody',
    'rdExpanded',
    'rdFlags',
    'collapsedGroups',
    'groupOrder',
  ]) {
    assert.ok(k in s, '缺初始字段 ' + k);
  }
  assert.equal(s.tab, 'reader');
  assert.ok(s.rdBody instanceof Map, 'rdBody 保持 Map 语义');
  assert.ok(s.rdExpanded instanceof Set, 'rdExpanded 保持 Set 语义');
});
