import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit 配置：生成/执行迁移。
 * schema 指向 src/schema.ts（单一真相源）。
 * 生成迁移不连库（drizzle-kit generate），执行迁移用 drizzle-kit migrate（连 DATABASE_URL）。
 *
 * 2.x 起由本仓库管理库结构：启动自举与 `upgrade` 一次性服务都会在目标库上执行 migrate
 * （幂等）。1.x 的库只读，不再由 1.x 代码改动。
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
