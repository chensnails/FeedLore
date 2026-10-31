#!/usr/bin/env bash
# ============================================================================
# FeedLore v1 → v2 一键旁路升级
#
# 目标：把正在运行的 v1（ghcr.io/chensnails/feedlore:latest，容器名默认 feedlore）
# 原地升级为 v2（独立数据库 + 数据迁移 + 端口接管），全程保留 v1 容器与数据库，
# 任何一步失败都能一键回滚。
#
# 用法（在部署 v1 的机器上，需要 docker 权限）：
#   bash upgrade-v1-to-v2.sh                 # 交互确认后执行
#   bash upgrade-v1-to-v2.sh --dry-run       # 只体检 + 迁移干跑，不写任何数据
#   bash upgrade-v1-to-v2.sh --yes           # 非交互（CI / 远程执行）
#
# 常用环境变量（也可用同名 --kebab-case 参数覆盖）：
#   V1_CONTAINER=feedlore              v1 应用容器
#   V1_DB_CONTAINER=feedlore-db        v1 数据库容器（留空自动探测）
#   V2_IMAGE=feedlore-v2:test          v2 应用镜像（不存在时加 --pull 或先导入）
#   V2_DB_IMAGE=postgres:18.4-alpine   v2 数据库镜像
#   TARGET_PORT=3210                   最终对外端口（留空用 v1 当前映射）
#   STAGE_PORT=                        验证用临时端口（留空自动挑空闲）
#   ACCESS_URL=http://<IP>:<端口>      用户实际访问地址（决定 Cookie 域/安全标记）
#   V2_TRUSTED_ORIGINS=                额外受信任来源（逗号分隔）
#   WORKDIR=/root/feedlore-v2-upgrade  配置/日志/临时文件目录（内含密钥，600）
#   BACKUP_DIR=/root/backups           v1 备份目录
#   PROBE_USER / PROBE_PASS            可选：用 v1 账号密码做端到端登录验证
#
# 参数：
#   --dry-run              只体检与迁移干跑（不建库、不备份、不切换）
#   --yes                  跳过交互确认
#   --skip-backup          跳过 v1 备份（不建议）
#   --no-image-cache       不搬图片缓存（默认搬）
#   --pull                 镜像缺失时尝试 docker pull
#   --v1-container=NAME    同 V1_CONTAINER
#   --v1-db-container=NAME 同 V1_DB_CONTAINER
#   --v2-image=IMAGE       同 V2_IMAGE
#   --v2-container=NAME    v2 应用容器名（默认 feedlore-v2）
#   --v2-db-container=NAME v2 数据库容器名（默认 feedlore-v2-db）
#   --v2-db-name=NAME      v2 库名（默认 feedlore_v2）
#   --v2-db-user=NAME      v2 库用户（默认 feedlore_v2）
#   --v2-network=NAME      专用网络（默认 feedlore-v2-net）
#   --v2-volume=NAME       专用数据卷（默认 feedlore-v2-pgdata）
#   --v2-db-image=IMAGE    同 V2_DB_IMAGE
#   --target-port=N        同 TARGET_PORT
#   --stage-port=N         同 STAGE_PORT
#   --access-url=URL       同 ACCESS_URL
#   --trusted-origins=LIST 同 V2_TRUSTED_ORIGINS
#   --workdir=PATH         同 WORKDIR
#   --backup-dir=PATH      同 BACKUP_DIR
#   --help                 显示帮助
#
# 覆盖的场景 / 已处理的坑：
#   1. v1 容器/数据库不叫默认名 —— 自动按网络 + postgres 镜像探测，探测不到再要求显式指定。
#   2. v1 密码哈希格式异常 —— 迁移脚本会退回一次性随机密码；本脚本把这条提醒放大。
#   3. 站点主密钥（cryptoSecret）漏搬 —— 迁移后比对 md5，不一致直接中止。
#   4. 时间戳时区 —— v1 是 timestamptz，v2 是 timestamp；迁移容器 / v2 服务端 / v2 数据库
#      必须统一 TZ=UTC，否则历史时间整体偏移。image_cache 直接 COPY 时用 PGTZ=UTC。
#   5. 图片缓存不在迁移脚本范围内 —— 默认手工搬（UTC 对齐），失败不影响主流程。
#   6. 迁移期间 v1 继续采集 —— 切换前停 v1 后再补跑一次增量迁移，零丢失。
#   7. 切换后验证失败 —— 自动回滚：删 v2 容器、拉起 v1，v1 数据卷原样保留。
#   8. 重复执行 —— 库/容器/配置全部复用；条目按 (feed,guid) 幂等，可安全重跑。
#   9. watchtower / compose —— 只告警不改文件：v1 停掉后不会被拉起，但重新
#      `docker compose up` 会复活 v1 并抢占端口。
#  10. 端口冲突 —— 切换前确认目标端口属于 v1 或空闲；验证用临时端口自动避让。
#  11. 磁盘空间 —— 按 v1 库大小预估并检查备份/工作目录剩余空间。
#  12. 密钥文件丢失 —— 已有 v2 库时无法用新口令连接；给出明确处理路径。
#  13. 并发执行 —— flock 单实例锁。
#  14. dry-run —— 不写库、不备份、不切换，可安全在生产机上跑。
# ============================================================================

set -Eeuo pipefail
export TZ=UTC
umask 077

# ------------------------------- 默认值 ------------------------------------

V1_CONTAINER="${V1_CONTAINER:-feedlore}"
V1_DB_CONTAINER="${V1_DB_CONTAINER:-}"
V2_IMAGE="${V2_IMAGE:-ghcr.io/chensnails/feedlore-v2:latest}"
V2_CONTAINER="${V2_CONTAINER:-feedlore-v2}"
V2_DB_CONTAINER="${V2_DB_CONTAINER:-feedlore-v2-db}"
V2_DB_NAME="${V2_DB_NAME:-feedlore_v2}"
V2_DB_USER="${V2_DB_USER:-feedlore_v2}"
V2_DB_IMAGE="${V2_DB_IMAGE:-postgres:18.4-alpine}"
V2_NETWORK="${V2_NETWORK:-feedlore-v2-net}"
V2_VOLUME="${V2_VOLUME:-feedlore-v2-pgdata}"
TARGET_PORT="${TARGET_PORT:-}"
STAGE_PORT="${STAGE_PORT:-}"
ACCESS_URL="${ACCESS_URL:-}"
V2_TRUSTED_ORIGINS="${V2_TRUSTED_ORIGINS:-}"
WORKDIR="${WORKDIR:-/root/feedlore-v2-upgrade}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups}"
PROBE_USER="${PROBE_USER:-}"
PROBE_PASS="${PROBE_PASS:-}"
AUTH_SECURE_COOKIES_OVERRIDE="${AUTH_SECURE_COOKIES:-}"
V2_TRUST_PROXY="${V2_TRUST_PROXY:-}"
V2_ALLOW_PRIVATE_HOSTS="${V2_ALLOW_PRIVATE_HOSTS:-}"
V2_DATABASE_URL="${V2_DATABASE_URL:-}"

