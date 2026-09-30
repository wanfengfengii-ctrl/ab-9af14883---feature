# 洞穴水准网联合配平

把多条往返水准观测**联合**配成一个高程网，避免逐条修正后各段不超差、环路却无法闭合。
前端录入测站、基准高程与带方向的观测；后端对**全部整数高程**联合求解，使每条观测的改正量

```
c_k = H[终点] − H[起点] − 实测高差_k
```

满足 `|c_k| ≤ 最大允许改正量_k`，并按以下优先级依次最优：

1. **最小化最大绝对改正量** M = max |c_k|
2. **最小化绝对改正量总和** S = Σ |c_k|
3. 在前两者最优的前提下，最小化**按测站录入顺序展开的高程序列** (H₁, H₂, …) 的字典序

所有高程、高差、改正量均为整数毫米。

## 目录结构

```
api/                 Node 内置 http 实现的后端（零运行时依赖）
  src/solver.js      整数联合求解器（差分约束 + 精确分数单纯形 + 整数兜底）
  src/server.js      HTTP 服务：/healthz、/api/leveling/adjust
  test/              node:test 单元/性质/随机暴力对比/HTTP 测试
  Dockerfile
web/                 Vite + 原生 JS 前端
  src/main.js        草稿、立即撤销旧结论、结果与环路展示
  nginx.conf         静态托管 + /api 反向代理
  Dockerfile         多阶段：node 构建 → nginx 运行
verify/              一次性校验服务
  run.sh             等待健康 → 代码测试 → 前端构建 → API 冒烟，按失败数退出
  smoke.mjs          闭合网冒烟（可行/不可行/校验失败/反代两条路径）
  Dockerfile
docker-compose.yml   api / web / verify 三服务
.env.example         WEB_PORT、API_PORT 配置样例
```

## 快速开始

```bash
cp .env.example .env      # 可选：修改 WEB_PORT / API_PORT
docker compose up -d --build
# 前端： http://localhost:${WEB_PORT:-8080}
# API：  http://localhost:${API_PORT:-8081}/healthz
```

`WEB_PORT`、`API_PORT` 是**宿主机**暴露端口；容器内部固定为 web 8080 / api 8081。

一次性校验（`verify` 是 `restart: "no"` 的普通一次性服务；`run` 会先等待
api / web 健康，再执行测试、前端构建与冒烟，完成后自行退出，退出码汇总失败步骤数）：

```bash
docker compose run --build --rm verify
```

停止：

```bash
docker compose down
```

## 本地开发（无 Docker 时）

```bash
npm_config_cache=./.npm-cache npm install   # 仅前端构建需要 vite
npm --prefix api test                        # 后端测试
npm --prefix web run build                   # 前端构建
API_PORT=8081 node api/src/server.js         # 启动 API（开发态 vite 会代理 /api）
npm --prefix web run dev                     # 另一终端启动开发服务器
```

## HTTP 接口

### `GET /healthz`

```json
{ "status": "ok", "service": "leveling-api", "time": "..." }
```

### `POST /api/leveling/adjust`

请求：

```json
{
  "stations": ["A", "B", "C", "D", "E"],
  "datumElevation": "1000",
  "observations": [
    { "from": "A", "to": "B", "measuredDifference": "12", "maxCorrection": "5" }
  ]
}
```

约束：测站 5–10 个、名称唯一（第一个为基准站）；观测 7–18 条、方向完整；
基准高程/实测高差/允许改正量均为整数毫米，允许改正量非负；水准网（忽略方向）须连通。

成功（可行）：

```json
{
  "feasible": true,
  "stations": [{ "name": "A", "elevation": "1000" }],
  "corrections": [{
    "from": "A", "to": "B",
    "measuredDifference": "12", "maxCorrection": "5",
    "correction": "-1", "recomputedDifference": "11"
  }],
  "objective": { "maxAbsoluteCorrection": "1", "sumAbsoluteCorrections": "3" }
}
```

成功（但**允许改正量不足**，无可行配平）：HTTP 200，

```json
{ "feasible": false, "reason": "INSUFFICIENT_CORRECTION", "message": "允许改正量不足：…" }
```

输入非法：HTTP 400，`error.code = VALIDATION_FAILED` 并附字段级 `details`；
请求体非 JSON：`INVALID_JSON`。

## 求解原理

1. 令 x₀ = 0、xᵢ = Hᵢ − datum。`|x_v − x_u − w_k| ≤ b_k` 等价于一组成对
   **差分约束**（x_v − x_u ≤ w+b、x_u − x_v ≤ b−w）。用 Floyd-Warshall 判负环
   做可行性判定，对 M 二分（b_k = min(M, cap_k)）得到最小 M*。
2. Floyd 同时给出各 xᵢ 在 M* 下的紧可行整数区间 [loᵢ, hiᵢ]。令 yᵢ = xᵢ − loᵢ，
   全部变量非负，用 **BigInt 精确分数的两阶段单纯形**（Bland 规则）最小化一个
   加权整数目标：t_k（|c_k|）权重最大且压倒字典序项，字典序权重按区间宽度超递增，
   严格实现「先 S 后录入顺序字典序」。
3. 节点-弧关联矩阵**全幺模**、右端为整数，LP 必有整数最优解；另设整数分支定界兜底。

随机测试对数百个小型网络与全枚举暴力最优解逐字段对比（M、S、完整高程序列），
另含往返平行观测、负基准、可行/不可行判定与 HTTP 层测试。

## 前端行为

- 任何草稿编辑（增删改测站/观测、改基准高程）都会**立即撤销旧结论**：
  清空结果区并提示「草稿已修改，旧结论已撤销」，草稿内容完整保留。
- 提交后由真实 API 渲染各站高程、逐观测改正值与回算高差。
- 「环路闭合」表由返回高程沿生成树基础环自然计算：改正后的闭合代数和恒为 0。
- 无可行配平时保留草稿、清除旧结果，并明确提示**允许改正量不足**。
