// 闭合网 API 冒烟：直连 API 与经 nginx 反代两条路径各跑一次，
// 覆盖可行配平（含环路闭合）、允许改正量不足、输入校验失败、健康检查。
// 退出码：0 全部通过；非 0 失败项数量。

const API_URL = process.env.API_URL || 'http://127.0.0.1:8081';
const WEB_URL = process.env.WEB_URL || 'http://127.0.0.1:8080';

let failures = 0;
const ok = (cond, msg) => {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  }
};

async function postJson(base, payload) {
  const resp = await fetch(`${base}/api/leveling/adjust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await resp.json(); } catch { /* 非 JSON */ }
  return { status: resp.status, body };
}

// 带闭合差的可行网：真值 A=1000 B=1010 C=1025 D=1015 E=990，AB 实测多 2mm
const feasibleInput = {
  stations: ['A', 'B', 'C', 'D', 'E'],
  datumElevation: '1000',
  observations: [
    { from: 'A', to: 'B', measuredDifference: '12', maxCorrection: '5' },
    { from: 'B', to: 'C', measuredDifference: '15', maxCorrection: '5' },
    { from: 'C', to: 'D', measuredDifference: '-10', maxCorrection: '5' },
    { from: 'D', to: 'A', measuredDifference: '-15', maxCorrection: '5' },
    { from: 'A', to: 'E', measuredDifference: '-10', maxCorrection: '5' },
    { from: 'E', to: 'D', measuredDifference: '25', maxCorrection: '5' },
    { from: 'B', to: 'E', measuredDifference: '-20', maxCorrection: '5' },
  ],
};

// 同一网但允许改正量全部为 0：闭合差无法消除
const infeasibleInput = {
  ...feasibleInput,
  observations: feasibleInput.observations.map((o) => ({ ...o, maxCorrection: '0' })),
};

// 启用单边失效复核（阈值 1：该网最优改正量恰好全部 ≤1，整网无桥）
const reviewInput = {
  ...feasibleInput,
  review: { enabled: true, trustedCorrectionThreshold: '1' },
};

// 结构性桥边：E 只经单条 A-E 连接，即使阈值充足也复核冗余不足
const reviewBridgeInput = {
  stations: ['A', 'B', 'C', 'D', 'E'],
  datumElevation: '1000',
  observations: [
    { from: 'A', to: 'B', measuredDifference: '10', maxCorrection: '5' },
    { from: 'B', to: 'C', measuredDifference: '15', maxCorrection: '5' },
    { from: 'C', to: 'D', measuredDifference: '-10', maxCorrection: '5' },
    { from: 'D', to: 'A', measuredDifference: '-15', maxCorrection: '5' },
    { from: 'B', to: 'D', measuredDifference: '5', maxCorrection: '5' },
    { from: 'A', to: 'C', measuredDifference: '25', maxCorrection: '5' },
    { from: 'A', to: 'E', measuredDifference: '-10', maxCorrection: '5' },
  ],
  review: { enabled: true, trustedCorrectionThreshold: '5' },
};

// 显式关闭复核：响应须与不带 review 完全一致
const reviewOffInput = { ...feasibleInput, review: { enabled: false, trustedCorrectionThreshold: '9' } };

const badInput = {
  stations: ['A', 'B'], // 数量不足
  datumElevation: 'abc',
  observations: [],
};

function checkFeasibleResult(body, label) {
  ok(body && body.feasible === true, `${label}: feasible=true`);
  if (!body || body.feasible !== true) return;

  const elev = new Map(body.stations.map((s) => [s.name, BigInt(s.elevation)]));
  ok(elev.get('A') === 1000n, `${label}: 基准站高程固定为 1000`);
  ok(body.stations.length === 5, `${label}: 返回 5 个站高程`);
  ok(body.corrections.length === 7, `${label}: 返回 7 条逐观测改正`);

  let maxAbs = 0n;
  let sumAbs = 0n;
  for (const c of body.corrections) {
    const corr = BigInt(c.correction);
    const dh = BigInt(c.measuredDifference);
    const cap = BigInt(c.maxCorrection);
    const a = corr < 0n ? -corr : corr;
    maxAbs = a > maxAbs ? a : maxAbs;
    sumAbs += a;
    ok(corr <= cap && corr >= -cap, `${label}: ${c.from}→${c.to} 改正 ${corr} 未越限 ±${cap}`);
    ok(elev.get(c.to) - elev.get(c.from) === dh + corr,
      `${label}: ${c.from}→${c.to} 终点-起点 = 实测+改正`);
    ok(BigInt(c.recomputedDifference) === dh + corr,
      `${label}: ${c.from}→${c.to} 回算高差一致`);
  }
  ok(maxAbs === BigInt(body.objective.maxAbsoluteCorrection), `${label}: 目标 M=${maxAbs} 自洽`);
  ok(sumAbs === BigInt(body.objective.sumAbsoluteCorrections), `${label}: 目标 S=${sumAbs} 自洽`);
  ok(maxAbs === 1n, `${label}: 最小最大改正量为 1（闭合差需要改正）`);

  // 环路闭合：A-B-C-D-A 与 B-E-D-C-B（由返回高程算，改正后必为 0）
  const corrOf = (from, to) => body.corrections.find((c) => c.from === from && c.to === to);
  const loops = [
    [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A']],
    [['B', 'E'], ['E', 'D'], ['D', 'C'], ['C', 'B']],
  ];
  for (const cy of loops) {
    let sum = 0n;
    for (const [u, v] of cy) {
      const c = corrOf(u, v) || corrOf(v, u);
      const sign = corrOf(u, v) ? 1n : -1n;
      sum += sign * (BigInt(c.measuredDifference) + BigInt(c.correction));
    }
    ok(sum === 0n, `${label}: 环路 ${cy.map(([u, v]) => u + v).join('-')} 改正后闭合（代数和 0）`);
  }
}

async function checkTarget(base, label) {
  console.log(`\n[smoke] ${label} (${base})`);

  const health = await fetch(`${base}/healthz`);
  ok(health.status === 200, `${label}: GET /healthz → 200`);

  const good = await postJson(base, feasibleInput);
  ok(good.status === 200, `${label}: 可行配平 HTTP 200`);
  checkFeasibleResult(good.body, label);

  const tight = await postJson(base, infeasibleInput);
  ok(tight.status === 200 && tight.body.feasible === false,
    `${label}: 允许改正量不足返回 feasible=false（HTTP 200 业务结果）`);
  ok(tight.body?.reason === 'INSUFFICIENT_CORRECTION', `${label}: 原因码 INSUFFICIENT_CORRECTION`);
  ok(/允许改正量不足/.test(tight.body?.message || ''), `${label}: 明确指出允许改正量不足`);
  ok(Array.isArray(tight.body?.stations) && tight.body.stations[0]?.elevation === '1000',
    `${label}: 不可行时仍回带测站与基准高程`);

  const bad = await postJson(base, badInput);
  ok(bad.status === 400, `${label}: 非法输入 HTTP 400`);
  ok(bad.body?.error?.code === 'VALIDATION_FAILED', `${label}: 错误码 VALIDATION_FAILED`);
  ok(Array.isArray(bad.body?.error?.details) && bad.body.error.details.length > 0,
    `${label}: 返回字段级错误明细`);

  await checkReview(base, label);

  const malformed = await fetch(`${base}/api/leveling/adjust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  ok(malformed.status === 400, `${label}: 非法 JSON HTTP 400`);
}

async function checkReview(base, label) {
  // 启用单边失效复核
  const rv = await postJson(base, reviewInput);
  ok(rv.status === 200 && rv.body?.feasible === true, `${label}: 复核启用可行配平 HTTP 200`);
  const body = rv.body;
  if (body?.feasible !== true) return;
  ok(body.review?.enabled === true && body.review?.redundant === true,
    `${label}: review.enabled/redundant 为 true`);
  ok(body.review?.trustedCorrectionThreshold === '1', `${label}: 回带阈值 1`);

  const elev = new Map(body.stations.map((s) => [s.name, BigInt(s.elevation)]));
  const T = 1n;
  const inNet = [];
  body.corrections.forEach((c, k) => {
    const a = BigInt(c.correction) < 0n ? -BigInt(c.correction) : BigInt(c.correction);
    ok(typeof c.inReviewNetwork === 'boolean', `${label}: 每条观测都标注是否进入复核网`);
    ok(c.inReviewNetwork === (a <= T),
      `${label}: ${c.from}→${c.to} 复核网归属可由改正值与阈值独立核对（|${c.correction}| ≤ ${T}）`);
    if (c.inReviewNetwork) inNet.push(k);
  });
  ok(inNet.length === 7, `${label}: 该网 7 条观测全部进入复核网`);

  // 两路见证：每个非基准站两条边不相交路径，代数和等于高程差
  const stations = body.stations.map((s) => s.name);
  ok(Array.isArray(body.review.witnessPaths) && body.review.witnessPaths.length === stations.length - 1,
    `${label}: 为每个非基准站返回两路见证`);
  const obsList = reviewInput.observations;
  for (const w of body.review.witnessPaths) {
    ok(w.paths.length === 2, `${label}: ${w.station} 有两条路径`);
    const sets = w.paths.map((p) => new Set(p.map((h) => h.observationIndex)));
    let disjoint = true;
    for (const k of sets[0]) if (sets[1].has(k)) disjoint = false;
    ok(disjoint, `${label}: 到 ${w.station} 的两路见证无公共观测`);
    const sums = w.paths.map((path) => {
      let cur = stations[0];
      let sum = 0n;
      for (const h of path) {
        const o = obsList[h.observationIndex];
        const c = body.corrections[h.observationIndex];
        ok(c.inReviewNetwork === true, `${label}: 见证只走复核边`);
        const sign = o.from === cur ? 1n : -1n;
        sum += sign * (BigInt(o.measuredDifference) + BigInt(c.correction));
        cur = sign === 1n ? o.to : o.from;
      }
      return { sum, end: cur };
    });
    for (const s of sums) {
      ok(s.end === w.station, `${label}: 见证路径终点为 ${w.station}`);
      ok(s.sum === elev.get(w.station) - elev.get(stations[0]),
        `${label}: 到 ${w.station} 的见证可由返回改正值核对到高程差 ${s.sum}`);
    }
  }

  // 任一复核边失效后仍全部可达基准站
  const idx = new Map(stations.map((s, i) => [s, i]));
  for (const dead of inNet) {
    const c = body.corrections[dead];
    const adj = new Map(stations.map((_, i) => [i, []]));
    inNet.filter((k) => k !== dead).forEach((k) => {
      const x = body.corrections[k];
      adj.get(idx.get(x.from)).push(idx.get(x.to));
      adj.get(idx.get(x.to)).push(idx.get(x.from));
    });
    const seen = new Set([0]);
    const stk = [0];
    while (stk.length) {
      const u = stk.pop();
      for (const v of adj.get(u)) if (!seen.has(v)) { seen.add(v); stk.push(v); }
    }
    ok(seen.size === stations.length,
      `${label}: 复核边 ${c.from}→${c.to} 失效后各测站仍可达基准站`);
  }

  // 显式关闭复核：与不带 review 的响应逐字段一致
  const [plainNow, off] = await Promise.all([postJson(base, feasibleInput), postJson(base, reviewOffInput)]);
  ok(off.status === 200, `${label}: 显式关闭复核 HTTP 200`);
  ok(plainNow.status === 200 && JSON.stringify(off.body) === JSON.stringify(plainNow.body),
    `${label}: review.enabled=false 与原请求响应完全一致`);

  // 结构性桥边：冗余不足
  const bridge = await postJson(base, reviewBridgeInput);
  ok(bridge.status === 200 && bridge.body?.feasible === false,
    `${label}: 复核冗余不足返回业务失败（HTTP 200）`);
  ok(bridge.body?.reason === 'REVIEW_NOT_REDUNDANT', `${label}: 原因码 REVIEW_NOT_REDUNDANT`);
  ok(/复核冗余不足/.test(bridge.body?.message || ''), `${label}: 明确报告复核冗余不足`);
  ok(bridge.body?.review?.redundant === false, `${label}: review.redundant=false`);
  ok(Array.isArray(bridge.body?.observations) && bridge.body.observations.length === 7,
    `${label}: 冗余不足时保留草稿观测回显`);
  ok(bridge.body?.stations?.[0]?.elevation === '1000', `${label}: 冗余不足时回带基准高程`);

  // 非法阈值：400 且定位到字段
  const badThreshold = await postJson(base, { ...reviewInput, review: { enabled: true, trustedCorrectionThreshold: '-1' } });
  ok(badThreshold.status === 400, `${label}: 负阈值 HTTP 400`);
  ok(badThreshold.body?.error?.code === 'VALIDATION_FAILED', `${label}: 负阈值 VALIDATION_FAILED`);
  ok(badThreshold.body?.error?.details?.some((d) => /trustedCorrectionThreshold/.test(d.field)),
    `${label}: 负阈值定位到 review.trustedCorrectionThreshold`);
}

await checkTarget(API_URL, '直连 API');
await checkTarget(WEB_URL, '经 nginx 反代');

console.log(`\n[smoke] 失败项：${failures}`);
process.exit(failures === 0 ? 0 : 1);
