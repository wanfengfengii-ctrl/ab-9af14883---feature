// 整数高程网联合配平求解器（所有高程/高差均为整数毫米）。
//
// 模型：站点 i 高程 H[i]，基准站 H[0] = datum（第一个录入的测站）。
// 有向观测 k：u -> v，实测高差 dh_k，最大允许改正量 cap_k（>=0）。
//   改正量 c_k = H[v] - H[u] - dh_k，约束 |c_k| <= cap_k。
//
// 三级目标（依次最小化）：
//   1. M = max_k |c_k|
//   2. S = Σ_k |c_k|
//   3. (H[1], H[2], …, H[n-1]) 按录入顺序的字典序
//
// 算法：
//   * 令 x_0=0、x_i=H[i]-datum（i>0），c_k = x_v-x_u-w_k。
//     |c_k|<=b_k 是一组成对的差分约束，用 Floyd-Warshall 判负环做可行性判定，
//     对 M 二分（b_k=min(M,cap_k)）得到最小 M*。
//   * Floyd 同时给出每个 x_i 的紧可行整数区间 [lo_i, hi_i]。令 y_i=x_i-lo_i
//     （0 <= y_i <= hi_i-lo_i），所有变量非负，用标准两阶段单纯形（BigInt
//     精确分数，Bland 规则）最小化一个加权整数目标：权重按区间宽度做超递增
//     构造，严格保证「先 S 后字典序」的优先级。
//   * 关联矩阵全幺模、右端为整数，LP 必有整数最优解；若顶点出现分数，
//     用整数分支定界兜底，保证输出严格整数。

export class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

// ---- 输入校验 ------------------------------------------------------------

const INT_RE = /^[+-]?\d+$/;

function toBigInt(value, field, errors, { nonNeg = false } = {}) {
  let t;
  if (typeof value === 'number' && Number.isSafeInteger(value)) t = String(value);
  else if (typeof value === 'string') t = value.trim();
  else t = null;
  if (t === null || !INT_RE.test(t)) {
    errors.push({ field, message: '必须是整数（毫米）' });
    return null;
  }
  const b = BigInt(t);
  if (b > 10n ** 9n || b < -(10n ** 9n)) {
    errors.push({ field, message: '绝对值不能超过 10^9 毫米' });
    return null;
  }
  if (nonNeg && b < 0n) {
    errors.push({ field, message: '不能为负数' });
    return null;
  }
  return b;
}

export function validateInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('请求体必须是 JSON 对象');
  }

  const errors = [];
  const rawStations = input.stations;
  if (!Array.isArray(rawStations)) {
    throw new ValidationError('stations 必须是数组');
  }
  const n = rawStations.length;
  if (n < 5 || n > 10) {
    errors.push({ field: 'stations', message: '测站数量须在 5 至 10 个之间' });
  }

  const stations = [];
  const seen = new Set();
  rawStations.forEach((s, i) => {
    if (typeof s !== 'string') {
      errors.push({ field: `stations[${i}]`, message: '测站名必须是字符串' });
      return;
    }
    const name = s.trim();
    if (name === '') errors.push({ field: `stations[${i}]`, message: '测站名不能为空' });
    else if (seen.has(name)) errors.push({ field: `stations[${i}]`, message: `测站名重复：${name}` });
    else seen.add(name);
    stations.push(name);
  });

  const datum = toBigInt(input.datumElevation, 'datumElevation', errors);

  if (!Array.isArray(input.observations)) {
    throw new ValidationError('observations 必须是数组');
  }
  const rawObs = input.observations;
  if (rawObs.length < 7 || rawObs.length > 18) {
    errors.push({ field: 'observations', message: '观测数量须在 7 至 18 条之间' });
  }

  const observations = [];
  rawObs.forEach((o, k) => {
    if (o === null || typeof o !== 'object') {
      errors.push({ field: `observations[${k}]`, message: '观测必须是对象' });
      return;
    }
    const from = typeof o.from === 'string' ? o.from.trim() : '';
    const to = typeof o.to === 'string' ? o.to.trim() : '';
    if (!seen.has(from)) errors.push({ field: `observations[${k}].from`, message: `未知测站：${String(o.from ?? '')}` });
    if (!seen.has(to)) errors.push({ field: `observations[${k}].to`, message: `未知测站：${String(o.to ?? '')}` });
    if (from && from === to) errors.push({ field: `observations[${k}]`, message: '起点与终点不能相同' });
    const measuredDifference = toBigInt(o.measuredDifference, `observations[${k}].measuredDifference`, errors);
    const maxCorrection = toBigInt(o.maxCorrection, `observations[${k}].maxCorrection`, errors, { nonNeg: true });
    if (from && to && seen.has(from) && seen.has(to)) {
      observations.push({
        from, to,
        fromIndex: stations.indexOf(from),
        toIndex: stations.indexOf(to),
        measuredDifference,
        maxCorrection,
      });
    }
  });

  if (errors.length) throw new ValidationError('输入校验失败', errors);

  // 连通性（忽略方向）
  const adj = Array.from({ length: n }, () => []);
  for (const o of observations) {
    adj[o.fromIndex].push(o.toIndex);
    adj[o.toIndex].push(o.fromIndex);
  }
  const visited = new Array(n).fill(false);
  const stack = [0];
  visited[0] = true;
  while (stack.length) {
    const i = stack.pop();
    for (const j of adj[i]) if (!visited[j]) { visited[j] = true; stack.push(j); }
  }
  const unreachable = stations.filter((_, i) => !visited[i]);
  if (unreachable.length) {
    throw new ValidationError(
      `测站未与基准站连通，无法联合配平：${unreachable.join('、')}`,
      [{ field: 'observations', message: '水准网（忽略方向）必须连通' }],
    );
  }

  return { stations, datum: datum ?? 0n, observations };
}

