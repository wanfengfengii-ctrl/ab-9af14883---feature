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

// 启用单边失效复核（阈值 1mm；原最优解 M=1，其复核边本身成无桥网）
const reviewInput = {
  ...feasibleInput,
  review: { enabled: true, trustedThreshold: '1' },
};

// 结构性桥网：E 仅经 A-E 一条观测与主网相连（其余 6 条在 A-B-C-D 环上）
const bridgeInput = {
  stations: ['A', 'B', 'C', 'D', 'E'],
  datumElevation: '1000',
  observations: [
    { from: 'A', to: 'B', measuredDifference: '10', maxCorrection: '5' },
    { from: 'B', to: 'C', measuredDifference: '15', maxCorrection: '5' },
    { from: 'C', to: 'D', measuredDifference: '-10', maxCorrection: '5' },
    { from: 'D', to: 'A', measuredDifference: '-15', maxCorrection: '5' },
    { from: 'B', to: 'C', measuredDifference: '16', maxCorrection: '5' },
    { from: 'C', to: 'B', measuredDifference: '-14', maxCorrection: '5' },
    { from: 'A', to: 'E', measuredDifference: '-10', maxCorrection: '5' },
  ],
  review: { enabled: true, trustedThreshold: '5' },
};

// 原网络不可行（cap 全 0）+ 启用复核：仍判 INSUFFICIENT_CORRECTION
const reviewInfeasibleInput = {
  ...feasibleInput,
  observations: feasibleInput.observations.map((o) => ({ ...o, maxCorrection: '0' })),
  review: { enabled: true, trustedThreshold: '0' },
};

// 阈值非法（负数）
const reviewBadInput = {
  ...feasibleInput,
  review: { enabled: true, trustedThreshold: '-2' },
};

// 独立复核复核网不变量：标记、见证路径、单边失效
function checkReviewInvariants(body, input, label) {
  ok(body.review && body.review.enabled === true, `${label}: review.enabled=true`);
  ok(body.review.trustedThreshold === '1', `${label}: 阈值原样返回`);
  ok(body.review.sufficient === true, `${label}: sufficient=true`);
  const T = 1n;
  const flags = body.review.reviewEdges;
  ok(Array.isArray(flags) && flags.length === body.corrections.length,
    `${label}: 每条观测都有是否入复核网标记`);
  flags.forEach((f, k) => {
    const a = BigInt(body.corrections[k].correction);
    const abs = a < 0n ? -a : a;
    const cap = BigInt(body.corrections[k].maxCorrection);
    ok(abs <= cap, `${label}: 观测 ${k} 改正未越其允许改正量 ±${cap}`);
    ok(f === (abs <= T), `${label}: 观测 ${k} 复核标记与 |改正|≤阈值 一致`);
  });
  ok(body.review.reviewEdgeCount === flags.filter(Boolean).length, `${label}: 复核边计数自洽`);

  const idx = new Map(input.stations.map((s, i) => [s, i]));
  const netEdges = flags.map((f, k) => f ? [
    idx.get(body.corrections[k].from), idx.get(body.corrections[k].to), k,
  ] : null).filter(Boolean);

  // 删任一条复核边后全部测站仍可达基准站
  for (const [, , dead] of netEdges) {
    const adj = input.stations.map(() => []);
    for (const [u, v, k] of netEdges) if (k !== dead) { adj[u].push(v); adj[v].push(u); }
    const seen = new Array(input.stations.length).fill(false);
    seen[0] = true; const st = [0];
    while (st.length) { const u = st.pop(); for (const v of adj[u]) if (!seen[v]) { seen[v] = true; st.push(v); } }
    ok(seen.every(Boolean), `${label}: 删复核边 ${dead} 后各站仍连基准站`);
  }

  // 每个非基准站两条无公共观测的基准路径，且只经复核边
  ok(body.review.witnesses.length === input.stations.length - 1, `${label}: 每非基准站一组见证`);
  for (const w of body.review.witnesses) {
    ok(w.paths.length === 2, `${label}: ${w.station} 有两条见证路径`);
    const sets = w.paths.map((p) => new Set(p.observations));
    ok([...sets[0]].every((k) => !sets[1].has(k)), `${label}: ${w.station} 两路径无公共观测`);
    for (const p of w.paths) {
      ok(p.stations[0] === w.station && p.stations.at(-1) === input.stations[0],
        `${label}: ${w.station} 路径起于该站、终于基准站`);
      for (let i = 0; i < p.observations.length; i++) {
        const k = p.observations[i];
        ok(flags[k] === true, `${label}: 见证路径只用复核边`);
        const a = idx.get(p.stations[i]), b = idx.get(p.stations[i + 1]);
        const c = body.corrections[k];
        ok((idx.get(c.from) === a && idx.get(c.to) === b)
          || (idx.get(c.from) === b && idx.get(c.to) === a),
        `${label}: 见证路径与观测起终点一致`);
        const abs = BigInt(c.correction) < 0n ? -BigInt(c.correction) : BigInt(c.correction);
        ok(abs <= T, `${label}: 见证边可由改正值独立核对（|改正|≤阈值）`);
      }
    }
  }
}


