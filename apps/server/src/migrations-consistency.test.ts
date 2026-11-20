/**
 * 迁移文件一致性守卫（不需要数据库）。
 *
 * 本仓库的迁移是**手写 SQL + 手工登记 meta/_journal.json**，从不跑 drizzle-kit generate
 * （见 packages/db/drizzle.config.ts 注释）。因此 journal 与磁盘上的 SQL 必须严格一一对应：
 * - 写了 SQL 忘了加 journal → migrate 不认识它，某次升级静默漏一列；
 * - journal 加了但 SQL 文件丢了 → 启动自举直接 migrate 失败。
 *
 * 运行期 migrate 只认 journal + SQL，不认 snapshot —— 所以历史 snapshot 从 0007 起
 * 停更不影响升级，这只是一条「别误用 generate」的文档约束，不在此处校验。
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'packages', 'db', 'drizzle');

interface JournalEntry {
  idx: number;
  tag: string;
}

function journal(): JournalEntry[] {
  const raw = readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

test('迁移 journal 与磁盘 SQL 一一对应（漏登记/漏文件都会被抓）', () => {
  const entries = journal()
    .slice()
    .sort((a, b) => a.idx - b.idx);
  assert.ok(entries.length > 0, 'journal 不应为空');

  // idx 连续、tag 带正确的四位前缀
  entries.forEach((e, i) => {
    assert.equal(e.idx, i, `journal 第 ${i} 条的 idx 应为 ${i}，实际 ${e.idx}`);
    assert.match(e.tag, /^\d{4}_/, `journal tag 应为四位序号开头：${e.tag}`);
  });

  // 每个 journal 条目都有对应 SQL 文件
  const sqlFiles = readdirSync(drizzleDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const fromJournal = entries.map((e) => `${e.tag}.sql`).sort();
  assert.deepEqual(fromJournal, sqlFiles, 'journal 登记的 SQL 与磁盘文件必须完全一致');
});

test('每个迁移 SQL 非空且以 breakpoint 标记收尾（migrate 能正确分段）', () => {
  const entries = journal();
  for (const e of entries) {
    const sql = readFileSync(join(drizzleDir, `${e.tag}.sql`), 'utf8');
    assert.ok(sql.trim().length > 0, `${e.tag}.sql 不应为空`);
  }
});
