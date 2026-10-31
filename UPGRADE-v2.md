# 从 1.x 升级到 2.0

面向已经用 `docker-compose.release.yml`（镜像模式）跑着 1.x 的部署。2.0 走**旁路升级**：
新镜像、同一台 Postgres 里的新库，1.x 的库与数据卷全程只读，随时可以切回去。

一句话流程：**备份 → 在 `.env` 补两个变量 → `up -d` → 等 `upgrade` 跑完 → 验证 →（不满意就）切回 1.x。**

---

## 0. 前置条件

| 项目 | 要求 |
| --- | --- |
| Docker Compose | v2（`docker compose version` ≥ 2.20，需要 `service_completed_successfully` 启动顺序） |
| 磁盘 | 2.0 的库是 1.x 的一份拷贝（图片缓存也一起搬），预留与现有 Postgres 数据卷大致相当的空间 |
| 目录 | 1.x 的 `docker-compose.release.yml` 与 `.env` 所在目录，2.0 的 compose 放在同一级 |
| 网络 | 能拉取 `ghcr.io/chensnails/feedlore-v2`（私有仓库时先 `docker login ghcr.io`） |

## 1. 备份（强烈建议）

```bash
docker exec feedlore-db pg_dump -U "${PG_USER:-feedlore}" -d "${PG_DB:-feedlore}" -Fc \
  > "feedlore-v1-$(date +%Y%m%d-%H%M).dump"
```

同时**保留 1.x 的 `docker-compose.release.yml`**：回滚就是再用它 `up -d`。

## 2. 在 `.env` 里补 2.0 的变量

```dotenv
# 必填：会话签名密钥。生成一次后不要再改 —— 改了所有人当前登录态全部失效
AUTH_SECRET=<openssl rand -hex 32 的输出>

# 必填：用户在浏览器里实际访问的地址，带协议和端口
AUTH_BASE_URL=http://192.168.1.10:3210
```

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AUTH_SECRET` | 是 | `openssl rand -hex 32` 生成。迁移过程中的账号创建与之后的会话签名都用它 |
| `AUTH_BASE_URL` | 是 | **必须与地址栏一致**。登录/登出的 Origin 校验按它来，写成 `localhost` 会导致外网访问时登录被拒 |
| `AUTH_TRUSTED_ORIGINS` | 否 | 反代域名和 IP 两种方式都要用时，逗号分隔列出（`https://a.example.com,http://192.168.1.10:3210`） |
| `AUTH_SECURE_COOKIES` | 否 | 纯 HTTP 必须留 `0` 或不填；只有前面是 HTTPS 反代时才设 `1` |
| `V2_DB_NAME` | 否 | 新库名，默认 `feedlore_v2` |
| `V2_IMAGE` | 否 | 镜像，默认 `ghcr.io/chensnails/feedlore-v2:2.0.0-v2` |
| `UPGRADE_SKIP_IMAGE_CACHE` | 否 | 设 `1` 跳过图片缓存拷贝（v2 会按需回源重新缓存），图片多时能明显缩短迁移时间 |

`PG_PASSWORD`、`WATCHTOWER_HTTP_API_TOKEN`、`ALLOW_PRIVATE_HOSTS`、`TRUST_PROXY` 沿用 1.x 的，不用改。

## 3. 取回 2.0 的 compose 文件

放到 1.x 的 `docker-compose.release.yml` 旁边：

```bash
curl -fsSLO https://raw.githubusercontent.com/chensnails/FeedLore/v2/docker-compose.v2.release.yml
```

> 合并到 `main` 之后把 URL 里的 `/v2/` 换成 `/main/`。

这份 compose 的 `name: feedlore` 与 1.x 相同，因此复用同一个 compose 项目、同一个
`feedlore-pgdata` 卷、同一台 `feedlore-db` 和同一个 `3210` 端口 —— 不需要迁移数据卷。

## 4. 执行升级

```bash
docker compose -f docker-compose.v2.release.yml up -d
docker compose -f docker-compose.v2.release.yml logs -f upgrade
```

发生的事：

1. `db` 健康检查通过（现有 Postgres 容器不会被重建）。
2. `upgrade` 一次性容器依次执行：建 `feedlore_v2` 库（并把库级时区钉成 UTC）→ 建表 →
   迁移用户 / 订阅 / 文章 / 日报 / 偏好 / 模型设置 / 图片缓存 → 校验条数 → 写完成标记。
