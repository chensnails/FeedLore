-- 首次登录必须改密标记。
-- 只有「空站点首次启动」播种出来的初始管理员为 true；改密成功后置回 false。
-- 迁移前已存在的账号全部取默认 false —— 升级后的老用户不会被要求改密，
-- 登录态与权限完全不受影响。
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean NOT NULL DEFAULT false;