// ---- 精确分数 ------------------------------------------------------------

function gcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) { [a, b] = [b, a % b]; }
  return a || 1n;
}
function Q(num, den = 1n) {
  num = BigInt(num); den = BigInt(den);
  if (den === 0n) throw new Error('零分母');
  if (den < 0n) { num = -num; den = -den; }
  if (num === 0n) return { num: 0n, den: 1n };
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}
const ZERO = Object.freeze({ num: 0n, den: 1n });
const ONE = Object.freeze({ num: 1n, den: 1n });
const qneg = (x) => (x.num === 0n ? ZERO : { num: -x.num, den: x.den });
const qsub = (a, b) => Q(a.num * b.den - b.num * a.den, a.den * b.den);
const qmul = (a, b) => Q(a.num * b.num, a.den * b.den);
const qdiv = (a, b) => Q(a.num * b.den, a.den * b.num);
function qFloor(x) {
  const q = x.num / x.den;
  return x.num < 0n && x.num % x.den !== 0n ? q - 1n : q;
}

// ---- 差分约束可行性 / 可行区间 ------------------------------------------
//
// c_k = x_v - x_u - w_k，|c_k| <= b_k 等价于：
//   x_v - x_u <= w_k + b_k   （边 u->v）
//   x_u - x_v <= b_k - w_k   （边 v->u）
// 系统无可行解当且仅当约束图存在负环。
// x_i = H[i] - datum 且 x_0 = 0，基准高程在高差中抵消，故 w_k 即实测高差。
// 可行时 x_i ∈ [-dist[i][0], dist[0][i]]。

const shiftedObservation = (o) => o.measuredDifference;

function floyd(n, edges) {
  const dist = Array.from({ length: n }, () => new Array(n).fill(null));
  for (let i = 0; i < n; i++) dist[i][i] = 0n;
  for (const [u, v, w] of edges) {
    if (dist[u][v] === null || w < dist[u][v]) dist[u][v] = w;
  }
  for (let k = 0; k < n; k++) {
    const dk = dist[k];
    for (let i = 0; i < n; i++) {
      const dik = dist[i][k];
      if (dik === null) continue;
      const di = dist[i];
      for (let j = 0; j < n; j++) {
        const dkj = dk[j];
        if (dkj === null) continue;
        const nd = dik + dkj;
        if (di[j] === null || nd < di[j]) di[j] = nd;
      }
    }
  }
  return dist;
}

function diffDistances(n, problem, boundFor) {
  const edges = [];
  problem.observations.forEach((o, k) => {
    const w = shiftedObservation(o);
    const b = boundFor(o, k);
    edges.push([o.fromIndex, o.toIndex, w + b]);
    edges.push([o.toIndex, o.fromIndex, b - w]);
  });
  return floyd(n, edges);
}

const distFeasible = (dist) => dist.every((row, i) => row[i] >= 0n);

// ---- 两阶段单纯形（全部变量非负，BigInt 精确分数） ----------------------
//
// 输入：a·x <= b 形式的行；min costs·x。
// b>=0 的行加松弛变量 +1；b<0 的行取反后加剩余变量 -1 与人工变量 +1。
// 第一阶段最小化人工变量之和；第二阶段换入真实目标。
// Bland 规则（最小下标进基、平局最小基变量下标出基），保证有限步终止。

