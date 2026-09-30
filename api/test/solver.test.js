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
