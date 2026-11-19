import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLegacyDatabaseUrl, type DbProbe } from './bootstrap';

const SRC = 'postgres://feedlore:secret@db:5432/feedlore';

interface ProbeSpec {
  databases?: string[];
  rows?: Record<string, boolean>;
  /** 旧库「全部待改密」判定；undefined 表示桩不实现该方法。 */
  allUsersRequireChange?: boolean | (() => never);
  throwOn?: string;
}

function probe(spec: ProbeSpec): DbProbe {
  const databases = spec.databases ?? ['feedlore', 'feedlore_v2'];
  const rows = spec.rows ?? {};
  const p: DbProbe = {
    databaseExists: async (name) => {
      if (spec.throwOn === 'exists') throw new Error('probe exists failed');
      return databases.includes(name);
    },
    hasAnyRow: async (db, table) => {
      if (spec.throwOn === 'row') throw new Error('probe row failed');
      return rows[`${db}.${table}`] === true;
    },
  };
  if (spec.allUsersRequireChange !== undefined) {
    p.allUsersRequireChange = async (db) => {
      if (spec.throwOn === 'seed') throw new Error('probe seed failed');
      const v = spec.allUsersRequireChange;
      return typeof v === 'function' ? (v as () => never)() : v === true;
    };
  }
  return p;
}

test('旧库名 + 旧库无账号 + v2 库有账号 → 改写到 feedlore_v2（保留凭据/主机/端口）', async () => {
  const out = await resolveLegacyDatabaseUrl(
    SRC,
    probe({ rows: { 'feedlore_v2.users': true } }),
  );
  const u = new URL(out);
  assert.equal(u.pathname, '/feedlore_v2');
  assert.equal(u.username, 'feedlore');
  assert.equal(u.password, 'secret');
  assert.equal(u.host, 'db:5432');
});

test('两边都有账号 → 不动（用户真的在用旧库名跑站点，交给用户决定）', async () => {
  const out = await resolveLegacyDatabaseUrl(
    SRC,
    probe({ rows: { 'feedlore.users': true, 'feedlore_v2.users': true } }),
  );
  assert.equal(out, SRC);
});

test('v2 库没有账号 → 不动（真正的新站点不能误切到空库）', async () => {
  const out = await resolveLegacyDatabaseUrl(SRC, probe({ rows: {} }));
  assert.equal(out, SRC);
});

test('v2 库不存在 → 不动（保持原行为，不凭空切换）', async () => {
  const out = await resolveLegacyDatabaseUrl(
    SRC,
    probe({ databases: ['feedlore'], rows: { 'feedlore_v2.users': true } }),
  );
  assert.equal(out, SRC);
});

test('非旧库名 → 原样返回（自定义库名绝不误伤）', async () => {
  const custom = 'postgres://feedlore:secret@db:5432/mysite';
  const out = await resolveLegacyDatabaseUrl(
    custom,
    probe({ rows: { 'feedlore_v2.users': true } }),
  );
  assert.equal(out, custom);
});

test('已指向 feedlore_v2 → 原样返回（幂等）', async () => {
  const v2 = 'postgres://feedlore:secret@db:5432/feedlore_v2';
  const out = await resolveLegacyDatabaseUrl(
    v2,
    probe({ rows: { 'feedlore_v2.users': true } }),
  );
  assert.equal(out, v2);
});

test('探测抛错 → 保持原连接串，不冒险切换', async () => {
  const out = await resolveLegacyDatabaseUrl(
    SRC,
    probe({ rows: { 'feedlore_v2.users': true }, throwOn: 'exists' }),
  );
  assert.equal(out, SRC);
  const out2 = await resolveLegacyDatabaseUrl(
    SRC,
    probe({ rows: { 'feedlore_v2.users': true }, throwOn: 'row' }),
  );
  assert.equal(out2, SRC);
});

test('非标准连接串 → 原样返回，不抛错', async () => {
  const out = await resolveLegacyDatabaseUrl('not a url', probe({ rows: {} }));
  assert.equal(out, 'not a url');
});

test('改写会记录日志（运维可追溯）', async () => {
  const logged: string[] = [];
  await resolveLegacyDatabaseUrl(
    SRC,
    probe({ rows: { 'feedlore_v2.users': true } }),
    (...a) => logged.push(a.map(String).join(' ')),
  );
  assert.equal(logged.length, 2);
  assert.match(logged[0] ?? '', /legacy setup/);
  assert.match(logged[1] ?? '', /Switching DATABASE_URL/);
});

test('2.5.3 误播种：旧库账号全是待改密 → 切回 feedlore_v2（2.5.5 自愈）', async () => {
  const logged: string[] = [];
  const out = await resolveLegacyDatabaseUrl(
    SRC,
    probe({
      rows: { 'feedlore.users': true, 'feedlore_v2.users': true },
      allUsersRequireChange: true,
    }),
    (...a) => logged.push(a.map(String).join(' ')),
  );
  assert.equal(new URL(out).pathname, '/feedlore_v2');
  assert.match(logged[0] ?? '', /mis-seed/);
  assert.ok(logged.some((l) => /Switching DATABASE_URL/.test(l)), '应记录切库日志');
});

test('旧库有已改密的真实账号 → 不动（用户确实在用旧库名跑站点）', async () => {
  const out = await resolveLegacyDatabaseUrl(
    SRC,
    probe({
      rows: { 'feedlore.users': true, 'feedlore_v2.users': true },
      allUsersRequireChange: false,
    }),
  );
  assert.equal(out, SRC);
});

test('探测实现不支持误播种判定 → 不动（保守，不靠猜）', async () => {
  const out = await resolveLegacyDatabaseUrl(
    SRC,
    probe({ rows: { 'feedlore.users': true, 'feedlore_v2.users': true } }),
  );
  assert.equal(out, SRC);
});

test('误播种判定抛错 → 不动（探测失败不冒险）', async () => {
  const out = await resolveLegacyDatabaseUrl(
    SRC,
    probe({
      rows: { 'feedlore.users': true, 'feedlore_v2.users': true },
      allUsersRequireChange: true,
      throwOn: 'seed',
    }),
  );
  assert.equal(out, SRC);
});