class Simplex {
  constructor(leRows, costs) {
    this.nr = leRows.length;
    this.ns = costs.length;
    this.slackStart = this.ns;           // 松弛/剩余变量
    this.artStart = this.ns + this.nr;   // 人工变量
    this.ncols = this.ns + 2 * this.nr;
    this.active = new Array(this.nr).fill(true);
    this.basis = new Array(this.nr);
    this.T = Array.from({ length: this.nr + 1 }, () =>
      new Array(this.ncols + 1).fill(null).map(() => Q(0n)));
    this.artRows = [];

    leRows.forEach((row, i) => {
      const tr = this.T[i + 1];
      if (row.b >= 0n) {
        for (let j = 0; j < this.ns; j++) tr[j] = Q(row.a[j]);
        tr[this.slackStart + i] = ONE;
        tr[this.ncols] = Q(row.b);
        this.basis[i] = this.slackStart + i;
      } else {
        for (let j = 0; j < this.ns; j++) tr[j] = Q(-row.a[j]);
        tr[this.slackStart + i] = Q(-1n);
        tr[this.artStart + i] = ONE;
        tr[this.ncols] = Q(-row.b);
        this.basis[i] = this.artStart + i;
        this.artRows.push(i);
      }
    });
  }

  pivot(i, j) {
    const T = this.T;
    const pr = i + 1;
    const piv = T[pr][j];
    const prow = T[pr];
    for (let k = 0; k <= this.ncols; k++) if (k !== j) prow[k] = qdiv(prow[k], piv);
    prow[j] = ONE;
    for (let r = 0; r <= this.nr; r++) {
      if (r === pr || (r >= 1 && !this.active[r - 1])) continue;
      const tr = T[r];
      const f = tr[j];
      if (f.num === 0n) continue;
      for (let k = 0; k <= this.ncols; k++) if (k !== j) tr[k] = qsub(tr[k], qmul(f, prow[k]));
      tr[j] = ZERO; // 消元后枢轴列在非枢轴行上为 0（单位列）
    }
    this.basis[i] = j;
  }

  // 最小化当前第 0 行；true=最优，false=无界
  optimize() {
    for (let guard = 0; guard < 500000; guard++) {
      const r0 = this.T[0];
      const basicSet = new Set();
      for (let i = 0; i < this.nr; i++) if (this.active[i]) basicSet.add(this.basis[i]);

      let enter = -1;
      for (let j = 0; j < this.artStart; j++) {
        if (!basicSet.has(j) && r0[j].num < 0n) { enter = j; break; }
      }
      if (enter === -1) return true;

      let best = null;
      let prow = -1;
      let tieBasic = Infinity;
      for (let i = 0; i < this.nr; i++) {
        if (!this.active[i]) continue;
        const a = this.T[i + 1][enter];
        if (a.num <= 0n) continue;
        const ratio = qdiv(this.T[i + 1][this.ncols], a);
        const cmp = best === null ? -1n : (ratio.num * best.den - best.num * ratio.den);
        if (cmp < 0n || (cmp === 0n && this.basis[i] < tieBasic)) {
          best = ratio; prow = i; tieBasic = this.basis[i];
        }
      }
      if (prow === -1) return false; // 无界（本应用所有变量有界，不会发生）
      this.pivot(prow, enter);
    }
    throw new Error('单纯形迭代次数超限');
  }

  _zeroObjectiveRow() {
    const r0 = this.T[0];
    for (let j = 0; j <= this.ncols; j++) r0[j] = ZERO;
  }

  // 安装「min costs·x」的检验数行，并消去基变量成本。
  // 约定：第 0 行存 -z，初始结构列系数为 +costs；右端 = -z；
  // 检验数 < 0 时进基（下降方向）。
  installObjective(costs) {
    this._zeroObjectiveRow();
    for (let j = 0; j < this.ns; j++) this.T[0][j] = Q(costs[j]);
    for (let i = 0; i < this.nr; i++) {
      if (!this.active[i]) continue;
      const jb = this.basis[i];
      if (jb < this.ns && costs[jb] !== 0n) {
        const row = this.T[i + 1];
        const f = Q(costs[jb]);
        for (let j = 0; j <= this.ncols; j++) this.T[0][j] = qsub(this.T[0][j], qmul(f, row[j]));
      }
    }
  }

