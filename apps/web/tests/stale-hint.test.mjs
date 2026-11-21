/* 慢响应被取代时的低干扰提示（node:test）。
 * 竞态防护本身由 ui-regression 的代际守卫看着；这里只测提示的收敛条件：
 * 快速操作不打扰、慢请求才提示、冷却窗内不重复。 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getToastQueue,
  noteListStale,
  resetStaleHint,
  STALE_HINT_COOLDOWN_MS,
  STALE_HINT_MIN_MS,
  STALE_HINT_TEXT,
} from '../src/core/util.ts';

/* toast 入队会派发 overlays 事件，Node 下没有 window，给一个最小桩。 */
globalThis.window = {
  Event: class {
    constructor(type) {
      this.type = type;
    }
  },
  CustomEvent: class {
    constructor(type, opts) {
      this.type = type;
      this.detail = opts && opts.detail;
    }
  },
  dispatchEvent() {
    return true;
  },
  addEventListener() {},
  removeEventListener() {},
};

/** 只看本次调用新增的 toast：旧提示过期不会造成误判。 */
function addedToasts(run) {
  const before = new Set(getToastQueue().map((x) => x.id));
  run();
  return getToastQueue().filter((x) => !before.has(x.id));
}

test('快速改条件不提示；挂够久的旧请求才解释一句', () => {
  const T = 1_000_000;
  resetStaleHint();
  assert.equal(
    addedToasts(() => noteListStale(T - (STALE_HINT_MIN_MS - 100), T)).length,
    0,
    '搜索连打 / 快速切频道不该被打扰',
  );
  const added = addedToasts(() => noteListStale(T - STALE_HINT_MIN_MS, T));
  assert.equal(added.length, 1);
  assert.equal(added[0].msg, STALE_HINT_TEXT);
  assert.equal(added[0].ok, true, '走成功态：不抢撤销提示、不清空队列');
});

test('冷却窗内不重复提示，窗外才再提示一次', () => {
  const T = 2_000_000;
  const startedAt = T - 5000;
  resetStaleHint();
  assert.equal(addedToasts(() => noteListStale(startedAt, T)).length, 1);
  assert.equal(addedToasts(() => noteListStale(startedAt, T + 1000)).length, 0);
  assert.equal(
    addedToasts(() => noteListStale(startedAt, T + STALE_HINT_COOLDOWN_MS + 1)).length,
    1,
  );
});

test('无效起始时间不提示', () => {
  resetStaleHint();
  assert.equal(addedToasts(() => noteListStale(Number.NaN, 3_000_000)).length, 0);
  assert.equal(addedToasts(() => noteListStale(Number.POSITIVE_INFINITY, 3_000_000)).length, 0);
});
