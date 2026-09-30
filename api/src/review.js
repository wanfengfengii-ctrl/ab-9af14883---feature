// 单边失效复核（与三级裁决联合求解，不做「先求解、后检查」）。
//
// 给定整数可信改正阈值 T，一条观测 k 可作复核边当且仅当 |c_k| <= T。
// 复核网 R = { k : |c_k| <= T } 必须：
//   1) 连接全部测站与基准站；
//   2) 删去 R 中任意一条边后，每个测站仍能沿 R 的其余边到达基准站
//      （R 含一张无桥/2-边连通生成子图；按 Robbins/Menger 等价于
//        每个非基准站都有两条不含公共观测的基准路径）。
//
// 联合性：把观测分为
//   F = { cap_k <= T }：任何可行解里恒为复核边（上界天然不超过 T）；
//   P = { cap_k >  T }：只有解中被压到 |c_k| <= T 时才进入复核网。
// 枚举使 G[F ∪ L] 无桥连通的极小 L ⊆ P，在「F ∪ L 上界取 T、其余取 cap」
// 的约束下整体重跑 M → S → 高程序列三级裁决，再在全部候选间按同一裁决取
// 全局最优。任何满足复核性质的解，其复核网都含某个被枚举的极小核，故不会
// 漏解；而每个候选核在最终解里都确实满足 |c|<=T，故也不会误判。

import { diffDistances, distFeasible, optimizeWithBounds } from './solver.js';

// ---- 无桥连通判定（Tarjan 桥，多重边安全） -------------------------------

export function analyzeGraph(n, edges) {
  // edges: [{u, v}]（同一起终点的多条边按邻接位置区分，需带 k）
  const adj = Array.from({ length: n }, () => []);
  for (const e of edges) { adj[e.u].push([e.v, e.k]); adj[e.v].push([e.u, e.k]); }
  const seen = new Array(n).fill(false);
  const stack = [0];
  seen[0] = true;
  while (stack.length) {
    const u = stack.pop();
    for (const [v] of adj[u]) if (!seen[v]) { seen[v] = true; stack.push(v); }
  }
  if (!seen.every(Boolean)) return { connected: false, bridgeCount: 1 };

  const tin = new Array(n).fill(-1);
  const low = new Array(n);
  let timer = 0;
  let bridgeCount = 0;
  const dfs = (u, parentEdge) => {
    tin[u] = low[u] = timer++;
    for (const [v, ek] of adj[u]) {
      if (ek === parentEdge) continue;
      if (tin[v] >= 0) { low[u] = Math.min(low[u], tin[v]); continue; }
      dfs(v, ek);
      low[u] = Math.min(low[u], low[v]);
      if (low[v] > tin[u]) bridgeCount++;
    }
  };
  dfs(0, -1);
  return { connected: true, bridgeCount };
}

const isBridgeless = (n, edges) => {
  const a = analyzeGraph(n, edges);
  return a.connected && a.bridgeCount === 0;
};

// 枚举使「F ∪ L」无桥连通的极小 L ⊆ P（删去 L 中任一条都会重新出现桥或断连），
// 返回 L 在 P 中的位掩码集合。
// 按观测下标递增的 DFS：每个子集有唯一的规范顺序；当前已无桥即记录并停止
// 扩展，「当前边 ∪ 剩余全部边仍不能无桥」时剪枝。DFS 首次达到无桥时，较早
// 加入的边未必必要，故记录前再做一次逐条删除的极小性校验（非极小集必含某个
// 极小子集，其约束更松、最优值不会更差，故可安全丢弃）。
export function enumerateMinimalCores(n, fixedEdges, pEdges) {
  const m = pEdges.length;
  const cores = [];
  if (!isBridgeless(n, fixedEdges.concat(pEdges))) return cores;

  const chosen = new Array(m).fill(false);
  const chosenEdges = () => fixedEdges.concat(pEdges.filter((_, i) => chosen[i]));

  // L 的 P-极小性：删去 L 中任一条 P 边后 F∪(L\\{e}) 不再无桥连通。
  // 不检查 F 边：F 的上界恒为 T（=其 cap，本就无额外约束），其图上是否多余
  // 不改变候选的可行域；真正产生新收紧的只有被选入的 P 边。
  const isPMinimal = (chosenSet) => {
    for (let i = 0; i < m; i++) {
      if (!chosenSet[i]) continue;
      chosenSet[i] = false;
      const still = isBridgeless(n, chosenEdges());
      chosenSet[i] = true;
      if (still) return false;
    }
    return true;
  };

  const dfs = (start) => {
    if (isBridgeless(n, chosenEdges())) {
      if (isPMinimal(chosen)) {
        let mask = 0;
        for (let i = 0; i < m; i++) if (chosen[i]) mask |= 1 << i;
        cores.push(mask);
      }
      return;
    }
    for (let k = start; k < m; k++) {
      chosen[k] = true;
      // 乐观剪枝：当前选择 + k+1..m-1 全部加入后必须能补成无桥
      let optimistic;
      if (k + 1 === m) {
        optimistic = chosenEdges();
      } else {
        optimistic = chosenEdges().concat(pEdges.slice(k + 1));
      }
      if (isBridgeless(n, optimistic)) dfs(k + 1);
      chosen[k] = false;
    }
  };
  dfs(0);
  return cores;
}

