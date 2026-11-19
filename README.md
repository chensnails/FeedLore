# 笺川 · FeedLore

> 拾取值得读的 —— 自托管 RSS 阅读器 + 资源卡片墙。
> 多用户 · 无广告 · 无遥测 · 数据全在你自己的 PostgreSQL。

**在线体验**：https://feedlore.669600.xyz  （`demo` / `demo`）
当前版本 **2.5.3-rc.1**（预发布；`latest` 仍为 2.5.2） · [更新日志](CHANGELOG.md) · [快速开始](#快速开始)

## 亮点

- **两种读法**：文章页点标题就地展开全文；卡片墙把图片与资源链接铺成网格，一键复制、识别常见网盘。
- **订阅与规则**：OPML 导入导出、分组排序、单频道抓取频率与全文抓取；关键词 / 正则过滤、关注 / 屏蔽规则。
- **AI 日报与 MCP**：把 24 小时新条目整理成中文简报；外部 AI 客户端经 `/mcp` 直接检索频道、文章全文与日报（[接入文档](docs/MCP.md)）。
- **多用户与角色**：每人独立订阅、已读、收藏、规则与模型配置；支持只读账户，默认不开放注册。
- **顺手的细节**：4 套主题 × 6 档主色，字号 / 密度 / 阅读宽度可调；手机端横滑频道条、整屏弹层配系统返回键、底部导航随滚动收展。
- **零折腾部署**：一条 compose 命令起服务；Watchtower 或「设置 → 关于」一键更新。

## 界面截图

以下截图取自[在线体验站点](https://feedlore.669600.xyz)（演示账号 `demo` / `demo`）。

| 文章页 | 卡片墙 |
| --- | --- |
| ![文章页（浅色）](docs/screenshots/02-reader.png) | ![卡片墙（浅色）](docs/screenshots/03-cards.png) |

| 暗色主题 | 手机端 |
| --- | --- |
| ![文章页（暗色）](docs/screenshots/06-reader-dark.png) | ![手机端文章列表](docs/screenshots/10-mobile-detail.png) |

## 快速开始

Docker 24+ 与 Compose v2，默认端口 `3210`。compose 文件存成默认名 `docker-compose.yml`，
之后的命令就不用再写 `-f`。

### 全新安装

**海外**

```bash
mkdir -p feedlore && cd feedlore
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
V2_IMAGE=ghcr.io/chensnails/feedlore:2.5.3-rc.1 docker compose up -d
```

**国内**（compose 走 gh-proxy，镜像走南京大学镜像站，不用再手动 pull + tag）

```bash
mkdir -p feedlore && cd feedlore
curl -fsSL -o docker-compose.yml 'https://gh-proxy.org/https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml'
V2_IMAGE=ghcr.nju.edu.cn/chensnails/feedlore:2.5.3-rc.1 docker compose up -d
```

打开 `http://<主机>:3210`：用户名 `admin`，初始密码 `Admin2026`。
**首次登录必须先设置新密码**，改完才能使用其他功能 —— 服务端强制，未改密时除改密接口外
一律返回 403。初始密码是公开值，改掉之前站点等于没上锁。

> 这是**预发布版**：只推 `2.5.3-rc.1` 这个镜像标签，`latest` 仍指向 2.5.2，存量站点不会被自动升级。
> 想用 2.5.2 就把命令里的 `2.5.3-rc.1` 换成 `2.5.2`（2.5.2 的初始密码是随机口令，见启动日志）。

### 升级

```bash
cd feedlore
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
V2_IMAGE=ghcr.io/chensnails/feedlore:2.5.3-rc.1 docker compose up -d
```

国内把镜像名换成 `ghcr.nju.edu.cn/chensnails/feedlore:2.5.3-rc.1`、curl 换成 gh-proxy 那一条。
把 `2.5.3-rc.1` 换成目标版本；新的版本号本地没有镜像，`up -d` 会自动拉取，不必先 `pull`。
compose 文件没变化时可以跳过 curl。数据、密码、账号都不变，**老账号不会被要求改密**
（强制改密只挂在全新部署创建的那个 `admin` 上）。

> 想把这个版本固定下来，就把 `V2_IMAGE=...` 写进 `.env`；否则以后再执行不带该变量的
> `docker compose up -d`，会回到 compose 文件里的默认版本。

### 忘记密码

```bash
docker exec -it feedlore initial-password --reset
```

重置为 `Admin2026`，该账号所有旧会话立即作废；用它登录后同样必须先设置新密码。

### 查看状态

```bash
docker compose ps
curl -s http://127.0.0.1:3210/api/health
```

## 配置

改端口、走 HTTPS 反代、指定初始账号：把 [`.env.example`](.env.example) 复制成 `.env` 改对应项，
再 `docker compose up -d`。想跟随最新版就把 `V2_IMAGE` 设为 `ghcr.io/chensnails/feedlore:latest`，
交给 Watchtower 自动重建，也可在「设置 → 关于」一键更新。

从 1.x 迁移：在 1.7.4 用「设置 → 数据 → 导出」备份，装好 2.x 后导入。

## 本地开发

Node ≥ 22.23.4（22.x 安全下限；`package.json` 的 engines 与镜像、CI 用同一数字）：

```bash
pnpm install
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/feedlore_v2
pnpm --filter @feedlore/db migrate
pnpm --filter @feedlore/server dev   # http://127.0.0.1:3000
pnpm --filter @feedlore/web dev      # Vite，5173
```

接口契约在 `packages/contract`，服务端在 `apps/server`，前端在 `apps/web`。检查：

```bash
pnpm -r typecheck
pnpm -r test
```

## 支持项目

赞赏完全自愿，**不解锁任何功能、不影响使用**。如果它帮你省下了订阅费，可以点开二维码请作者喝杯咖啡：

[支付宝赞赏二维码（点击查看）](docs/screenshots/sponsor-alipay.png)

## 许可

[GPL-3.0](LICENSE)。
