import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveNetwork, validateInput, ValidationError } from '../src/solver.js';

// 构造输入的小工具
function makeInput({ stations, datum, obs }) {
  return {
    stations,
    datumElevation: String(datum),
    observations: obs.map(([from, to, dh, cap]) => ({
      from, to,
      measuredDifference: String(dh),
      maxCorrection: String(cap),
    })),
  };
}

// 校验返回结果：整数、闭合、不越限、基准高程正确
function assertWellFormed(input, r) {
  assert.equal(r.feasible, true);
  const elev = new Map(r.stations.map((s) => [s.name, BigInt(s.elevation)]));
  assert.equal(elev.get(input.stations[0]), BigInt(input.datumElevation));
  let M = 0n, S = 0n;
  for (const c of r.corrections) {
    const corr = BigInt(c.correction);
    const dh = BigInt(c.measuredDifference);
    const cap = BigInt(c.maxCorrection);
    assert.ok(corr <= cap && corr >= -cap, `改正量越限: ${corr} vs ${cap}`);
    assert.equal(elev.get(c.to) - elev.get(c.from), dh + corr);
    assert.equal(BigInt(c.recomputedDifference), dh + corr);
    const a = corr < 0n ? -corr : corr;
    M = a > M ? a : M;
    S += a;
  }
  assert.equal(M, BigInt(r.objective.maxAbsoluteCorrection));
  assert.equal(S, BigInt(r.objective.sumAbsoluteCorrections));
  return { M, S, elev };
}

test('零误差观测：改正量全为 0，高程等于真实高程', () => {
  // A=1000 B=1010 C=1025 D=1015 E=990
  const input = makeInput({
    stations: ['A', 'B', 'C', 'D', 'E'],
    datum: 1000,
    obs: [
      ['A', 'B', 10, 5],
      ['B', 'C', 15, 5],
      ['C', 'D', -10, 5],
      ['D', 'A', -15, 5],
      ['A', 'E', -10, 5],
      ['E', 'D', 25, 5],
      ['B', 'E', -20, 5],
    ],
  });
  const r = solveNetwork(input);
  const { M, S, elev } = assertWellFormed(input, r);
  assert.equal(M, 0n);
  assert.equal(S, 0n);
  assert.deepEqual([...elev.values()].map(String), ['1000', '1010', '1025', '1015', '990']);
});

test('单环路存在闭合差：闭合差经点高程分摊（M=1 时 S=3）', () => {
  // 仅 A->B 观测有 +2 粗差，但 B 还由 B->E->...->A 以多条精确观测固定，
  // 改正量是点高程的差分，不能逐边任意分摊。
  const input = makeInput({
    stations: ['A', 'B', 'C', 'D', 'E'],
    datum: 1000,
    obs: [
      ['A', 'B', 12, 5], // 真值 10，观测多了 2
      ['B', 'C', 15, 5],
      ['C', 'D', -10, 5],
      ['D', 'A', -15, 5],
      ['A', 'E', -10, 5],
      ['E', 'D', 25, 5],
      ['B', 'E', -20, 5],
    ],
  });
  const r = solveNetwork(input);
  const { M, S } = assertWellFormed(input, r);
  assert.equal(M, 1n, '最大改正量应为 1');
  assert.equal(S, 3n, 'M=1 时改正量总和应为 3');
  // B 取折中高程 1011：AB 改 -1，CD 与 BE 各改 +1
  assert.equal(r.stations[1].elevation, '1011');
});

test('往返水准成对观测：往测 101/返测 -99 各让 1mm', () => {
  // 真值 A=1000 B=1100 C=1120 D=1130 E=1100
  const input = makeInput({
    stations: ['A', 'B', 'C', 'D', 'E'],
    datum: 1000,
    obs: [
      ['A', 'B', 101, 5],   // 真值 100，往测 +1
      ['B', 'A', -99, 5],   // 返测折算高差 99，−1
      ['B', 'C', 20, 5],
      ['C', 'D', 10, 5],
      ['D', 'E', -30, 5],
      ['E', 'A', -100, 5],
      ['C', 'A', -120, 5],
    ],
  });
  const r = solveNetwork(input);
  const { M, S } = assertWellFormed(input, r);
  assert.equal(M, 1n);
  assert.equal(S, 2n);
  const ab = r.corrections.find((c) => c.from === 'A' && c.to === 'B');
  const ba = r.corrections.find((c) => c.from === 'B' && c.to === 'A');
  assert.equal(BigInt(ab.correction), -1n);
  assert.equal(BigInt(ba.correction), -1n);
});

