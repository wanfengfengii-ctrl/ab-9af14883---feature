# 水准配平 API 镜像（无第三方运行时依赖）
# 构建上下文为 api/ 目录（见 docker-compose.yml）
FROM node:22-alpine

WORKDIR /app

# 先拷清单以利用层缓存（本服务无外部依赖）
COPY package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production \
    API_PORT=8081 \
    API_HOST=0.0.0.0

EXPOSE 8081

# busybox wget 在 alpine 中可用；shell 形式在容器运行时展开 $API_PORT
HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=20 \
  CMD wget -qO- "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]