// ---- 两条边不相交的基准路径（无向单位边容量最大流） -----------------------
//
// 每条无向观测建成 u→v、v→u 两条容量 1 的有向弧（标准无向边建模）；
// 两次增广得到 source→基准站 0 的 2 单位整数流。若同一无向边被两个方向
// 同时占用，作为环流抵消；消去有向环后分解为两条边不相交路径。
export function witnessPaths(n, edgeList, source) {
  const adj = Array.from({ length: n }, () => []);
  const arcs = []; // {u, v, cap, flow, edgeId}
  const addArc = (u, v, cap, edgeId) => {
    const fwd = arcs.length;
    const rev = arcs.length + 1;
    arcs.push({ u, v, cap, flow: 0, edgeId });
    arcs.push({ u: v, v: u, cap: 0, flow: 0, edgeId });
    adj[u].push(fwd); adj[v].push(rev);
    return fwd;
  };
  for (const e of edgeList) {
    addArc(e.u, e.v, 1, e.k);
    addArc(e.v, e.u, 1, e.k);
  }

  const augment = () => {
    const prevArc = new Array(n).fill(-1);
    const seen = new Array(n).fill(false);
    seen[source] = true;
    const queue = [source];
    while (queue.length) {
      const u = queue.shift();
      if (u === 0) break;
      for (const ai of adj[u]) {
        const a = arcs[ai];
        if (seen[a.v] || a.cap - a.flow <= 0) continue;
        seen[a.v] = true;
        prevArc[a.v] = ai;
        queue.push(a.v);
      }
    }
    if (!seen[0]) return false;
    for (let v = 0; v !== source; ) {
      const ai = prevArc[v];
      if (ai < 0) return false;
      const a = arcs[ai];
      a.flow += 1;
      arcs[ai ^ 1].flow -= 1;
      v = a.u;
    }
    return true;
  };

  if (!augment() || !augment()) return null;

  // 只保留原始容量弧上的正流（残量弧仅为记账），再抵消同一条无向观测上
  // 方向相反的一对流（无向边被两次增广反向占用时构成环流）。
  let live = arcs.filter((a) => a.cap === 1 && a.flow > 0);
  for (let i = 0; i < live.length; i++) {
    if (live[i].flow <= 0) continue;
    const opp = live.findIndex((b, j) =>
      j > i && b.flow > 0 && b.edgeId === live[i].edgeId && b.u === live[i].v && b.v === live[i].u);
    if (opp >= 0) { live[i].flow = 0; live[opp].flow = 0; }
  }
  live = live.filter((a) => a.flow > 0);

  // 消去剩余有向环（保持流量守恒与流值不变），使活弧恰好是两条源→汇路径。
  const cancelCycles = () => {
    for (;;) {
      const color = new Array(n).fill(0);
      const nodeStack = [];
      const arcStack = [];
      let cycle = null;
      const dfs = (u) => {
        color[u] = 1;
        nodeStack.push(u);
        for (const a of live) {
          if (a.u !== u || a.flow <= 0) continue;
          if (color[a.v] === 0) {
            arcStack.push(a);
            if (dfs(a.v)) return true;
            arcStack.pop();
          } else if (color[a.v] === 1) {
            const start = nodeStack.indexOf(a.v);
            cycle = arcStack.slice(start).concat(a);
            return true;
          }
        }
        color[u] = 2;
        nodeStack.pop();
        return false;
      };
      let found = false;
      for (let u = 0; u < n; u++) {
        if (color[u] === 0 && dfs(u)) { found = true; break; }
      }
      if (!found) return;
      for (const a of cycle) a.flow = 0;
      live = live.filter((a) => a.flow > 0);
    }
  };
  cancelCycles();

  // 从源沿正流弧取出两条到达基准站的路径
  const out = Array.from({ length: n }, () => []);
  live.forEach((a) => out[a.u].push(a));
  const paths = [];
  for (let which = 0; which < 2; which++) {
    const nodes = [source];
    const edgeIds = [];
    let u = source;
    let guard = 0;
    while (u !== 0) {
      if (++guard > n + 2) return null;
      const a = out[u].find((x) => x.flow > 0);
      if (!a) return null;
      a.flow = 0;
      edgeIds.push(a.edgeId);
      u = a.v;
      nodes.push(u);
    }
    paths.push({ nodes, edgeIds });
  }
  // 校验：两条路径不共享任何无向观测，且均终于基准站
  const shared = paths[0].edgeIds.filter((id) => paths[1].edgeIds.includes(id));
  if (shared.length) return null;
  if (paths.some((p) => p.nodes[0] !== source || p.nodes[p.nodes.length - 1] !== 0)) return null;
  return paths;
}

