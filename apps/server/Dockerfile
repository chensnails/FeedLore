# FeedLore v2 —— 生产形态镜像（Web 静态产物 + API 同容器）
#
# 构建上下文必须是**仓库根目录**（monorepo），因为需要 packages/* 与根级 workspace 清单：
#   docker build -f apps/server/Dockerfile -t feedlore-v2:test .
#
# ⚠️ 该镜像仅供 172.26.1.2 测试用，与线上 ghcr.io/chensnails/feedlore:latest 完全无关，
#    绝不能被 watchtower 拉取（本机 watchtower 只更新带 enable 标签的容器，这里不打标签）。

# ---------------- 阶段 1：构建前端 ----------------
# 单独一层：前端依赖（vite/react）与后端依赖的改动频率不同，分层能吃到构建缓存。
FROM node:22-slim AS web

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.16.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json .npmrc ./
COPY packages ./packages
COPY apps/web ./apps/web
# 只为满足 lockfile 里的 workspace importer（不参与前端构建）
COPY apps/server/package.json ./apps/server/package.json

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @feedlore/web build

# ---------------- 阶段 2：运行时 ----------------
FROM node:22-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.16.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json .npmrc ./
COPY packages ./packages
COPY apps/server ./apps/server
# 同上：lockfile 里的 apps/web importer 必须存在，否则 --frozen-lockfile 会判定不一致
COPY apps/web/package.json ./apps/web/package.json

# dangerouslyAllowAllBuilds 已在 pnpm-workspace.yaml 开启，否则 esbuild 的 postinstall
# 被拦截会让 install 返回退出码 1，直接打断构建。
RUN pnpm install --frozen-lockfile

# 前端产物由阶段 1 拷入；WEB_ROOT 让 Hono 托管它（同源，无需 CORS）
COPY --from=web /app/apps/web/dist ./apps/web/dist

ENV NODE_ENV=production
ENV PORT=3000
ENV WEB_ROOT=/app/apps/web/dist

EXPOSE 3000

# 健康检查直接打契约端点：DB 未就绪时 /api/health 返回 503 → 容器 unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@feedlore/server", "start"]
