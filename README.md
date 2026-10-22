# 笺川 · FeedLora

> 拾取值得读的 —— 一个干净、顺手的**自托管 RSS 阅读器**，附资源卡片墙。多用户、无广告、无遥测，数据都在你自己的服务器上。

## 这是什么

笺川把「订阅 → 阅读 → 沉淀」收在一处：左边订阅源、右边文章，点开就地读全文；值得回头看的资源进卡片墙。所有数据存在你自己的 PostgreSQL 里，不经过任何第三方。

## 功能一览

- **专注阅读**：左频道（按分组）右文章，点标题就地展开全文；已读 / 未读 / 收藏齐全，顶部搜索，可开自动刷新。
- **图文原样呈现**：图片按原文顺序内联，统一经服务端代理加载，源站防盗链也不裂图。
- **订阅管理**：OPML 导入 / 导出（含分组、自动去重），频道重命名、分组重命名与拖拽排序，单频道可设抓取频率。
- **卡片墙**：网格 / 列表展示资源卡片，可按频道、体积筛选与搜索。
- **条目过滤**：按关键词 / 正则设置「只收」或「屏蔽」，新抓取的条目入库前自动过滤，每个账号独立配置。
- **外观可定制**：4 套主题、6 套主色，字号 / 字体 / 行高 / 阅读宽度可调，即时生效。
- **多用户与角色**：每人独立订阅源 / 已读 / 收藏；**模型配置按账户绑定**（自己的 Key 优先，未配回退站点默认）。
- **移动端友好 + PWA**：可「添加到主屏幕」离线使用。
- **可选的 AI 日报**：需要者在「设置 → 模型」填入自己的大模型 Key 后，即可按账号把过去 24 小时的新条目整理成中文简报；不配 Key 不影响任何其它功能。

## 界面截图

| 文章阅读页（浅色） | 文章阅读页（暗色） |
| --- | --- |
| ![文章阅读页](docs/screenshots/02-reader.png) | ![文章阅读页 · 暗色](docs/screenshots/06-reader-dark.png) |

| 卡片墙（浅色） | 卡片墙（暗色） |
| --- | --- |
| ![卡片墙](docs/screenshots/03-cards.png) | ![卡片墙 · 暗色](docs/screenshots/07-cards-dark.png) |

| 数据源管理（分组 / 采集参数） |
| --- |
| ![数据源管理](docs/screenshots/05-settings.png) |

## 快速开始

需要 **Docker（含 Compose）**。

```bash
git clone https://github.com/chensnails/feedlore.git
cd feedlore
cp .env.example .env      # 至少把 PG_PASSWORD 改成强密码
docker compose up -d --build
```

打开 `http://<主机>:3210`，默认账号 **admin / admin**，登录后请到「设置 → 账号」改密码。

**上手两步**：①「设置 → 数据源」粘贴 RSS / Atom 添加频道，或导入 OPML；② 回「文章」页开始读。

## 多用户与角色

| 角色 | 权限 |
| --- | --- |
| **管理员** | 全部功能 + 用户管理、站点级设置（采集参数 / 状态 / 模型站点默认） |
| **普通用户** | 自己的订阅源、外观与个人模型配置 |

- 账号只由管理员创建，无开放注册。
- 不同用户订阅同一 URL 互不影响；频道 / 文章 / 已读 / 收藏均按账号隔离。

## 部署与更新

两种部署模式，容器名 / 数据库卷 / 网络完全一致，可随时互切、数据零迁移：

**源码模式**（适合二次开发）：

```bash
git clone https://github.com/chensnails/feedlore.git
cd feedlore
cp .env.example .env

# ⚠️ 生成强随机数据库密码（切勿使用弱密码）
sed -i "s|^PG_PASSWORD=.*|PG_PASSWORD=$(openssl rand -base64 32)|" .env

# 确认密码已更换，并保存好凭据
grep PG_PASSWORD .env

# 构建并启动
docker compose up -d --build
```

**镜像模式**（日常使用，推荐）：拉取 ghcr.io 预构建镜像，Watchtower 自动更新——

```bash
# 1. 克隆仓库（仅为了获取 .env.example 和 docker-compose.release.yml）
git clone https://github.com/chensnails/feedlore.git
cd feedlore

# 2. 创建环境配置文件
cp .env.example .env

# 3. ⚠️ 生成强随机数据库密码（切勿使用弱密码）
sed -i "s|^PG_PASSWORD=.*|PG_PASSWORD=$(openssl rand -base64 32)|" .env
sed -i "s|^WATCHTOWER_HTTP_API_TOKEN=.*|WATCHTOWER_HTTP_API_TOKEN=$(openssl rand -hex 32)|" .env

# 5. 确认关键配置已正确写入
grep -E '^(PG_PASSWORD|WATCHTOWER_HTTP_API_TOKEN)=' .env

# 6. 使用 release 专用 compose 文件启动（预构建镜像 + Watchtower）
docker compose -f docker-compose.release.yml up -d
```

之后发版 = 推送 git tag，Watchtower 每 5 分钟自动拉取新镜像重启；也可以到「设置 → 关于 → 检查更新」发现新版本后点「一键更新」立即触发（约 1~2 分钟，期间页面短暂不可用，登录态不受影响）。

## 在手机上用（PWA）

HTTPS 下用浏览器「添加到主屏幕」即可当 App；建议用反向代理挂域名与证书。

## 常见问题

- **图片裂图？** 图统一经服务端 `/api/img` 代理；大量裂图多半源站失效，可到「设置 → 状态」查看。
- **别人能看到我的订阅吗？** 不能，全部按账号隔离。
- **数据备份？** 备份 PostgreSQL 数据卷（`db` 服务）。
- **怎么知道有没有新版本？** 「设置 → 关于 → 检查更新」（向 GitHub 查最新 Release，结果缓存 10 分钟）。
- **端口占用？** 改 `.env` 的 `HOST_PORT` 后 `docker compose up -d`。

## 配置（`.env`）

除端口与数据库外，其余项**首次启动后一律以页面「设置」为准**，再改 `.env` 不生效。关键变量见 `.env.example`；`.env` 不入库。

## 技术栈

Node 22 + PostgreSQL + Vite / React 前端，单容器部署。许可证：[MIT](LICENSE)。
