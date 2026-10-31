# 笺川 · FeedLore

> 拾取值得读的 —— 一个干净、顺手的**自托管 RSS 阅读器**，附资源卡片墙。
> 多用户、无广告、无遥测，所有数据都在你自己的 PostgreSQL 里。

**在线体验**：https://feedlore.669600.xyz · 演示账户 `demo` / `demo`
（普通用户角色，数据可能随使用变动或重置。想试多用户隔离，请自己部署一份。）

当前版本 **2.0.2** · [更新日志](CHANGELOG.md) · [从 1.x 升级](UPGRADE-v2.md)

---

## 这是什么

笺川把「订阅 → 阅读 → 沉淀」收在一处：左侧是按分组整理的订阅源，右侧是文章列表，
点开就地读全文；值得回头看的资源进卡片墙。文章、图片、已读状态、收藏、规则与模型配置
全部存在你自己的服务器上，不经过任何第三方。

2.x 是 1.x 的重写：服务端换成 Hono + better-auth + Drizzle，前端沿用 1.x 的界面与交互，
数据仍在 PostgreSQL。**1.x 站点可以零配置升级**，原账号密码直接可登录。

## 功能一览

- **专注阅读**：左频道（按分组）右文章，点标题就地展开全文；已读 / 未读 / 收藏齐全，
  服务端搜索、自动刷新、上一篇下一篇都在。
- **图文原样呈现**：图片按原文顺序内联，统一经服务端代理加载，源站防盗链也不会裂图。
- **订阅管理**：OPML 导入 / 导出（含分组、自动去重）、频道重命名、订阅地址可改、
  分组拖拽排序、单频道抓取频率；连续失败的频道会自动停用并提示。
- **卡片墙**：网格 / 列表展示资源卡片，按频道、标签筛选与搜索，点卡片直接看全文。
- **两个视图互相指路**：卡片详情里点「在文章页查看」，会切到文章页并高亮那一条。
- **条目过滤**：按关键词或正则设置「只收」或「屏蔽」，可选只匹配标题 / 摘要 / 正文，
  每个账号独立配置，新条目入库前生效。
- **外观可定制**：4 套主题、6 套主色，字号 / 字体 / 行高 / 阅读宽度 / 密度可调，即时生效。
- **多用户与角色**：每人独立订阅源、已读、收藏、规则与模型配置；账号由管理员创建，
  默认不开放注册。
- **移动端当 App 用**：整屏弹层、下拉关闭、侧缘滑动手势；HTTPS 下「添加到主屏幕」
  即可安装，外壳离线可打开。
- **可选的 AI 日报**：在「设置 → 模型」填自己的地址 / Key / 模型名，再在「设置 → 日报」
  设定生成时间与写作风格，即可按账号把过去 24 小时的新条目整理成中文简报；
  不配 Key 不影响其它功能。
- **自带更新通道**：「设置 → 关于」检查版本，配合 Watchtower 可一键更新。

## 界面截图

| 文章阅读页（浅色） | 文章阅读页（暗色） |
| --- | --- |
| ![文章阅读页](docs/screenshots/02-reader.png) | ![文章阅读页 · 暗色](docs/screenshots/06-reader-dark.png) |

| 卡片墙（浅色） | 卡片墙（暗色） |
| --- | --- |
| ![卡片墙](docs/screenshots/03-cards.png) | ![卡片墙 · 暗色](docs/screenshots/07-cards-dark.png) |

| 卡片详情弹窗 | 数据源管理（分组 / 采集参数） |
| --- | --- |
| ![卡片详情弹窗](docs/screenshots/04-card-detail.png) | ![数据源管理](docs/screenshots/05-settings.png) |

| 从卡片页跳到文章页：滚到那条并高亮 |
| --- |
| ![落点高亮](docs/screenshots/08-jump-flash.png) |

| 手机端 · 卡片墙 | 手机端 · 整屏详情（可下拉关闭） |
| --- | --- |
| ![手机端卡片墙](docs/screenshots/09-mobile-cards.png) | ![手机端整屏详情](docs/screenshots/10-mobile-detail.png) |

---

## 部署

### 环境要求

- 一台能跑 Docker 的 Linux / NAS / 小主机，**Docker 24+ 与 Compose v2**；
- 一个空闲端口（默认 `3210`）；
- 不需要单独安装 PostgreSQL：compose 里自带 `postgres:18.4`，数据放在命名卷
  `feedlore-pgdata`；
- 手机 / 浏览器能访问到这台机器；要装成 App 或走公网，建议再配 HTTPS 反向代理。

部署只需要一份 compose 文件：`docker-compose.v2.release.yml`（`.env` 是可选的覆盖项）。**不需要克隆源码。**

### 1. 启动

只需要一份 compose 文件，**不需要 `.env`，不需要填任何变量或密码**：

```bash
mkdir feedlore && cd feedlore
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
docker compose -f docker-compose.v2.release.yml up -d
```

