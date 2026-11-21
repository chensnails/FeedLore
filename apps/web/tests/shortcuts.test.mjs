/* 快捷键发现入口：命令面板里列出真实存在的键位，不复活已下线的 j/k/o/s/u/?。 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommands } from '../src/cmdk/commands.ts';

const fakeCore = {
  switchView() {},
  applyTheme() {},
  openSettings() {},
  selectScope() {},
  jumpToFeed() {},
  focusSearchBox() {},
  exportOpml() {},
  refresh() {},
  scrollTop() {},
  shortFeedName: (n) => String(n ?? ''),
  feedTitle: (f) => String(f?.title ?? ''),
  THEME_MODES: [],
  THEME_META: {},
  state: { feedList: [] },
  toastCalls: [],
  toast(msg) {
    this.toastCalls.push(msg);
  },
};

test('命令面板有「帮助」分组，列出当前真实键位', () => {
  const cmds = buildCommands(fakeCore);
  const help = cmds.filter((c) => c.group === '帮助');
  assert.equal(help.length, 1, '帮助分组应只有一条入口');
  assert.match(help[0].label, /快捷键/);
  help[0].run();
  const text = fakeCore.toastCalls.join(' ');
  for (const key of ['⌘K', 'Ctrl K', '/', '↑↓', '↵', 'Esc']) {
    assert.ok(text.includes(key), `键位说明缺 ${key}`);
  }
});

test('不恢复已下线的旧快捷键', () => {
  const cmds = buildCommands(fakeCore);
  const labels = cmds.map((c) => c.label + ' ' + (c.keywords || '')).join(' ');
  for (const key of ['j/k', '按 J', '按 K', '按 ?']) {
    assert.ok(!labels.includes(key), `仍宣传旧键位：${key}`);
  }
});
