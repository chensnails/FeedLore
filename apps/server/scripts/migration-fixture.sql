-- 迁移演练：在 v2 库的 `legacy` schema 里造一份 1.7.x 形状的数据。
-- 目的：让 scripts/migrate-legacy.ts 在真实 PG 上跑一遍（列名、类型、jsonb 形状、
-- 唯一约束冲突、keyset 分页都能验到），而不必去碰生产库。
--
-- 用完即删：drop schema legacy cascade;

drop schema if exists legacy cascade;
create schema legacy;

create table legacy.users (
  id            bigserial primary key,
  username      text not null unique,
  salt          text not null,
  password_hash text not null,
  role          text not null default 'user',
  prefs         jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table legacy.feeds (
  id              bigserial primary key,
  owner_id        bigint references legacy.users(id) on delete cascade,
  url             text not null,
  title           text,
  site_url        text,
  description     text,
  icon_url        text,
  enabled         boolean not null default true,
  card_enabled    boolean not null default true,
  group_name      text,
  custom_title    text,
  sort_order      integer not null default 0,
  refresh_minutes integer,
  etag            text,
  last_modified   text,
  last_status     text,
  last_error      text,
  fail_streak     smallint not null default 0,
  last_fetched_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (owner_id, url)
);

create table legacy.entries (
  id           bigserial primary key,
  feed_id      bigint not null references legacy.feeds(id) on delete cascade,
  guid         text not null,
  title        text not null,
  link         text,
  pwd          text,
  description  text,
  content      text,
  size         text,
  tags         text[] not null default '{}',
  image        text,
  images       text[],
  source_url   text,
  body_json    text,
  links        text[],
  published_at timestamptz,
  fetched_at   timestamptz not null default now(),
  is_read      boolean not null default false,
  read_at      timestamptz,
  is_favorite  boolean not null default false,
  favorited_at timestamptz,
  watch_state  text,
  watch_rule   text,
  unique (feed_id, guid)
);

create table legacy.digests (
  date       date not null,
  owner_id   bigint not null references legacy.users(id) on delete cascade,
  payload    jsonb not null,
  model      text,
  fallback   boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (owner_id, date)
);

-- 一个普通用户，prefs 里带 legacy 形状的 llm（密文用假值，只验搬运不断言能解密）
insert into legacy.users (username, salt, password_hash, role, prefs) values (
  'legacyuser', 's1', 'deadbeef',
  'user',
  '{
     "appearance": {"theme":"light","accent":"teal","density":"compact","fontSize":"m"},
     "layout": {"view":"cards","tab":"all","sections":[],"sort":"new","rdScope":"all","rdCollapsedGroups":[],"readerSideWidth":240,"digestEnabled":true},
     "filters": [],
     "watchRules": [],
     "webhookUrl": "",
     "digest": {"auto":true,"time":"08:30","mode":"all","feeds":[],"maxPerFeed":15,"maxTotal":120,"keepDays":14,"style":"简洁点","lastAuto":""},
     "llm": {"baseUrl":"https://api.example.com/v1","model":"legacy-model","apiKeyEnc":"enc.v1.aaa.bbb.ccc","temperature":0.4,"thinking":true,"thinkingDepth":"high"}
   }'::jsonb
);

insert into legacy.feeds (owner_id, url, title, site_url, icon_url, enabled, group_name, sort_order, refresh_minutes) values
  (1, 'https://migration-test.example/rss.xml', '迁移演练源', 'https://migration-test.example',
   'https://migration-test.example/icon.png', true, '演练', 3, 60);

insert into legacy.entries (feed_id, guid, title, link, description, size, tags, image, published_at, is_read, read_at, is_favorite) values
  (1, 'g-1', '演练条目一', 'https://migration-test.example/1', '第一条', '1.2GB', '{影视,4K}',
   'https://migration-test.example/1.jpg', now() - interval '2 hours', true, now() - interval '1 hour', true),
  (1, 'g-2', '演练条目二', 'https://migration-test.example/2', '第二条', '800MB', '{音乐}',
   null, now() - interval '5 hours', false, null, false),
  (1, 'g-3', '演练条目三', 'https://migration-test.example/3', null, null, '{}',
   null, null, false, null, false);

insert into legacy.digests (date, owner_id, payload, model, fallback) values (
  current_date - 1, 1,
  '{"date":"2026-10-29","generatedAt":1761700000000,"windowFrom":1761613600000,"windowTo":1761700000000,
    "model":"legacy-model","usedMapReduce":false,"fallback":false,"error":null,
    "stats":{"collected":9,"kept":7,"feeds":1},"overview":"演练日报概览","highlights":[],"sections":[]}'::jsonb,
  'legacy-model', false
);

select 'legacy 演练数据已就绪' as msg,
       (select count(*) from legacy.users) as users,
       (select count(*) from legacy.feeds) as feeds,
       (select count(*) from legacy.entries) as entries,
       (select count(*) from legacy.digests) as digests;
