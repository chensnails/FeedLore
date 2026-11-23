import assert from 'node:assert/strict';
import test from 'node:test';

/* 纯函数几何单测：不需要 DOM。验证「已可见就不动 / 看不见才滚 / clamp / 超高元素」。
 * 抽屉位置记忆本身（remember/restore）由 UI 回归的源码守卫 + 真机烟测钉住。 */
const { revealScrollTop } = await import('../src/core/channelDrawerScroll.ts');

test('频道抽屉聚焦：元素已完整可见 → 不滚动（返回 null）', () => {
  // 可视区 0..400，元素 100..160，当前 scrollTop=0
  assert.equal(revealScrollTop(100, 60, 0, 400, 1200), null);
  // 已滚到中段，元素正好在可视区内
  assert.equal(revealScrollTop(150, 60, 500, 400, 1200), null);
});

test('频道抽屉聚焦：元素在可视区下方 → 滚到居中', () => {
  // 可视区 0..400（scrollTop=0），元素相对顶 900，高 50 → 绝对 900..950
  const got = revealScrollTop(900, 50, 0, 400, 1200);
  assert.ok(got != null && got > 0, '应向下滚');
  // 居中后元素中心 ≈ 视口中心
  const center = 900 + 25 - got;
  assert.ok(Math.abs(center - 200) <= 1, `居中偏差过大：${center}`);
});

test('频道抽屉聚焦：元素在可视区上方 → 向上滚', () => {
  // 当前 scrollTop=800，可视区绝对 800..1200，元素相对顶 -750 → 绝对 50..100
  const got = revealScrollTop(-750, 50, 800, 400, 1200);
  assert.ok(got != null && got < 800, '应向上滚');
  assert.ok(got >= 0, '不该滚成负');
});

test('频道抽屉聚焦：结果 clamp 到 [0, scrollHeight-clientHeight]', () => {
  // 元素绝对 10..50，当前 scrollTop=800（视口 800..1200）→ 在上方，居中目标 -170 → 夹到 0
  assert.equal(revealScrollTop(10 - 800, 40, 800, 400, 1200), 0);
  // 元素绝对 1180..1200，居中目标 990 → 夹到 max 800
  assert.equal(revealScrollTop(1180, 20, 0, 400, 1200), 800);
});

test('频道抽屉聚焦：元素比可视区还高 → 只保证顶部露出，不强推居中', () => {
  // 元素绝对 100..900（高 800 > 视口 400），当前 0：顶部已露 → 不动
  assert.equal(revealScrollTop(100, 800, 0, 400, 1200), null);
  // 元素绝对 900..1700，当前 0：顶部在视口下方 → 滚到顶部可见
  const got = revealScrollTop(900, 800, 0, 400, 2000);
  assert.ok(got != null && got > 0 && got <= 900, `顶部可见滚轮：${got}`);
});

test('频道抽屉聚焦：布局不可读（clientHeight=0）→ 不瞎滚', () => {
  assert.equal(revealScrollTop(900, 50, 0, 0, 0), null);
});
