English: [README.en.md](README.en.md)

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

**方式 A：一键脚本（推荐）** —— 启动、等健康、**直接把登录链接和密码回显在终端**：

```bash
mkdir feedlore && cd feedlore
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/scripts/deploy.sh
chmod +x deploy.sh && ./deploy.sh
```

国内网络下载慢或 `ghcr.io` 拉不动时，改用 `deploy-cn.sh`（多源下载 + 镜像反代）：

```bash
curl -fsSL -O https://gh-proxy.org/https://raw.githubusercontent.com/chensnails/FeedLore/main/scripts/deploy-cn.sh
chmod +x deploy-cn.sh && ./deploy-cn.sh
```

**方式 B：手动**

```bash
mkdir feedlore && cd feedlore
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
docker compose -f docker-compose.v2.release.yml up -d
docker compose -f docker-compose.v2.release.yml logs app   # 看首启横幅
```

两种方式都会按场景自动处理，不会覆盖已有数据：

| 场景 | 会发生什么 |
| --- | --- |
| **新用户**（全新安装） | 自动创建 `admin` 并生成随机密码：脚本直接回显；手动方式看 `FEEDLORE FIRST RUN` 横幅 |
| **老用户**（已有数据） | **跳过生成、原密码不变**，日志提示「数据库已有 N 个账号」；想改密码才用 `--reset` |

**忘记密码 / 错过横幅**（容器内执行，不开网络接口）：

```bash
# 24 小时内查回初始密码
docker exec -it feedlore pnpm --filter @feedlore/server initial-password
# 忘记密码：重置并打印新密码（旧会话全部失效）
docker exec -it feedlore pnpm --filter @feedlore/server initial-password --reset
```

> **老用户手动升级**：先换新版 compose 再 `up -d`，否则旧版里的 upgrade 服务会挡住启动：
> `curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml`
> Watchtower / 「设置 → 一键更新」路径不用换。

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