DRY_RUN=0
ASSUME_YES=0
DO_BACKUP=1
COPY_IMAGE_CACHE=1
DO_PULL=0

# 运行期状态（供 EXIT trap 回滚）
V1_STOPPED=0
V2_STARTED=0
CUTOVER_VERIFIED=0
ATTACHED_V1=0
STAGE_NAME=""
MIGRATE_ENV=""
LOG_FILE=""
BACKUP_FILE=""
V1_DB=""
V1_USER=""
V1_PW=""
TARGET_PORT_OWNER=""

# ------------------------------- 输出工具 ----------------------------------

log()  { printf '%s [upgrade] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf '%s [warn]    %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
step() { printf '\n%s ==== %s ====\n' "$(date -u +%H:%M:%S)" "$*"; }
die()  { printf '%s [error]   %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; exit 1; }

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

# ------------------------------- 参数解析 ----------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)          DRY_RUN=1 ;;
    --yes|-y)           ASSUME_YES=1 ;;
    --skip-backup)      DO_BACKUP=0 ;;
    --no-image-cache)   COPY_IMAGE_CACHE=0 ;;
    --pull)             DO_PULL=1 ;;
    -h|--help)          usage; exit 0 ;;
    --*=*)
      key=${1%%=*}; val=${1#*=}
      case "$key" in
        --v1-container)       V1_CONTAINER=$val ;;
        --v1-db-container)    V1_DB_CONTAINER=$val ;;
        --v2-image)           V2_IMAGE=$val ;;
        --v2-container)       V2_CONTAINER=$val ;;
        --v2-db-container)    V2_DB_CONTAINER=$val ;;
        --v2-db-name)         V2_DB_NAME=$val ;;
        --v2-db-user)         V2_DB_USER=$val ;;
        --v2-db-image)        V2_DB_IMAGE=$val ;;
        --v2-network)         V2_NETWORK=$val ;;
        --v2-volume)          V2_VOLUME=$val ;;
        --target-port)        TARGET_PORT=$val ;;
        --stage-port)         STAGE_PORT=$val ;;
        --access-url)         ACCESS_URL=$val ;;
        --trusted-origins)    V2_TRUSTED_ORIGINS=$val ;;
        --workdir)            WORKDIR=$val ;;
        --backup-dir)         BACKUP_DIR=$val ;;
        *) die "未知参数：$key（--help 查看用法）" ;;
      esac
      ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
  shift
done

case "$TARGET_PORT" in ''|*[!0-9]*) [ -z "$TARGET_PORT" ] || die "--target-port 必须是数字" ;; esac
case "$STAGE_PORT"  in ''|*[!0-9]*) [ -z "$STAGE_PORT" ]  || die "--stage-port 必须是数字" ;; esac
if [ "$TARGET_PORT" -ge 65536 ] 2>/dev/null; then die "--target-port 超出范围"; fi
if [ "$STAGE_PORT" -ge 65536 ] 2>/dev/null;  then die "--stage-port 超出范围"; fi
if [ -n "$PROBE_USER" ] && [ -z "$PROBE_PASS" ]; then die "设置了 PROBE_USER 但没有 PROBE_PASS"; fi

# 是否由调用方显式给了目标库（干跑时用来决定能否做迁移预演）
V2_URL_EXPLICIT=0
[ -n "$V2_DATABASE_URL" ] && V2_URL_EXPLICIT=1

# ------------------------------- 基础工具 ----------------------------------

rand_hex() {
  local n=$1
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$n"
  else
    od -An -tx1 -N "$n" /dev/urandom | tr -d ' \n'
  fi
}

# 只对 URL 里的 user/password/db 做百分号编码（纯 bash，兼容没有 jq 的机器）
urlencode() {
  local s=$1 out='' i c
  LC_ALL=C
  for ((i=0; i<${#s}; i++)); do
    c=${s:i:1}
    case "$c" in
      [a-zA-Z0-9.~_-]) out+=$c ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s' "$out"
}

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

origin_of() {
  printf '%s' "$1" | sed -E 's|^([a-zA-Z][a-zA-Z0-9+.-]*://[^/]+).*|\1|'
}

container_exists() { docker inspect "$1" >/dev/null 2>&1; }
container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }

container_env() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null \
    | awk -v k="$2" 'index($0, k"=") == 1 { sub("^" k"=", ""); print; exit }' || true
}

container_networks() {
  docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$1" 2>/dev/null || true
}

container_on_network() {
  local nets
  nets=$(container_networks "$1")
  case " $nets " in *" $2 "*) return 0 ;; *) return 1 ;; esac
}

v1_published_port() {
  local p
  p=$(docker port "$V1_CONTAINER" 3000/tcp 2>/dev/null | head -n1 | awk -F: '{print $NF}' || true)
  # 容器已停止时 docker port 可能返回空，回退到 inspect 里的端口映射配置
  [ -n "$p" ] || p=$(docker inspect -f '{{with index .HostConfig.PortBindings "3000/tcp"}}{{with index . 0}}{{.HostPort}}{{end}}{{end}}' "$V1_CONTAINER" 2>/dev/null || true)
  printf '%s' "$p"
}

host_ip() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i == "src") { print $(i+1); exit }}' || true)
  [ -n "$ip" ] || ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  [ -n "$ip" ] || ip=127.0.0.1
  printf '%s' "$ip"
}

free_kb() { df -Pk "$1" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0; }

port_free() {
  local p=$1
  if command -v ss >/dev/null 2>&1; then
    ! ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"
  elif command -v netstat >/dev/null 2>&1; then
    ! netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$"
  else
    ! docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":${p}->"
  fi
}

port_owner() {
  docker ps --format '{{.Names}}	{{.Ports}}' 2>/dev/null \
    | awk -v p=":$1->" 'index($0, p) {print $1; exit}' || true
}

