#!/usr/bin/env bash
# FeedLore 中国网络部署脚本：多源镜像下载 compose + ghcr 镜像反代拉取 + 首启账密回显。
#
# 一键用法（在国内机器上）：
#   bash <(curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/chensnails/FeedLore/main/scripts/deploy-cn.sh)
# 或分两步（推荐，能看到下载过程）：
#   curl -fsSL -o deploy-cn.sh https://gh-proxy.org/https://raw.githubusercontent.com/chensnails/FeedLore/main/scripts/deploy-cn.sh
#   chmod +x deploy-cn.sh && ./deploy-cn.sh
#
# 它比 deploy.sh 多做两件网络适配（都可用环境变量覆盖）：
#   1. 下载 compose：先直连 raw.githubusercontent.com，失败依次试内置 GitHub 代理前缀；
#      RAW_MIRROR="https://你的代理/" ./deploy-cn.sh  可指定单个代理（末尾需带 /）。
#   2. 拉 ghcr 镜像：按优先级试公共 ghcr 反代，拉成功后 `docker tag` 回官方名，
#      因此 compose 里的 image 保持 ghcr.io/chensnails/feedlore:版本 不变。
#      GHCR_MIRROR="ghcr.nju.edu.cn" ./deploy-cn.sh   可指定单个反代域名。
#
# ⚠️ 公共镜像站由第三方维护，可用性/安全性不由本项目保证，随时可能失效。
#    生产环境强烈建议把镜像同步到自己的私有仓库（阿里云 ACR / 腾讯云 TCR），
#    然后用 GHCR_MIRROR=你的仓库域名 指向它。
#
# 账密回显语义与 deploy.sh 一致：首次部署显示一次性密码，升级部署提示原密码保持原样。

set -euo pipefail

# 本脚本与它下载的 deploy.sh 共用的版本标记：本地副本不匹配就强制重下，
# 避免 CDN / 旧文件让用户跑到上一版的逻辑（曾出现「下载成功但内容是旧版」）。
SCRIPT_VER='fl-deploy-4'
EXPECT_VER="$SCRIPT_VER"
# 任何未预期的失败都打行号，绝不静默退出。
trap 'code=$?; echo "错误：脚本在第 $LINENO 行失败（退出码 $code）" >&2' ERR

REPO_RAW='https://raw.githubusercontent.com/chensnails/FeedLore/main'
COMPOSE_FILE='docker-compose.v2.release.yml'
DEPLOY_SCRIPT='deploy.sh'
IMAGE='ghcr.io/chensnails/feedlore:2.5.2'

# GitHub 文件下载代理前缀（末尾带 /），按顺序尝试；直连也会先试。
RAW_MIRRORS=(
  "${RAW_MIRROR:-}"
  'https://gh-proxy.org/'
  'https://ghproxy.net/'
  'https://github.akams.cn/'
)
# ghcr.io 反代域名（不带协议/路径），按顺序尝试；官方 ghcr.io 作为最后兜底。
GHCR_MIRRORS=(
  "${GHCR_MIRROR:-}"
  'ghcr.nju.edu.cn'
  'ghcr.1ms.run'
  'ghcr.m.daocloud.io'
  'ghcr.dockerproxy.net'
  'ghcr.io'
)

RULE='========================================================================'
say() { printf '%s\n' "$*"; }
line() { printf '  %s\n' "$*"; }
die() { echo "错误：$*" >&2; exit 1; }

# --- 1. 下载 compose / deploy.sh -------------------------------------------------
fetch_one() {
  local url="$1" out="$2"
  curl -fsSL --connect-timeout 8 --max-time 60 -o "$out" "$url" 2>/dev/null
}

# 内容是否当前版本（不只是「像那么回事」）：代理错误页、旧版 compose（含 upgrade）、
# 旧版脚本（版本标记不符）一律判不合格，继续试下一个源。
content_ok() {
  local path="$1" out="$2"
  [[ -s "$out" ]] || return 1
  if [[ "$path" == *.yml ]]; then
    grep -q '^services:' "$out" && ! grep -q '^  upgrade:' "$out"
  else
    grep -q "SCRIPT_VER='$EXPECT_VER'" "$out"
  fi
}

