/* 滚动状态类（body.is-scrolling）的回归（node --test）
 *
 * 这个类只做一件事：滚动期间让列表项的悬停过渡让路。它一旦失灵，用户看到的
 * 不是报错而是「滚起来发涩」—— 没有断言就没人会发现。这里用假 document 验四条：
 *   1. 只认内容区滚动，抽屉 / 弹层里的滚动不挂类；
 *   2. 滚动一停就摘掉（否则滚完再悬停也永远没有过渡）；
 *   3. 连续滚动不会因为计时器抖动闪一下（每次事件都重置计时）；
 *   4. dispose 之后不再挂类。
 * 真实浏览器里的收益由 .workbuddy/ui-lab/perf.mjs 量（真滚轮事件）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installScrollBusy } from '../src/ui/scrollBusy.js';

/** 造一个假 document：classList 记状态，addEventListener 记监听器 */
function fakeDoc() {
  const classes = new Set();
  const listeners = [];
  const body = {
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    },
  };
  const doc = {
    body,
    scrollingElement: { nodeType: 1, matches: () => false },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    has: (name) => classes.has(name),
    fire(target) { for (const l of listeners) l.fn({ target }); },
    listenerCount: () => listeners.length,
  };
  return doc;
}

/** 造一个能命中 SCROLLERS 的滚动容器 */
const scroller = (sel = '.reader-main') => ({ nodeType: 1, matches: (s) => sel.split(',').map((x) => x.trim()).includes(sel) });

test('内容区滚动时挂类，停下后摘掉', async () => {
  const doc = fakeDoc();
  const dispose = installScrollBusy(doc, { idle: 20 });
  assert.equal(doc.has('is-scrolling'), false, '初始不该有类');
  doc.fire(scroller());
  assert.equal(doc.has('is-scrolling'), true, '滚动开始必须立刻挂类');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(doc.has('is-scrolling'), false, '滚动停下要摘掉，否则悬停永远没有过渡');
  dispose();
});

test('连续滚动不闪断：每个事件都重置计时', async () => {
  const doc = fakeDoc();
  const dispose = installScrollBusy(doc, { idle: 40 });
  for (let i = 0; i < 4; i += 1) {
    doc.fire(scroller());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(doc.has('is-scrolling'), true, `第 ${i + 1} 次滚动期间类不该被摘`);
  }
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(doc.has('is-scrolling'), false);
  dispose();
});

test('抽屉 / 弹层里的滚动不算（列表没在动，不该关过渡）', () => {
  const doc = fakeDoc();
  const dispose = installScrollBusy(doc, { idle: 20 });
  doc.fire({ nodeType: 1, matches: () => false });
  assert.equal(doc.has('is-scrolling'), false);
  dispose();
});

test('窗口级滚动（target 是 document）也认', () => {
  const doc = fakeDoc();
  const dispose = installScrollBusy(doc, { idle: 20 });
  doc.fire({ nodeType: 9 });
  assert.equal(doc.has('is-scrolling'), true);
  dispose();
});

test('dispose 后不再挂类，监听也摘干净', () => {
  const doc = fakeDoc();
  const dispose = installScrollBusy(doc, { idle: 20 });
  doc.fire(scroller());
  assert.equal(doc.has('is-scrolling'), true);
  dispose();
  assert.equal(doc.has('is-scrolling'), false, 'dispose 要顺手清掉状态类');
  assert.equal(doc.listenerCount(), 0, '监听必须摘干净，重复安装不该叠监听');
});