wait_http() {
  local url=$1 timeout=${2:-90} i code
  for ((i=0; i<timeout; i+=2)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$url" 2>/dev/null || true)
    [ "$code" = "200" ] && return 0
    sleep 2
  done
  return 1
}

wait_db_ready() {
  local c=$1 u=$2 d=$3 timeout=${4:-60} i
  for ((i=0; i<timeout; i++)); do
    docker exec "$c" pg_isready -U "$u" -d "$d" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# ------------------------------- 数据库读取 --------------------------------

db_v1() {
  docker exec -e PGTZ=UTC -e PGPASSWORD="$V1_PW" "$V1_DB_CONTAINER" \
    psql -U "$V1_USER" -d "$V1_DB" -tAc "$1"
}

db_v2_admin() {
  docker exec -e PGTZ=UTC -e PGPASSWORD="$V2_DB_PASSWORD" "$V2_DB_CONTAINER" \
    psql -U "$V2_DB_USER" -d postgres -v ON_ERROR_STOP=1 -tAc "$1"
}

db_v2() {
  docker exec -e PGTZ=UTC -e PGPASSWORD="$V2_DB_PASSWORD" "$V2_DB_CONTAINER" \
    psql -U "$V2_DB_USER" -d "$V2_DB_NAME" -tAc "$1"
}

# ------------------------------- 准备工作 ----------------------------------

ensure_workdir() {
  mkdir -p "$WORKDIR"
  chmod 700 "$WORKDIR" 2>/dev/null || true
  LOG_FILE="$WORKDIR/upgrade-$(date -u +%Y%m%d-%H%M%S).log"
  : > "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  exec > >(tee -a "$LOG_FILE") 2>&1
}

ensure_lock() {
  command -v flock >/dev/null 2>&1 || return 0
  exec 9>"$WORKDIR/.upgrade.lock"
  flock -n 9 || die "已有另一个升级进程在运行（$WORKDIR/.upgrade.lock）"
}

load_or_create_secrets() {
  local config="$WORKDIR/upgrade.env" had=0
  if [ -f "$config" ]; then
    had=1
    # shellcheck disable=SC1090
    set -a; . "$config"; set +a
  fi
  : "${V2_DB_PASSWORD:=}"
  : "${AUTH_SECRET:=}"
  [ -n "$V2_DB_PASSWORD" ] || V2_DB_PASSWORD=$(rand_hex 24)
  [ -n "$AUTH_SECRET" ] || AUTH_SECRET=$(rand_hex 32)

  if [ "$DRY_RUN" != 1 ] && [ "$had" != 1 ]; then
    local tmp="$config.tmp.$$"
    printf 'V2_DB_PASSWORD=%s\nAUTH_SECRET=%s\n' "$V2_DB_PASSWORD" "$AUTH_SECRET" > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$config"
    log "已生成 v2 配置：$config（600，含数据库口令与 AUTH_SECRET，请勿外传）"
  fi

  if [ -z "$V2_DATABASE_URL" ]; then
    V2_DATABASE_URL="postgres://$(urlencode "$V2_DB_USER"):$(urlencode "$V2_DB_PASSWORD")@${V2_DB_CONTAINER}:5432/$(urlencode "$V2_DB_NAME")"
  fi
}

# ------------------------------- v1 探测 ------------------------------------

detect_v1_db() {
  if [ -n "$V1_DB_CONTAINER" ]; then
    container_exists "$V1_DB_CONTAINER" || die "找不到 v1 数据库容器：$V1_DB_CONTAINER"
    return 0
  fi
  if container_exists "feedlore-db" && docker inspect -f '{{.Config.Image}}' feedlore-db 2>/dev/null | grep -qi postgres; then
    V1_DB_CONTAINER=feedlore-db
    return 0
  fi

  local nets c img found=()
  nets=$(container_networks "$V1_CONTAINER")
  while IFS= read -r c; do
    [ "$c" = "$V2_DB_CONTAINER" ] && continue
    img=$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null || true)
    case "$img" in
      *postgres*|*postgis*)
        local cn
        for cn in $nets; do
          if container_on_network "$c" "$cn"; then found+=("$c"); break; fi
        done
        ;;
    esac
  # 含已停止容器：v1 停机后恢复升级时，数据库容器往往也是停的
  done < <(docker ps -a --format '{{.Names}}' 2>/dev/null)

  case "${#found[@]}" in
    0) die "无法自动探测 v1 数据库容器，请用 --v1-db-container=NAME 指定" ;;
    1) V1_DB_CONTAINER=${found[0]} ;;
    *) die "探测到多个 PostgreSQL 容器（${found[*]}），请用 --v1-db-container=NAME 指定" ;;
  esac
}

v1_creds() {
  V1_DB=$(container_env "$V1_DB_CONTAINER" POSTGRES_DB)
  [ -n "$V1_DB" ] || V1_DB=$(container_env "$V1_CONTAINER" PG_DB)
  V1_USER=$(container_env "$V1_DB_CONTAINER" POSTGRES_USER)
  [ -n "$V1_USER" ] || V1_USER=$(container_env "$V1_CONTAINER" PG_USER)
  V1_PW=$(container_env "$V1_DB_CONTAINER" POSTGRES_PASSWORD)
  [ -n "$V1_PW" ] || V1_PW=$(container_env "$V1_CONTAINER" PG_PASSWORD)
  [ -n "$V1_DB" ]   || die "读不到 v1 数据库名（POSTGRES_DB/PG_DB）"
  [ -n "$V1_USER" ] || die "读不到 v1 数据库用户（POSTGRES_USER/PG_USER）"
  [ -n "$V1_PW" ]   || die "读不到 v1 数据库口令（POSTGRES_PASSWORD/PG_PASSWORD）"
}

check_v1_schema() {
  local has
  has=$(db_v1 "select count(*) from information_schema.columns where table_name='users' and column_name='password_hash'") \
    || die "无法读取 v1 数据库（连接/权限问题）"
  [ "$has" = "1" ] || die "目标库不像 v1（users.password_hash 不存在）；如果已是 v2，请勿重复迁移"
}

# ------------------------------- 预检 --------------------------------------

