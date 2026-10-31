# 更新日志

本文件记录 2.x 的用户可见变化与部署相关变更。

- 1.x 的完整历史见 tag [v1.7.4](https://github.com/chensnails/FeedLore/tree/v1.7.4) 及对应的 GitHub Releases。
- 从 1.x 升级的步骤见 [UPGRADE-v2.md](UPGRADE-v2.md)。

## 2.0.1 — 2026-10-31

### 新增

- **1.x 零配置升级**：2.x 容器启动时若发现 1.x 库结构，会自动快照 `<库名>_backup`、
  建 `<库名>_v2`（库级 UTC）、执行结构迁移与数据迁移，并校验条数、凭据与站点主密钥；
  成功后写完成标记，之后启动只做一次探测。开着 Watchtower 的 1.x 站点无需改任何配置。
- **手动 / 受控升级**：`docker-compose.v2.release.yml` 的 `upgrade` 一次性服务先迁移，
  成功后才替换应用容器；全新安装同样适用。
- **零配置鉴权**：`AUTH_SECRET` 未配置时自动生成并持久化到 `settings.authSecret`；
  `AUTH_BASE_URL` 可留空，按请求 Host 做同源校验（登录与登出都可用）。
- 发布通道迁回 `ghcr.io/chensnails/feedlore`：正式版同时推版本号标签与 `latest`，并创建 GitHub Release。

### 变更

- 前端整体回退到 1.x 的界面与交互（三视图、分组折叠、卡片详情、频道抽屉、PWA），
  服务端、契约与部署链路不变。
- 仓库收敛为单一 `main` 主线：移除 `apps/legacy`、旧的 v2 compose 与一次性运维脚本；
  1.x 源码与 compose 只保留在 tag `v1.7.4`。
- CI 只对 `main` 运行（类型检查、单测、真库集成、前端构建与产物校验、amd64/arm64 镜像构建）。
- 版本号单一真源改为根 `package.json`（不再有 `VERSION` 文件）；`release.yml` 拒绝 1.x tag。
- 公开文档只保留仓库根的 `README.md`、`CHANGELOG.md`、`UPGRADE-v2.md`、`LICENSE`。

### 修复

- 1.x 密码无损迁移：原 scrypt 哈希以 `legacy$<salt>$<hash>` 写入 2.x，首次登录校验通过后
  自动改写为 better-auth 哈希，用户无需重设密码。
- 用户名规则对齐 1.x：允许 `-`、`@`，保留大小写，长度 1–40。
- 迁移后时间列不再偏移 8 小时（迁移容器、服务端与数据库统一 `TZ=UTC`）。

### 部署

- 镜像：`ghcr.io/chensnails/feedlore:2.0.1`（amd64 + arm64），`latest` 指向同一 digest。
- 默认 compose 钉版本号；需要滚动升级时把 `V2_IMAGE` 设为 `…:latest`。
- 回滚：用 1.x 的 `docker-compose.release.yml` 重新拉起（1.x 库与卷从未被写入）。

## 2.0.0 — 2026-10-31

2.x 重写首发（含预发布 `2.0.0-v2`）。

- 单体应用重写为 pnpm monorepo：
  - `apps/server`：Hono + better-auth + Drizzle ORM，PostgreSQL 18；
  - `apps/web`：React + Vite（PWA）；
  - `packages/contract` / `db` / `auth` / `ai` / `client`：端点与 DTO 的唯一真相源、
    数据库结构与迁移、鉴权、模型调用与日报、类型安全客户端。
- 契约在服务端运行时强制校验（请求 400 / 响应 500），前后端版本错配不会把脏数据塞进界面。
- 出网统一经过 SSRF 校验出口；图片代理限定 `image/*`；采集、过滤、关注/屏蔽、日报与一键更新保留。
- 首次提供镜像内一次性升级服务与 2.x compose（db / upgrade / app / watchtower）。
