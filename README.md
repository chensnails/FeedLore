# 笺川 · FeedLore

> 拾取值得读的 —— 一个干净、顺手的**自托管 RSS 阅读器**，附资源卡片墙。
> 多用户、无广告、无遥测，所有数据都在你自己的 PostgreSQL 里。

**在线体验**：https://feedlore.669600.xyz · 演示账户 `demo` / `demo`

当前版本 **2.1.0** · [更新日志](CHANGELOG.md) · [升级与部署](UPGRADE-v2.md)

## 这是什么

笺川是一款自托管、以个人自用为主的 RSS 阅读器。它提供文章列表与卡片墙两种阅读形态，
帮助快速发现信息、直接跳转原文，并提取文章里的资源链接，尤其适合网盘资源类文章。

## 功能

- **阅读**：左频道（按分组）右文章，点标题就地展开全文；已读 / 未读 / 收藏、服务端搜索、
  自动刷新一应俱全。
- **卡片墙**：网格 / 列表两种排布，按频道、分组筛选与搜索，与文章页互相跳转并高亮落点；
  卡片会提取文章内的资源链接，可一键复制，并识别常见网盘。
- **订阅管理**：OPML 导入导出（含分组、自动去重）、频道重命名与改址、分组拖拽排序、
  单频道抓取频率；可对只给摘要的频道开启全文抓取，连续失败的频道会自动停用。
- **规则**：关注 / 屏蔽关键词给条目打标，关注条目集中在智能分组中，可设保留天数自动退出；
  入库前可按关键词或正则「丢弃 / 只收」。两类规则都能限定到指定分组或频道。
- **多用户与角色**：每人独立订阅源、已读、收藏、规则与模型配置；账号由管理员创建，
  支持只读账户。默认不开放注册。
- **外观与移动端**：4 套主题、6 套主色，字号 / 字体 / 行高 / 阅读宽度 / 卡片密度可调；
  手机端支持整屏弹层、下拉关闭与侧缘手势，HTTPS 下可添加到主屏幕。
- **AI 日报**：按账号配置模型，把过去 24 小时的新条目整理成中文简报；不配置不影响其它功能。
- **一键更新**：设置页检查版本，配合 Watchtower 直接更新。

## 界面截图

| 文章阅读页（浅色） | 文章阅读页（暗色） |
| --- | --- |
| ![文章阅读页](docs/screenshots/02-reader.png) | ![文章阅读页 · 暗色](docs/screenshots/06-reader-dark.png) |

| 卡片墙 | 手机端 |
| --- | --- |
| ![卡片墙](docs/screenshots/03-cards.png) | ![手机端整屏详情](docs/screenshots/10-mobile-detail.png) |

## 快速开始

要求 Docker 24+ 与 Compose v2，一个空闲端口（默认 `3210`）。不需要克隆源码，也不需要
预先准备 `.env`。

```bash
mkdir feedlore && cd feedlore
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml
docker compose -f docker-compose.v2.release.yml up -d
```

首次启动会拉取镜像并建库、初始化数据库，可能需要几分钟；想看进度或排查失败可执行
`docker compose -f docker-compose.v2.release.yml logs upgrade`。

全新站点会创建管理员 `admin`，并生成一次性随机密码，只在启动日志里打印一次：

```bash
docker compose -f docker-compose.v2.release.yml logs app | grep 'one-time password'
```

拿到密码后访问 `http://<主机>:3210` 登录，并立即在「设置 → 账号」修改。随后在
「设置 → 数据源」添加 RSS / Atom 或导入 OPML，即可开始阅读。

## 配置与升级

默认值开箱可用。需要改端口、走 HTTPS 反代、复用数据库密码或指定初始账号时，把
[`.env.example`](.env.example) 复制为 `.env`，每个变量的含义与默认值都写在文件注释里，
改完重新 `up -d` 即可。

- **从 1.x 升级**：开着 Watchtower 的站点无需操作，会自动迁移并保留原账号密码；
  手动步骤、回滚与备份见 [UPGRADE-v2.md](UPGRADE-v2.md)。
- **更新**：镜像默认钉版本号，换版本改 `V2_IMAGE`；设为 `:latest` 则跟随 Watchtower
  滚动升级，也可在「设置 → 关于」一键更新。

## 本地开发

需要 Node ≥ 22。

```bash
pnpm install
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/feedlore_v2
pnpm --filter @feedlore/db migrate
pnpm --filter @feedlore/server dev   # http://127.0.0.1:3000
pnpm --filter @feedlore/web dev      # Vite，5173
```

接口定义与校验集中在 `packages/contract`，采集、规则、日报与图片缓存位于 `apps/server`，
前端位于 `apps/web`。测试与类型检查：

```bash
pnpm -r typecheck
pnpm -r test
```

## 许可

[GPL-3.0](LICENSE)。