preflight() {
  step "0/8 预检"

  command -v docker >/dev/null 2>&1 || die "本机没有 docker"
  docker info >/dev/null 2>&1 || die "无法连接 Docker daemon（需要 docker 权限）"
  command -v curl >/dev/null 2>&1 || die "本机没有 curl"

  container_exists "$V1_CONTAINER" || die "找不到 v1 应用容器：$V1_CONTAINER（用 --v1-container 指定）"
  if container_running "$V1_CONTAINER"; then
    log "v1 应用：$V1_CONTAINER（运行中）"
  else
    warn "v1 应用 $V1_CONTAINER 当前未运行；按「恢复/续跑」模式继续"
  fi

  detect_v1_db
  container_exists "$V1_DB_CONTAINER" || die "找不到 v1 数据库容器：$V1_DB_CONTAINER"
  v1_creds
  container_running "$V1_DB_CONTAINER" || docker start "$V1_DB_CONTAINER" >/dev/null
  wait_db_ready "$V1_DB_CONTAINER" "$V1_USER" "$V1_DB" 60 \
    || die "v1 数据库 60s 内未就绪"
  log "v1 数据库：$V1_DB_CONTAINER"

  check_v1_schema

  local users feeds entries
  users=$(db_v1 "select count(*) from users")
  feeds=$(db_v1 "select count(*) from feeds")
  entries=$(db_v1 "select count(*) from entries")
  log "v1 数据：用户 $users / 频道 $feeds / 条目 $entries"
  [ "$users" -gt 0 ] || die "v1 库里没有用户，拒绝迁移（避免产出无人能登录的空站点）"

  # 目标端口：默认沿用 v1 映射
  if [ -z "$TARGET_PORT" ]; then
    TARGET_PORT=$(v1_published_port)
    TARGET_PORT=${TARGET_PORT:-3210}
  fi
  TARGET_PORT_OWNER=$(port_owner "$TARGET_PORT")
  if [ -n "$TARGET_PORT_OWNER" ]; then
    case "$TARGET_PORT_OWNER" in
      "$V1_CONTAINER"|"$V2_CONTAINER") : ;;
      *)
        if [ "$DRY_RUN" = 1 ]; then warn "端口 $TARGET_PORT 被 $TARGET_PORT_OWNER 占用（干跑继续）"
        else die "端口 $TARGET_PORT 被 $TARGET_PORT_OWNER 占用"; fi
        ;;
    esac
  elif ! port_free "$TARGET_PORT"; then
    if [ "$DRY_RUN" = 1 ]; then warn "端口 $TARGET_PORT 被非 Docker 进程占用（干跑继续）"
    else die "端口 $TARGET_PORT 被非 Docker 进程占用"; fi
  fi

  if [ -z "$STAGE_PORT" ]; then
    local p=$((TARGET_PORT + 1))
    while [ "$p" -le $((TARGET_PORT + 20)) ] && ! port_free "$p"; do p=$((p + 1)); done
    [ "$p" -le 65535 ] || die "找不到空闲的验证端口"
    STAGE_PORT=$p
  fi
  log "端口：最终 $TARGET_PORT / 验证 $STAGE_PORT"

  HOST_IP=$(host_ip)
  if [ -z "$ACCESS_URL" ]; then
    ACCESS_URL="http://${HOST_IP}:${TARGET_PORT}"
  fi
  ACCESS_URL=${ACCESS_URL%/}
  ACCESS_ORIGIN=$(origin_of "$ACCESS_URL")
  if [ "$ACCESS_ORIGIN" != "$ACCESS_URL" ]; then
    warn "ACCESS_URL 含路径（$ACCESS_URL）；v2 只支持根路径，Cookie / 回调可能异常"
  fi
  if [ -n "$AUTH_SECURE_COOKIES_OVERRIDE" ]; then
    AUTH_SECURE_COOKIES=$AUTH_SECURE_COOKIES_OVERRIDE
  else
    case "$ACCESS_URL" in https://*) AUTH_SECURE_COOKIES=1 ;; *) AUTH_SECURE_COOKIES=0 ;; esac
  fi
  [ -n "$V2_TRUSTED_ORIGINS" ] || V2_TRUSTED_ORIGINS=$ACCESS_ORIGIN
  log "访问地址：$ACCESS_URL（secureCookies=$AUTH_SECURE_COOKIES）"

  # 沿用 v1 的出网/反代开关（只认 "1"）
  local flag
  if [ -z "$V2_TRUST_PROXY" ]; then
    flag=$(container_env "$V1_CONTAINER" TRUST_PROXY)
    if [ "$flag" = "1" ]; then V2_TRUST_PROXY=1; fi
  fi
  if [ -z "$V2_ALLOW_PRIVATE_HOSTS" ]; then
    flag=$(container_env "$V1_CONTAINER" ALLOW_PRIVATE_HOSTS)
    if [ "$flag" = "1" ]; then V2_ALLOW_PRIVATE_HOSTS=1; fi
  fi
  if [ -n "$V2_TRUST_PROXY" ]; then log "沿用 v1：TRUST_PROXY=1"; fi
  if [ -n "$V2_ALLOW_PRIVATE_HOSTS" ]; then log "沿用 v1：ALLOW_PRIVATE_HOSTS=1"; fi

  # 已升级过：容器在跑且健康 → 直接成功退出（幂等）
  if container_running "$V2_CONTAINER"; then
    if [ "$DRY_RUN" = 1 ]; then
      warn "v2 容器 $V2_CONTAINER 已在运行（干跑继续）"
    elif wait_http "http://127.0.0.1:${TARGET_PORT}/api/health" 5; then
      log "检测到 $V2_CONTAINER 已在 $TARGET_PORT 正常服务，视为已完成升级"
      exit 0
    else
      die "v2 容器 $V2_CONTAINER 存在但健康检查失败；请先 docker logs $V2_CONTAINER 排查"
    fi
  fi

  # 镜像
  if ! docker image inspect "$V2_IMAGE" >/dev/null 2>&1; then
    if [ "$DO_PULL" = 1 ]; then
      log "拉取 v2 镜像：$V2_IMAGE"
      docker pull "$V2_IMAGE" || die "docker pull 失败（ghcr 私有镜像需先 docker login）"
    else
      die "v2 镜像不存在：$V2_IMAGE（先构建/导入，或加 --pull）"
    fi
  fi
  docker run --rm --entrypoint sh "$V2_IMAGE" \
    -c 'test -f /app/apps/server/scripts/migrate-legacy.ts && test -d /app/packages/db' >/dev/null 2>&1 \
    || die "v2 镜像里缺少迁移脚本（镜像版本过旧）"

  if ! docker image inspect "$V2_DB_IMAGE" >/dev/null 2>&1; then
    log "拉取数据库镜像：$V2_DB_IMAGE"
    docker pull "$V2_DB_IMAGE" || die "拉取 $V2_DB_IMAGE 失败"
  fi

  # 磁盘
  local size_bytes need_kb dir free
  size_bytes=$(db_v1 "select pg_database_size(current_database())")
  need_kb=$(( size_bytes / 1024 * 2 + 524288 ))
  for dir in "$BACKUP_DIR" "$WORKDIR"; do
    mkdir -p "$dir"
    free=$(free_kb "$dir")
    [ "${free:-0}" -ge "$need_kb" ] || die "$dir 可用空间不足：需要约 $((need_kb / 1024)) MB，当前 $((free / 1024)) MB"
  done
  log "磁盘：v1 库 $(numfmt --to=iec "$size_bytes" 2>/dev/null || echo "${size_bytes}B")，预留空间检查通过"

  # v1 由 compose/watchtower 管理时只告警，不改文件
  local compose_file wt_label
  compose_file=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$V1_CONTAINER" 2>/dev/null || true)
  case "$compose_file" in ''|'<no value>') : ;; *) warn "v1 由 compose 管理：$compose_file —— 切换后请勿再 docker compose up，否则 v1 会复活并抢占 $TARGET_PORT" ;; esac
  wt_label=$(docker inspect -f '{{index .Config.Labels "com.centurylinklabs.watchtower.enable"}}' "$V1_CONTAINER" 2>/dev/null || true)
  [ "$wt_label" = "true" ] && warn "v1 容器带 watchtower 标签：停止后不会被自动拉起；若 ghcr latest 已变成 v2，重新启动 v1 会直接坏掉"

  if [ -z "$PROBE_USER" ]; then
    warn "未提供 PROBE_USER/PROBE_PASS，将跳过端到端登录验证（仍会校验数据量/设置）"
  fi
}