// ---- 复核失败回包 ---------------------------------------------------------

function reviewFailure(problem, reason, message) {
  const { stations, datum, observations, review } = problem;
  return {
    feasible: false,
    reason,
    message,
    stations: stations.map((name, i) => ({ name, elevation: i === 0 ? datum.toString() : null })),
    observations: observations.map((o) => ({
      from: o.from, to: o.to,
      measuredDifference: o.measuredDifference.toString(),
      maxCorrection: o.maxCorrection.toString(),
    })),
    review: {
      enabled: true,
      trustedThreshold: review.threshold.toString(),
      sufficient: false,
    },
  };
}

// ---- 联合求解主入口（由 solveNetwork 调用） -------------------------------

export function solveWithReview(problem) {
  const { stations, observations, review } = problem;
  const n = stations.length;
  const T = review.threshold;
  const edgeOf = (k) => ({ u: observations[k].fromIndex, v: observations[k].toIndex, k });

  const fixedIdx = [];
  const pIdx = [];
  observations.forEach((o, k) => (o.maxCorrection <= T ? fixedIdx : pIdx).push(k));
  const fixedEdges = fixedIdx.map(edgeOf);
  const pEdges = pIdx.map(edgeOf);

  // 即使所有观测都可作复核边仍有桥：结构性复核冗余不足，直接判定。
  if (!isBridgeless(n, fixedEdges.concat(pEdges))) {
    return reviewFailure(
      problem,
      'REVIEW_REDUNDANCY_INSUFFICIENT',
      `复核冗余不足：阈值 ${T} 毫米下，即使每条观测都作复核边，水准网中仍存在「桥」观测——该观测一旦失效，相关测站将无法沿复核边到达基准站。草稿已保留、旧结论已清除；请加大可信改正阈值、补充平行/环线观测后重试。`,
    );
  }

  const cores = enumerateMinimalCores(n, fixedEdges, pEdges)
    .map((mask) => ({ mask, size: countBits(mask) }))
    .sort((a, b) => (a.size - b.size || a.mask - b.mask));

  const tripleOf = (r) => [r.M, r.S, r.elevations.slice(1)];
  const lessTriple = (a, b) => {
    const [M1, S1, X1] = tripleOf(a);
    const [M2, S2, X2] = tripleOf(b);
    if (M1 !== M2) return M1 < M2;
    if (S1 !== S2) return S1 < S2;
    for (let i = 0; i < X1.length; i++) {
      if (X1[i] !== X2[i]) return X1[i] < X2[i];
    }
    return false;
  };
  const tripleEqual = (a, b) => !lessTriple(a, b) && !lessTriple(b, a);
  const satisfiesBounds = (r, bounds) =>
    observations.every((o, k) => {
      const c = r.corrections[k];
      const a = c < 0n ? -c : c;
      return a <= bounds[k];
    });

  // 快速通道：原（无复核约束）最优解若本身满足复核网条件，则它在收紧后的
  // 可行集内仍然可行，而它已是全局三级裁决最优，故必为复核问题的最优解。
  // 原解不满足时下面仍逐个候选核联合重裁（不是事后拿桥边否决原解）。
  const original = optimizeWithBounds(problem, observations.map((o) => o.maxCorrection));
  let answer = null;       // 合法复核答案（现任最优）
  let unbeatable = false;  // 答案即原无约束最优，不可能再被改进
  if (original) {
    const trustedEdges = observations
      .map((o, k) => ({ u: o.fromIndex, v: o.toIndex, k }))
      .filter((e) => {
        const c = original.corrections[e.k];
        return (c < 0n ? -c : c) <= T;
      });
    if (isBridgeless(n, trustedEdges)) { answer = original; unbeatable = true; }
  }

  // 差分约束（Floyd）二分候选的最小可行 M，并给出该 M 下 S 的一个下界：
  // 放松「各 |c_k| 共享同一组高程」的耦合，仅由每个 x_v、x_u 的紧可行整数
  // 区间独立求 |c_k| 的最小可能值之和。下界不超过真实最优 S，故只用于剪枝。
  const minMwithSLB = (bounds) => {
    const feasible = (bb) => distFeasible(diffDistances(n, problem, (_o, k) => bb[k]));
    if (!feasible(bounds)) return null;
    const maxB = bounds.reduce((a, b) => (b > a ? b : a), 0n);
    let lo = 0n, hi = maxB;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (feasible(bounds.map((b) => (mid < b ? mid : b)))) hi = mid; else lo = mid + 1n;
    }
    const M = lo;
    const B = bounds.map((b) => (M < b ? M : b));
    const dist = diffDistances(n, problem, (_o, k) => B[k]);
    const rangeOf = (i) => (i === 0 ? [0n, 0n] : [-dist[i][0], dist[0][i]]);
    let slb = 0n;
    for (const o of observations) {
      const [lv, hv] = rangeOf(o.toIndex);
      const [lu, hu] = rangeOf(o.fromIndex);
      const w = o.measuredDifference;
      const loC = lv - hu - w;
      const hiC = hv - lu - w;
      slb += loC > 0n ? loC : (hiC < 0n ? -hiC : 0n);
    }
    return { M, slb };
  };

  for (const { mask } of cores) {
    if (unbeatable) break; // 答案已是理论最优（M=0 或原无约束最优）
    const tight = new Set(fixedIdx);
    pEdges.forEach((e, i) => { if (mask >> i & 1) tight.add(e.k); });
    // 核内边的有效上界为 min(T, cap)：F 边 cap≤T 仍受 cap 限制，
    // 入选的 P 边 cap>T 才被压到 T；核外边维持原 cap。
    const bounds = observations.map((o, k) =>
      (tight.has(k) && T < o.maxCorrection ? T : o.maxCorrection));

    // 剪枝 1：现任合法答案在该候选约束下仍可行 ⇒ 该候选最优三级裁决不会更优。
    if (answer && satisfiesBounds(answer, bounds)) continue;

    // 剪枝 2：Floyd 最小 M 与 S 下界（微秒级），严格劣于现任则跳过单纯形。
    const probe = minMwithSLB(bounds);
    if (!probe) continue;
    if (answer && (probe.M > answer.M || (probe.M === answer.M && probe.slb > answer.S))) continue;

    // 该候选下整体三级裁决（M→S→高程序列），与原求解同一套优化器。
    const cand = optimizeWithBounds(problem, bounds);
    if (!cand) continue;
    if (!answer || lessTriple(cand, answer)) {
      answer = cand;
      if (cand.M === 0n) { unbeatable = true; break; }
      // 已追平原无约束最优的三级裁决值，后续候选不可能更优
      if (original && tripleEqual(cand, original)) { unbeatable = true; break; }
    }
  }

  if (!answer) {
    return reviewFailure(
      problem,
      'REVIEW_REDUNDANCY_INSUFFICIENT',
      `复核冗余不足：原网络在允许改正量内可以配平，但在可信改正阈值 ${T} 毫米下，不存在能让足够多观测（|改正| ≤ ${T}）组成「删任一条仍连通基准站」复核网的整数高程。草稿已保留、旧结论已清除；请加大阈值、放宽改正量或补充环线/往返观测后重试。`,
    );
  }

  // 实际复核网：所有改正量不超过 T 的观测（含被选中的极小核，故无桥）。
  const reviewFlag = answer.corrections.map((c) => {
    const a = c < 0n ? -c : c;
    return a <= T;
  });
  const reviewEdges = observations
    .map((o, k) => ({ u: o.fromIndex, v: o.toIndex, k }))
    .filter((e) => reviewFlag[e.k]);
  if (!isBridgeless(n, reviewEdges)) throw new Error('内部错误：复核网不满足无桥连通');

  // 从实际复核网中贪心跳出一张极小无桥生成子网作为「复核核心」（诊断用）。
  const coreEdges = reviewEdges.slice();
  for (let i = coreEdges.length - 1; i >= 0; i--) {
    const trial = coreEdges.slice(0, i).concat(coreEdges.slice(i + 1));
    if (isBridgeless(n, trial)) coreEdges.splice(i, 1);
  }
  const coreIndices = coreEdges.map((e) => e.k).sort((a, b) => a - b);

  // 每个非基准站的两条边不相交基准路径（站名 + 观测下标，便于独立核对）
  const witnesses = [];
  for (let i = 1; i < n; i++) {
    const two = witnessPaths(n, reviewEdges, i);
    if (!two || two.length !== 2) throw new Error('内部错误：无法构造两条复核见证路径');
    witnesses.push({
      station: stations[i],
      paths: two.map((p) => ({
        stations: p.nodes.map((v) => stations[v]),
        observations: p.edgeIds.slice(),
      })),
    });
  }

  return {
    problem,
    result: answer,
    reviewBlock: {
      enabled: true,
      trustedThreshold: T.toString(),
      sufficient: true,
      reviewEdges: reviewFlag,
      reviewEdgeCount: reviewFlag.filter(Boolean).length,
      core: coreIndices.sort((a, b) => a - b),
      witnesses,
    },
  };
}

function countBits(x) {
  let c = 0;
  while (x) { x &= x - 1; c++; }
  return c;
}
