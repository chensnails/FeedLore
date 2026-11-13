English: [README.en.md](README.en.md)

# 笺川 · FeedLore

> 拾取值得读的 —— 自托管 RSS 阅读器 + 资源卡片墙。
> 多用户 · 无广告 · 无遥测 · 数据全在你自己的 PostgreSQL。

**在线体验**：https://feedlore.669600.xyz  （`demo` / `demo`）
当前版本 **2.4.5** · [更新日志](CHANGELOG.md) · [升级与部署](UPGRADE-v2.md)

## 亮点

- **两种读法**：文章页点标题就地展开全文；卡片墙把图片与资源链接铺成网格，一键复制、识别常见网盘。
- **订阅与规则**：OPML 导入导出、分组排序、单频道抓取频率与全文抓取；关键词 / 正则过滤、关注 / 屏蔽规则。
- **AI 日报与 MCP**：把 24 小时新条目整理成中文简报；外部 AI 客户端经 `/mcp` 直接检索频道、文章全文与日报（[接入文档](docs/MCP.md)）。
- **多用户与角色**：每人独立订阅、已读、收藏、规则与模型配置；支持只读账户，默认不开放注册。
- **顺手的细节**：4 套主题 × 6 档主色，字号 / 密度 / 阅读宽度可调；手机端横滑频道条、手势关闭弹层、底部导航随滚动收展。
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

Docker 24+ 与 Compose v2，一个空闲端口（默认 `3210`）。无需克隆源码或准备 `.env`：

```bash
mkdir feedlore && cd feedlore
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
docker compose -f docker-compose.v2.release.yml up -d
```

首次启动建库需几分钟，进度看 `docker compose -f docker-compose.v2.release.yml logs upgrade`。
全新站点创建管理员 `admin`，一次性随机密码只在启动日志打印一次：

```bash
docker compose -f docker-compose.v2.release.yml logs app | grep 'one-time password'
```

访问 `http://<主机>:3210` 登录并立即改密，然后在「设置 → 数据源」添加 RSS / Atom 或导入 OPML 即可阅读。

## 配置与升级

默认值开箱可用。改端口、走 HTTPS 反代、复用数据库密码或指定初始账号时，把 [`.env.example`](.env.example)
复制为 `.env`（每项含义都在注释里），改完重新 `up -d`。

- **从 1.x 升级**：开着 Watchtower 的站点自动迁移并保留账号密码；手动步骤、回滚与备份见 [UPGRADE-v2.md](UPGRADE-v2.md)。
- **更新**：镜像默认钉版本号，换版本改 `V2_IMAGE`；设为 `:latest` 跟随 Watchtower 滚动升级，也可在「设置 → 关于」一键更新。

## 本地开发

Node ≥ 22：

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