download_file() {
  local path="$1" out="$2" name="$3" mirror prefix url ok=1
  if [[ -f "$out" ]] && content_ok "$path" "$out"; then
    line "$name 已存在（当前版本），跳过下载"
    return 0
  fi
  if [[ -f "$out" ]]; then
    line "$name 是旧版，重新下载…"
    rm -f "$out"
  fi
  say "  下载 $name …"
  # 带时间戳查询参数：绕过 raw/jsDelivr 的 branch 缓存（缓存 key 含 query）。
  local bust="?t=$(date +%s)"
  for prefix in "${RAW_MIRRORS[@]}"; do
    if [[ -z "$prefix" ]]; then
      url="${REPO_RAW}/${path}${bust}"
      line "试直连 raw.githubusercontent.com"
    else
      url="${prefix}${REPO_RAW}/${path}${bust}"
      line "试代理 ${prefix%/}"
    fi
    if fetch_one "$url" "$out"; then
      if content_ok "$path" "$out"; then
        line "  成功 ✓"
        return 0
      fi
      # 下到了代理错误页或旧缓存：删掉继续试下一个源。
      line "  内容不是当前版本（可能是缓存），换下一个源"
      rm -f "$out"
    fi
  done
  die "$name 所有下载源均失败或仍是旧版。可设 RAW_MIRROR='https://你的代理/' 重试；
     或直接按 commit 固定下载（必定最新）：
       curl -fsSL -o $name https://raw.githubusercontent.com/chensnails/FeedLore/main/$path"
}

say "$RULE"
line 'FEEDLORE CN DEPLOY / 中国网络部署'
say "$RULE"

say '[1/4] 准备 compose 与部署脚本…'
# 两个文件都按内容+版本校验：旧 compose（含 upgrade 服务）和旧脚本一律重下。
download_file "$COMPOSE_FILE" "$COMPOSE_FILE" "$COMPOSE_FILE"
download_file "scripts/$DEPLOY_SCRIPT" "$DEPLOY_SCRIPT" "$DEPLOY_SCRIPT"
chmod +x "$DEPLOY_SCRIPT"

# --- 2. 从 compose 读出实际镜像（跟随版本升级，不硬编码）------------------------
# 兼容两种写法：`image: ${V2_IMAGE:-x}` 与旧版的 `image: &v2-image ${V2_IMAGE:-x}`。
image_from_compose() {
  sed -n 's|^[[:space:]]*image:[[:space:]]*\(&v2-image[[:space:]]*\)\?\${V2_IMAGE:-\([^}]*\)}.*|\2|p' "$COMPOSE_FILE" | head -1
}
parsed="$(image_from_compose)"
if [[ -n "$parsed" ]]; then IMAGE="$parsed"; fi
# 允许 .env 里的 V2_IMAGE 覆盖（用户钉了版本时尊重它）
env_image="$(sed -n 's/^V2_IMAGE=\(.*\)$/\1/p' .env 2>/dev/null | head -1 | tr -d '"'\''')"
if [[ -n "$env_image" ]]; then IMAGE="$env_image"; fi
line "目标镜像：$IMAGE"

# --- 3. ghcr 反代拉取 + tag 回官方名 --------------------------------------------
pull_via_mirror() {
  local mirror="$1" src="$2" rest tag_ok=1
  if [[ "$mirror" == "ghcr.io" ]]; then
    line "试官方 ghcr.io（最后兜底）"
    docker pull "$src" && return 0 || return 1
  fi
  rest="${src#ghcr.io/}"
  line "试反代 $mirror"
  if docker pull "${mirror}/${rest}"; then
    docker tag "${mirror}/${rest}" "$src" && return 0
  fi
  return 1
}

say '[2/4] 拉取镜像（公共 ghcr 反代，逐个尝试）…'
pulled=0
for m in "${GHCR_MIRRORS[@]}"; do
  if [[ -z "$m" ]]; then continue; fi
  if pull_via_mirror "$m" "$IMAGE"; then
    pulled=1
    break
  fi
done
if [[ $pulled -ne 1 ]]; then
  die "所有 ghcr 源均拉取失败。可设 GHCR_MIRROR=你的私有仓库域名，或先手工 docker pull $IMAGE"
fi
line "镜像就绪 ✓（已 tag 回官方名，compose 无需改动）"

# --- 4. 用 deploy.sh 完成部署与账密回显 -----------------------------------------
say '[3/4] 部署并回显凭据…'
say ''
./"$DEPLOY_SCRIPT" "$COMPOSE_FILE" --pull never
