# 从 1.x 升级到 2.x

2.x 走**旁路升级**：同一台 Postgres 里的新库（默认 `feedlore_v2`），1.x 的库与数据卷
全程**只读**，数据迁移只往里写新库。升级后原账号密码直接可登录（首次登录自动换成 2.x 的哈希）。

| 你的情况 | 该怎么做 |
| --- | --- |
| 1.x + Watchtower（1.x 默认部署方式） | **什么都不用做**，等它自动升级（见 A） |
| 想手动/分步升级 | 用 `docker-compose.v2.release.yml`（见 B） |
| 全新安装 | 同上，再手动建管理员（见 C） |

---

## A. 自动升级（无感，推荐）

1.x 的应用容器带着 `com.centurylinklabs.watchtower.enable=true` 标签，Watchtower 每 5 分钟
检查一次 `ghcr.io/chensnails/feedlore:latest`。2.x 正式版发布后 `latest` 指向 2.x 镜像，
Watchtower 会：

1. 停掉 1.x 容器、用 2.x 镜像重建（**环境变量、端口、网络原样继承**）；
2. 2.x 进程启动时自动自举：在同一个 Postgres 实例里
   - 给 1.x 库做一份实例内快照 `<库名>_backup`；
   - 建 `<库名>_v2`，把库级时区钉成 UTC；
   - 跑结构迁移 → 迁数据（用户/订阅/文章/日报/偏好/模型 Key）→ 校验条数、凭据、站点主密钥；
   - 成功后写完成标记，之后每次启动只做一次探测就直连新库。
3. 自举完成后端口才开始监听，浏览器里用**原账号密码**登录即可。

**要等多久 / 期间能访问吗**：不能。Watchtower 先停旧容器再起新容器，从开始重建到自举结束
（通常几十秒到几分钟，取决于文章数）站点是打不开的，之后自动恢复。容器日志里看到
`自举完成` 就是好了：

```bash
docker logs -f feedlore        # 看到 "[bootstrap] 自举完成" 即可
docker logs feedlore-watchtower | tail -20
```

**不需要准备任何东西**：不用改 `.env`、不用填 `AUTH_SECRET` / `AUTH_BASE_URL`。

- `AUTH_SECRET` 缺失时自动生成并保存到 `feedlore_v2.settings.authSecret`，之后每次重建都读同一枚；
- `AUTH_BASE_URL` 缺失时按请求的 Host 做同源校验（登录/登出不会被 Origin 拦）。

**图片缓存不迁移**：1.x 的 `image_cache` 不搬（几十万行 BYTEA，搬过去又慢又占空间），
2.x 会在浏览时按需回源重新缓存。要连缓存一起搬，走 B 的手动路径。

**回滚**（1.x 的库从未被写过）：

```bash
# 在 1.x compose 目录里，把 image 从 :latest 改成一个具体的 1.x 版本号，再 up -d
# 例：image: ghcr.io/chensnails/feedlore:1.7.4
docker compose -f docker-compose.release.yml up -d
```

> ⚠️ 不要再用 `:latest` 拉 1.x —— 它已经属于 2.x。Watchtower 的 `WATCHTOWER_CLEANUP=true`
> 会清掉旧镜像，所以回滚前确认要用的 1.x 版本号标签仍能拉取（1.x 正式版都打了版本号标签）。

## 手动升级（B）

面向没有 Watchtower、或想自己控制升级时机的部署。前置：Docker Compose v2（≥ 2.20）、
能拉 `ghcr.io/chensnails/feedlore`、2.x 的库要预留与现有数据卷相近的空间。

### 1. 备份（建议）

```bash
docker exec feedlore-db pg_dump -U "${PG_USER:-feedlore}" -d "${PG_DB:-feedlore}" -Fc \
  > "feedlore-v1-$(date +%Y%m%d-%H%M).dump"
```

保留 1.x 的 `docker-compose.release.yml`：回滚就是用它再 `up -d`。

### 2. 取回 2.x 的 compose

放到 1.x 的 compose 旁边：

```bash
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/v2/docker-compose.v2.release.yml
```

`name: feedlore` 与 1.x 相同，复用同一个 compose 项目、同一个 `feedlore-pgdata` 卷、
同一台 `feedlore-db` 和同一个 `3210` 端口。

### 3. `.env`（大多可不填）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AUTH_SECRET` | 否 | 不填则自动生成并保存到 v2 库；填了就以环境变量为准（之后不要改，改了什么登录态都会失效） |
| `AUTH_BASE_URL` | 否 | 反代改写了 Host、或一个站点多个域名时再填；不填按请求 Host 同源校验 |
| `AUTH_TRUSTED_ORIGINS` | 否 | 需要额外信任的来源，逗号分隔 |
| `AUTH_SECURE_COOKIES` | 否 | 纯 HTTP 保持 `0`；前面是 HTTPS 反代时设 `1` |
| `V2_DB_NAME` | 否 | 新库名，默认 `feedlore_v2` |
| `V2_IMAGE` | 否 | 默认 `ghcr.io/chensnails/feedlore:2.0.1`；想跟 latest 滚动就写 `:latest` |
| `UPGRADE_SKIP_IMAGE_CACHE` | 否 | 设 `1` 跳过图片缓存拷贝（v2 会按需回源） |
| `UPGRADE_SKIP_BACKUP` | 否 | 仅自举路径：设 `1` 跳过 `<库名>_backup` 快照 |

