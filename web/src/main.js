// 水准网配平前端：草稿状态 + 提交真实 API + 结果/环路展示。
//
// 关键交互约定：
//   * 任何草稿编辑（测站、基准、观测增删改）都会立即撤销旧结论：
//     清空结果区并显示「草稿已修改」横幅，草稿本身完整保留。
//   * 提交后由真实 API 返回各站高程、逐观测改正值和回算高差。
//   * 无可行配平时保留草稿、清除旧结果，并明确指出允许改正量不足。

const INT_RE = /^[+-]?\d+$/;

const EXAMPLE = {
  datum: '1000',
  stations: ['A', 'B', 'C', 'D', 'E'],
  observations: [
    { from: 'A', to: 'B', dh: '12', cap: '5' },
    { from: 'B', to: 'C', dh: '15', cap: '5' },
    { from: 'C', to: 'D', dh: '-10', cap: '5' },
    { from: 'D', to: 'A', dh: '-15', cap: '5' },
    { from: 'A', to: 'E', dh: '-10', cap: '5' },
    { from: 'E', to: 'D', dh: '25', cap: '5' },
    { from: 'B', to: 'E', dh: '-20', cap: '5' },
  ],
};

// ---------- 草稿状态 ----------
let draft = clone(EXAMPLE);
let stale = false;        // 草稿在最近一次提交后被改过
let renderedOnce = false; // 是否曾经展示过配平结果
let submitting = false;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// ---------- 渲染草稿 ----------
function renderStations() {
  const list = $('#stationList');
  list.innerHTML = '';
  draft.stations.forEach((name, i) => {
    const row = el('div', 'station-row');
    row.append(el('span', 'ord', String(i + 1)));
    const input = el('input');
    input.value = name;
    input.setAttribute('aria-label', `测站 ${i + 1} 名称`);
    input.addEventListener('input', () => {
      draft.stations[i] = input.value;
      invalidate();
      renderStationCounts();
      refreshObsSelects();
    });
    row.append(input);
    const right = el('div');
    if (i === 0) right.append(el('span', 'tag', '基准站'));
    else {
      const del = el('button', 'btn btn-danger', '删除');
      del.type = 'button';
      del.addEventListener('click', () => {
        draft.stations.splice(i, 1);
        draft.observations = draft.observations.filter(
          (o) => o.from !== name && o.to !== name,
        );
        invalidate();
        renderAll();
      });
      right.append(del);
    }
    row.append(right);
    list.append(row);
  });
  renderStationCounts();
}

function stationNames() {
  return draft.stations.map((s) => s.trim()).filter(Boolean);
}

function renderStationCounts() {
  const names = stationNames();
  const unique = new Set(names).size === names.length;
  const ok = draft.stations.length >= 5 && draft.stations.length <= 10 && unique && names.length === draft.stations.length;
  const badge = $('#stationCount');
  badge.textContent = `${draft.stations.length} 个（需 5–10，且唯一）`;
  badge.className = unique ? 'badge good' : 'badge bad';
  if (!ok) badge.classList.add('bad');
  $('#addStation').disabled = draft.stations.length >= 10;
}

function renderObservations() {
  const list = $('#obsList');
  list.innerHTML = '';
  draft.observations.forEach((o, k) => list.append(renderObsRow(o, k)));
  $('#addObs').disabled = draft.observations.length >= 18;
  renderObsCount();
}

