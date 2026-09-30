// 水准高程网配平 API（无第三方依赖，Node 内置 http）。
import http from 'node:http';
import { solveNetwork, ValidationError } from './solver.js';

const PORT = Number.parseInt(process.env.API_PORT || '8080', 10);
const HOST = process.env.API_HOST || '0.0.0.0';
const MAX_BODY = 256 * 1024;

let startedAt = new Date().toISOString();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/api/healthz')) {
    sendJson(res, 200, { status: 'ok', service: 'leveling-api', time: new Date().toISOString() });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/api/leveling/adjust' || url.pathname === '/api/solve')) {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        sendJson(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' } });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let data;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        sendJson(res, 400, { error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON' } });
        return;
      }
      try {
        const result = solveNetwork(data);
        sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof ValidationError) {
          sendJson(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message, details: err.details } });
          return;
        }
        // eslint-disable-next-line no-console
        console.error('求解失败：', err);
        sendJson(res, 500, { error: { code: 'SOLVER_ERROR', message: '服务端求解时发生内部错误' } });
      }
    });
    req.on('error', () => {
      if (!res.headersSent) sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: '请求读取失败' } });
    });
    return;
  }

  sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由：${req.method} ${url.pathname}` } });
});

server.listen(PORT, HOST, () => {
  startedAt = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[leveling-api] listening on http://${HOST}:${PORT} (started ${startedAt})`);
});

const shutdown = (signal) => {
  // eslint-disable-next-line no-console
  console.log(`[leveling-api] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