`PG_PASSWORD`、`WATCHTOWER_HTTP_API_TOKEN`、`ALLOW_PRIVATE_HOSTS`、`TRUST_PROXY` 沿用 1.x。

### 4. 执行

```bash
docker compose -f docker-compose.v2.release.yml up -d
docker compose -f docker-compose.v2.release.yml logs -f upgrade
```

1. `db` 健康检查通过（现有 Postgres 容器不会被重建）。
2. `upgrade` 一次性容器：建 `feedlore_v2`（库级时区钉成 UTC）→ 建表 → 迁数据（含图片缓存）
   → 校验 → 写完成标记。
3. `upgrade` 退出码 0 之后，`app` 才替换 1.x 的应用容器。

**这期间 1.x 一直在线**，停机只有最后重建应用容器的几秒。成功日志：
`升级完成：v2 数据已就绪，应用容器可以启动`（全新安装是 `按全新安装处理，跳过数据迁移`）。

### 5. 验证

- 用 1.x 的**原账号密码**登录。
- 订阅数、文章数与 1.x 对得上；打开一篇带图文章确认图片能显示。
- 设置页改一下采集间隔，确认能保存；进入「关于」确认版本号与镜像一致。

## C. 全新安装

同一份 compose 也能新装：`upgrade` 检测不到 1.x 数据会跳过迁移，只建表。2.x 不会自动
建管理员（除非 1.x 环境里带着 `ADMIN_USER`/`ADMIN_PASS` 且站点为空），需要手动播种：

```bash
docker exec -e ADMIN_USER=admin -e 'ADMIN_PASS=<强密码>' feedlore \
  pnpm --filter @feedlore/server seed
```

新装还要补 1.x 没有的 `WATCHTOWER_HTTP_API_TOKEN`（compose 里是必填项，随便一串随机值即可）。

## 升级之后

- **更新**：`latest` 是滚动通道 —— Watchtower 自动升级照旧，「设置 → 关于 → 一键更新」
  也能立即触发。想钉死版本就把 `V2_IMAGE` 写成 `ghcr.io/chensnails/feedlore:<版本号>`。
- **备份对象变了**：以后备份新库
  `docker exec feedlore-db pg_dump -U "${PG_USER:-feedlore}" -d "${V2_DB_NAME:-feedlore_v2}" -Fc > feedlore-v2.dump`。
- **不要改时区**：2.x 全链路按 UTC 存时间（库级时区已设为 UTC），把 `TZ` 改回 `Asia/Shanghai`
  会让新写入的时间整体偏 8 小时（注入的旧环境变量会被启动自举强制纠正，但别依赖它）。
- **重复执行是安全的**：2.x 的迁移是幂等的，再次 `up -d` 只会跑结构迁移，不会重复搬数据。
- **1.x 的库会一直留着**：占空间但保证可回退；确认不要了再手动删（不可逆）：
  ```bash
  docker exec feedlore-db psql -U "${PG_USER:-feedlore}" -d postgres -c 'DROP DATABASE "${PG_DB:-feedlore}";'
  ```

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 自动升级后站点打不开 | 自举还在跑（大库要几分钟），`docker logs -f feedlore` 等 `自举完成`；若反复重启，日志里会有具体失败原因 |
| 登录后马上又回到未登录 / 403 | 反代改写了 Host：补 `AUTH_BASE_URL`；HTTPS 下没设 `AUTH_SECURE_COOKIES=1` 或纯 HTTP 反而设了 `1` |
| `upgrade` 失败退出 | `logs upgrade` 看原因。失败时 `app` 不会启动，1.x 继续服务；修好后重新 `up -d`（幂等） |
| 建库报权限错误 | 数据库用户需要 `CREATEDB` 权限（官方镜像的 `feedlore` 用户有）；外部托管库请先手动建库，或用 `V2_DATABASE_URL` 指定目标库 |
| 快照创建失败（日志有 ⚠️） | 迁移期间有别的连接占着 1.x 库；迁移本身只读、不受影响，但请自行 `pg_dump` 备份 |
| upgrade 卡在图片缓存 | 图片多时正常；可 `UPGRADE_SKIP_IMAGE_CACHE=1` 后重新 `up -d` |
| 找不到 1.x 的库 | 1.x 改过容器名 / 端口 / 库名的，把 2.x compose 里 `db` 段的 `container_name`、`.env` 里的 `PG_*` 和 `HOST_PORT` 同步改掉 |
| 想重来 | 删新库后重新 `up -d`：`docker exec feedlore-db psql -U "${PG_USER:-feedlore}" -d postgres -c 'DROP DATABASE "${V2_DB_NAME:-feedlore_v2}";'`（会丢掉切换后的新数据） |
