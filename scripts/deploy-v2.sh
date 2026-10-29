#!/usr/bin/env bash
#
# FeedLore v2 —— 测试栈更新脚本（在 172.26.1.2 上执行）
#
# 作用：拉取 v2 分支最新代码 → 重建本地镜像 → 重启容器 → 跑迁移 → 打印状态与端点自检。
#
# 用法：
#   bash /root/FeedLore-v2/scripts/deploy-v2.sh
#
# 可用环境变量覆盖：
#   REPO_DIR=/root/FeedLore-v2  仓库目录
#   BRANCH=v2                   分支
#   PORT=3211                   对外端口
#
# 安全说明：
# - 镜像是本地构建的 feedlore-v2:test，不推 ghcr，不影响 ghcr.io/.../feedlore:latest，
#   因此 172.26.1.1 生产站的 watchtower 不会被触发。
# - 不打 watchtower enable 标签，本机 watchtower（LABEL_ENABLE=true）不会接管本栈。

set -euo pipefail

REPO_DIR="${REPO_DIR:-/root/FeedLore-v2}"
BRANCH="${BRANCH:-v2}"
PORT="${PORT:-3211}"

cd "$REPO_DIR"

echo "==> [1/5] 拉取 ${BRANCH} 最新代码"
git fetch origin "$BRANCH"
git checkout -q "$BRANCH"
git reset -q --hard "origin/${BRANCH}"
git log --oneline -1

echo "==> [2/5] 重建镜像"
docker compose -f docker-compose.v2.yml build

echo "==> [3/5] 执行数据库迁移（幂等）"
docker compose -f docker-compose.v2.yml run --rm v2-migrate

echo "==> [4/5] 重启服务"
docker compose -f docker-compose.v2.yml up -d

echo "==> [5/5] 自检"
docker ps --filter name=feedlore-v2 --format '{{.Names}} | {{.Status}}'
echo
echo "--- GET /api/health ---"
curl -s -m 10 "http://127.0.0.1:${PORT}/api/health" || echo "(无响应)"
echo
echo "--- GET /api/feeds ---"
curl -s -m 10 "http://127.0.0.1:${PORT}/api/feeds" | head -c 400 || echo "(无响应)"
echo
echo "完成。外部访问：http://<服务器IP>:${PORT}/api/health"
