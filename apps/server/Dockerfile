# FeedLore v2 —— apps/server 容器（P3 测试镜像）
#
# 构建上下文必须是**仓库根目录**（monorepo），因为需要 packages/* 与根级 workspace 清单：
#   docker build -f apps/server/Dockerfile -t feedlore-v2:test .
#
# ⚠️ 该镜像仅供 172.26.1.2 测试用，与线上 ghcr.io/chensnails/feedlore:latest 完全无关，
#    绝不能被 watchtower 拉取（本机 watchtower 只更新带 enable 标签的容器，这里不打标签）。

FROM node:22-slim

WORKDIR /app

# pnpm 走 corepack，版本与根 package.json 的 packageManager 保持一致
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate

# 先只拷清单，最大化利用 Docker 层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json .npmrc ./

# 源码：契约层 + 数据层 + 服务层（apps/legacy 与 apps/web 不进镜像）
COPY packages ./packages
COPY apps/server ./apps/server

# 注：pnpm-workspace.yaml 里声明了 apps/web（尚未创建），pnpm 对匹配不到的 glob 只是忽略。
# dangerouslyAllowAllBuilds 已在 pnpm-workspace.yaml 开启，否则 esbuild 的 postinstall
# 被拦截会让 install 返回退出码 1，直接打断构建。
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# 健康检查直接打契约端点：DB 未就绪时 /api/health 返回 503 → 容器 unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@feedlore/server", "start"]
