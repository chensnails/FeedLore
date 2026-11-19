/**
 * 分层测试入口（V3.2）。
 *
 * 背景：原来用一个递归 glob 扫 src 下全部 .test.ts，靠 DATABASE_URL
 * 是否为空来决定接口级用例「跳过还是真跑」。结果本地单测阶段会把集成用例静默
 * 跳过，而 CI 真库阶段又只显式点名 api.integration.test.ts —— entryAi 那份
 * 从未在 CI 跑过。这里把分层做成显式命令，文件清单由目录遍历生成，
 * 不依赖 shell glob（Windows 的 cmd.exe 不认识引号里的 glob）。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tier = process.argv[2] || 'unit';

if (!['unit', 'integration', 'all'].includes(tier)) {
  console.error(`未知测试层：${tier}（可选 unit / integration / all）`);
  process.exit(2);
}

/** 递归收集 src 下所有 *.test.ts，路径统一成正斜杠便于打印。 */
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
  console.error('[test:integration] 缺少 DATABASE_URL：接口级测试需要已跑过迁移的 Postgres。');
  console.error('  本地只跑纯单测请用：pnpm --filter @feedlore/server test:unit');
  process.exit(1);
}

const names = selected.map((f) => relative(root, f).split(sep).join('/'));
console.log(`[test:${tier}] ${selected.length} 个文件`);
if (tier === 'unit') {
  console.log(
    `[test:unit] 已排除 ${integration.length} 个接口级用例（需 DATABASE_URL，见 test:integration）`,
  );
} else {
  console.log(`[test:${tier}] ${names.join(', ')}`);
}

// 集成用例共用同一个测试库：默认的文件级并发会让两套账号互相污染
// （整站还原断言「只剩 1 个账号」却看到另一套测试的 3 个）。必须串行。
const r = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', ...selected],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
process.exit(r.status ?? 1);
