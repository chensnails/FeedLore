-- 0021 原先在启动迁移里建两只 coalesce 表达式 trigram GIN 索引。
-- 大表上 CREATE INDEX 要扫全表数分钟，app 会卡在迁移结束前不监听
-- （3.0.1 生产环境 502 事故）。索引已移到服务监听后的后台任务：
--   apps/server/src/lib/perfIndexes.ts
-- 由它用 CREATE INDEX CONCURRENTLY 逐只补建，不阻塞读写，也不挡启动。
-- 本迁移保留为空操作，维持版本序列与已升级站点的迁移记录连续性。
SELECT 1;