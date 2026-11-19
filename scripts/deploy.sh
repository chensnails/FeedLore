#!/usr/bin/env bash
# FeedLore 部署辅助：up -d → 等 app healthy → 在终端直接回显登录链接与凭据。
#
#   用法：./deploy.sh [compose 文件] [传给 up 的额外参数]
#   ./deploy.sh                                   # 默认 docker-compose.v2.release.yml
#   ./deploy.sh -f docker-compose.v2.release.yml  # 显式指定
#
# 首次部署（空站点）：回显服务端首启横幅，含登录链接 / 初始用户名 / 一次性密码。
# 升级部署（已有账号）：不生成新密码，回显登录链接并明确提示「密码保持原样」。
#
# 原理：横幅由服务端在监听成功后打印一次，docker logs 会留存；
# 脚本抓日志里的 FEEDLORE FIRST RUN 标记。日志若已被清/轮转，
# 24h 内回退到容器内 CLI 查询。两者都没有 → 判定为升级部署。

set -euo pipefail

COMPOSE_FILE="docker-compose.v2.release.yml"
EXTRA_ARGS=()
if [[ $# -gt 0 && "$1" != -* && ("$1" == *.yml || "$1" == *.yaml) ]]; then
  COMPOSE_FILE="$1"
  shift
fi
EXTRA_ARGS=("$@")

# 缺 compose 就自己下 —— 「一键脚本」不该要求用户先手动准备第二个文件。
# COMPOSE_URL 可覆盖（国内网络换成 gh-proxy 前缀即可）。
if [[ ! -f "$COMPOSE_FILE" ]]; then
  COMPOSE_URL="${COMPOSE_URL:-https://raw.githubusercontent.com/chensnails/FeedLore/main/docker-compose.v2.release.yml}"
  echo "未找到 $COMPOSE_FILE，正在下载…"
  if curl -fsSL --connect-timeout 8 --max-time 60 -o "$COMPOSE_FILE" "$COMPOSE_URL" \
     && grep -q '^services:' "$COMPOSE_FILE"; then
    echo "  已下载 $COMPOSE_FILE"
  else
    rm -f "$COMPOSE_FILE"
    echo "错误：compose 文件下载失败（网络不通或被代理拦截）。" >&2
    echo "  手动下载：curl -fsSLO $COMPOSE_URL" >&2
    echo "  国内网络：curl -fsSLO https://gh-proxy.org/$COMPOSE_URL" >&2
    exit 1
  fi
fi

if docker compose version >/dev/null 2>&1; then
  DC=(docker compose -f "$COMPOSE_FILE")
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose -f "$COMPOSE_FILE")
else
  echo "错误：未找到 docker compose（也没有 docker-compose）" >&2
  exit 1
fi

RULE='========================================================================'
say() { printf '%s\n' "$*"; }
line() { printf '  %s\n' "$*"; }

say "$RULE"
line 'FEEDLORE DEPLOY / 部署'
say "$RULE"
line "compose: $COMPOSE_FILE"
say ''

say '[1/3] 启动容器…'
"${DC[@]}" up -d "${EXTRA_ARGS[@]}"

say '[2/3] 等待应用健康（最多 180 秒）…'
ready=0
for _ in $(seq 1 60); do
  if [[ "$(docker inspect -f '{{.State.Health.Status}}' feedlore 2>/dev/null || echo missing)" == "healthy" ]]; then
    ready=1
    break
  fi
  sleep 3
done
if [[ $ready -ne 1 ]]; then
  echo "错误：app 容器 180 秒内未 healthy，请检查：${DC[*]} logs app" >&2
  exit 1
fi
say '  app healthy ✓'

# 访问地址：PUBLIC_URL 优先；否则读 HOST_PORT 拼 localhost。
pub_url="$(sed -n 's/^PUBLIC_URL=\(.*\)$/\1/p' .env 2>/dev/null | head -1 | tr -d '"'\''')"
host_port="$(sed -n 's/^HOST_PORT=\(.*\)$/\1/p' .env 2>/dev/null | head -1 | tr -d '"'\''')"
# 注意：set -e 下不要用 `[[ ... ]] && var=...`，条件为假时整个脚本会静默退出。
if [[ -z "$host_port" ]]; then host_port=3210; fi
url="${pub_url:-http://localhost:${host_port}}"
if [[ -n "$pub_url" ]]; then
  url_note='（PUBLIC_URL 指定的对外地址）'
else
  url_note='（对外访问请在 .env 设 PUBLIC_URL）'
fi

say '[3/3] 读取凭据…'
say ''
banner="$(docker logs feedlore 2>&1 | grep -A 12 'FEEDLORE FIRST RUN' || true)"

if [[ -n "$banner" ]]; then
  say "$RULE"
  say "$banner"
  say "$RULE"
  say ''
  line "登录链接   $url $url_note"
  line '下一步：登录 → 设置 → 账户 → 立刻改掉初始密码。'
  line '如错过横幅，24h 内可查：docker exec -it feedlore pnpm --filter @feedlore/server initial-password'
else
  # 日志里没有横幅：可能日志已轮转，先试 CLI；查不到即判定升级部署。
  creds="$(docker exec feedlore pnpm --filter @feedlore/server initial-password 2>/dev/null || true)"
  if [[ "$creds" == *"初始密码"* || "$creds" == *"password:"* ]]; then
    say "$RULE"
    line 'FEEDLORE 首次部署凭据 / FIRST RUN（从 CLI 查回）'
    say "$RULE"
    printf '%s\n' "$creds" | sed 's/^/  /'
    say "$RULE"
    line "登录链接   $url $url_note"
    line '下一步：登录 → 设置 → 账户 → 立刻改掉初始密码。'
  else
    say "$RULE"
    line 'FEEDLORE 部署完成 / DEPLOY COMPLETE'
    say "$RULE"
    line '[升级部署] 检测到已有账号：未生成新密码，原密码保持原样。'
    line "登录链接   $url $url_note"
    line '如需重置密码：登录后在「设置 → 账户」修改。'
  fi
fi
say "$RULE"
