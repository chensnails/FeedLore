# 笺川 · FeedLore

> 拾取值得读的 —— 自托管 RSS 阅读器 + 资源卡片墙。
> 多用户 · 无广告 · 无遥测 · 数据全在你自己的 PostgreSQL。

**在线体验**：https://feedlore.669600.xyz  （`demo` / `demo`）
当前版本 **2.5.2**（2.5.3 待发布） · [更新日志](CHANGELOG.md) · [升级与部署](UPGRADE-v2.md)

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

需要 Docker 24+ 与 Compose v2，一个空闲端口（默认 `3210`）。不用克隆源码，也不用准备 `.env`。

### 先分清你在哪种情况

| 情况 | 判断依据 | 结果 |
| --- | --- | --- |
| **全新安装** | 这台机器没跑过 FeedLore，或已清空数据 | 自动建 `admin` + 生成随机密码，**日志里直接打印** |
| **已有数据** | 数据卷 `feedlore-pgdata` 还在 | **保留原账号与密码**；跳过生成，日志不打印密码 |

> ⚠️ `docker rm -f feedlore` 只删容器，**数据卷还在**——重新部署仍属"已有数据"，
> 不会生成新密码。想真正重来（连订阅和账号一起清空）：
>
> ```bash
> docker compose -f docker-compose.v2.release.yml down -v     # -v 删数据卷，不可逆
> ```

### 全新安装

**国内网络**（代理站已写死，整段复制）：

```bash
mkdir -p feedlore && cd feedlore
docker compose -f docker-compose.v2.release.yml down -v 2>/dev/null   # 清旧容器与数据；首次安装报错可忽略
curl -fsSL -o docker-compose.v2.release.yml   'https://gh-proxy.org/https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml'
docker pull ghcr.nju.edu.cn/chensnails/feedlore:2.5.2
docker tag  ghcr.nju.edu.cn/chensnails/feedlore:2.5.2 ghcr.io/chensnails/feedlore:2.5.2
docker compose -f docker-compose.v2.release.yml up -d
docker compose -f docker-compose.v2.release.yml logs -f app
```

**海外 / 能直连 GitHub**：把中间四行换成

```bash
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
docker pull ghcr.io/chensnails/feedlore:2.5.2
```

最后一条会实时跟日志，几秒后出现：

```
[bootstrap] ⚠️ Empty site: created initial admin admin, one-time password: TJ69Z2Pb8oDbM1Jr
```

看到密码按 `Ctrl+C`（只停日志跟随，容器继续运行），用 `admin` + 该密码登录。

> `docker tag` 不能省：compose 里写的是官方名 `ghcr.io/...`，反代拉下来必须改回官方名，
> Watchtower 与后续升级才认得出。反代失效时把 `ghcr.nju.edu.cn` 换成
> `ghcr.1ms.run` / `ghcr.m.daocloud.io`，或能直连时直接用 `ghcr.io`。

### 已有数据升级

**先换 compose**——旧版含 `upgrade` 服务，新镜像里那条命令已删除，会挡住 app 启动。
再拉新镜像、重启：

```bash
cd feedlore
curl -fsSL -o docker-compose.v2.release.yml   'https://gh-proxy.org/https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml'
docker pull ghcr.nju.edu.cn/chensnails/feedlore:2.5.3
docker tag  ghcr.nju.edu.cn/chensnails/feedlore:2.5.3 ghcr.io/chensnails/feedlore:2.5.3
V2_IMAGE=ghcr.io/chensnails/feedlore:2.5.3 docker compose -f docker-compose.v2.release.yml up -d
docker compose -f docker-compose.v2.release.yml logs --tail 40 app
```

把 `2.5.3` 换成目标版本。`.env` 里若已写死 `V2_IMAGE`，改那一行并去掉命令里的前缀（两处一致）。

**这一步不会打印密码**：库里已有账号，直接沿用原密码。忘了就重置：

```bash
docker exec -it feedlore pnpm --filter @feedlore/server initial-password --reset   # 需 2.5.3+ 镜像
```

2.5.2 及更早没有这个命令，用帮助文档「重置管理员密码」里的一次性脚本。

### 起不来怎么查

```bash
docker compose -f docker-compose.v2.release.yml ps            # healthy / restarting / exited
docker compose -f docker-compose.v2.release.yml logs --tail 60 app
```

首次启动要跑结构迁移，低配机器 1~2 分钟才 healthy 属正常。

访问 `http://<主机>:3210` 登录并立即改密，然后在「设置 → 数据源」添加 RSS / Atom 或导入 OPML 即可阅读。

## 配置与升级

默认值开箱可用。改端口、走 HTTPS 反代、复用数据库密码或指定初始账号时，把 [`.env.example`](.env.example)
复制为 `.env`（每项含义都在注释里），改完重新 `up -d`。

- **从 1.x 升级**：v1→v2 自动数据迁移已下线（1.x 库已删）；老站点请用 1.7.4 的「设置 → 数据 → 导出」+ 本版导入。详见 [UPGRADE-v2.md](UPGRADE-v2.md)。
- **更新**：镜像默认钉版本号，换版本改 `V2_IMAGE`；设为 `:latest` 跟随 Watchtower 滚动升级，也可在「设置 → 关于」一键更新。

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