# ------------------------------- 1. 备份 -----------------------------------

backup_v1() {
  step "1/8 备份 v1 数据库"
  if [ "$DO_BACKUP" != 1 ]; then
    warn "已按 --skip-backup 跳过备份（不建议）"
    return 0
  fi
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR" 2>/dev/null || true
  BACKUP_FILE="$BACKUP_DIR/feedlore-v1-$(date -u +%Y%m%d-%H%M%S).dump"
  log "备份到 $BACKUP_FILE"
  docker exec -e PGTZ=UTC "$V1_DB_CONTAINER" \
    pg_dump -U "$V1_USER" -d "$V1_DB" -Fc > "$BACKUP_FILE" \
    || die "pg_dump 失败"
  [ -s "$BACKUP_FILE" ] || die "备份文件为空"
  chmod 600 "$BACKUP_FILE"
  docker exec -i "$V1_DB_CONTAINER" pg_restore -l < "$BACKUP_FILE" >/dev/null 2>&1 \
    || die "备份文件校验失败（pg_restore -l）"
  log "备份完成（$(du -h "$BACKUP_FILE" | awk '{print $1}')）"
}

# ------------------------------- 2. v2 库 ----------------------------------

ensure_network() {
  docker network inspect "$V2_NETWORK" >/dev/null 2>&1 || {
    log "创建网络 $V2_NETWORK"
    docker network create "$V2_NETWORK" >/dev/null
  }
}

ensure_v2_db() {
  step "2/8 准备 v2 数据库"

  if ! docker image inspect "$V2_DB_IMAGE" >/dev/null 2>&1; then
    log "拉取数据库镜像：$V2_DB_IMAGE"
    docker pull "$V2_DB_IMAGE" || die "拉取 $V2_DB_IMAGE 失败"
  fi

  if container_exists "$V2_DB_CONTAINER"; then
    log "复用 v2 数据库容器：$V2_DB_CONTAINER"
    container_running "$V2_DB_CONTAINER" || docker start "$V2_DB_CONTAINER" >/dev/null
    # 已有库若来自别的网络（如 compose 默认网络），补接一条，保证迁移容器能按名字解析
    if ! container_on_network "$V2_DB_CONTAINER" "$V2_NETWORK"; then
      docker network connect "$V2_NETWORK" "$V2_DB_CONTAINER" \
        || die "把 $V2_DB_CONTAINER 接入 $V2_NETWORK 失败"
      log "已把 v2 数据库接入 $V2_NETWORK（额外网络，保留不影响原栈）"
    fi
  else
    log "创建 v2 数据库容器：$V2_DB_CONTAINER（卷 $V2_VOLUME）"
    docker run -d --name "$V2_DB_CONTAINER" \
      --network "$V2_NETWORK" \
      --restart unless-stopped \
      -e POSTGRES_DB="$V2_DB_NAME" \
      -e POSTGRES_USER="$V2_DB_USER" \
      -e POSTGRES_PASSWORD="$V2_DB_PASSWORD" \
      -e PGDATA=/var/lib/postgresql/data/pgdata \
      -e TZ=UTC \
      -v "$V2_VOLUME:/var/lib/postgresql/data" \
      --health-cmd "pg_isready -U $V2_DB_USER -d $V2_DB_NAME" \
      --health-interval 10s --health-timeout 5s --health-retries 12 \
      "$V2_DB_IMAGE" >/dev/null
  fi

  wait_db_ready "$V2_DB_CONTAINER" "$V2_DB_USER" postgres 90 \
    || die "v2 数据库 90s 内未就绪"

  if ! docker exec -e PGPASSWORD="$V2_DB_PASSWORD" "$V2_DB_CONTAINER" \
        psql -U "$V2_DB_USER" -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    die "用 $WORKDIR/upgrade.env 里的口令连不上 v2 数据库。
      若这是上次运行留下的库，请恢复原来的 upgrade.env；
      否则请换一个 --workdir（旧卷里的数据不会自动适配新口令）。"
  fi

  local exists
  exists=$(db_v2_admin "select 1 from pg_database where datname = '$V2_DB_NAME'")
  if [ "$exists" != "1" ]; then
    log "创建数据库 $V2_DB_NAME"
    db_v2_admin "create database \"$V2_DB_NAME\" owner \"$V2_DB_USER\"" >/dev/null
  fi

  log "执行 drizzle 迁移（幂等）"
  docker run --rm --network "$V2_NETWORK" \
    -e DATABASE_URL="$V2_DATABASE_URL" -e TZ=UTC \
    --entrypoint sh "$V2_IMAGE" \
    -c 'cd /app/packages/db && pnpm migrate' \
    || die "数据库迁移失败"
}

# ------------------------------- 3. 迁移 -----------------------------------

attach_v1_db() {
  step "3/8 连接 v1 数据库到 v2 网络"
  if container_on_network "$V1_DB_CONTAINER" "$V2_NETWORK"; then
    log "v1 数据库已在网络 $V2_NETWORK 中"
    return 0
  fi
  docker network connect "$V2_NETWORK" "$V1_DB_CONTAINER" \
    || die "把 $V1_DB_CONTAINER 接入 $V2_NETWORK 失败"
  ATTACHED_V1=1
  log "已临时接入（结束后自动断开）"
}

check_v1_reachable_from_v2_net() {
  docker run --rm --network "$V2_NETWORK" -e TZ=UTC \
    -e PGPASSWORD="$V1_PW" --entrypoint psql "$V2_DB_IMAGE" \
    -h "$V1_DB_CONTAINER" -U "$V1_USER" -d "$V1_DB" -tAc 'select 1' >/dev/null 2>&1 \
    || die "迁移容器无法连接 v1 数据库（网络/口令）"
}

write_migrate_env() {
  MIGRATE_ENV="$WORKDIR/.migrate-$$.env"
  {
    printf 'LEGACY_DATABASE_URL=postgres://%s:%s@%s:5432/%s\n' \
      "$(urlencode "$V1_USER")" "$(urlencode "$V1_PW")" "$V1_DB_CONTAINER" "$(urlencode "$V1_DB")"
    printf 'DATABASE_URL=%s\n' "$V2_DATABASE_URL"
    printf 'AUTH_SECRET=%s\n' "$AUTH_SECRET"
    printf 'AUTH_BASE_URL=%s\n' "$ACCESS_URL"
    printf 'TZ=UTC\n'
  } > "$MIGRATE_ENV"
  chmod 600 "$MIGRATE_ENV"
}