function renderObsRow(o, k) {
  const row = el('div', 'obs-row obs-grid');
  const mkSel = (which) => {
    const sel = el('select');
    sel.append(new Option('起点…', ''));
    for (const name of stationNames()) sel.append(new Option(name, name));
    sel.value = o[which];
    sel.addEventListener('change', () => {
      o[which] = sel.value;
      invalidate();
      renderObsCount();
    });
    return sel;
  };
  const mkNum = (key, label) => {
    const input = el('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.value = o[key];
    input.setAttribute('aria-label', `${label} ${k + 1}`);
    input.addEventListener('input', () => {
      o[key] = input.value.trim();
      input.classList.toggle('invalid', o[key] !== '' && !INT_RE.test(o[key]));
      invalidate();
      renderObsCount();
    });
    if (o[key] !== '' && !INT_RE.test(o[key])) input.classList.add('invalid');
    return input;
  };
  const del = el('button', 'btn btn-danger', '×');
  del.type = 'button';
  del.title = '删除该观测';
  del.addEventListener('click', () => {
    draft.observations.splice(k, 1);
    invalidate();
    renderAll();
  });
  row.append(mkSel('from'), mkSel('to'), mkNum('dh', '实测高差'), mkNum('cap', '最大允许改正'), del);
  return row;
}

function refreshObsSelects() {
  // 名称变更后仅同步下拉选项，保留当前选中（若已不存在则显示为空）
  $('#obsList').innerHTML = '';
  draft.observations.forEach((o, k) => $('#obsList').append(renderObsRow(o, k)));
  renderObsCount();
}

function renderObsCount() {
  const names = stationNames();
  const okCount = draft.observations.length >= 7 && draft.observations.length <= 18;
  let endpointOk = true;
  for (const o of draft.observations) {
    if (!names.includes(o.from) || !names.includes(o.to) || o.from === o.to) endpointOk = false;
  }
  const badge = $('#obsCount');
  badge.textContent = `${draft.observations.length} 条（需 7–18，方向完整）`;
  badge.className = okCount && endpointOk ? 'badge good' : 'badge bad';
}

function renderAll() {
  renderStations();
  renderObservations();
  renderObsCount();
}

// ---------- 立即撤销旧结论 ----------
function invalidate() {
  stale = true;
  $('#staleBanner').hidden = !renderedOnce;
  $('#result').hidden = true;
  $('#errorBanner').hidden = true;
  if (renderedOnce) $('#emptyBanner').hidden = true;
}

// ---------- 客户端校验 ----------
function validateDraft() {
  const errors = [];
  const names = stationNames();

  if (!INT_RE.test($('#datum').value.trim())) {
    errors.push('基准高程必须是整数（毫米）。');
  }
  if (draft.stations.length < 5 || draft.stations.length > 10) {
    errors.push(`测站数量须在 5 至 10 个之间（当前 ${draft.stations.length}）。`);
  }
  if (names.length !== draft.stations.length) {
    errors.push('存在空白测站名。');
  } else if (new Set(names).size !== names.length) {
    errors.push('测站名必须唯一。');
  }
  if (draft.observations.length < 7 || draft.observations.length > 18) {
    errors.push(`观测数量须在 7 至 18 条之间（当前 ${draft.observations.length}）。`);
  }
  draft.observations.forEach((o, k) => {
    const tag = `第 ${k + 1} 条观测`;
    if (!names.includes(o.from) || !names.includes(o.to)) errors.push(`${tag}：起点/终点必须是已录入测站。`);
    else if (o.from === o.to) errors.push(`${tag}：起点与终点不能相同。`);
    if (!INT_RE.test(o.dh)) errors.push(`${tag}：实测高差必须是整数（毫米）。`);
    if (!INT_RE.test(o.cap)) errors.push(`${tag}：最大允许改正量必须是整数（毫米）。`);
    else if (BigInt(o.cap) < 0n) errors.push(`${tag}：最大允许改正量不能为负。`);
  });
  return errors;
}

// ---------- 提交 ----------
async function submit() {
  if (submitting) return;
  const errors = validateDraft();
  if (errors.length) {
    showError('草稿校验未通过：', errors);
    return;
  }

  submitting = true;
  const btn = $('#submit');
  btn.disabled = true;
  btn.textContent = '求解中…';
  $('#errorBanner').hidden = true;

  const payload = {
    stations: stationNames(),
    datumElevation: $('#datum').value.trim(),
    observations: draft.observations.map((o) => ({
      from: o.from,
      to: o.to,
      measuredDifference: o.dh,
      maxCorrection: o.cap,
    })),
  };

  try {
    const resp = await fetch('./api/leveling/adjust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = data?.error?.message || `请求失败（HTTP ${resp.status}）`;
      showError(msg, data?.error?.details?.map((d) => d.message) || []);
      return;
    }
    if (data.feasible === false) {
      // 无可行配平：保留草稿、清除旧结果、明确指出允许改正量不足
      renderedOnce = true;
      stale = false;
      $('#staleBanner').hidden = true;
      $('#result').hidden = true;
      $('#emptyBanner').hidden = true;
      showError(data.message || '允许改正量不足，无法闭合。', [
        '草稿已保留，可放宽若干观测的最大允许改正量后重新提交。',
      ]);
      return;
    }
    renderedOnce = true;
    stale = false;
    $('#staleBanner').hidden = true;
    $('#errorBanner').hidden = true;
    $('#emptyBanner').hidden = true;
    renderResult(data, payload);
  } catch (err) {
    showError('无法连接配平 API，请确认服务已启动。', [String(err?.message || err)]);
  } finally {
    submitting = false;
    btn.disabled = false;
    btn.textContent = '提交配平';
  }
}

function showError(message, details = []) {
  const banner = $('#errorBanner');
  banner.innerHTML = '';
  banner.append(el('strong', '', message));
  if (details.length) {
    const ul = el('ul');
    for (const d of details) ul.append(el('li', '', d));
    banner.append(ul);
  }
  banner.hidden = false;
  $('#result').hidden = true;
  $('#emptyBanner').hidden = true;
}

// ---------- 结果渲染 ----------
function fmtCls(v) {
  if (v === 0n) return 'zero';
  return v < 0n ? 'neg' : 'pos';
}
function b(v) { return BigInt(v); }

function renderResult(data, payload) {
  $('#result').hidden = false;
  $('#objM').textContent = data.objective.maxAbsoluteCorrection;
  $('#objS').textContent = data.objective.sumAbsoluteCorrections;

  // 各站高程
  const datum = b(payload.datumElevation);
  const stBody = $('#stationResult');
  stBody.innerHTML = '';
  data.stations.forEach((s, i) => {
    const tr = el('tr');
    tr.append(el('td', '', String(i + 1)), el('td', 'dir', s.name));
    tr.append(el('td', '', s.elevation));
    tr.append(el('td', '', String(b(s.elevation) - datum)));
    stBody.append(tr);
  });

  // 逐观测
  const obsBody = $('#obsResult');
  obsBody.innerHTML = '';
  data.corrections.forEach((c) => {
    const tr = el('tr');
    const corr = b(c.correction);
    tr.append(
      el('td', 'dir', `${c.from} → ${c.to}`),
      el('td', '', c.measuredDifference),
      el('td', fmtCls(corr), (corr > 0n ? '+' : '') + c.correction),
      el('td', '', c.recomputedDifference),
      el('td', '', `±${c.maxCorrection}`),
    );
    obsBody.append(tr);
  });

  // 环路（由返回高程自然闭合）
  renderLoops(payload, data);
}

// ---------- 基础环（生成树弦环） ----------
function fundamentalCycles(stations, observations) {
  // observations: {from,to,dh,cap}，端点用测站下标
  const idx = new Map(stations.map((s, i) => [s, i]));
  const edges = observations
    .map((o, k) => ({ k, u: idx.get(o.from), v: idx.get(o.to) }))
    .filter((e) => e.u !== undefined && e.v !== undefined);

  // BFS 生成树（忽略方向）
  const adj = new Map(stations.map((_, i) => [i, []]));
  edges.forEach((e) => { adj.get(e.u).push([e.v, e.k]); adj.get(e.v).push([e.u, e.k]); });
  const parent = new Array(stations.length).fill(-1);
  const parentEdge = new Array(stations.length).fill(-1);
  const seen = new Array(stations.length).fill(false);
  const queue = [0];
  seen[0] = true;
  while (queue.length) {
    const x = queue.shift();
    for (const [y, ek] of adj.get(x)) {
      if (!seen[y]) { seen[y] = true; parent[y] = x; parentEdge[y] = ek; queue.push(y); }
    }
  }

  const cycles = [];
  for (const e of edges) {
    if (parentEdge[e.v] === e.k || parentEdge[e.u] === e.k) continue; // 树边
    if (!seen[e.u] || !seen[e.v]) continue;
    // 树路径 u -> ... -> v
    const pathU = [];
    let a = e.u;
    while (a !== 0) { pathU.push([a, parentEdge[a]]); a = parent[a]; }
    const pathV = [];
    let z = e.v;
    while (z !== 0) { pathV.push([z, parentEdge[z]]); z = parent[z]; }
    const setU = new Map(pathU.map(([node, ek]) => [node, ek]));
    let lca = 0;
    for (const [node] of pathV) if (setU.has(node)) { lca = node; break; }
    const up = [];
    let x = e.u;
    while (x !== lca) { up.push(parentEdge[x]); x = parent[x]; }
    const down = [];
    x = e.v;
    const downNodes = [];
    while (x !== lca) { downNodes.push(x); down.push(parentEdge[x]); x = parent[x]; }
    down.reverse(); downNodes.reverse();

    // 组装「顶点序列 + 每条边的观测下标 + 行进方向是否与观测一致」
    const seq = [e.u];
    let cur = e.u;
    const signed = [];
    const walkUp = up;
    for (const ek of walkUp) {
      const ob = edges.find((g) => g.k === ek);
      const next = cur === ob.u ? ob.v : ob.u;
      signed.push({ ek, sign: cur === ob.u ? 1 : -1 });
      cur = next; seq.push(cur);
    }
    // cur = lca；沿 down 到 e.v
    for (const ek of down) {
      const ob = edges.find((g) => g.k === ek);
      const next = cur === ob.u ? ob.v : ob.u;
      signed.push({ ek, sign: cur === ob.u ? 1 : -1 });
      cur = next; seq.push(cur);
    }
    // 弦边从 e.v 回到 e.u
    signed.push({ ek: e.k, sign: e.v === edges.find((g) => g.k === e.k).u ? 1 : -1 });
    seq.push(e.u);
    cycles.push({ seq, signed });
  }
  return cycles;
}

function renderLoops(payload, data) {
  const body = $('#loopResult');
  body.innerHTML = '';
  const cycles = fundamentalCycles(payload.stations, payload.observations);
  // data.corrections 与 payload.observations 顺序一致，直接按下标取改正值
  const corr = data.corrections;

  cycles.forEach((cy, ci) => {
    let measured = 0n;
    let corrected = 0n;
    const names = cy.seq.map((i) => payload.stations[i]).join(' → ');
    for (const { ek, sign } of cy.signed) {
      const c = corr[ek];
      measured += BigInt(sign) * b(payload.observations[ek].dh);
      corrected += BigInt(sign) * (b(payload.observations[ek].dh) + b(c.correction));
    }
    const tr = el('tr');
    tr.append(
      el('td', 'dir', `环 ${ci + 1}：${names}`),
      el('td', fmtCls(measured), (measured > 0n ? '+' : '') + String(measured)),
      el('td', corrected === 0n ? 'closed' : 'neg', String(corrected)),
    );
    body.append(tr);
  });

  if (cycles.length === 0) {
    const tr = el('tr');
    tr.append(el('td', 'zero', '该网为树状结构，无闭合环。'));
    body.append(tr);
  }
}

// ---------- 健康检查 ----------
async function pingApi() {
  const state = $('#apiState');
  try {
    const resp = await fetch('./api/healthz');
    if (!resp.ok) throw new Error('bad status');
    state.textContent = 'API 在线';
    state.className = 'ok';
  } catch {
    state.textContent = 'API 不可达';
    state.className = 'bad';
  }
}

// ---------- 绑定 ----------
function bind() {
  $('#datum').addEventListener('input', () => {
    draft.datum = $('#datum').value;
    invalidate();
  });
  $('#addStation').addEventListener('click', () => {
    if (draft.stations.length >= 10) return;
    draft.stations.push(`S${draft.stations.length + 1}`);
    invalidate();
    renderAll();
  });
  $('#addObs').addEventListener('click', () => {
    if (draft.observations.length >= 18) return;
    const names = stationNames();
    draft.observations.push({
      from: names[0] || '',
      to: names[1] || names[0] || '',
      dh: '0',
      cap: '5',
    });
    invalidate();
    renderAll();
  });
  $('#submit').addEventListener('click', submit);
  $('#reset').addEventListener('click', () => {
    draft = clone(EXAMPLE);
    $('#datum').value = draft.datum;
    invalidate();
    renderAll();
  });
}

bind();
renderAll();
pingApi();
setInterval(pingApi, 10000);
