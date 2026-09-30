import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveNetwork, validateInput, ValidationError } from '../src/solver.js';
import { analyzeGraph, witnessPaths } from '../src/review.js';

function makeInput({ stations, datum, obs, review }) {
  const out = {
    stations,
    datumElevation: String(datum),
    observations: obs.map(([from, to, dh, cap]) => ({
      from, to,
      measuredDifference: String(dh),
      maxCorrection: String(cap),
    })),
  };
  if (review !== undefined) out.review = review;
  return out;
}

const S5 = ['A', 'B', 'C', 'D', 'E'];
const BASE_OBS = [
  ['A', 'B', 12, 5], ['B', 'C', 15, 5], ['C', 'D', -10, 5],
  ['D', 'A', -15, 5], ['A', 'E', -10, 5], ['E', 'D', 25, 5], ['B', 'E', -20, 5],
];

// 复核成功结果的结构性不变量：标记一致、复核网无桥、见证两两不共边、删边不断
function assertReviewInvariants(input, r) {
  assert.equal(r.feasible, true);
  const rv = r.review;
  assert.ok(rv && rv.enabled === true && rv.sufficient === true);
  const T = BigInt(rv.trustedThreshold);
  const names = input.stations;
  const idx = new Map(names.map((s, i) => [s, i]));
  const elev = new Map(r.stations.map((s) => [s.name, BigInt(s.elevation)]));

  assert.equal(rv.reviewEdges.length, r.corrections.length);
  const flagged = [];
  r.corrections.forEach((c, k) => {
    const a = BigInt(c.correction); const abs = a < 0n ? -a : a;
    assert.ok(abs <= BigInt(c.maxCorrection), `观测 ${k} 改正量不得超过其允许改正量`);
    assert.equal(rv.reviewEdges[k], abs <= T, `观测 ${k} 标记与阈值不一致`);
    // 改正值自洽
    assert.equal(elev.get(c.to) - elev.get(c.from),
      BigInt(c.measuredDifference) + BigInt(c.correction));
    if (rv.reviewEdges[k]) {
      flagged.push({ u: idx.get(c.from), v: idx.get(c.to), k });
    }
  });
  assert.equal(rv.reviewEdgeCount, flagged.length);

  // 复核网连通且无桥
  assert.deepEqual(analyzeGraph(names.length, flagged), { connected: true, bridgeCount: 0 });

  // 删任一条复核边，全部测站仍可达基准站
  for (const dead of flagged) {
    const adj = names.map(() => []);
    for (const e of flagged) {
      if (e.k === dead.k) continue;
      adj[e.u].push(e.v); adj[e.v].push(e.u);
    }
    const seen = new Array(names.length).fill(false);
    seen[0] = true; const st = [0];
    while (st.length) { const u = st.pop(); for (const v of adj[u]) if (!seen[v]) { seen[v] = true; st.push(v); } }
    assert.ok(seen.every(Boolean), `删复核边 ${dead.k} 后仍应全部连通基准站`);
  }

  // 每个非基准站两条无公共观测的基准路径
  assert.equal(rv.witnesses.length, names.length - 1);
  for (let i = 1; i < names.length; i++) {
    const w = rv.witnesses[i - 1];
    assert.equal(w.station, names[i]);
    assert.equal(w.paths.length, 2);
    const [p1, p2] = w.paths;
    // 起终点
    assert.equal(p1.stations[0], names[i]); assert.equal(p1.stations.at(-1), names[0]);
    assert.equal(p2.stations[0], names[i]); assert.equal(p2.stations.at(-1), names[0]);
    // 无公共观测
    const common = p1.observations.filter((k) => p2.observations.includes(k));
    assert.deepEqual(common, [], `${names[i]} 两见证路径不得共享观测`);
    // 全部为复核边、端点一致、可由改正值独立核对阈值
    for (const p of [p1, p2]) {
      for (let j = 0; j < p.observations.length; j++) {
        const k = p.observations[j];
        assert.equal(rv.reviewEdges[k], true);
        const c = r.corrections[k];
        const a = BigInt(c.correction); const abs = a < 0n ? -a : a;
        assert.ok(abs <= T, '见证边改正量须不超过阈值');
        const ua = idx.get(p.stations[j]); const va = idx.get(p.stations[j + 1]);
        assert.ok(
          (idx.get(c.from) === ua && idx.get(c.to) === va)
          || (idx.get(c.from) === va && idx.get(c.to) === ua),
          '见证路径相邻站点必须与观测端点一致');
      }
    }
  }
}

test('启用复核：标准示例各阈值均给出无桥复核网与两条见证', () => {
  for (const T of ['0', '1', '2', '5']) {
    const input = makeInput({ stations: S5, datum: 1000, obs: BASE_OBS,
      review: { enabled: true, trustedThreshold: T } });
    const r = solveNetwork(input);
    assertReviewInvariants(input, r);
  }
});

