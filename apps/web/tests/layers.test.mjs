/* 弹层层级判据的回归（node --test）
 *
 * 守的是「Esc 该关哪一层」「⌘K 能不能再叠一层」这两件事的共同前提。
 * 这里用假 document 直接喂选择器 → 元素，不依赖 jsdom，跑得快；
 * 真实组件侧的接线（命令面板 / 卡片详情）由 tests/ui 的 jsdom 回归覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasLayerAbove, LAYER_SELECTORS } from '../src/ui/layers.js';

/** 造一个「元素」：只实现 contains，够 hasLayerAbove 用 */
function el(children = []) {
  const node = {
    nodeType: 1,
    contains(target) {
      if (target === node) return true;
      return children.some((c) => (c && typeof c.contains === 'function' ? c.contains(target) : false));
    },
  };
  return node;
}

/** 按 LAYER_SELECTORS 的键布置 DOM，只让 querySelectorAll 返回布置过的那几层 */
function mount(byKey) {
  globalThis.document = {
    querySelectorAll(sel) {
      for (const [key, s] of Object.entries(LAYER_SELECTORS)) {
        if (s === sel) return byKey[key] || [];
      }
      return [];
    },
  };
}

test.afterEach(() => { delete globalThis.document; });

test('没有任何弹层时不算有上层', () => {
  mount({});
  assert.equal(hasLayerAbove(), false);
  assert.equal(hasLayerAbove('cmdk'), false);
});

test('自己那一层不算上层（按键）', () => {
  mount({ cmdk: [el()] });
  assert.equal(hasLayerAbove('cmdk'), false, '命令面板开着自己不该挡自己');
  assert.equal(hasLayerAbove(), true, '别人问的时候它算一层');
});

test('确认框压在命令面板上时，命令面板认得到上层', () => {
  mount({ cmdk: [el()], confirm: [el()] });
  assert.equal(hasLayerAbove('cmdk'), true, '确认框开着时 ⌘K 不该再叠一层');
});

test('元素形态：自己所在的容器不算上层', () => {
  const panel = el();
  const mask = el([panel]);
  mount({ modal: [mask] });
  assert.equal(hasLayerAbove(panel), false, '卡片详情自己渲染的 .modal-mask 不能被当成上层');
});

test('元素形态：别人那一层照算', () => {
  const panel = el();
  const ownMask = el([panel]);
  const confirmMask = el();
  mount({ modal: [ownMask], confirm: [confirmMask] });
  assert.equal(hasLayerAbove(panel), true, '确认框压在上面时必须让位');
});

test('设置弹层与确认框是两个选择器，确认框不会被当成设置弹层', () => {
  // 选择器本身就排除了 .confirm-mask，这里确认这张表没写错
  assert.match(LAYER_SELECTORS.modal, /:not\(\.confirm-mask\)/);
  assert.match(LAYER_SELECTORS.modal, /:not\(\[hidden\]\)/);
  assert.equal(LAYER_SELECTORS.confirm, '.confirm-mask');
});

test('没有 document（SSR / 单测环境）时不抛错', () => {
  delete globalThis.document;
  assert.equal(hasLayerAbove(), false);
  assert.equal(hasLayerAbove('cmdk'), false);
});
