/** 整站还原包级预检：只验结构，不连库。行级校验仍由还原事务负责。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { precheckSiteArchive } from './importData';

const REQUIRED: Record<string, string> = {
  'accounts.json': '[]',
  'feeds.json': '[]',
  'digests.json': '[]',
  'user_llm.json': '[]',
  'settings.json': '[]',
  'image_cache.json': '[]',
};

async function writeArchive(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'feedlore-precheck-test-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  return dir;
}

const manifest = (kind: string) =>
  JSON.stringify({
    format: 'feedlore-backup',
    formatVersion: 1,
    kind,
    counts: { users: 1, feeds: 2, entries: 3 },
  });

test('precheckSiteArchive：完整 site 包通过并回传清单计数', async () => {
  const dir = await writeArchive({
    'manifest.json': manifest('site'),
    'users.json': '[{"id":"u1"}]',
    ...REQUIRED,
  });
  try {
    const result = await precheckSiteArchive(dir);
    assert.equal(result.kind, 'site');
    assert.equal(result.counts.users, 1);
    assert.equal(result.counts.feeds, 2);
    assert.equal(result.counts.entries, 3);
    assert.equal(result.counts.mcpTokens, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('precheckSiteArchive：账号导出包在留底前就被拒', async () => {
  const dir = await writeArchive({
    'manifest.json': manifest('user'),
    'users.json': '[{"id":"u1"}]',
    ...REQUIRED,
  });
  try {
    await assert.rejects(precheckSiteArchive(dir), { code: 'E_ARCHIVE_IS_USER_EXPORT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('precheckSiteArchive：缺 users.json / 空包 / 坏 JSON 都在留底前失败', async () => {
  for (const files of [
    { 'manifest.json': manifest('site'), ...REQUIRED },
    { 'manifest.json': manifest('site'), 'users.json': '[]', ...REQUIRED },
    {
      'manifest.json': manifest('site'),
      'users.json': '[{"id":"u1"}]',
      ...REQUIRED,
      'feeds.json': '{bad json',
    },
  ]) {
    const dir = await writeArchive(files);
    try {
      await assert.rejects(precheckSiteArchive(dir), (err: unknown) => {
        const e = err as { code?: string };
        return e.code === 'E_IMPORT_INVALID';
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