run_legacy_migrate() {
  local mode=$1 out kept reset
  local flag=""
  [ "$mode" = "dry" ] && flag="--dry-run"

  log "运行 migrate:legacy ${flag:-（写入）}"
  if ! out=$(docker run --rm --network "$V2_NETWORK" --env-file "$MIGRATE_ENV" \
        --entrypoint sh "$V2_IMAGE" \
        -c "cd /app/apps/server && ./node_modules/.bin/tsx scripts/migrate-legacy.ts $flag" 2>&1); then
    printf '%s\n' "$out"
    die "migrate:legacy 失败"
  fi
  printf '%s\n' "$out"

  kept=$(printf '%s\n' "$out" | sed -n 's/.*密码：沿用 v1 \([0-9][0-9]*\) 个.*/\1/p' | tail -n1)
  reset=$(printf '%s\n' "$out" | sed -n 's/.*随机重置 \([0-9][0-9]*\) 个.*/\1/p' | tail -n1)
  kept=${kept:-0}; reset=${reset:-0}

  if [ "$reset" -gt 0 ]; then
    warn "有 $reset 个账号的 v1 哈希格式异常，已重置为一次性随机密码；"
    warn "密码见本次输出（只在 600 权限日志 $LOG_FILE 里，请尽快人工重置）"
  fi
  log "密码沿用 v1：$kept 个；随机重置：$reset 个"
}

# ------------------------------- 4. 图片缓存 --------------------------------

copy_image_cache() {
  step "4/8 图片缓存"
  if [ "$COPY_IMAGE_CACHE" != 1 ]; then
    log "已按 --no-image-cache 跳过（v2 会按需重新回源）"
    return 0
  fi

  local has_v1 v1_n v2_n
  has_v1=$(db_v1 "select count(*) from information_schema.tables where table_name='image_cache'")
  if [ "$has_v1" != "1" ]; then
    log "v1 没有 image_cache 表，跳过"
    return 0
  fi
  v1_n=$(db_v1 "select count(*) from image_cache")
  v2_n=$(db_v2 "select count(*) from image_cache")
  if [ "$v1_n" = "0" ]; then
    log "v1 图片缓存为空，跳过"
    return 0
  fi
  if [ "$v2_n" != "0" ]; then
    log "v2 已有 $v2_n 条缓存，跳过 COPY（避免主键冲突）"
    return 0
  fi

  log "搬运 $v1_n 条图片缓存（PGTZ=UTC，避免 timestamptz → timestamp 偏移）"
  if { printf 'BEGIN;\n'
       docker exec -e PGTZ=UTC "$V1_DB_CONTAINER" \
         pg_dump -U "$V1_USER" -d "$V1_DB" --data-only --table=image_cache \
           --no-owner --no-privileges
       printf 'COMMIT;\n'
     } | docker exec -i -e PGTZ=UTC "$V2_DB_CONTAINER" \
           psql -U "$V2_DB_USER" -d "$V2_DB_NAME" -v ON_ERROR_STOP=1 -q; then
    v2_n=$(db_v2 "select count(*) from image_cache")
    log "图片缓存：v2 现有 $v2_n 条"
  else
    warn "图片缓存搬运失败（不影响主流程；v2 会按需重新回源）"
  fi
}

# ------------------------------- 5. 校验 -----------------------------------

verify_data() {
  step "5/8 数据校验"

  local v1_users v2_users v1_feeds v2_feeds v1_entries v2_entries
  local v1_digests v2_digests v1_pw_rows v2_creds v2_legacy v1_prefs v2_prefs
  local v1_crypto v2_crypto v1_source v2_source v1_flags v2_flags

  v1_users=$(db_v1 "select count(*) from users")
  v2_users=$(db_v2 "select count(*) from users")
  v1_feeds=$(db_v1 "select count(*) from feeds")
  v2_feeds=$(db_v2 "select count(*) from feeds")
  v1_entries=$(db_v1 "select count(*) from entries")
  v2_entries=$(db_v2 "select count(*) from entries")
  v1_digests=$(db_v1 "select count(*) from digests")
  v2_digests=$(db_v2 "select count(*) from digests")

  log "用户 $v1_users→$v2_users / 频道 $v1_feeds→$v2_feeds / 条目 $v1_entries→$v2_entries / 日报 $v1_digests→$v2_digests"

  [ "$v2_users" -ge "$v1_users" ]   || die "用户数不一致"
  [ "$v2_feeds" -ge "$v1_feeds" ]   || die "频道数不一致"
  [ "$v2_entries" -ge "$v1_entries" ] || die "条目数少于 v1（迁移不完整）"
  [ "$v2_digests" -ge "$v1_digests" ] || die "日报数不一致"

  v1_pw_rows=$(db_v1 "select count(*) from users where password_hash is not null and password_hash <> ''")
  v2_creds=$(db_v2 "select count(*) from accounts where provider_id='credential' and coalesce(password,'') <> ''")
  v2_legacy=$(db_v2 "select count(*) from accounts where password like 'legacy$%'")
  [ "$v2_creds" -ge "$v1_pw_rows" ] || die "有账号没有写入凭据（v2 里会登录不了）"
  log "凭据齐全：$v2_creds 个（其中 legacy 原样保留 $v2_legacy 个，首次登录自动升级）"

  v1_crypto=$(db_v1 "select md5(value::text) from settings where key='cryptoSecret'")
  v2_crypto=$(db_v2 "select md5(value::text) from settings where key='cryptoSecret'")
  if [ -n "$v1_crypto" ]; then
    [ "$v1_crypto" = "$v2_crypto" ] || die "站点主密钥 cryptoSecret 未正确迁移（模型 Key 会解不开）"
    log "站点主密钥：一致（模型 Key 可继续解密）"
  else
    warn "v1 没有 cryptoSecret（从未存过模型 Key），跳过该项"
  fi

  v1_source=$(db_v1 "select md5(value::text) from settings where key='source'")
  v2_source=$(db_v2 "select md5(value::text) from settings where key='source'")
  if [ -n "$v1_source" ]; then
    if [ "$v1_source" = "$v2_source" ]; then
      log "采集参数 settings.source：一致"
    else
      warn "采集参数与 v1 不完全一致（若你已在 v2 里改过设置，可忽略）"
    fi
  else
    warn "v1 没有 settings.source，v2 将使用环境变量/默认值"
  fi

  v1_prefs=$(db_v1 "select count(*) from users where prefs is not null and prefs <> '{}'::jsonb")
  v2_prefs=$(db_v2 "select count(*) from users where prefs is not null and prefs <> '{}'::jsonb")
  [ "$v2_prefs" -ge "$v1_prefs" ] || die "用户偏好迁移不完整（v1 $v1_prefs / v2 $v2_prefs）"

  v1_flags=$(db_v1 "select count(*) filter (where is_read) || '/' || count(*) filter (where is_favorite) from entries")
  v2_flags=$(db_v2 "select count(*) filter (where is_read) || '/' || count(*) filter (where is_favorite) from entries")
  if [ "$v1_flags" = "$v2_flags" ]; then
    log "已读/收藏状态：一致（$v1_flags）"
  else
    warn "已读/收藏状态不一致（v1 $v1_flags / v2 $v2_flags）；若切换后已在 v2 操作过可忽略"
  fi

  local v1_img v2_img
  v1_img=$(db_v1 "select count(*) from image_cache" 2>/dev/null || echo 0)
  v2_img=$(db_v2 "select count(*) from image_cache")
  if [ "$v1_img" -gt 0 ] && [ "$v2_img" -lt "$v1_img" ]; then
    warn "图片缓存少于 v1（v1 $v1_img / v2 $v2_img）；不影响使用，v2 会重新回源"
  fi

  log "数据校验通过"
}

