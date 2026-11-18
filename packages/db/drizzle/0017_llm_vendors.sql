-- 厂商 / 模型两层拆分（2026-11-18）
--
-- 0015 的 llm_providers 每行同时存 baseUrl + encryptedKey + model，一个「模型」
-- 实际上是一整路接入：同一家厂商跑两个模型就要复制两份地址与 Key，默认槽又与
-- llm_providers.is_default 并存，界面上说不清谁才是默认。
--
-- 0017 把「接入」抽成 llm_vendors：厂商 = 名称 + 地址 + 加密 Key，可被多个模型复用。
-- llm_providers 继续作为模型表（id 不变，路由里的 providerId 因此完全不用迁移），
-- 新增 vendor_id 指向厂商。旧的 base_url / encrypted_key 列保留不动：
--   - 旧镜像回滚时仍能按旧逻辑读写；
--   - 未完成回填的行由应用层按「有 vendor 用 vendor，无 vendor 用旧列」兜底。
--
-- 回填规则：
--   1. 现有提供商行按 (用户, 地址, 密文 Key) 归组，每组生成一个厂商；
--   2. 旧默认槽 user_llm 的三件套也抽成一个厂商 + 一个模型（模型名非空时），
--      已有 is_default 的账号不重复设默认；
--   3. 每账号只保留一个 is_default。

CREATE TABLE IF NOT EXISTS "llm_vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"encrypted_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_vendors" ADD CONSTRAINT "llm_vendors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_vendors_user_idx" ON "llm_vendors" ("user_id");
--> statement-breakpoint

ALTER TABLE "llm_providers" ADD COLUMN IF NOT EXISTS "vendor_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_vendor_id_llm_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "llm_vendors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_providers_vendor_idx" ON "llm_providers" ("vendor_id");
--> statement-breakpoint

-- 历史数据可能被手工改出多个默认，先收敛成一个
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at, id) AS rn
  FROM llm_providers
  WHERE is_default = true
)
UPDATE llm_providers p
SET is_default = false
FROM ranked r
WHERE p.id = r.id AND r.rn > 1;
--> statement-breakpoint

-- 现有模型行 → 厂商（同一用户下地址与密文 Key 相同视为同一家）
INSERT INTO llm_vendors (id, user_id, name, base_url, encrypted_key, created_at, updated_at)
SELECT
  gen_random_uuid()::text,
  g.user_id,
  COALESCE(
    NULLIF(split_part(regexp_replace(g.base_url, '^[a-zA-Z][a-zA-Z0-9+.-]*://', ''), '/', 1), ''),
    NULLIF(g.any_name, ''),
    '未命名厂商'
  ),
  g.base_url,
  g.encrypted_key,
  COALESCE(g.created_at, now()),
  now()
FROM (
  SELECT
    user_id,
    COALESCE(base_url, '') AS base_url,
    encrypted_key,
    MIN(created_at) AS created_at,
    MIN(NULLIF(name, '')) AS any_name
  FROM llm_providers
  GROUP BY user_id, COALESCE(base_url, ''), encrypted_key
) g;
--> statement-breakpoint

UPDATE llm_providers p
SET vendor_id = v.id
FROM llm_vendors v
WHERE p.vendor_id IS NULL
  AND v.user_id = p.user_id
  AND v.base_url = COALESCE(p.base_url, '')
  AND v.encrypted_key IS NOT DISTINCT FROM p.encrypted_key;
--> statement-breakpoint

-- 旧默认槽 user_llm → 厂商（地址/Key 与已有厂商相同时直接复用）
INSERT INTO llm_vendors (id, user_id, name, base_url, encrypted_key, created_at, updated_at)
SELECT
  gen_random_uuid()::text,
  l.user_id,
  COALESCE(
    NULLIF(split_part(regexp_replace(COALESCE(l.base_url, ''), '^[a-zA-Z][a-zA-Z0-9+.-]*://', ''), '/', 1), ''),
    '未命名厂商'
  ),
  COALESCE(l.base_url, ''),
  l.encrypted_key,
  now(),
  now()
FROM user_llm l
WHERE (COALESCE(l.base_url, '') <> '' OR l.encrypted_key IS NOT NULL OR COALESCE(l.model, '') <> '')
  AND NOT EXISTS (
    SELECT 1 FROM llm_vendors v
    WHERE v.user_id = l.user_id
      AND v.base_url = COALESCE(l.base_url, '')
      AND v.encrypted_key IS NOT DISTINCT FROM l.encrypted_key
  );
--> statement-breakpoint

-- 旧默认槽有模型名的，补成一行模型；没有默认模型的账号把它标为默认
INSERT INTO llm_providers (
  id, user_id, vendor_id, name, encrypted_key, base_url, model,
  temperature, thinking, thinking_depth, is_default, created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  l.user_id,
  v.id,
  '',
  l.encrypted_key,
  l.base_url,
  l.model,
  l.temperature,
  l.thinking,
  l.thinking_depth,
  NOT EXISTS (
    SELECT 1 FROM llm_providers p
    WHERE p.user_id = l.user_id AND p.is_default = true
  ),
  now(),
  now()
FROM user_llm l
JOIN llm_vendors v
  ON v.user_id = l.user_id
 AND v.base_url = COALESCE(l.base_url, '')
 AND v.encrypted_key IS NOT DISTINCT FROM l.encrypted_key
WHERE COALESCE(l.model, '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM llm_providers p2
    WHERE p2.user_id = l.user_id
      AND p2.vendor_id = v.id
      AND COALESCE(p2.model, '') = COALESCE(l.model, '')
  );
