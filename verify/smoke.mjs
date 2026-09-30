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