test('允许改正量不足：返回 feasible=false 并保留基准高程', () => {
  // 环路闭合差需要 10mm 改正，但每边 cap=1（总容量 4）
  const input = makeInput({
    stations: ['A', 'B', 'C', 'D', 'E'],
    datum: 1000,
    obs: [
      ['A', 'B', 18, 1], // 真值 10
      ['B', 'C', 15, 1],
      ['C', 'D', -10, 1],
      ['D', 'A', -13, 1], // 配合制造闭合差
      ['A', 'E', -10, 1],
      ['E', 'D', 25, 1],
      ['B', 'E', -20, 1],
    ],
  });
  const r = solveNetwork(input);
  assert.equal(r.feasible, false);
  assert.equal(r.reason, 'INSUFFICIENT_CORRECTION');
  assert.match(r.message, /允许改正量不足/);
  assert.equal(r.stations[0].elevation, '1000');
  assert.equal(r.stations[1].elevation, null);
});

test('放宽改正量后同一网可行', () => {
  const input = makeInput({
    stations: ['A', 'B', 'C', 'D', 'E'],
    datum: 1000,
    obs: [
      ['A', 'B', 18, 6],
      ['B', 'C', 15, 6],
      ['C', 'D', -10, 6],
      ['D', 'A', -13, 6],
      ['A', 'E', -10, 6],
      ['E', 'D', 25, 6],
      ['B', 'E', -20, 6],
    ],
  });
  const r = solveNetwork(input);
  assertWellFormed(input, r);
});

test('输入校验：数量、唯一性、连通性、整数性', () => {
  const base = makeInput({
    stations: ['A', 'B', 'C', 'D', 'E'],
    datum: 1000,
    obs: [
      ['A', 'B', 10, 5], ['B', 'C', 15, 5], ['C', 'D', -10, 5],
      ['D', 'A', -15, 5], ['A', 'E', -10, 5], ['E', 'D', 25, 5], ['B', 'E', -20, 5],
    ],
  });

  assert.throws(() => validateInput({ ...base, stations: ['A', 'B', 'C', 'D'] }), ValidationError);
  const eleven = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
  assert.throws(() => validateInput({ ...base, stations: eleven }), ValidationError);
  assert.throws(() => validateInput({ ...base, stations: ['A', 'B', 'C', 'D', 'D'] }), ValidationError);
  assert.throws(() => validateInput({ ...base, datumElevation: '12.5' }), ValidationError);
  assert.throws(() => validateInput({ ...base, datumElevation: 'abc' }), ValidationError);

  const tooFew = { ...base, observations: base.observations.slice(0, 6) };
  assert.throws(() => validateInput(tooFew), ValidationError);

  const badCap = JSON.parse(JSON.stringify(base));
  badCap.observations[0].maxCorrection = '-3';
  assert.throws(() => validateInput(badCap), ValidationError);

  const nonInt = JSON.parse(JSON.stringify(base));
  nonInt.observations[0].measuredDifference = '1.5';
  assert.throws(() => validateInput(nonInt), ValidationError);

  const unknown = JSON.parse(JSON.stringify(base));
  unknown.observations[0].from = 'Z';
  assert.throws(() => validateInput(unknown), ValidationError);

  const selfLoop = JSON.parse(JSON.stringify(base));
  selfLoop.observations[0].to = 'A';
  assert.throws(() => validateInput(selfLoop), ValidationError);

  // 不连通：把与 E 相关的两条边改为 B-C 平行边，E 孤立
  const disc = JSON.parse(JSON.stringify(base));
  disc.observations[4] = { from: 'B', to: 'C', measuredDifference: '14', maxCorrection: '5' };
  disc.observations[5] = { from: 'C', to: 'B', measuredDifference: '-16', maxCorrection: '5' };
  disc.observations[6] = { from: 'B', to: 'C', measuredDifference: '16', maxCorrection: '5' };
  assert.throws(() => validateInput(disc), ValidationError);
});