  solve(costs) {
    // 第一阶段
    if (this.artRows.length) {
      this._zeroObjectiveRow();
      for (const i of this.artRows) {
        const row = this.T[i + 1];
        for (let j = 0; j <= this.ncols; j++) this.T[0][j] = qsub(this.T[0][j], row[j]);
      }
      if (!this.optimize()) return { status: 'unbounded' }; // 第一阶段不可能无界
      if (this.T[0][this.ncols].num !== 0n) return { status: 'infeasible' };

      // 仍在基中的人工变量（值为 0）换出；只能选非基本列
      const basicNow = new Set(this.basis.filter((b) => b >= 0));
      for (const i of this.artRows) {
        if (!this.active[i] || this.basis[i] !== this.artStart + i) continue;
        let pick = -1;
        for (let j = 0; j < this.artStart; j++) {
          if (!basicNow.has(j) && this.T[i + 1][j].num !== 0n) { pick = j; break; }
        }
        if (pick === -1) { this.active[i] = false; continue; } // 冗余等式行
        basicNow.delete(this.artStart + i);
        basicNow.add(pick);
        this.pivot(i, pick);
      }
    }

    // 第二阶段
    this.installObjective(costs);
    if (!this.optimize()) return { status: 'unbounded' };

    const values = new Array(this.ns).fill(ZERO);
    for (let i = 0; i < this.nr; i++) {
      if (!this.active[i]) continue;
      const jb = this.basis[i];
      if (jb < this.ns) values[jb] = this.T[i + 1][this.ncols];
    }
    return { status: 'optimal', values };
  }
}

// ---- 整数分支定界（理论上根节点即整数解，此处为兜底） --------------------

function lpSolveInteger(baseRows, costs) {
  let incumbent = null;

  const objOf = (values) => {
    let s = 0n;
    for (let j = 0; j < costs.length; j++) s += costs[j] * values[j];
    return s;
  };

  const visit = (extra, depth) => {
    if (depth > 200) throw new Error('整数求解深度超限');
    const sx = new Simplex(baseRows.concat(extra), costs);
    const res = sx.solve(costs);
    if (res.status !== 'optimal') return;
    let z = 0n, zDen = 1n;
    res.values.forEach((v, j) => {
      z = z * v.den + costs[j] * v.num * zDen;
      zDen *= v.den;
    });
    if (incumbent && z * incumbent.objDen >= incumbent.obj * zDen) return;

    const fracIdx = res.values.findIndex((v) => v.den !== 1n);
    if (fracIdx === -1) {
      const vals = res.values.map((v) => v.num);
      incumbent = { values: vals, obj: objOf(vals), objDen: 1n };
      return;
    }
    const f = qFloor(res.values[fracIdx]);
    const bound = (sign, rhs) => {
      const a = new Array(costs.length).fill(0n);
      a[fracIdx] = sign;
      return { a, b: rhs };
    };
    visit(extra.concat([bound(1n, f)]), depth + 1);        // y <= floor
    visit(extra.concat([bound(-1n, -(f + 1n))]), depth + 1); // y >= ceil
  };

  visit([], 0);
  if (!incumbent) throw new Error('整数求解失败：无可行解');
  return incumbent.values;
}

// ---- 主流程 --------------------------------------------------------------

