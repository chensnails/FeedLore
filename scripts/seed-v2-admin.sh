#!/usr/bin/env bash
#
# FeedLore v2 —— 创建/提升管理员（幂等，可重复执行）
#
# 用法（在 172.26.1.2 上）：
#   ADMIN_PASS='强密码' bash /root/FeedLore-v2/scripts/seed-v2-admin.sh
#
# 做法：走 better-auth 自带的 username 注册端点（密码哈希由库自己算，不手写加密），
#       再把该用户的 role 置为 admin（admin 插件使用 users.role 列）。

set -euo pipefail

PORT="${PORT:-3211}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:?请先设置 ADMIN_PASS 环境变量（建议 16 位以上强密码）}"
DB_CONTAINER="${DB_CONTAINER:-feedlore-v2-v2-db-1}"
DB_USER="${DB_USER:-feedlore_v2}"
DB_NAME="${DB_NAME:-feedlore_v2}"
BASE="http://127.0.0.1:${PORT}"

echo "==> [1/2] 通过 better-auth 注册用户 ${ADMIN_USER}（已存在会报错，属正常）"
curl -s -m 15 -X POST "${BASE}/api/auth/sign-up/username" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\",\"name\":\"${ADMIN_USER}\",\"email\":\"${ADMIN_USER}@example.com\"}" \
  | head -c 300
echo

echo "==> [2/2] 提升为管理员"
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" \
  -c "update users set role = 'admin' where username = '${ADMIN_USER}'"

echo "==> 校验：应以 admin 身份登录成功"
curl -s -m 15 -X POST "${BASE}/api/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}"
echo
