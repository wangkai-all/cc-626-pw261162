// http-server.js
// 仅使用 Node.js 内置模块（http / fs / path / url）的 HTTP 服务。
// 业务结果全部由 domain.js 实际计算后返回，前端只负责渲染。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DomainError,
  NotFoundError,
  MODE_SEPARATE,
  MODE_REPLAN,
  EVAL_MODES,
  ESTIMATE_TYPES,
  createStore,
  addEstimate,
  addActual,
  listOrders,
  getOrder,
  evaluate,
  getTimeline,
  decomposeOrder,
  decomposeAll,
  compareModes,
  buildSeedFixtures,
} from './domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function resetStore(store, res, sendJson) {
  store.orders.clear();
  const seeded = buildSeedFixtures();
  store.orders = seeded.store.orders;
  return sendJson(res, 200, {
    ok: true,
    message: '已重置为合成数据',
    orderCount: listOrders(store).length,
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function createApp(store = createStore()) {
  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  function sendError(res, err) {
    if (err instanceof NotFoundError) {
      return sendJson(res, 404, { error: err.code, message: err.message });
    }
    if (err instanceof DomainError) {
      return sendJson(res, 400, { error: err.code, message: err.message });
    }
    return sendJson(res, 500, {
      error: 'INTERNAL',
      message: err?.message ?? '内部错误',
    });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 1_000_000) {
          reject(new DomainError('PAYLOAD_TOO_LARGE', '请求体超过 1MB 限制'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (raw === '') return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new DomainError('INVALID_JSON', '请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('not found');
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    const query = url.searchParams;

    try {
      // ---------- API ----------
      if (pathname.startsWith('/api/')) {
        // 路由表：pathname -> 允许的方法 -> 处理函数
        const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)(\/(timeline|decompose))?$/);
        const routes = [
          { path: '/api/health', methods: { GET: () => sendJson(res, 200, { ok: true, orderCount: listOrders(store).length }) } },
          { path: '/api/reset', methods: { POST: () => resetStore(store, res, sendJson) } },
          { path: '/api/orders', methods: { GET: () => sendJson(res, 200, { orders: listOrders(store) }) } },
          {
            test: () => orderMatch,
            methods: {
              GET: () => {
                const orderId = decodeURIComponent(orderMatch[1]);
                const sub = orderMatch[3];
                if (sub === 'timeline') return sendJson(res, 200, getTimeline(store, orderId));
                if (sub === 'decompose') {
                  const mode = normalizeMode(query.get('mode'));
                  return sendJson(res, 200, decomposeOrder(store, orderId, mode));
                }
                return sendJson(res, 200, getOrder(store, orderId));
              },
            },
          },
          { path: '/api/evaluate', methods: { GET: () => sendJson(res, 200, evaluate(store, normalizeMode(query.get('mode')))) } },
          { path: '/api/decompose', methods: { GET: () => sendJson(res, 200, decomposeAll(store, normalizeMode(query.get('mode')))) } },
          { path: '/api/compare-modes', methods: { GET: () => sendJson(res, 200, compareModes(store)) } },
          {
            path: '/api/estimates',
            methods: {
              POST: async () => {
                const body = await readBody(req);
                if (!body.type) body.type = 'scope_change'; // 页面按钮语义：补录一次范围变化
                if (!ESTIMATE_TYPES.includes(body.type)) {
                  throw new DomainError('INVALID_TYPE', `type 必须是 ${ESTIMATE_TYPES.join('/')} 之一`);
                }
                const record = addEstimate(store, body);
                return sendJson(res, 201, { ok: true, record });
              },
            },
          },
          {
            path: '/api/actuals',
            methods: {
              POST: async () => {
                const body = await readBody(req);
                const record = addActual(store, body);
                return sendJson(res, 201, { ok: true, record });
              },
            },
          },
        ];

        const route = routes.find((r) => (r.path ? r.path === pathname : r.test()));
        if (!route) {
          return sendJson(res, 404, { error: 'ROUTE_NOT_FOUND', message: `无此接口: ${pathname}` });
        }
        const handler = route.methods[req.method];
        if (!handler) {
          return sendJson(res, 405, {
            error: 'METHOD_NOT_ALLOWED',
            message: `该接口仅支持 ${Object.keys(route.methods).join('/')}`,
          });
        }
        return await handler();
      }

      // ---------- 静态资源 ----------
      if (req.method === 'GET') {
        return serveStatic(res, pathname);
      }
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: '仅支持 GET' });
    } catch (err) {
      return sendError(res, err);
    }
  });

  return server;
}

function normalizeMode(value) {
  if (value === null || value === '') return MODE_SEPARATE;
  if (!EVAL_MODES.includes(value)) {
    throw new DomainError('INVALID_MODE', `mode 必须是 ${EVAL_MODES.join('/')} 之一`);
  }
  return value;
}

export { MODE_SEPARATE, MODE_REPLAN };
