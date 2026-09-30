# 一次性校验镜像：代码测试 + 前端构建 + API 冒烟
FROM node:22-alpine

WORKDIR /workspace

# API 无第三方依赖；前端仅在构建期需要 vite
COPY api/package.json ./api/package.json
COPY web/package.json ./web/package.json
RUN npm --prefix web install --no-audit --no-fund

COPY api ./api
COPY web ./web
COPY verify ./verify

ENV API_URL=http://api:8081 \
    WEB_URL=http://web:8080 \
    NODE_ENV=development

CMD ["sh", "./verify/run.sh"]