// 同一网但允许改正量全部为 0：闭合差无法消除
const infeasibleInput = {
  ...feasibleInput,
  observations: feasibleInput.observations.map((o) => ({ ...o, maxCorrection: '0' })),
};

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
  ok(!('review' in (good.body || {})), `${label}: 未启用复核时响应不含 review 字段`);

  // 显式 enabled=false：请求、裁决与结果同未启用
  const disabled = await postJson(base, { ...feasibleInput, review: { enabled: false } });
  ok(disabled.status === 200 && disabled.body.feasible === true, `${label}: review.enabled=false 正常配平`);
  ok(!('review' in (disabled.body || {})), `${label}: enabled=false 响应不含 review 字段`);
  ok(disabled.body?.objective?.maxAbsoluteCorrection === good.body.objective.maxAbsoluteCorrection
    && disabled.body?.objective?.sumAbsoluteCorrections === good.body.objective.sumAbsoluteCorrections,
  `${label}: enabled=false 三级裁决与未启用一致`);

  // 启用单边失效复核：可行 + 复核网/见证不变量（直连与反代各验一遍）
  const reviewed = await postJson(base, reviewInput);
  ok(reviewed.status === 200 && reviewed.body.feasible === true, `${label}: 启用复核 HTTP 200 feasible=true`);
  if (reviewed.body?.feasible === true) checkReviewInvariants(reviewed.body, reviewInput, label);

  // 结构桥：复核冗余不足（区别于允许改正量不足）
  const bridge = await postJson(base, bridgeInput);
  ok(bridge.status === 200 && bridge.body.feasible === false, `${label}: 桥网返回 feasible=false`);
  ok(bridge.body?.reason === 'REVIEW_REDUNDANCY_INSUFFICIENT', `${label}: 原因码 REVIEW_REDUNDANCY_INSUFFICIENT`);
  ok(/复核冗余不足/.test(bridge.body?.message || ''), `${label}: 明确报告复核冗余不足`);
  ok(bridge.body?.review?.sufficient === false && bridge.body?.review?.trustedThreshold === '5',
    `${label}: 复核失败仍回带阈值与 sufficient=false`);
  ok(Array.isArray(bridge.body?.stations) && bridge.body.stations[0]?.elevation === '1000',
    `${label}: 复核失败保留草稿数据（基准高程回带）`);

  // 原网络不可行 + 启用复核：优先报允许改正量不足
  const revInf = await postJson(base, reviewInfeasibleInput);
  ok(revInf.status === 200 && revInf.body.feasible === false, `${label}: 不可行+复核 feasible=false`);
  ok(revInf.body?.reason === 'INSUFFICIENT_CORRECTION', `${label}: 原因码仍为 INSUFFICIENT_CORRECTION`);

  // 阈值非法：400 字段级错误
  const revBad = await postJson(base, reviewBadInput);
  ok(revBad.status === 400 && revBad.body?.error?.code === 'VALIDATION_FAILED',
    `${label}: 负阈值 HTTP 400 VALIDATION_FAILED`);
  ok((revBad.body?.error?.details || []).some((d) => /trustedThreshold/.test(d.field)),
    `${label}: 负阈值返回字段级明细`);

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

  const malformed = await fetch(`${base}/api/leveling/adjust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  ok(malformed.status === 400, `${label}: 非法 JSON HTTP 400`);
}

await checkTarget(API_URL, '直连 API');
await checkTarget(WEB_URL, '经 nginx 反代');

console.log(`\n[smoke] 失败项：${failures}`);
process.exit(failures === 0 ? 0 : 1);
