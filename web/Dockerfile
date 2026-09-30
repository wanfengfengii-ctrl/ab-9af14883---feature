# ---- 构建阶段 ----
FROM node:22-alpine AS build
WORKDIR /app

COPY web/package.json ./package.json
RUN npm install --no-audit --no-fund

COPY web/ ./
RUN npm run build

# ---- 运行阶段：纯静态 + 反代 API ----
FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf

# 容器内固定 8080；宿主机发布端口由 Compose 的 WEB_PORT 决定
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=20 \
  CMD wget -qO- "http://127.0.0.1:8080/healthz" >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