test('未启用 / enabled=false：请求裁决与结果结构与旧版完全一致', () => {
  const plain = makeInput({ stations: S5, datum: 1000, obs: BASE_OBS });
  const off = makeInput({ stations: S5, datum: 1000, obs: BASE_OBS,
    review: { enabled: false } });
  const r1 = solveNetwork(plain);
  const r2 = solveNetwork(off);
  assert.ok(!('review' in r1));
  assert.ok(!('review' in r2));
  assert.deepEqual(r1, r2);
  // 启用时结果多且仅多 review 块；裁决可能因联合约束改变
  const on = solveNetwork(makeInput({ stations: S5, datum: 1000, obs: BASE_OBS,
    review: { enabled: true, trustedThreshold: '1' } }));
  assert.ok(on.review);
  delete on.review;
  // 删除 review 块后其余字段仍自洽（此例原解本身合格，裁决应不变）
  assert.deepEqual(on.objective, r1.objective);
});

test('结构性桥：REVIEW_REDUNDANCY_INSUFFICIENT，保留草稿与基准高程', () => {
  const obs = [
    ['A', 'B', 10, 5], ['B', 'C', 15, 5], ['C', 'D', -10, 5],
    ['D', 'A', -15, 5], ['B', 'C', 16, 5], ['C', 'B', -14, 5],
    ['A', 'E', -10, 5], // E 唯一连接：桥
  ];
  const input = makeInput({ stations: S5, datum: 1000, obs,
    review: { enabled: true, trustedThreshold: '5' } });
  const r = solveNetwork(input);
  assert.equal(r.feasible, false);
  assert.equal(r.reason, 'REVIEW_REDUNDANCY_INSUFFICIENT');
  assert.match(r.message, /复核冗余不足/);
  assert.equal(r.review.sufficient, false);
  assert.equal(r.review.trustedThreshold, '5');
  assert.equal(r.stations[0].elevation, '1000');
  assert.equal(r.stations[1].elevation, null);
});

test('原网络不可行时启用复核：仍报 INSUFFICIENT_CORRECTION', () => {
  const obs = BASE_OBS.map(([f, t]) => [f, t, 0, 0]);
  // 上面的映射丢了原高差，重建：cap 全 0
  const zero = [
    ['A', 'B', 12, 0], ['B', 'C', 15, 0], ['C', 'D', -10, 0],
    ['D', 'A', -15, 0], ['A', 'E', -10, 0], ['E', 'D', 25, 0], ['B', 'E', -20, 0],
  ];
  void obs;
  const input = makeInput({ stations: S5, datum: 1000, obs: zero,
    review: { enabled: true, trustedThreshold: '0' } });
  const r = solveNetwork(input);
  assert.equal(r.feasible, false);
  assert.equal(r.reason, 'INSUFFICIENT_CORRECTION');
});

test('阈值校验：类型、整数性、非负', () => {
  const base = makeInput({ stations: S5, datum: 1000, obs: BASE_OBS });
  assert.throws(() => validateInput({ ...base, review: 'x' }), ValidationError);
  assert.throws(() => validateInput({ ...base, review: {} }), ValidationError);
  assert.throws(() => validateInput({ ...base, review: { enabled: 'yes' } }), ValidationError);
  assert.throws(() => validateInput({ ...base,
    review: { enabled: true, trustedThreshold: '1.5' } }), ValidationError);
  assert.throws(() => validateInput({ ...base,
    review: { enabled: true, trustedThreshold: '-1' } }), ValidationError);
  // enabled=false 时不需要阈值
  assert.doesNotThrow(() => validateInput({ ...base, review: { enabled: false } }));
  // 合法：0 与大整数
  assert.doesNotThrow(() => validateInput({ ...base,
    review: { enabled: true, trustedThreshold: '0' } }));
  assert.doesNotThrow(() => validateInput({ ...base,
    review: { enabled: true, trustedThreshold: '1000000000' } }));
  assert.throws(() => validateInput({ ...base,
    review: { enabled: true, trustedThreshold: '1000000001' } }), ValidationError);
});

// ---- 暴力枚举复核联合最优，证明「联合」而非先解后查 ----------------------

function floydAll(n, problem) {
  const dist = Array.from({ length: n }, () => new Array(n).fill(null));
  for (let i = 0; i < n; i++) dist[i][i] = 0n;
  for (const o of problem.observations) {
    const w = o.measuredDifference; const b = o.maxCorrection;
    const up = (u, v, ww) => { if (dist[u][v] === null || ww < dist[u][v]) dist[u][v] = ww; };
    up(o.fromIndex, o.toIndex, w + b); up(o.toIndex, o.fromIndex, b - w);
  }
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
    if (dist[i][k] === null) continue;
    for (let j = 0; j < n; j++) {
      if (dist[k][j] === null) continue;
      const nd = dist[i][k] + dist[k][j];
      if (dist[i][j] === null || nd < dist[i][j]) dist[i][j] = nd;
    }
  }
  return dist;
}

