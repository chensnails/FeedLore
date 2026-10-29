import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit 配置：生成/执行迁移。
 * schema 指向 src/schema.ts（单一真相源）。
 * 生成迁移不连库（drizzle-kit generate），执行迁移用 drizzle-kit migrate（连 DATABASE_URL）。
 *
 * ⚠️ 线上库当前由 apps/legacy/db.js 管理，v2 迁移只在 P7 切换时执行，
 * 在此之前不要对线上库跑 migrate。本地可用 docker 起一个临时 PG 验证迁移。
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