首次启动会拉取镜像并执行一次性的 `upgrade` 服务：建库 → 建表 → 迁移 1.x 数据
（全新安装则按空站点跳过）→ 校验。**它成功退出后**应用容器才会启动。

```bash
docker compose -f docker-compose.v2.release.yml logs -f upgrade
curl -s http://127.0.0.1:3210/api/health
# {"ok":true,"db":{"ready":true}}
```

### 2. 打开并登录

浏览器访问 `http://<主机>:3210`，初始管理员账号是：

```
用户名：admin
密码：  admin
```

> **登录后请立即到「设置 → 账号」修改密码。** 空站点首次启动才会自动创建这个账号；
> 已有账号的站点不会被覆盖。

### 3. 第一次使用

1. 管理员在「设置 → 账号 / 用户管理」创建其他成员（没有开放注册）；
2. 在「设置 → 数据源」粘贴 RSS / Atom 添加频道，或导入 OPML；
3. 回到「文章」或「卡片」页开始读；
4. 需要 AI 日报时，各自在「设置 → 模型」填地址 / Key / 模型名。

### 4. 可选配置

默认值已经够用；需要改端口、走 HTTPS 反代、复用 1.x 数据库密码或更换初始账号时，
复制模板为 `.env` 再修改，然后重新 `up -d`：

```bash
curl -fsSL https://raw.githubusercontent.com/chensnails/FeedLore/main/.env.example -o .env
# 编辑 .env 后
docker compose -f docker-compose.v2.release.yml up -d
```

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST_PORT` | `3210` | 宿主机端口 |
| `PG_DB` / `PG_USER` | `feedlore` | 数据库名 / 用户 |
| `PG_PASSWORD` | `feedlore` | 数据库密码；**已有 1.x 站点升级时必须填原来的值** |
| `V2_DB_NAME` | `feedlore_v2` | 2.x 实际使用的库；1.x 的库保持只读 |
| `V2_IMAGE` | `…/feedlore:2.0.2` | 钉版本号；改成 `…:latest` 则跟随 Watchtower 滚动 |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin` | 仅空站点首次启动时生效 |
| `AUTH_SECRET` | 留空 | 自动生成并存入 v2 库；**一旦有值不要再改** |
| `AUTH_BASE_URL` | 留空 | 留空按访问 Host 做同源校验；多域名 / 反代改写 Host 时建议填 |
| `AUTH_TRUSTED_ORIGINS` | 留空 | 额外信任的来源，逗号分隔 |
| `AUTH_SECURE_COOKIES` | `0` | 纯 HTTP 必须为 `0`；HTTPS 反代下设 `1` |
| `WATCHTOWER_HTTP_API_TOKEN` | `feedlore-update` | 「一键更新」用；只在容器网络内有效 |
| `REFRESH_MINUTES` / `KEEP_PER_FEED` / `KEEP_DAYS` | `30` / `300` / `90` | 采集默认值，仅新库首次落库时生效 |
| `UPGRADE_SKIP_BACKUP` / `UPGRADE_SKIP_IMAGE_CACHE` | 留空 | 升级时跳过库内快照 / 图片缓存迁移 |
| `ALLOW_PRIVATE_HOSTS` | 留空 | 订阅内网 RSS、连本机 Ollama 时设 `1` |
| `TRUST_PROXY` | 留空 | 反代后面要按真实 IP 限流时设 `1` |

默认数据库密码 `feedlore` 与更新令牌 `feedlore-update` 都只在 Docker 内部网络使用，
数据库和 Watchtower 端口没有映射到宿主机。若这台机器上还跑着其它容器、或你介意默认值，
请在首次启动前用 `.env` 覆盖 `PG_PASSWORD` 与 `WATCHTOWER_HTTP_API_TOKEN`。

### 从 1.x 升级

| 你的情况 | 做法 |
| --- | --- |
| 1.x + Watchtower（默认部署方式） | **什么都不用做**：`latest` 已指向 2.x，Watchtower 会自动换镜像；2.x 启动时自建 `feedlore_v2` 并迁移，日志出现 `自举完成` 后用原账号密码登录 |
| 想手动 / 分步升级 | 用同一份 `docker-compose.v2.release.yml`：`upgrade` 先迁移，成功后才替换应用 |
| 回滚 | 用 1.x 的 `docker-compose.release.yml` 重新拉起；1.x 的库与卷从未被写入 |

完整步骤、迁移内容与注意事项见 **[UPGRADE-v2.md](UPGRADE-v2.md)**。

### 更新

- **钉版本号（默认，推荐）**：镜像固定为 `feedlore:2.0.2`，不会自己变化。改 `.env` 的
  `V2_IMAGE` 为新版本后重新 `up -d`。
- **跟随 latest**：把 `V2_IMAGE` 设为 `ghcr.io/chensnails/feedlore:latest`，Watchtower
  每 5 分钟检查并重建；也可以在「设置 → 关于 → 一键更新」立即触发。
