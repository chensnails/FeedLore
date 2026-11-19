# 笺川 · FeedLore

> 拾取值得读的 —— 自托管 RSS 阅读器 + 资源卡片墙。
> 多用户 · 无广告 · 无遥测 · 数据全在你自己的 PostgreSQL。

**在线体验**：https://feedlore.669600.xyz  （`demo` / `demo`）
当前版本 **2.5.5** · [更新日志](CHANGELOG.md) · [快速开始](#快速开始)

## 核心功能

- **两种读法**：文章页点标题就地展开全文；卡片墙把图片与资源链接铺成网格，一键复制、识别常见网盘。
- **订阅与规则**：OPML 导入导出、分组排序、单频道抓取频率与全文抓取；关键词 / 正则过滤、关注 / 屏蔽规则。
- **AI 日报与 MCP**：把 24 小时新条目整理成中文简报；外部 AI 客户端经 `/mcp` 直接检索频道、文章全文与日报（[接入文档](docs/MCP.md)）。
- **多用户与角色**：每人独立订阅、已读、收藏、规则与模型配置；支持只读账户，默认不开放注册。
- **界面**：4 套主题 × 6 档主色，字号 / 密度 / 阅读宽度可调；手机端横滑频道条、整屏弹层配系统返回键、底部导航随滚动收展。

## 快速开始

Docker 24+ 与 Compose v2，默认端口 `3210`。compose 文件存成默认名 `docker-compose.yml`，之后的命令不用再写 `-f`。
**手动升级必须先重下这个文件再启动**（本版移除了旧版 compose 里的 `upgrade` 服务）。

### 全新安装

**海外**

```bash
mkdir -p feedlore && cd feedlore
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
V2_IMAGE=ghcr.io/chensnails/feedlore:2.5.5 docker compose up -d
```

**国内**（compose 走 gh-proxy，镜像走南京大学镜像站，不用再手动 pull + tag）

```bash
mkdir -p feedlore && cd feedlore
curl -fsSL -o docker-compose.yml 'https://gh-proxy.org/https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml'
V2_IMAGE=ghcr.nju.edu.cn/chensnails/feedlore:2.5.5 docker compose up -d
```

打开 `http://<主机>:3210`：用户名 `admin`，初始密码 `Admin2026`。
**首次登录必须先设置新密码**，改完才能使用其他功能 —— 服务端强制，未改密时除改密接口外
一律返回 403。初始密码是公开值，改掉之前站点等于没上锁。

### 升级

```bash
cd feedlore
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
V2_IMAGE=ghcr.io/chensnails/feedlore:2.5.5 docker compose up -d
```

国内把镜像名换成 `ghcr.nju.edu.cn/chensnails/feedlore:2.5.5`、curl 换成 gh-proxy 那一条。
数据、密码、账号都不变，**老账号不会被要求改密**（强制改密只挂在全新部署创建的 `admin` 上）。

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

## 许可证

[GPL-3.0](LICENSE)。
