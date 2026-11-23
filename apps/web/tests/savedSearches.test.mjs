import assert from 'node:assert/strict';
import test from 'node:test';

/* Node 没有 localStorage：用最小的 Storage 替身验证「持久化 + 脏数据回落」。
 * 真实浏览器里走同一份代码，UI 回归再钉组件接线。 */
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => {
    mem.set(k, String(v));
  },
  removeItem: (k) => {
    mem.delete(k);
  },
  clear: () => {
    mem.clear();
  },
};

test('保存搜索：脏 JSON / 上限 / 去重 / 删除后落盘', async () => {
  mem.set('feedlore.savedSearches.v1', '{坏掉的 json');
  const mod = await import('../src/core/savedSearches.ts');
  assert.deepEqual(mod.listSavedSearches(), [], '坏 JSON 回落为空');

  const first = mod.addSavedSearch('  碳酸锂  ');
  assert.equal(first.length, 1);
  assert.equal(first[0].q, '碳酸锂', '两端空白要裁掉');
  assert.deepEqual(
    mod.addSavedSearch('碳酸锂'),
    first,
    '同词不重复占坑（引用也应稳定给 useSyncExternalStore 用）',
  );
  assert.deepEqual(mod.addSavedSearch('   '), first, '空词不落库');

  for (let i = 0; i < 25; i += 1) mod.addSavedSearch('词' + i);
  const all = mod.listSavedSearches();
  assert.equal(all.length, mod.SAVED_SEARCH_LIMIT, '最多 20 条');
  assert.equal(all[0].q, '词24', '新词插在最前');

  const afterRemove = mod.removeSavedSearch('词24');
  assert.equal(afterRemove.length, mod.SAVED_SEARCH_LIMIT - 1);
  assert.ok(!afterRemove.some((s) => s.q === '词24'));
  const raw = JSON.parse(mem.get('feedlore.savedSearches.v1'));
  assert.equal(raw.length, afterRemove.length, '删除也真的写回本机');
  assert.ok(raw.every((s) => typeof s.q === 'string' && Number.isFinite(s.savedAt)));
});
