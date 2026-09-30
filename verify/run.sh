#!/bin/sh
# 一次性 verify：等待健康 → 代码测试 → 前端构建 → 闭合网 API 冒烟。
# 任一关键步骤失败都计入退出码，最后一次性退出汇总。

set -u

FAIL=0

wait_health() {
  name="$1"; url="$2"; tries=60
  echo "[verify] waiting for ${name} health: ${url}/healthz"
  while [ "$tries" -gt 0 ]; do
    if wget -qO- "${url}/healthz" >/dev/null 2>&1; then
      echo "[verify] ${name} is healthy"
      return 0
    fi
    tries=$((tries - 1))
    sleep 2
  done
  echo "[verify] FATAL: ${name} 未在限定时间内变健康" >&2
  return 1
}

wait_health "api" "${API_URL:-http://api:8081}" || FAIL=$((FAIL + 1))
wait_health "web" "${WEB_URL:-http://web:8080}" || FAIL=$((FAIL + 1))

if [ "$FAIL" -eq 0 ]; then
  echo "[verify] (1/3) 后端代码测试（node --test）"
  npm --prefix api test || FAIL=$((FAIL + 1))

  echo "[verify] (2/3) 前端构建（vite build）"
  npm --prefix web run build || FAIL=$((FAIL + 1))

  echo "[verify] (3/3) 闭合网 API 冒烟"
  node verify/smoke.mjs || FAIL=$((FAIL + 1))
fi

if [ "$FAIL" -eq 0 ]; then
  echo "[verify] ALL CHECKS PASSED"
else
  echo "[verify] CHECKS FAILED (failed steps: ${FAIL})" >&2
fi
exit "$FAIL"