# ------------------------------- 6. 验证实例 -------------------------------

write_server_env() {
  local file=$1 base_url=$2 secure=$3 refresh_disabled=$4
  {
    printf 'DATABASE_URL=%s\n' "$V2_DATABASE_URL"
    printf 'AUTH_SECRET=%s\n' "$AUTH_SECRET"
    printf 'AUTH_BASE_URL=%s\n' "$base_url"
    printf 'AUTH_TRUSTED_ORIGINS=%s\n' "$V2_TRUSTED_ORIGINS"
    printf 'AUTH_SECURE_COOKIES=%s\n' "$secure"
    printf 'TZ=UTC\n'
    if [ -n "${V2_TRUST_PROXY:-}" ]; then printf 'TRUST_PROXY=%s\n' "$V2_TRUST_PROXY"; fi
    if [ -n "${V2_ALLOW_PRIVATE_HOSTS:-}" ]; then printf 'ALLOW_PRIVATE_HOSTS=%s\n' "$V2_ALLOW_PRIVATE_HOSTS"; fi
    if [ "$refresh_disabled" = 1 ]; then printf 'REFRESH_DISABLED=1\n'; fi
  } > "$file"
  chmod 600 "$file"
}

probe_login() {
  local base=$1 origin=$2 secure=${3:-0} jar resp code
  [ -n "$PROBE_USER" ] || return 0
  jar="$WORKDIR/.probe-cookies.$$"
  resp="$WORKDIR/.probe-resp.$$"
  code=$(curl -s -o "$resp" -w '%{http_code}' -m 15 -c "$jar" \
    -H 'Content-Type: application/json' -H "Origin: $origin" \
    -d "{\"username\":\"$(json_escape "$PROBE_USER")\",\"password\":\"$(json_escape "$PROBE_PASS")\"}" \
    "$base/api/login" 2>/dev/null || true)
  if [ "$code" != "200" ]; then
    warn "登录验证失败（HTTP $code）：$base/api/login"
    [ -s "$resp" ] && warn "响应：$(head -c 300 "$resp")"
    rm -f "$jar" "$resp"
    return 1
  fi
  if [ "$secure" = "1" ]; then
    # Secure Cookie 在 http 下不会被 curl 回传；这种情况下只能确认密码校验通过
    log "secure cookie 已开启：HTTP 探针无法回传会话，仅校验登录接口 200"
    rm -f "$jar" "$resp"
    return 0
  fi
  if ! curl -s -m 10 -b "$jar" "$base/api/session" | grep -q '"authenticated":true'; then
    warn "登录成功但会话未建立（Cookie 未回传？检查 AUTH_BASE_URL / AUTH_SECURE_COOKIES）"
    rm -f "$jar" "$resp"
    return 1
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -b "$jar" "$base/api/feeds" 2>/dev/null || true)
  [ "$code" = "200" ] || { warn "已登录但 /api/feeds 返回 $code"; rm -f "$jar" "$resp"; return 1; }
  log "登录验证通过：$PROBE_USER（$base）"
  rm -f "$jar" "$resp"
}

start_stage() {
  step "6/8 验证实例（端口 $STAGE_PORT，不采集新数据）"
  STAGE_NAME="${V2_CONTAINER}-stage"
  docker rm -f "$STAGE_NAME" >/dev/null 2>&1 || true
  # 只绑回环：验证实例不对外暴露；Origin 也统一用 127.0.0.1，避免和真实域名的 CSRF 校验混淆
  local stage_origin="http://127.0.0.1:${STAGE_PORT}" saved_origins="$V2_TRUSTED_ORIGINS"
  V2_TRUSTED_ORIGINS="$stage_origin${saved_origins:+,$saved_origins}"
  write_server_env "$WORKDIR/.stage.env" "$stage_origin" 0 1
  V2_TRUSTED_ORIGINS="$saved_origins"

  docker run -d --name "$STAGE_NAME" \
    --network "$V2_NETWORK" \
    --env-file "$WORKDIR/.stage.env" \
    -p "127.0.0.1:${STAGE_PORT}:3000" \
    --restart no \
    "$V2_IMAGE" >/dev/null

  if ! wait_http "http://127.0.0.1:${STAGE_PORT}/api/health" 90; then
    docker logs --tail 80 "$STAGE_NAME" >&2 || true
    die "v2 验证实例未通过健康检查"
  fi
  log "验证实例健康"

  if [ -n "$PROBE_USER" ]; then
    probe_login "http://127.0.0.1:${STAGE_PORT}" "$stage_origin" 0 \
      || die "验证实例登录失败（v1 密码可能没迁移成功，先不要切换）"
  fi

  docker rm -f "$STAGE_NAME" >/dev/null 2>&1 || true
  STAGE_NAME=""
  rm -f "$WORKDIR/.stage.env"
  log "验证通过，已关闭验证实例"
}

# ------------------------------- 7. 切换 -----------------------------------

