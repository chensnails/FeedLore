import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit 配置：生成/执行迁移。
 * schema 指向 src/schema.ts（单一真相源）。
 * 执行迁移用 drizzle-kit migrate（连 DATABASE_URL）。
 *
 * ⚠️ **不要运行 `drizzle-kit generate`**。本仓库的迁移一直是手写 SQL + 手工登记
 * `meta/_journal.json`（见 git 历史：0018/0019 都只带 .sql 与 _journal.json），
 * 因此 `meta/` 下的 snapshot 从 0007 起就停更了。运行期 migrate 只读 journal + SQL，
 * 不读 snapshot，所以升级完全不受影响；但 generate 会拿过期的 0007 快照对比当前
 * schema，产出重复建表的破坏性迁移（实测现在更是直接因缺快照报错）。新增迁移请
 * 直接写 `drizzle/NNNN_*.sql` 并在 journal 追加一条 —— 有
 * `apps/server/src/migrations-consistency.test.ts` 守卫两者一一对应。
 *
 * 2.x 起由本仓库管理库结构：启动自举都会在目标库上执行 migrate（幂等）。
 */
export default {
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
} satisfies Config;
