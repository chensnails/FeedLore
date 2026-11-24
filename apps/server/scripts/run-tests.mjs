/**
 * 分层测试入口（V3.2）。
 *
 * 单元测试与接口级测试显式分层；接口级测试按文件创建独立 Postgres schema，
 * 各自迁移、执行、删除。整站还原会清空整库，不能与其它测试共用 public schema。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const root = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const tier = process.argv[2] || 'unit';

if (!['unit', 'integration', 'all'].includes(tier)) {
  console.error(`未知测试层：${tier}（可选 unit / integration / all）`);
  process.exit(2);
}

function collectTests(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectTests(p));
    else if (ent.isFile() && ent.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const all = collectTests(join(root, 'src')).sort();
const isIntegration = (f) => /\.integration\.test\.ts$/.test(f);
const unit = all.filter((f) => !isIntegration(f));
const integration = all.filter(isIntegration);
const selected = tier === 'unit' ? unit : tier === 'integration' ? integration : all;

if (!selected.length) {
  console.error(`[test:${tier}] 没有找到任何测试文件`);
  process.exit(1);
}

if ((tier === 'integration' || tier === 'all') && !process.env.DATABASE_URL) {
  console.error('[test:integration] 缺少 DATABASE_URL：接口级测试需要 Postgres。');
  console.error('  本地只跑纯单测请用：pnpm --filter @feedlore/server test:unit');
  process.exit(1);
}

console.log(`[test:${tier}] ${selected.length} 个文件`);
if (tier === 'unit') {
  console.log(
    `[test:unit] 已排除 ${integration.length} 个接口级用例（需 DATABASE_URL，见 test:integration）`,
  );
}

function runNode(files, env = process.env) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-concurrency=1', ...files],
    { cwd: root, env, stdio: 'inherit' },
  );
}

function schemaUrl(databaseUrl, schema) {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  return url.toString();
}

async function migrateSchema(connectionString, schema) {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    await migrate(drizzle(client), {
      migrationsFolder: join(repoRoot, 'packages/db/drizzle'),
      migrationsSchema: schema,
    });
  } finally {
    await client.end();
  }
}

async function runIntegrationFile(file, index) {
  const databaseUrl = process.env.DATABASE_URL;
  const schema = `itest_${process.pid}_${index}`;
  const name = relative(root, file).split(sep).join('/');
  console.log(`[test:integration] ${name} → schema ${schema}`);

  const admin = new pg.Client({ connectionString: databaseUrl });
  try {
    await admin.connect();
    await admin.query(`create schema "${schema}"`);
  } catch (e) {
    console.error(`[test:integration] 无法创建 ${schema}：`, e?.message ?? e);
    return 1;
  } finally {
    await admin.end().catch(() => {});
  }

  const env = {
    ...process.env,
    DATABASE_URL: schemaUrl(databaseUrl, schema),
    FEEDLORE_TEST_SCHEMA: schema,
    PGOPTIONS: `-csearch_path=${schema}`,
    TZ: 'UTC',
  };

  try {
    await migrateSchema(schemaUrl(databaseUrl, schema), schema);
    const result = runNode([file], env);
    return result.status ?? 1;
  } finally {
    const cleanup = new pg.Client({ connectionString: databaseUrl });
    try {
      await cleanup.connect();
      await cleanup.query(`drop schema if exists "${schema}" cascade`);
    } catch (e) {
      console.error(`[test:integration] 无法删除 ${schema}：`, e?.message ?? e);
    } finally {
      await cleanup.end().catch(() => {});
    }
  }
}

let failed = false;
if (tier === 'unit') {
  const result = runNode(unit);
  failed = (result.status ?? 1) !== 0;
} else {
  if (tier === 'all') {
    console.log(`[test:all] 先跑 ${unit.length} 个单元测试文件`);
    const result = runNode(unit, { ...process.env, DATABASE_URL: '' });
    failed = (result.status ?? 1) !== 0;
  }
  for (const [index, file] of integration.entries()) {
    if ((await runIntegrationFile(file, index)) !== 0) failed = true;
  }
}

process.exitCode = failed ? 1 : 0;