- 预发布版本只推版本号标签、不动 `latest`，普通部署不会收到。

查看容器内实际版本：

```bash
docker exec feedlore node -e "console.log(require('/app/package.json').version)"
```

### 反向代理 / HTTPS

用 Nginx、Caddy、Traefik 等把域名转到 `HOST_PORT`，并注意：

- `AUTH_BASE_URL` 填用户实际访问的地址，例如 `https://feed.example.com`；
- HTTPS 下 `AUTH_SECURE_COOKIES=1`（纯 HTTP 保持 `0`，否则浏览器不回传 Cookie，
  表现为「登录成功但仍未登录」）；
- 反代要转发 `X-Forwarded-For` 时设 `TRUST_PROXY=1`；
- 若同时用域名和 IP 访问，把另一个来源加进 `AUTH_TRUSTED_ORIGINS`。

### 备份与恢复

2.x 的数据都在 `feedlore_v2` 库（`.env` 的 `V2_DB_NAME`）：

```bash
# 备份
docker compose -f docker-compose.v2.release.yml exec db \
  pg_dump -U "${PG_USER:-feedlore}" -d "${V2_DB_NAME:-feedlore_v2}" -Fc > feedlore-$(date +%F).dump
```

恢复时停应用、用 `pg_restore` 导入后重启：

```bash
# 已部署的站点：恢复前先停应用
docker compose -f docker-compose.v2.release.yml stop app
docker exec -i feedlore-db pg_restore -U "${PG_USER:-feedlore}" -d "${V2_DB_NAME:-feedlore_v2}" \
  --clean --if-exists --no-owner < feedlore-2026-10-31.dump
docker compose -f docker-compose.v2.release.yml start app

# 新机器：先起数据库，建同名空库再导入，最后起全部服务
docker compose -f docker-compose.v2.release.yml up -d db
docker exec feedlore-db psql -U "${PG_USER:-feedlore}" -d postgres -c "CREATE DATABASE ${V2_DB_NAME:-feedlore_v2};"
docker exec -i feedlore-db pg_restore -U "${PG_USER:-feedlore}" -d "${V2_DB_NAME:-feedlore_v2}" \
  --no-owner < feedlore-2026-10-31.dump
docker compose -f docker-compose.v2.release.yml up -d
```

迁移到新机器时，除了数据库，还要带走 `.env`（尤其 `PG_PASSWORD`、`AUTH_SECRET`、
`WATCHTOWER_HTTP_API_TOKEN`）与反代配置。只备份订阅可用「设置 → 数据源 → 导出 OPML」
（不含已读 / 收藏 / 规则）。

### 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 登录成功但马上又变回未登录 | 纯 HTTP 下开了 `AUTH_SECURE_COOKIES=1`；改回 `0` |
| 登录 / 登出被 Origin 拦截 | 填对 `AUTH_BASE_URL`；多域名时补 `AUTH_TRUSTED_ORIGINS` |
| `upgrade` 失败、应用没起来 | `logs upgrade` 看具体错误；磁盘不足或图片缓存过大可先设 `UPGRADE_SKIP_IMAGE_CACHE=1` |
| 订阅内网 RSS / Ollama 失败 | `ALLOW_PRIVATE_HOSTS=1`（仅在你信任这些地址时） |
| 更新后版本没变 | 镜像钉了版本号 / Watchtower 还没轮询；查实际版本或用「一键更新」 |
| 日报不生成 | 模型配置按账号独立，先在该账号「设置 → 模型」填好地址 / Key |

---

## 本地开发

需要 Node ≥ 22（pnpm 由 corepack 按 `packageManager` 提供）。

```bash
pnpm install

# 任一 PostgreSQL 18 实例
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/feedlore_v2
pnpm --filter @feedlore/db migrate

pnpm --filter @feedlore/server dev   # http://127.0.0.1:3000
pnpm --filter @feedlore/web dev      # Vite，5173，/api 代理到 3000

pnpm -r typecheck
pnpm -r test                          # 单元；接口级测试需要 DATABASE_URL
pnpm --filter @feedlore/web build && node scripts/verify-dist.mjs
```

## 技术栈

| 目录 | 内容 |
| --- | --- |
| `apps/server` | Hono + better-auth + Drizzle；采集调度、日报、图片缓存、契约校验 |
| `apps/web` | React + Vite（PWA），交互沿用 1.x |
| `packages/contract` | 前后端唯一真相源：端点、DTO 与 Zod 校验 |
| `packages/db` | Drizzle schema 与迁移 |
| `packages/auth` | better-auth 实例与用户名登录 |
| `packages/ai` | 模型调用、加密与日报生成 |
| `packages/client` | 前端类型安全 API 客户端 |

运行时全链路按 UTC 记录时间；1.x 的源码与 compose 只保留在 tag `v1.7.4`。

## 许可

[MIT](LICENSE)
