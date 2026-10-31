# 笺川（FeedLore）2.x

自托管 RSS 阅读器与资源卡片墙：多用户、按账号隔离订阅与偏好，支持采集调度、AI 日报、
图片缓存与一键更新。数据全部存 PostgreSQL，运行时全链路按 UTC 记录时间。

当前版本 **2.0.1**，更新内容见 [CHANGELOG.md](CHANGELOG.md)。

> 2.x 是 1.x 的单体应用重写为 pnpm monorepo；仓库只有 `main` 一条线，1.x 已冻结在 tag `v1.7.4`。
> 1.x 站点升级见 **[UPGRADE-v2.md](UPGRADE-v2.md)**（开着 Watchtower 的站点无需任何配置）。

## 架构

| 目录 | 内容 |
| --- | --- |
| `apps/server` | Hono + better-auth + Drizzle；采集调度、日报、图片缓存、契约校验 |
| `apps/web` | React + Vite（PWA），交互沿用 1.x |
| `packages/contract` | 前后端唯一真相源：端点、DTO 与 Zod 校验 |
| `packages/db` | Drizzle schema 与迁移（单一真相源） |
| `packages/auth` | better-auth 实例与用户名登录 |
| `packages/ai` | 模型调用、加密与日报生成 |
| `packages/client` | 前端类型安全 API 客户端（hc） |
| `scripts` | `verify-dist.mjs`（产物校验）、`ui-smoke.mjs`（真机冒烟） |

## 部署

镜像发布在 `ghcr.io/chensnails/feedlore`：正式版同时推版本号标签与 `latest`。

```bash
# 1) 准备 .env（每项说明见 .env.example）
cp .env.example .env

# 2) 起栈：upgrade 一次性服务先建库/迁移/校验，成功后 app 才启动
docker compose -f docker-compose.v2.release.yml up -d
docker compose -f docker-compose.v2.release.yml logs -f upgrade
```

全新安装时迁移不到 1.x 数据，会按空站点建表；随后手动播种管理员：

```bash
docker exec -e ADMIN_USER=admin -e 'ADMIN_PASS=<强密码>' feedlore \
  pnpm --filter @feedlore/server seed
```

更新：默认镜像钉版本号，改 `.env` 的 `V2_IMAGE` 后 `up -d`；`V2_IMAGE` 设为
`ghcr.io/chensnails/feedlore:latest` 则跟随 Watchtower 滚动升级，也可在
「设置 → 关于 → 一键更新」触发。

## 本地开发

需要 Node ≥ 22（pnpm 由 corepack 按 `packageManager` 提供）。

```bash
pnpm install

# 任一 PostgreSQL 18 实例
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/feedlore_v2
pnpm --filter @feedlore/db migrate

pnpm --filter @feedlore/server dev   # http://127.0.0.1:3000
pnpm --filter @feedlore/web dev      # Vite 开发服务器

pnpm -r typecheck
pnpm -r test                          # 单元；接口级测试需要 DATABASE_URL
pnpm --filter @feedlore/web build && node scripts/verify-dist.mjs
```

## 许可

[MIT](LICENSE)
