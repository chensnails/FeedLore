#!/usr/bin/env bash
#
# FeedLore v2 —— 创建/提升管理员（幂等，可重复执行）
#
# 用法（在 172.26.1.2 上）：
#   ADMIN_PASS='强密码' bash /root/FeedLore-v2/scripts/seed-v2-admin.sh
#
# 实现：在 v2-server 容器内执行 `pnpm seed`（apps/server/src/seed.ts），
# 直接调 better-auth 的服务端 API 注册并把 role 置为 admin。
# ⚠️ 不走 HTTP /api/auth/sign-up/username —— better-auth 1.7.x 的 username 插件
#    只提供 sign-in/username，注册路径是 sign-up/email（前者会 404）。

set -euo pipefail

SERVER_CONTAINER="${SERVER_CONTAINER:-feedlore-v2-v2-server-1}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:?请先设置 ADMIN_PASS 环境变量（建议 16 位以上强密码）}"
PORT="${PORT:-3211}"

echo "==> 在容器内播种管理员 ${ADMIN_USER}"
docker exec \
  -e "ADMIN_USER=${ADMIN_USER}" \
  -e "ADMIN_PASS=${ADMIN_PASS}" \
  "$SERVER_CONTAINER" \
  pnpm --filter @feedlore/server seed

echo
echo "==> 校验登录（应返回 role=admin 并下发 Set-Cookie）"
curl -s -m 15 -i -X POST "http://127.0.0.1:${PORT}/api/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}" | head -14
echo