function bridgelessOf(n, observations, trusted) {
  const edges = [];
  observations.forEach((o, k) => { if (trusted[k]) edges.push({ u: o.fromIndex, v: o.toIndex, k }); });
  const a = analyzeGraph(n, edges);
  return a.connected && a.bridgeCount === 0;
}

// 在硬 cap 可行集上枚举，按三级裁决选出「复核合格」的最优解
function bruteReview(problem, T) {
  const { stations, datum, observations } = problem;
  const n = stations.length;
  const dist = floydAll(n, problem);
  for (let i = 0; i < n; i++) if (dist[i][i] < 0n) return null;
  const ranges = [];
  for (let i = 1; i < n; i++) ranges.push([-dist[i][0], dist[0][i]]);

  let best = null;
  const x = new Array(n - 1);
  const keyLess = (a, b) => { for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; } return false; };
  const evalX = () => {
    const rel = [0n, ...x];
    const corr = [];
    let M = 0n, S = 0n;
    for (const o of observations) {
      const c = rel[o.toIndex] - rel[o.fromIndex] - o.measuredDifference;
      if (c > o.maxCorrection || c < -o.maxCorrection) return;
      const a = c < 0n ? -c : c; M = a > M ? a : M; S += a; corr.push(c);
    }
    const trusted = corr.map((c) => (c < 0n ? -c : c) <= T);
    if (!bridgelessOf(n, observations, trusted)) return;
    const key = [M, S, ...x];
    if (!best || keyLess(key, best.key)) best = { key, corr, x: x.slice() };
  };
  const rec = (i) => {
    if (i === n - 1) { evalX(); return; }
    const [lo, hi] = ranges[i];
    for (let v = lo; v <= hi; v++) { x[i] = v; rec(i + 1); }
  };
  rec(0);
  return best;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('随机小网：复核联合最优与暴力枚举一致（含成功与冗余不足）', () => {
  const rand = mulberry32(777);
  const n = 5;
  const stations = S5;
  let success = 0; let insufficient = 0;
  for (let trial = 0; trial < 60; trial++) {
    const truth = [0n];
    for (let i = 1; i < n; i++) truth.push(BigInt(Math.floor(rand() * 7) - 3));
    const edgeSet = new Set(); const pairs = [];
    const addEdge = (u, v) => { const key = u * n + v;
      if (u === v || edgeSet.has(key)) return false; edgeSet.add(key); pairs.push([u, v]); return true; };
    const conn = [0];
    while (conn.length < n) {
      const u = conn[Math.floor(rand() * conn.length)];
      const v = Math.floor(rand() * n);
      if (!conn.includes(v)) { addEdge(u, v); conn.push(v); }
    }
    let guard = 0;
    while (pairs.length < 7 && guard++ < 200) {
      addEdge(Math.floor(rand() * n), Math.floor(rand() * n));
    }
    const obs = pairs.map(([u, v]) => {
      const noise = BigInt(Math.floor(rand() * 5) - 2);
      return [stations[u], stations[v], truth[v] - truth[u] + noise, 1n + BigInt(Math.floor(rand() * 3))];
    });
    const T = BigInt(Math.floor(rand() * 3)); // 0..2，常常偏紧
    const input = makeInput({ stations, datum: 1000, obs,
      review: { enabled: true, trustedThreshold: String(T) } });
    const problem = validateInput(input);
    // 硬 cap 不可行的网跳过（前置阶段，与复核无关）
    const dist = floydAll(n, problem);
    if (dist.some((row, i) => row[i] < 0n)) continue;

    const r = solveNetwork(input);
    const brute = bruteReview(problem, T);
    if (!brute) {
      insufficient++;
      assert.equal(r.feasible, false, `trial ${trial} T=${T}：暴力无合格复核解`);
      assert.equal(r.reason, 'REVIEW_REDUNDANCY_INSUFFICIENT');
      continue;
    }
    success++;
    assert.equal(r.feasible, true, `trial ${trial} T=${T}：暴力有解`);
    assertReviewInvariants(input, r);
    assert.equal(BigInt(r.objective.maxAbsoluteCorrection), brute.key[0], `trial ${trial} M`);
    assert.equal(BigInt(r.objective.sumAbsoluteCorrections), brute.key[1], `trial ${trial} S`);
    const datum = 1000n;
    for (let i = 1; i < n; i++) {
      assert.equal(BigInt(r.stations[i].elevation) - datum, brute.x[i - 1],
        `trial ${trial} 高程序列第 ${i} 位`);
    }
  }
  assert.ok(success >= 5, `复核成功样本过少：${success}`);
  assert.ok(insufficient >= 3, `应包含复核冗余不足样本：${insufficient}`);
});

