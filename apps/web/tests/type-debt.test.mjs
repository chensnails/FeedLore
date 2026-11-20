/* 前端 any 债务棘轮（node --test）。
 *
 * 背景：V4.1 把 .js/.jsx 全量转真 TS 时，JSDoc 里的 any 原样保留了下来 ——
 * "typecheck 全绿"只说明语法是 TS，不代表组件边界有类型约束。服务端同类标注仅个位数，
 * 前端实测约 1600 处，绝大多数在巨型 Pane 的 props / 回填状态上。
 *
 * 全量补类型是一个独立的大工程（会牵动 671 项行为测试的桩边界），不适合夹带在
 * 任何一次功能提交里。本测试把基础设施层的 any 数锁成**上限**：只准减、不准涨。
 * 新增代码若继续用 any 顶过去，这里先红；每次认真收口一批就把上限下调一格。
 *
 * 只统计基础设施层（core / kernel / store）—— 它们的 any 会向所有调用方传染，
 * 是投入产出比最高的收口目标。巨型 Pane 的 any 影响面局限在单文件，暂不入棘轮。
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** 递归收集 .ts/.tsx（排除测试桩与构建产物）。 */
function collect(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collect(p));
    else if (/\.tsx?$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** 与审查同口径的显式 any 标注：`: any` / `as any` / `<any>` / `any[]`。 */
function countAny(files) {
  let total = 0;
  const per = {};
  const re = /:\s*any\b|\bas\s+any\b|<any>|any\[\]/g;
  for (const f of files) {
    const n = (readFileSync(f, 'utf8').match(re) ?? []).length;
    if (n) per[relative(root, f).replace(/\\/g, '/')] = n;
    total += n;
  }
  return { total, per };
}

const INFRA = ['core', 'kernel', 'store'];
const infraFiles = INFRA.flatMap((d) => collect(join(root, d)));
const { total, per } = countAny(infraFiles);

/** 2026-11-20 基线：基础设施层 359 处（本测试当场实测）。收口后同步下调，不要上调。 */
const CEILING = 359;

test('基础设施层显式 any 不增长（棘轮，只准下调）', () => {
  assert.ok(
    total <= CEILING,
    `core/kernel/store 的 any 数为 ${total}，超过上限 ${CEILING}；` +
      `新增代码请补类型，或收口一批后同步下调上限。分布：${JSON.stringify(per)}`,
  );
});
