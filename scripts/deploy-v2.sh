#!/usr/bin/env bash
#
# FeedLore v2 —— 测试栈更新脚本（在 172.26.1.2 上执行）
#
# 作用：拉取 v2 分支最新代码 → 重建本地镜像 → 重启容器 → 跑迁移 → 等待健康 → 端点自检。
#
# 用法：
#   bash /root/FeedLore-v2/scripts/deploy-v2.sh
#
# 可用环境变量覆盖：
#   REPO_DIR=/root/FeedLore-v2  仓库目录
#   BRANCH=v2                   分支
#   PORT=3211                   对外端口
#
# ⚠️ 自修改陷阱：本脚本位于仓库内，而步骤 1 的 git reset --hard 会把它自己覆盖掉，
#    bash 继续按原字节偏移读取新文件会执行到错位内容。故先自拷贝到 /tmp 再 exec（stage2）。
#
# 安全说明：
# - 镜像是本地构建的 feedlore-v2:test，不推 ghcr，不影响 ghcr.io/.../feedlore:latest，
#   因此 172.26.1.1 生产站的 watchtower 不会被触发。
# - 不打 watchtower enable 标签，本机 watchtower（LABEL_ENABLE=true）不会接管本栈。

set -euo pipefail

# ---- stage2：自拷贝到 /tmp 后重新执行，避免脚本被 git reset 覆盖 ----
if [ -z "${DEPLOY_V2_STAGE2:-}" ]; then
  export DEPLOY_V2_STAGE2=1
  tmp="$(mktemp /tmp/deploy-v2.XXXXXX.sh)"
  cp "$0" "$tmp"
  exec bash "$tmp" "$@"
fi

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

echo "==> [5/5] 等待健康检查（start_period=25s，需先等一轮）"
healthy=0
for _ in $(seq 1 40); do
  if curl -sf -m 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done

docker ps --filter name=feedlore-v2 --format '{{.Names}} | {{.Status}}'
echo

if [ "$healthy" != "1" ]; then
  echo "⚠️ 服务在 ~80s 内未通过健康检查，请查看：docker logs feedlore-v2-v2-server-1"
  exit 1
fi

echo "--- GET /api/health ---"
curl -s -m 10 "http://127.0.0.1:${PORT}/api/health"; echo
echo "--- GET /api/feeds ---"
curl -s -m 10 "http://127.0.0.1:${PORT}/api/feeds" | head -c 400; echo
echo
echo "完成。外部访问：http://<服务器IP>:${PORT}/api/health"