test('允许 5-10 站与 7-18 观测的边界数量', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  for (const n of [5, 10]) {
    const stations = names.slice(0, n);
    const obs = [];
    // 生成一棵连通骨架再补足边
    for (let i = 1; i < n; i++) obs.push(['A', names[i], 5 + i, 8]);
    for (let k = obs.length; k < 7; k++) obs.push(['A', 'B', 10 + k, 8]);
    const r = solveNetwork(makeInput({ stations, datum: 100, obs }));
    assertWellFormed(makeInput({ stations, datum: 100, obs }), r);
  }
});

// ---- 随机网络 + 暴力枚举对比 --------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 差分约束 Floyd：x_v - x_u <= w+b；返回最短路矩阵（null 表示不可达）
function floyd(n, problem) {
  const dist = Array.from({ length: n }, () => new Array(n).fill(null));
  for (let i = 0; i < n; i++) dist[i][i] = 0n;
  for (const o of problem.observations) {
    const w = o.measuredDifference;
    const b = o.maxCorrection;
    const upd = (u, v, ww) => { if (dist[u][v] === null || ww < dist[u][v]) dist[u][v] = ww; };
    upd(o.fromIndex, o.toIndex, w + b);
    upd(o.toIndex, o.fromIndex, b - w);
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

function bruteForce(problem) {
  const { stations, datum, observations } = problem;
  const n = stations.length;
  const dist = floyd(n, problem);
  for (let i = 0; i < n; i++) if (dist[i][i] < 0n) return null; // 负环：不可行

  // 各 x_i 的紧可行整数盒（x_0=0）
  const ranges = [];
  for (let i = 1; i < n; i++) ranges.push([-dist[i][0], dist[0][i]]);

  let best = null;
  const x = new Array(n - 1);
  const keyLess = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return false;
  };
  const evalX = () => {
    // x 为相对基准站的高程（x_0 = 0）；改正量与 datum 无关
    const rel = [0n, ...x];
    let M = 0n, S = 0n;
    for (const o of observations) {
      const c = rel[o.toIndex] - rel[o.fromIndex] - o.measuredDifference;
      if (c > o.maxCorrection || c < -o.maxCorrection) return;
      const a = c < 0n ? -c : c;
      M = a > M ? a : M;
      S += a;
    }
    const key = [M, S, ...x];
    if (!best || keyLess(key, best.key)) {
      best = { key, elev: [datum, ...x.map((v) => datum + v)] };
    }
  };
  const rec = (i) => {
    if (i === n - 1) { evalX(); return; }
    const [lo, hi] = ranges[i];
    for (let v = lo; v <= hi; v++) { x[i] = v; rec(i + 1); }
  };
  rec(0);
  return best;
}

test('随机网络：三级目标与暴力枚举完全一致（含可行/不可行判定）', () => {
  const rand = mulberry32(20260930);
  const stations = ['A', 'B', 'C', 'D', 'E'];
  const n = 5;
  const ri = (k) => BigInt(Math.floor(rand() * (2 * k + 1)) - k);
  let feasibleCount = 0;
  let infeasibleCount = 0;

  for (let trial = 0; trial < 24; trial++) {
    // 真实相对高程 [-3,3]
    const truth = [0n];
    for (let i = 1; i < n; i++) truth.push(ri(3));
    const edges = new Set();
    const pairs = [];
    const addEdge = (u, v) => {
      const key = u * n + v;
      if (u === v || edges.has(key)) return false;
      edges.add(key);
      pairs.push([u, v]);
      return true;
    };
    // 先保证连通（随机生成树）
    const connected = [0];
    while (connected.length < n) {
      const u = connected[Math.floor(rand() * connected.length)];
      const v = Math.floor(rand() * n);
      if (!connected.includes(v)) { addEdge(u, v); connected.push(v); }
    }
    // 补到 7 条，允许反向平行边（往返测）
    let guard = 0;
    while (pairs.length < 7 && guard++ < 200) {
      addEdge(Math.floor(rand() * n), Math.floor(rand() * n));
    }
    assert.ok(pairs.length >= 7, '随机构造应能产生 7 条边');

    const datum = 1000n;
    const obs = pairs.map(([u, v]) => {
      const noise = ri(2);
      const dh = truth[v] - truth[u] + noise;
      const cap = 1n + BigInt(Math.floor(rand() * 3)); // 1..3
      return [stations[u], stations[v], dh, cap];
    });
    const input = makeInput({ stations, datum, obs });
    const r = solveNetwork(input);

    const problem = validateInput(input);
    const best = bruteForce(problem);

    if (!best) {
      infeasibleCount++;
      assert.equal(r.feasible, false, `trial ${trial}：暴力无解，求解器不应给出解`);
      continue;
    }
    feasibleCount++;
    assert.equal(r.feasible, true, `trial ${trial}：暴力有解，求解器不应判不可行`);
    const { M, S, elev } = assertWellFormed(input, r);
    assert.equal(M, best.key[0], `trial ${trial} M 不一致`);
    assert.equal(S, best.key[1], `trial ${trial} S 不一致`);
    const gotX = [...elev.values()].slice(1).map((e) => e - datum);
    for (let i = 0; i < n - 1; i++) {
      assert.equal(gotX[i], best.elev[i + 1] - datum, `trial ${trial} 字典序高程第 ${i} 位不一致`);
    }
  }
  assert.ok(feasibleCount >= 5, `随机用例中可行样本过少：${feasibleCount}`);
  assert.ok(infeasibleCount >= 1, `随机用例中应包含不可行样本：${infeasibleCount}`);
});

test('负基准高程与负高差也能正确处理', () => {
  const input = makeInput({
    stations: ['A', 'B', 'C', 'D', 'E'],
    datum: -500,
    obs: [
      ['A', 'B', -10, 4],
      ['B', 'A', 9, 4],
      ['B', 'C', -20, 4],
      ['C', 'D', 15, 4],
      ['D', 'E', 5, 4],
      ['E', 'A', 11, 4],
      ['C', 'E', 20, 4],
    ],
  });
  const r = solveNetwork(input);
  assertWellFormed(input, r);
});

// ---- 单边失效复核 --------------------------------------------------------

const ZERO_ERROR_NET = () => makeInput({
  stations: ['A', 'B', 'C', 'D', 'E'],
  datum: 1000,
  obs: [
    ['A', 'B', 10, 5],
    ['B', 'C', 15, 5],
    ['C', 'D', -10, 5],
    ['D', 'A', -15, 5],
    ['A', 'E', -10, 5],
    ['E', 'D', 25, 5],
    ['B', 'E', -20, 5],
  ],
});

// 校验返回的两路见证：两条路径边不相交、端点连续、全部使用复核边、
// 沿「实测+改正」的带符号代数和等于该站与基准站的高程差。
function assertWitnessPaths(input, r) {
  const elev = new Map(r.stations.map((s) => [s.name, BigInt(s.elevation)]));
  assert.ok(Array.isArray(r.review.witnessPaths));
  assert.equal(r.review.witnessPaths.length, input.stations.length - 1);
  for (const w of r.review.witnessPaths) {
    assert.equal(w.station, input.stations[w.stationIndex]);
    assert.equal(w.paths.length, 2);
    const usedSets = w.paths.map((p) => new Set(p.map((h) => h.observationIndex)));
    for (const s of usedSets) assert.equal(s.size, w.paths[usedSets.indexOf(s)].length, '路径内观测不重复');
    for (const k of usedSets[0]) assert.ok(!usedSets[1].has(k), `到 ${w.station} 的两路见证共用观测 ${k}`);
    const sums = w.paths.map((path) => {
      let cur = input.stations[0];
      let sum = 0n;
      for (const h of path) {
        const c = r.corrections[h.observationIndex];
        const fwd = c.from === cur;
        const rev = c.to === cur;
        assert.ok(fwd || rev, '见证路径端点不连续');
        const sign = fwd ? 1n : -1n;
        sum += sign * (BigInt(c.measuredDifference) + BigInt(c.correction));
        cur = fwd ? c.to : c.from;
        assert.equal(c.inReviewNetwork, true, '见证路径只能使用复核边');
      }
      assert.equal(cur, w.station, '见证路径终点正确');
      return sum;
    });
    const want = elev.get(w.station) - elev.get(input.stations[0]);
    assert.equal(sums[0], want, '第一路见证可由改正值核对到目标高程');
    assert.equal(sums[1], want, '第二路见证可由改正值核对到目标高程');
  }
}

// 复核网结构断言：跨接基准连通，且删除任一复核边后仍连通。
function assertReviewRedundancy(input, r) {
  const n = input.stations.length;
  const idx = new Map(input.stations.map((s, i) => [s, i]));
  const edges = r.corrections
    .map((c, k) => ({ k, u: idx.get(c.from), v: idx.get(c.to), in: c.inReviewNetwork }))
    .filter((e) => e.in);
  assert.ok(edges.length >= n, '无桥连通图复核边数不少于测站数');
  for (const dead of edges.map((e) => e.k)) {
    const adj = Array.from({ length: n }, () => []);
    for (const e of edges) if (e.k !== dead) adj[e.u].push(e.v), adj[e.v].push(e.u);
    const seen = new Array(n).fill(false);
    const stk = [0];
    seen[0] = true;
    while (stk.length) {
      const u = stk.pop();
      for (const v of adj[u]) if (!seen[v]) { seen[v] = true; stk.push(v); }
    }
    assert.ok(seen.every(Boolean), `复核边 ${dead} 失效后仍须全部测站可达基准站`);
  }
}

test('复核未启用：响应形态与旧接口完全一致（无 review、无 inReviewNetwork）', () => {
  const r = solveNetwork(ZERO_ERROR_NET());
  assert.equal(r.feasible, true);
  assert.equal('review' in r, false);
  for (const c of r.corrections) assert.equal('inReviewNetwork' in c, false);
});

test('review.enabled=false：即使带了配置字段也与原请求完全一致', () => {
  const input = ZERO_ERROR_NET();
  const a = solveNetwork(input);
  const b = solveNetwork({ ...input, review: { enabled: false, trustedCorrectionThreshold: '9' } });
  assert.deepEqual(b, a);
});

test('复核启用且整网满足阈值：标注全部观测并返回两路见证', () => {
  const input = makeInput({
    stations: ['A', 'B', 'C', 'D', 'E'],
    datum: 1000,
    obs: [
      ['A', 'B', 12, 5],
      ['B', 'C', 15, 5],
      ['C', 'D', -10, 5],
      ['D', 'A', -15, 5],
      ['A', 'E', -10, 5],
      ['E', 'D', 25, 5],
      ['B', 'E', -20, 5],
    ],
  });
  const r = solveNetwork({ ...input, review: { enabled: true, trustedCorrectionThreshold: '1' } });
  const { M, S } = assertWellFormed(input, r);
  assert.equal(M, 1n);
  assert.equal(S, 3n);
  assert.equal(r.review.enabled, true);
  assert.equal(r.review.trustedCorrectionThreshold, '1');
  assert.equal(r.review.redundant, true);
  assert.equal(r.review.reviewEdgeCount, 7);
  for (const c of r.corrections) {
    const ac = BigInt(c.correction) < 0n ? -BigInt(c.correction) : BigInt(c.correction);
    assert.equal(c.inReviewNetwork, ac <= 1n, '是否进入复核网可由改正值与阈值独立核对');
    assert.equal(c.inReviewNetwork, true);
  }
  assertWitnessPaths(input, r);
  assertReviewRedundancy(input, r);
});

test('复核可能抬高最大改正量：M0=2 时阈值 1 需要 M=3，且非复核边严格超阈值', () => {
  // 该网普通最优 M0=2；阈值 1 下只有舍弃 AE、EA 等大改正边之外的联合高程
  // 才能形成无桥复核网，代价是最大改正量升到 3。
  const input = {
    stations: ['A', 'B', 'C', 'D', 'E'],
    datumElevation: '1000',
    observations: [
      { from: 'A', to: 'E', measuredDifference: '-3', maxCorrection: '3' },
      { from: 'E', to: 'B', measuredDifference: '1', maxCorrection: '1' },
      { from: 'A', to: 'D', measuredDifference: '-1', maxCorrection: '1' },
      { from: 'D', to: 'C', measuredDifference: '3', maxCorrection: '3' },
      { from: 'E', to: 'A', measuredDifference: '-1', maxCorrection: '3' },
      { from: 'B', to: 'C', measuredDifference: '3', maxCorrection: '3' },
      { from: 'D', to: 'E', measuredDifference: '1', maxCorrection: '2' },
    ],
  };
  const plain = solveNetwork(input);
  assert.equal(plain.objective.maxAbsoluteCorrection, '2');

  const r = solveNetwork({ ...input, review: { enabled: true, trustedCorrectionThreshold: '1' } });
  assert.equal(r.feasible, true);
  assert.equal(r.objective.maxAbsoluteCorrection, '3', '复核条件可要求更大的最大改正量');
  for (const c of r.corrections) {
    const ac = BigInt(c.correction) < 0n ? -BigInt(c.correction) : BigInt(c.correction);
    assert.equal(c.inReviewNetwork, ac <= 1n);
  }
  const reviewEdges = r.corrections.filter((c) => c.inReviewNetwork);
  assert.ok(reviewEdges.length < r.corrections.length, '存在被排除出复核网的观测');
  assertReviewRedundancy(input, r);
  assertWitnessPaths(input, r);

  // 阈值放宽到 2：恢复 M0=2 的高程，全部观测入网
  const r2 = solveNetwork({ ...input, review: { enabled: true, trustedCorrectionThreshold: '2' } });
  assert.equal(r2.feasible, true);
  assert.equal(r2.objective.maxAbsoluteCorrection, '2');
  assert.equal(r2.review.reviewEdgeCount, 7);
  assertReviewRedundancy(input, r2);
});

test('结构性桥边：阈值再大也报复核冗余不足，并保留草稿与基准高程', () => {
  // A-B-C-D 有闭合环和两条弦，E 只经单条 A-E 连接：A-E 是桥。
  const input = makeInput({
    stations: ['A', 'B', 'C', 'D', 'E'],
    datum: 1000,
    obs: [
      ['A', 'B', 10, 5],
      ['B', 'C', 15, 5],
      ['C', 'D', -10, 5],
      ['D', 'A', -15, 5],
      ['B', 'D', 5, 5],
      ['A', 'C', 25, 5],
      ['A', 'E', -10, 5],
    ],
  });
  assert.equal(solveNetwork(input).feasible, true);
  const r = solveNetwork({ ...input, review: { enabled: true, trustedCorrectionThreshold: '5' } });
  assert.equal(r.feasible, false);
  assert.equal(r.reason, 'REVIEW_NOT_REDUNDANT');
  assert.match(r.message, /复核冗余不足/);
  assert.match(r.message, /A→E/);
  assert.equal(r.stations[0].elevation, '1000');
  assert.equal(r.stations[1].elevation, null);
  assert.equal(r.observations.length, 7);
  assert.equal(r.review.redundant, false);
  assert.equal(r.review.trustedCorrectionThreshold, '5');
});

test('原网可配平但阈值内不存在无桥复核网：REVIEW_NOT_REDUNDANT', () => {
  const input = {
    stations: ['A', 'B', 'C', 'D', 'E'],
    datumElevation: '1000',
    observations: [
      { from: 'A', to: 'C', measuredDifference: '-2', maxCorrection: '3' },
      { from: 'A', to: 'D', measuredDifference: '2', maxCorrection: '1' },
      { from: 'A', to: 'E', measuredDifference: '-1', maxCorrection: '3' },
      { from: 'D', to: 'B', measuredDifference: '-1', maxCorrection: '3' },
      { from: 'E', to: 'A', measuredDifference: '-2', maxCorrection: '2' },
      { from: 'C', to: 'A', measuredDifference: '-2', maxCorrection: '1' },
      { from: 'B', to: 'A', measuredDifference: '-1', maxCorrection: '2' },
    ],
  };
  assert.equal(solveNetwork(input).feasible, true);
  for (const T of ['0', '1']) {
    const r = solveNetwork({ ...input, review: { enabled: true, trustedCorrectionThreshold: T } });
    assert.equal(r.feasible, false, `T=${T}`);
    assert.equal(r.reason, 'REVIEW_NOT_REDUNDANT', `T=${T}`);
  }
  // 放宽到 3：全部改正量都可纳入，整网无桥
  const r3 = solveNetwork({ ...input, review: { enabled: true, trustedCorrectionThreshold: '3' } });
  assert.equal(r3.feasible, true);
  assert.equal(r3.review.reviewEdgeCount, 7);
  assertReviewRedundancy(input, r3);
});

test('原网络本身不可配平时，复核请求仍返回 INSUFFICIENT_CORRECTION 并回带 review 配置', () => {
  const input = makeInput({
    stations: ['A', 'B', 'C', 'D', 'E'],
    datum: 1000,
    obs: [
      ['A', 'B', 18, 1],
      ['B', 'C', 15, 1],
      ['C', 'D', -10, 1],
      ['D', 'A', -13, 1],
      ['A', 'E', -10, 1],
      ['E', 'D', 25, 1],
      ['B', 'E', -20, 1],
    ],
  });
  const r = solveNetwork({ ...input, review: { enabled: true, trustedCorrectionThreshold: '1' } });
  assert.equal(r.feasible, false);
  assert.equal(r.reason, 'INSUFFICIENT_CORRECTION');
  assert.deepEqual(r.review, { enabled: true, trustedCorrectionThreshold: '1' });
});

test('复核配置校验：enabled 必须为布尔值，阈值必须为非负整数', () => {
  const base = ZERO_ERROR_NET();
  assert.throws(() => validateInput({ ...base, review: { enabled: true } }), ValidationError);
  assert.throws(() => validateInput({ ...base, review: { enabled: true, trustedCorrectionThreshold: '-1' } }), ValidationError);
  assert.throws(() => validateInput({ ...base, review: { enabled: true, trustedCorrectionThreshold: '1.0' } }), ValidationError);
  assert.throws(() => validateInput({ ...base, review: { enabled: 'yes', trustedCorrectionThreshold: '1' } }), ValidationError);
  assert.throws(() => validateInput({ ...base, review: [] }), ValidationError);
  // enabled=false 时不校验阈值
  assert.doesNotThrow(() => validateInput({ ...base, review: { enabled: false, trustedCorrectionThreshold: 'x' } }));
  // 安全整数的数字类型阈值也接受
  assert.doesNotThrow(() => validateInput({ ...base, review: { enabled: true, trustedCorrectionThreshold: 2 } }));
});

test('复核随机性质：可行则阈值自洽、无桥冗余、两路见证；不可行则原网可配平', () => {
  const rand = mulberry32(98765);
  const stations = ['A', 'B', 'C', 'D', 'E'];
  const n = 5;
  const ri = (k) => BigInt(Math.floor(rand() * (2 * k + 1)) - k);
  let redundant = 0;
  let notRedundant = 0;
  let infeasible = 0;
  for (let trial = 0; trial < 60; trial++) {
    const truth = [0n];
    for (let i = 1; i < n; i++) truth.push(ri(3));
    const edges = new Set();
    const pairs = [];
    const addEdge = (u, v) => {
      const key = u * n + v;
      if (u === v || edges.has(key)) return false;
      edges.add(key);
      pairs.push([u, v]);
      return true;
    };
    const connected = [0];
    while (connected.length < n) {
      const u = connected[Math.floor(rand() * connected.length)];
      const v = Math.floor(rand() * n);
      if (!connected.includes(v)) { addEdge(u, v); connected.push(v); }
    }
    let guard = 0;
    while (pairs.length < 7 && guard++ < 200) addEdge(Math.floor(rand() * n), Math.floor(rand() * n));
    const T = BigInt(Math.floor(rand() * 2));
    const obs = pairs.map(([u, v]) => {
      const noise = ri(2);
      const cap = 1n + BigInt(Math.floor(rand() * 3));
      return [stations[u], stations[v], truth[v] - truth[u] + noise, cap];
    });
    const input = makeInput({ stations, datum: 1000, obs });
    const r = solveNetwork({ ...input, review: { enabled: true, trustedCorrectionThreshold: String(T) } });
    const plain = solveNetwork(input);
    if (!plain.feasible) {
      assert.equal(r.reason, 'INSUFFICIENT_CORRECTION');
      infeasible++;
      continue;
    }
    if (!r.feasible) {
      assert.equal(r.reason, 'REVIEW_NOT_REDUNDANT');
      assert.equal(r.review.redundant, false);
      notRedundant++;
      continue;
    }
    redundant++;
    assert.equal(r.review.redundant, true);
    assertWellFormed(input, r);
    for (const c of r.corrections) {
      const ac = BigInt(c.correction) < 0n ? -BigInt(c.correction) : BigInt(c.correction);
      assert.equal(c.inReviewNetwork, ac <= T);
    }
    assert.ok(BigInt(r.objective.maxAbsoluteCorrection) >= BigInt(plain.objective.maxAbsoluteCorrection));
    assertReviewRedundancy(input, r);
    assertWitnessPaths(input, r);
  }
  assert.ok(redundant >= 5, `应有足够多的冗余成功样本：${redundant}`);
  assert.ok(notRedundant >= 5, `应有足够多的复核冗余不足样本：${notRedundant}`);
});