test('联合性反例：原最优解的紧边集不含基准站（有桥/不连通），联合解却存在', () => {
  // 主环闭合差 + 旁路。无约束最优 M=1，但其 T=0 紧边（c=0）里没有任何一条
  // 与基准站 A 相连——若「先取原最优、再检查桥边」只能判失败。
  // 联合裁决换到 M=2、S=2 的另一组高程，6 条观测 c=0 组成无桥复核网。
  const obs = [
    ['A', 'B', 12, 4], ['B', 'C', 15, 4], ['C', 'D', -10, 4],
    ['D', 'A', -17, 4], // 主环实测和 12+15-10-17=0
    ['A', 'E', -10, 4], ['E', 'D', 25, 4], ['B', 'E', -20, 4],
  ];
  const input = makeInput({ stations: S5, datum: 1000, obs,
    review: { enabled: true, trustedThreshold: '0' } });
  const plain = solveNetwork(makeInput({ stations: S5, datum: 1000, obs }));
  assert.equal(plain.objective.maxAbsoluteCorrection, '1');

  // 原最优解在 T=0 下的紧边不构成覆盖基准站的复核网（事后检查必失败）
  const idx = new Map(S5.map((s, i) => [s, i]));
  const tightEdges = plain.corrections
    .map((c, k) => ({ c: BigInt(c.correction), k, from: c.from, to: c.to }))
    .filter((e) => e.c === 0n);
  assert.ok(!tightEdges.some((e) => e.from === 'A' || e.to === 'A'),
    '原最优解的紧边不应连接基准站 A');

  const on = solveNetwork(input);
  assert.equal(on.feasible, true, '联合裁决应能找到合格复核解');
  assertReviewInvariants(input, on);
  // 为满足复核约束，M 由 1 退化到 2（联合而非原解）
  assert.equal(on.objective.maxAbsoluteCorrection, '2');
  assert.equal(on.objective.sumAbsoluteCorrections, '2');
  // 复核网确含连接基准站的紧边
  assert.ok(on.review.reviewEdges.some((f, k) => f
    && (on.corrections[k].from === 'A' || on.corrections[k].to === 'A')));
});

test('阈值大于部分允许改正量：小 cap 边恒为复核边且改正不越其 cap', () => {
  // 阈值 T=5，但部分环边 cap=1（≤T，恒紧）；改正只能在 ±1 内，仍须成无桥网
  const obs = [
    ['A', 'B', 12, 1], ['B', 'C', 15, 1], ['C', 'D', -10, 1],
    ['D', 'A', -15, 5], ['A', 'E', -10, 5], ['E', 'D', 25, 5], ['B', 'E', -20, 5],
  ];
  const input = makeInput({ stations: S5, datum: 1000, obs,
    review: { enabled: true, trustedThreshold: '5' } });
  const r = solveNetwork(input);
  assertReviewInvariants(input, r);
  r.corrections.forEach((c) => {
    assert.ok(BigInt(c.correction) <= BigInt(c.maxCorrection));
    assert.ok(BigInt(c.correction) >= -BigInt(c.maxCorrection));
  });
});

test('witnessPaths：无桥多重图返回两条边不相交路径，含桥图找不到第二路径', () => {
  // 两节点间 3 条平行边：source=1 → 0
  const two = witnessPaths(2, [{ u: 0, v: 1, k: 0 }, { u: 0, v: 1, k: 1 }, { u: 0, v: 1, k: 2 }], 1);
  assert.ok(two && two.length === 2);
  assert.deepEqual(two[0].nodes, [1, 0]);
  assert.deepEqual(two[1].nodes, [1, 0]);
  assert.notEqual(two[0].edgeIds[0], two[1].edgeIds[0]);

  // 四边形环 A-B-C-D-A，以 C(2) 为源（2 条边不相交路径到 0：C-B-A 与 C-D-A）
  const cyc = [
    { u: 0, v: 1, k: 0 }, { u: 1, v: 2, k: 1 },
    { u: 2, v: 3, k: 2 }, { u: 3, v: 0, k: 3 },
  ];
  const p = witnessPaths(4, cyc, 2);
  assert.ok(p && p.length === 2);
  assert.deepEqual([[1, 0], [3, 0]].sort(),
    [p[0].nodes.slice(1).join(','), p[1].nodes.slice(1).join(',')].sort()
      .map((s) => s.split(',').map(Number)));
  assert.deepEqual([], p[0].edgeIds.filter((k) => p[1].edgeIds.includes(k)));
});
