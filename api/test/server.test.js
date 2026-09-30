import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PORT = 8199;
let base;
let child;

before(async () => {
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, API_PORT: String(PORT), API_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  base = `http://127.0.0.1:${PORT}`;
  // 等待端口就绪
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) break;
    } catch { /* 尚未就绪 */ }
    await new Promise((res) => setTimeout(res, 100));
  }
});

after(async () => {
  child.kill('SIGTERM');
  await once(child, 'exit');
});

test('GET /healthz 返回 200 与 ok 状态', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'ok');
});

test('POST 可行配平返回高程、改正与回算高差', async () => {
  const r = await fetch(`${base}/api/leveling/adjust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stations: ['A', 'B', 'C', 'D', 'E'],
      datumElevation: '1000',
      observations: [
        { from: 'A', to: 'B', measuredDifference: '10', maxCorrection: '5' },
        { from: 'B', to: 'C', measuredDifference: '15', maxCorrection: '5' },
        { from: 'C', to: 'D', measuredDifference: '-10', maxCorrection: '5' },
        { from: 'D', to: 'A', measuredDifference: '-15', maxCorrection: '5' },
        { from: 'A', to: 'E', measuredDifference: '-10', maxCorrection: '5' },
        { from: 'E', to: 'D', measuredDifference: '25', maxCorrection: '5' },
        { from: 'B', to: 'E', measuredDifference: '-20', maxCorrection: '5' },
      ],
    }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.feasible, true);
  assert.equal(j.stations[0].elevation, '1000');
  assert.equal(j.objective.maxAbsoluteCorrection, '0');
  assert.equal(j.corrections.length, 7);
  for (const c of j.corrections) assert.equal(c.correction, '0');
});

test('允许改正量不足：200 + feasible=false + INSUFFICIENT_CORRECTION', async () => {
  const r = await fetch(`${base}/api/leveling/adjust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stations: ['A', 'B', 'C', 'D', 'E'],
      datumElevation: '1000',
      observations: [
        { from: 'A', to: 'B', measuredDifference: '18', maxCorrection: '1' },
        { from: 'B', to: 'C', measuredDifference: '15', maxCorrection: '1' },
        { from: 'C', to: 'D', measuredDifference: '-10', maxCorrection: '1' },
        { from: 'D', to: 'A', measuredDifference: '-13', maxCorrection: '1' },
        { from: 'A', to: 'E', measuredDifference: '-10', maxCorrection: '1' },
        { from: 'E', to: 'D', measuredDifference: '25', maxCorrection: '1' },
        { from: 'B', to: 'E', measuredDifference: '-20', maxCorrection: '1' },
      ],
    }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.feasible, false);
  assert.equal(j.reason, 'INSUFFICIENT_CORRECTION');
});

test('非法输入返回 400 与字段级明细', async () => {
  const r = await fetch(`${base}/api/leveling/adjust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stations: ['A', 'B'], datumElevation: 'x', observations: [] }),
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error.code, 'VALIDATION_FAILED');
  assert.ok(Array.isArray(j.error.details));
});

test('非法 JSON 返回 400 INVALID_JSON', async () => {
  const r = await fetch(`${base}/api/leveling/adjust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'oops',
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error.code, 'INVALID_JSON');
});

test('未知路由返回 404', async () => {
  const r = await fetch(`${base}/nope`);
  assert.equal(r.status, 404);
});