export function solveNetwork(input) {
  const problem = validateInput(input);
  const { stations, datum, observations } = problem;
  const n = stations.length;
  const m = observations.length;
  const nf = n - 1;
  const t0 = nf;

  const maxCap = observations.reduce((a, o) => (o.maxCorrection > a ? o.maxCorrection : a), 0n);

  // 阶段 1：硬界下总体可行？
  const dist0 = diffDistances(n, problem, (o) => o.maxCorrection);
  if (!distFeasible(dist0)) {
    return {
      feasible: false,
      reason: 'INSUFFICIENT_CORRECTION',
      message: '允许改正量不足：在各观测给定的最大允许改正量内，不存在能使全部环路闭合的整数高程解。请放宽若干观测的最大允许改正量，或核对实测高差。',
      stations: stations.map((name, i) => ({ name, elevation: i === 0 ? datum.toString() : null })),
      observations: observations.map((o) => ({
        from: o.from, to: o.to,
        measuredDifference: o.measuredDifference.toString(),
        maxCorrection: o.maxCorrection.toString(),
      })),
    };
  }

  // 阶段 2：二分最小 M
  let lo = 0n, hi = maxCap;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const d = diffDistances(n, problem, (o) => (mid < o.maxCorrection ? mid : o.maxCorrection));
    if (distFeasible(d)) hi = mid; else lo = mid + 1n;
  }
  const M = lo;
  const B = observations.map((o) => (M < o.maxCorrection ? M : o.maxCorrection));

  // 各 x_i 在 M* 下的紧可行整数区间
  const dist = diffDistances(n, problem, (_o, k) => B[k]);
  const lows = [];
  const widths = [];
  for (let i = 1; i < n; i++) {
    const l = -dist[i][0];
    lows.push(l);
    widths.push(dist[0][i] - l);
  }

  // 变量：y_i = x_i - lo_i >= 0（上界 width_i）；t_k >= 0（上界 B_k）
  const ns = nf + m;
  const leRows = [];
  const addRow = (a, b) => leRows.push({ a, b });

  observations.forEach((o, k) => {
    const w = shiftedObservation(o);
    const loV = o.toIndex === 0 ? 0n : lows[o.toIndex - 1];
    const loU = o.fromIndex === 0 ? 0n : lows[o.fromIndex - 1];
    const yi = (u) => u - 1;

    // x_v - x_u - t <= w  ⇔  y_v - y_u - t <= w - lo_v + lo_u
    {
      const a = new Array(ns).fill(0n);
      if (o.toIndex > 0) a[yi(o.toIndex)] += 1n;
      if (o.fromIndex > 0) a[yi(o.fromIndex)] -= 1n;
      a[t0 + k] = -1n;
      addRow(a, w - loV + loU);
    }
    // -x_v + x_u - t <= -w  ⇔  -y_v + y_u - t <= -w + lo_v - lo_u
    {
      const a = new Array(ns).fill(0n);
      if (o.toIndex > 0) a[yi(o.toIndex)] -= 1n;
      if (o.fromIndex > 0) a[yi(o.fromIndex)] += 1n;
      a[t0 + k] = -1n;
      addRow(a, -w + loV - loU);
    }
  });
  // 变量上界
  for (let i = 0; i < nf; i++) {
    const a = new Array(ns).fill(0n);
    a[i] = 1n;
    addRow(a, widths[i]);
  }
  for (let k = 0; k < m; k++) {
    const a = new Array(ns).fill(0n);
    a[t0 + k] = 1n;
    addRow(a, B[k]);
  }

  // 加权目标：min Σ w_i y_i + W0 Σ t_k。
  // w_i 超递增（按录入顺序反向构造），W0 压倒全部字典序项之和，
  // 因而严格实现「先最小 S，再 (x_1,x_2,…) 字典序」。
  const weightsX = new Array(nf).fill(0n);
  let acc = 0n;
  for (let i = nf - 1; i >= 0; i--) {
    const w = 1n + acc;
    weightsX[i] = w;
    acc += w * (widths[i] + 1n);
  }
  const W0 = 1n + acc;
  const costs = new Array(ns).fill(0n);
  for (let i = 0; i < nf; i++) costs[i] = weightsX[i];
  for (let k = 0; k < m; k++) costs[t0 + k] = W0;

  const values = lpSolveInteger(leRows, costs);
  const xs = [0n];
  for (let i = 0; i < nf; i++) xs.push(lows[i] + values[i]);
  const elevations = xs.map((x) => datum + x);

  const corrections = observations.map((o) => {
    const c = elevations[o.toIndex] - elevations[o.fromIndex] - o.measuredDifference;
    return {
      from: o.from,
      to: o.to,
      measuredDifference: o.measuredDifference.toString(),
      maxCorrection: o.maxCorrection.toString(),
      correction: c.toString(),
      recomputedDifference: (o.measuredDifference + c).toString(),
    };
  });

  const gotM = corrections.reduce((a, x) => {
    const v = BigInt(x.correction); const av = v < 0n ? -v : v;
    return av > a ? av : a;
  }, 0n);
  const gotS = corrections.reduce((a, x) => {
    const v = BigInt(x.correction);
    return a + (v < 0n ? -v : v);
  }, 0n);
  if (gotM !== M) throw new Error('内部错误：解未达到最优最大改正量');
  for (const x of corrections) {
    const v = BigInt(x.correction); const av = v < 0n ? -v : v;
    if (av > BigInt(x.maxCorrection)) throw new Error('内部错误：改正量越限');
  }

  return {
    feasible: true,
    stations: stations.map((name, i) => ({ name, elevation: elevations[i].toString() })),
    corrections,
    objective: {
      maxAbsoluteCorrection: M.toString(),
      sumAbsoluteCorrections: gotS.toString(),
    },
  };
}