3. `upgrade` 退出码为 0 之后，`app` 才会替换掉 1.x 的应用容器。

**这期间 1.x 一直在线**，真正的停机只有最后重建应用容器的几秒。迁移耗时取决于文章数和
图片缓存体积，几万篇通常几分钟。

成功的样子：`upgrade` 日志最后一行出现 `升级完成：v2 数据已就绪，应用容器可以启动`
（全新安装则是 `按全新安装处理，跳过数据迁移`），`docker compose ps` 里 `app` 是
`running`、`upgrade` 是 `exited (0)`。

## 5. 验证

- 打开 `AUTH_BASE_URL`，用 1.x 的**原账号密码**登录（v1 密码无损迁移，首次登录自动换成 2.0 的哈希）。
- 订阅数、文章数与 1.x 对得上；随便打开一篇带图文章确认图片能显示。
- 设置页改一下采集间隔，确认能保存。

## 6. 回滚

```bash
docker compose -f docker-compose.release.yml up -d
```

1.x 的库与卷从未被写过，回来就是升级前的样子。代价是**切换后在 2.x 里新写入的数据不会回流**
（新订阅、新文章只在新库里）。确认不再需要 1.x 之后，可以再删掉旧库腾空间（不可逆）：

```bash
docker exec feedlore-db psql -U "${PG_USER:-feedlore}" -d postgres -c 'DROP DATABASE "${PG_DB:-feedlore}";'
```

## 7. 升级之后

- **不会被自动升级**：2.x 的应用容器刻意没打 Watchtower 标签，也没接「一键更新」。
  换版本 = 改 `.env` 里的 `V2_IMAGE` 再 `up -d`（`upgrade` 会再执行一次结构迁移，
  数据迁移有完成标记会跳过）。
- **备份对象变了**：以后备份新库
  `docker exec feedlore-db pg_dump -U "${PG_USER:-feedlore}" -d "${V2_DB_NAME:-feedlore_v2}" -Fc > feedlore-v2.dump`。
- **不要改时区**：2.x 全链路按 UTC 存时间（库级时区已设为 UTC），把 `TZ` 改回 `Asia/Shanghai`
  会让新写入的时间整体偏 8 小时。
- **重复执行是安全的**：再次 `up -d` 只会跑结构迁移，不会重复搬数据。

### 全新安装（没有 1.x 数据）

同一份 compose 也能用于新装：`upgrade` 检测不到 1.x 数据会跳过迁移，只建表。2.x 不会
自动建管理员，需要手动播种（用 `feedlore` 应用容器）：

```bash
docker exec -e ADMIN_USER=admin -e 'ADMIN_PASS=<强密码>' feedlore \
  pnpm --filter @feedlore/server seed
```

新装还要补 1.x 没有的 `WATCHTOWER_HTTP_API_TOKEN`（compose 里是必填项，随便一串随机值即可）。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 登录提示成功，紧接着又回到未登录 / 直接 403 | `AUTH_BASE_URL` 与地址栏不一致；或 HTTPS 下没设 `AUTH_SECURE_COOKIES=1`、纯 HTTP 下反而设了 `1` |
| `upgrade` 失败退出 | `docker compose -f docker-compose.v2.release.yml logs upgrade` 看原因。失败时 `app` 不会被启动，1.x 继续服务；修好后重新 `up -d` 即可（幂等） |
| 建库报权限错误 | 数据库用户需要 `CREATEDB` 权限（默认的 `feedlore` 用户有） |
| upgrade 卡在图片缓存 | 图片多时正常；可用 `UPGRADE_SKIP_IMAGE_CACHE=1` 跳过，或在 `.env` 加上后重新 `up -d` |
| 找不到 1.x 的库 | 1.x 改过容器名 / 端口 / 库名的，把 2.0 compose 里 `db` 段的 `container_name`、`.env` 里的 `PG_*` 和 `HOST_PORT` 同步改掉 |
| 发现迁移数据不对，想重来 | 删掉新库后重新 `up -d`：`docker exec feedlore-db psql -U "${PG_USER:-feedlore}" -d postgres -c 'DROP DATABASE "${V2_DB_NAME:-feedlore_v2}";'`（会丢掉切换后的新数据） |
