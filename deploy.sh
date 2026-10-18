#!/usr/bin/env bash
# 笺川（Feedlore）—— 从 GitHub 拉取最新代码并重建容器
# 用法：在项目目录执行  ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "[deploy] 拉取最新代码…"
git pull --ff-only

echo "[deploy] 重建并启动容器…"
docker compose up -d --build

echo "[deploy] 容器状态："
docker compose ps

# 读 HOST_PORT（默认 3210），轮询等容器健康（最多约 60 秒）
port="$(grep -E '^HOST_PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
port="${port:-3210}"
echo "[deploy] 等待健康检查 http://127.0.0.1:${port}/api/health …"
for _ in $(seq 1 30); do
  if body="$(curl -fsS "http://127.0.0.1:${port}/api/health" 2>/dev/null)"; then
    echo "[deploy] 健康检查通过 ✓ ${body}"
    break
  fi
  sleep 2
done

if [ -z "${body:-}" ]; then
  echo "[deploy] 健康检查超时（60s），请查看：docker compose logs -f app" >&2
  exit 1
fi

# v2.2.1 起：健康检查通过 ≠ 一切正常。
# 教训：图片代理缓存状态（imgCache）被误删那次，容器正常启动、健康检查通过、
# 启动日志干净、前后端测试全绿，但每个 /api/img 请求都抛 ReferenceError。
# 所以部署收尾必须扫一遍启动期日志里的运行时错误，命中就让部署"失败"而非静默上线。
echo "[deploy] 扫描启动期错误日志…"
# 只看最近 10 分钟：本脚本刚重建完容器，启动期日志就在这里。
errs="$(docker compose logs --since 10m app 2>&1 \
  | grep -iE 'ReferenceError|TypeError|SyntaxError|MODULE_NOT_FOUND|Cannot find module|unhandled|uncaught|ECONNREFUSED|EADDRINUSE|panic' \
  || true)"
if [ -n "$errs" ]; then
  echo "[deploy] ✗ 启动日志中发现运行时错误（部署应视为失败，请勿放任上线）：" >&2
  echo "$errs" >&2
  exit 2
fi
echo "[deploy] 启动日志无运行时错误 ✓"
echo "[deploy] 完成。线上版本：$(cat VERSION)"
exit 0
