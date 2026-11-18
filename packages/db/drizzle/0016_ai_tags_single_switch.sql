-- AI 标签单开关收口：废弃 users.prefs.aiTags.enabled，统一到 user_llm.routes.ai_tags.enabled
--
-- 背景：AI 标签原来有两个开关——prefs.aiTags.enabled 控制「自动给全库打标」，
-- user_llm.routes.ai_tags.enabled 控制「这个能力能否调模型」。调度器两处都查，
-- 用户在设置页两个地方各看到一个开关，分不清该开哪个（界面重复配置项）。
--
-- 合并原则：routes.ai_tags 成为唯一真相源，且**默认关**（与旧 aiTags 默认关一致）。
-- 注意 routes 的通用语义是 enabled !== false（默认开），所以解析器对 ai_tags 特判为
-- enabled === true 才算开——避免升级后所有账号突然开始自动打标、狂烧额度。
--
-- 平滑迁移：旧账号已经开了 aiTags 的，把开启状态平移进 routes.ai_tags.enabled，
-- 用 jsonb_build_object 只加/改 ai_tags 这一个键，不动其它能力路由。

UPDATE user_llm l
SET routes = l.routes || jsonb_build_object(
  'ai_tags', COALESCE(l.routes->'ai_tags', '{}'::jsonb) || jsonb_build_object('enabled', true)
)
FROM users u
WHERE u.id = l.user_id
  AND u.prefs->'aiTags'->>'enabled' = 'true'
  AND COALESCE(l.routes->'ai_tags'->>'enabled', '') <> 'true';
