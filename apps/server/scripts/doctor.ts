/**
 * 部署自检（V3.3）：docker exec -it feedlore doctor [--json]
 *
 * 只做只读检查，不修数据、不写库。检查项：配置格式、数据库可达、表结构、
 * 管理员账号、采集调度与 AI 配置。退出码：0 = 无 FAIL，1 = 至少一项 FAIL
 * （WARN 是提示，不影响退出码）。
 *
 * 复用启动侧的 env.validateConfig 与 db 包，避免 doctor 的判断和生产启动分叉。
 */

import { createPool } from '@feedlore/db';
import {
  APP_VERSION,
  getAdminUser,
  getDatabaseUrl,
  SCHEDULER_ENABLED,
  validateConfig,
} from '../src/env';
import { normalizeSource } from '../src/lib/settings';

type Status = 'PASS' | 'WARN' | 'FAIL';

interface Check {
  name: string;
  status: Status;
  detail: string;
}

const checks: Check[] = [];
const add = (name: string, status: Status, detail: string): void => {
  checks.push({ name, status, detail });
};

const wantJson = process.argv.includes('--json');

async function main(): Promise<void> {
  add('版本', 'PASS', `FeedLore ${APP_VERSION}`);

  const issues = validateConfig();
  add(
    '配置格式',
    issues.length ? 'FAIL' : 'PASS',
    issues.length ? issues.map((i) => `${i.key}: ${i.message}`).join('; ') : 'validateConfig 通过',
  );

  const url = getDatabaseUrl();
  if (!url) {
    add('数据库', 'FAIL', 'DATABASE_URL 未设置');
    return report();
  }

  const pool = createPool(url);
  try {
    const t0 = Date.now();
    await pool.query('select 1');
    add('数据库可达', 'PASS', `select 1 成功（${Date.now() - t0}ms）`);

    const tables = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const present = new Set(tables.rows.map((r) => r.table_name));
    const required = ['users', 'sessions', 'settings', 'feeds', 'entries'];
    const missing = required.filter((t) => !present.has(t));
    add(
      '表结构',
      missing.length ? 'FAIL' : 'PASS',
      missing.length
        ? `缺少必需表：${missing.join(', ')}（先跑迁移）`
        : `${required.length} 张必需表齐全`,
    );
    for (const [name, note] of [
      ['llm_providers', 'AI 模型配置'],
      ['ai_jobs', 'AI 异步任务'],
    ] as const) {
      if (!present.has(name)) add(note, 'WARN', `表 ${name} 不存在（旧库未迁移？AI 功能会不可用）`);
    }

    if (!present.has('users')) return report();

    const { rows: admins } = await pool.query<{
      username: string | null;
      must_change_password: boolean;
    }>(
      "select username, must_change_password from users where role = 'admin' order by username limit 10",
    );
    if (!admins.length) {
      add('管理员账号', 'FAIL', '库里没有任何 admin 账号');
    } else {
      const pending = admins.filter((a) => a.must_change_password);
      add(
        '管理员账号',
        'PASS',
        `admin 数 ${admins.length}${pending.length ? `，其中 ${pending.length} 个仍待首次改密` : ''}`,
      );
      const configured = getAdminUser();
      if (!admins.some((a) => a.username === configured)) {
        add(
          'ADMIN_USER',
          'WARN',
          `配置的 ADMIN_USER=${configured} 不在 admin 列表里（不影响已有账号登录）`,
        );
      }
    }

    const { rows: userCount } = await pool.query<{ n: string }>(
      'select count(*)::text as n from users',
    );
    add('账号总数', 'PASS', `${userCount[0]?.n ?? '?'} 个`);

    try {
      const { rows } = await pool.query<{ value: unknown }>(
        "select value from settings where key = 'source' limit 1",
      );
      const src = normalizeSource((rows[0]?.value ?? null) as Record<string, unknown> | null);
      add(
        '采集调度',
        SCHEDULER_ENABLED ? 'PASS' : 'WARN',
        `全局间隔 ${src.refreshMinutes} 分钟 / 并发 ${src.concurrency}${SCHEDULER_ENABLED ? '' : '（REFRESH_DISABLED=1，仅手动刷新）'}`,
      );
    } catch (e) {
      add('采集调度', 'WARN', `读取配置失败：${(e as Error)?.message ?? e}`);
    }

    if (present.has('llm_providers')) {
      const { rows } = await pool.query<{ n: string }>(
        'select count(*)::text as n from llm_providers',
      );
      add('AI 模型配置', 'PASS', `${rows[0]?.n ?? '?'} 个 provider（0 表示未启用 AI，不影响阅读）`);
    }
  } catch (e) {
    add('数据库', 'FAIL', `连接或查询失败：${(e as Error)?.message ?? e}`);
  } finally {
    await pool.end().catch(() => {});
  }

  report();
}

function report(): void {
  if (wantJson) {
    process.stdout.write(
      JSON.stringify({ ok: !checks.some((c) => c.status === 'FAIL'), checks }) + '\n',
    );
  } else {
    const line = '─'.repeat(64);
    process.stdout.write(`${line}\nFeedLore doctor / 部署自检\n${line}\n`);
    for (const c of checks) process.stdout.write(`[${c.status}] ${c.name}：${c.detail}\n`);
    process.stdout.write(`${line}\n`);
  }
  process.exitCode = checks.some((c) => c.status === 'FAIL') ? 1 : 0;
}

main().catch((e) => {
  add('doctor', 'FAIL', `自检自身异常：${(e as Error)?.stack ?? e}`);
  report();
});