cutover() {
  step "7/8 切换"
  if [ "$ASSUME_YES" != 1 ]; then
    [ -t 0 ] || die "非交互环境请加 --yes"
    printf '即将停止 v1（%s）并用 v2 接管端口 %s。输入 yes 继续：' "$V1_CONTAINER" "$TARGET_PORT"
    local ans=""
    read -r ans || true
    [ "$ans" = "yes" ] || die "已取消"
  fi

  local owner
  owner=$(port_owner "$TARGET_PORT")
  if [ -n "$owner" ] && [ "$owner" != "$V1_CONTAINER" ]; then
    die "端口 $TARGET_PORT 被 $owner 占用，拒绝切换"
  fi

  log "注意：从这一刻起 v1 停机。若机器在切换过程中断电，需手动 docker start $V1_CONTAINER"
  if container_running "$V1_CONTAINER"; then
    log "停止 v1 应用（容器保留，可回滚）"
    # 先置位再停：万一 stop 中途失败，EXIT trap 也会把 v1 拉起来
    V1_STOPPED=1
    docker stop "$V1_CONTAINER" >/dev/null || die "停止 v1 失败"
  else
    warn "v1 应用当前未运行，跳过停止"
  fi

  # 停掉 v1 后再补跑一次，保证期间采集的数据全部进入 v2
  log "切换前补跑增量迁移"
  run_legacy_migrate write
  verify_data

  log "启动 v2 生产容器：$V2_CONTAINER"
  docker rm -f "$V2_CONTAINER" >/dev/null 2>&1 || true
  write_server_env "$WORKDIR/server.env" "$ACCESS_URL" "$AUTH_SECURE_COOKIES" 0
  V2_STARTED=1
  docker run -d --name "$V2_CONTAINER" \
    --network "$V2_NETWORK" \
    --env-file "$WORKDIR/server.env" \
    -p "${TARGET_PORT}:3000" \
    --restart unless-stopped \
    "$V2_IMAGE" >/dev/null

  if ! wait_http "http://127.0.0.1:${TARGET_PORT}/api/health" 90; then
    docker logs --tail 120 "$V2_CONTAINER" >&2 || true
    die "v2 生产容器未通过健康检查"
  fi

  if [ -n "$PROBE_USER" ]; then
    probe_login "http://127.0.0.1:${TARGET_PORT}" "$ACCESS_ORIGIN" "$AUTH_SECURE_COOKIES" \
      || die "v2 生产实例登录失败"
  fi

  owner=$(port_owner "$TARGET_PORT")
  [ "$owner" = "$V2_CONTAINER" ] || die "端口 $TARGET_PORT 未由 $V2_CONTAINER 接管（当前：${owner:-空}）"

  verify_data
  CUTOVER_VERIFIED=1
  log "切换完成"
}

# ------------------------------- 8. 回滚 / 收尾 ----------------------------

rollback_to_v1() {
  set +e
  warn "开始回滚到 v1"
  docker rm -f "$V2_CONTAINER" >/dev/null 2>&1
  if container_exists "$V1_CONTAINER"; then
    docker start "$V1_CONTAINER" >/dev/null 2>&1
    if wait_http "http://127.0.0.1:${TARGET_PORT}/api/health" 60; then
      warn "已回滚：v1 在 $TARGET_PORT 恢复服务"
    else
      warn "v1 已启动但健康检查未通过，请检查：docker logs $V1_CONTAINER"
    fi
  fi
}

on_exit() {
  local code=$?
  set +e
  if [ -n "$STAGE_NAME" ]; then docker rm -f "$STAGE_NAME" >/dev/null 2>&1; fi
  if [ -n "$MIGRATE_ENV" ]; then rm -f "$MIGRATE_ENV"; fi
  rm -f "$WORKDIR/.stage.env" "$WORKDIR"/.probe-cookies.* "$WORKDIR"/.probe-resp.* 2>/dev/null
  if [ "$ATTACHED_V1" = 1 ]; then
    docker network disconnect "$V2_NETWORK" "$V1_DB_CONTAINER" >/dev/null 2>&1
  fi
  if [ "$code" -ne 0 ]; then
    # v1 被本脚本停过、或 v2 已经顶上来但没通过验证 —— 都要把 v1 拉回去
    if [ "$CUTOVER_VERIFIED" != 1 ] && { [ "$V1_STOPPED" = 1 ] || [ "$V2_STARTED" = 1 ]; }; then
      rollback_to_v1
    fi
    warn "升级失败（退出码 $code）。日志：${LOG_FILE:-（未生成）}"
  fi
  exit "$code"
}

trap on_exit EXIT
trap 'exit 130' INT TERM

# ------------------------------- 主流程 ------------------------------------

ensure_workdir
ensure_lock
log "FeedLore v1 → v2 升级开始（$( [ "$DRY_RUN" = 1 ] && echo 干跑 || echo 写入 )）"

# 先做只读预检：已完成升级 / 基础环境不满足时直接退出，不留下半套密钥配置
preflight
load_or_create_secrets

if [ "$DRY_RUN" = 1 ]; then
  step "干跑：迁移预演"
  if [ "$V2_URL_EXPLICIT" = 1 ] && docker network inspect "$V2_NETWORK" >/dev/null 2>&1; then
    # 调用方显式给了可用的目标库（例如在已有 v2 库上复演）
    log "使用显式目标库做只读预演（退出时会断开临时网络连接）"
    attach_v1_db
    check_v1_reachable_from_v2_net
    write_migrate_env
    run_legacy_migrate dry
  elif [ "$V2_URL_EXPLICIT" = 1 ]; then
    warn "目标库已给出，但网络 $V2_NETWORK 不存在，跳过迁移预演"
  else
    log "未提供可用目标库，跳过迁移预演（真实执行时会先建库）"
  fi
  step "干跑结束"
  log "预检通过。去掉 --dry-run 即可执行真实升级。"
  exit 0
fi

backup_v1
ensure_network
ensure_v2_db
attach_v1_db
check_v1_reachable_from_v2_net
write_migrate_env
run_legacy_migrate dry
run_legacy_migrate write
copy_image_cache
verify_data
start_stage
cutover

step "完成"
cat <<EOF

FeedLore v2 已接管：$ACCESS_URL
  应用容器：$V2_CONTAINER（restart=unless-stopped，无 watchtower 标签）
  数据库：  $V2_DB_CONTAINER / $V2_DB_NAME（卷 $V2_VOLUME）
  服务端配置：$WORKDIR/server.env（600）
  升级配置：  $WORKDIR/upgrade.env（600，含 v2 库口令与 AUTH_SECRET，勿外传）
  本次日志：  $LOG_FILE
  v1 备份：   ${BACKUP_FILE:-（已跳过）}

回滚（切换后 v2 的新数据不会回写 v1）：
  docker stop $V2_CONTAINER && docker start $V1_CONTAINER

注意事项：
  1. 所有 v2 容器固定 TZ=UTC（与迁移时的日期序列化一致）。不要给它们改 TZ，
     否则历史时间会整体偏移。
  2. v1 容器与数据库都保留着；确认无误后可自行 docker rm/卷清理。
  3. 若 v1 由 compose 管理，勿再 docker compose up，否则 v1 会复活并抢占 $TARGET_PORT。
  4. 升级后旧会话全部失效，需要用 v1 原密码重新登录；密码本身已无损迁移。
  5. v2 镜像更新需手动重建容器（未打 watchtower 标签）；升级前先看是否需要跑数据库迁移。
EOF
