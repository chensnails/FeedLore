# 笺川（Feedlore）—— RSS 直连聚合与资源卡片墙（ARM64 / AMD64 通用）
# ---------------------------------------------------------------
# 阶段一：构建前端（Vite + React，产出 dist/）
# 多阶段构建：最终镜像不带 dev 依赖，也不带构建工具
# ---------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# 先装依赖再拷源码，源码改动不会让依赖层缓存失效
COPY package.json package-lock.json ./
RUN npm ci

# 构建输入：Vite 配置、两个入口 HTML、React 源码、public/ 静态资源
# （style.css / sw.js / 图标经 publicDir 原样拷入 dist）
COPY vite.config.mjs index.html login.html ./
COPY src ./src
COPY public ./public

RUN npm run build

# ---------------------------------------------------------------
# 阶段二：运行时（复用此前单阶段镜像的时区 / 健康检查配置）
# 基础镜像用 Debian（bookworm-slim）而非 Alpine：图片压缩依赖 sharp（原生 libvips），
# 其预编译二进制基于 glibc，在 Alpine(musl) 上加载会失败，Debian 上开箱即用。
# ---------------------------------------------------------------
FROM node:22-bookworm-slim

# 时区数据：定时摘要按 Asia/Shanghai 计算，日志时间也需要
# 注意：tzdata 不能删，否则 /usr/share/zoneinfo 丢失，TZ 无法解析会回落到 UTC
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Asia/Shanghai

# 只装生产依赖（pg / undici）；React / Vite 属于构建期依赖，不进最终镜像
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js db.js rss.js digest.js proxy.js ./
# lib/：后端纯函数（v2.2.0 起 server.js 会 require ./lib/*，漏拷会在容器启动时报 MODULE_NOT_FOUND）
COPY lib ./lib

# 前端构建产物：打进镜像（不再挂载 public/，改前端必须重新 build）
COPY --from=builder /app/dist ./dist

EXPOSE 3000

# 用 Node 自带 fetch 做健康检查，无需额外装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
