// http.test.js — 接口层正常与异常用例（node --test，内置 fetch）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/http-server.js';
import { createStore, buildSeedFixtures } from '../src/domain.js';

let server;
let base;

function freshStore() {
  const seeded = buildSeedFixtures();
  return seeded.store;
}

before(async () => {
  server = createApp(freshStore());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function jsonFetch(path, options) {
  const res = await fetch(base + path, options);
  const body = await res.json();
  return { status: res.status, body };
}

test('正常：健康检查与工单列表', async () => {
  const r = await jsonFetch('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.orderCount, 8);

  const list = await jsonFetch('/api/orders');
  assert.equal(list.body.orders.length, 8);
});

test('正常：运行原估时评估，结果由后端计算', async () => {
  const r = await jsonFetch('/api/evaluate?mode=scope_separate');
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'scope_separate');
  assert.ok(r.body.groups.length >= 1);
  assert.equal(r.body.overall.evaluatedOrders, 6);

  // WO-001：baseline 16h，实际 18h，单列模式误差 +2h
  const rows = r.body.groups.flatMap((g) => g.orders);
  const wo1 = rows.find((x) => x.orderId === 'WO-001');
  assert.equal(wo1.forecastError, 2);
  assert.equal(wo1.coveragePct, 18 / 16);
});

test('正常：阶段重估模式返回不同口径结果', async () => {
  const r = await jsonFetch('/api/evaluate?mode=phase_replan');
  assert.equal(r.status, 200);
  const wo4 = r.body.groups.flatMap((g) => g.orders).find((x) => x.orderId === 'WO-004');
  assert.equal(wo4.forecastHours, 96);  // 80 + 24 - 8
  assert.equal(wo4.actualHours, 98);
  assert.equal(wo4.forecastError, 2);
});

test('正常：默认 mode 缺省为范围单列', async () => {
  const r = await jsonFetch('/api/evaluate');
  assert.equal(r.body.mode, 'scope_separate');
});

test('正常：误差分解接口与恒等式闭合', async () => {
  const r = await jsonFetch('/api/decompose?mode=phase_replan');
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.body.components.planError) > 0);
  for (const d of r.body.perOrder) {
    assert.ok(Math.abs(d.identityCheck) < 1e-9);
  }
});

test('正常：工单时间线给出两个更正与差异区间', async () => {
  const r = await jsonFetch('/api/orders/WO-004/timeline');
  assert.equal(r.status, 200);
  assert.equal(r.body.correctionCount, 2);
  assert.equal(r.body.envelope.width, 24);
  assert.equal(r.body.envelope.drift, 16);
});

test('正常：补录一次范围变化只追加，baseline 不变且评估随之变化', async () => {
  const before = await jsonFetch('/api/evaluate?mode=scope_separate');
  const beforeWo3 = before.body.groups.flatMap((g) => g.orders).find((x) => x.orderId === 'WO-003');
  assert.equal(beforeWo3.scopeAddedHours, 8);

  const post = await jsonFetch('/api/estimates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orderId: 'WO-003',
      type: 'scope_change',
      hours: 5,
      timestamp: '2026-11-20T09:00:00.000Z',
      note: '测试追加',
    }),
  });
  assert.equal(post.status, 201);
  assert.equal(post.body.record.cumulativeForecast, 61); // 48 + 8 + 5

  const order = await jsonFetch('/api/orders/WO-003');
  const baseline = order.body.estimates.find((e) => e.type === 'baseline');
  assert.equal(baseline.hours, 48); // 原目标未被改写

  const after = await jsonFetch('/api/evaluate?mode=scope_separate');
  const afterWo3 = after.body.groups.flatMap((g) => g.orders).find((x) => x.orderId === 'WO-003');
  assert.equal(afterWo3.scopeAddedHours, 13); // 8 + 5，单列累加
  assert.equal(afterWo3.forecastError, beforeWo3.forecastError); // 计划误差不受追加影响
});

test('正常：POST estimates 缺省 type 时按 scope_change 处理', async () => {
  const r = await jsonFetch('/api/estimates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: 'WO-002', hours: 3, timestamp: '2026-11-20T10:00:00.000Z' }),
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.record.type, 'scope_change');
});

test('正常：重置接口恢复初始合成数据', async () => {
  const r = await jsonFetch('/api/reset', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.body.orderCount, 8);
  const list = await jsonFetch('/api/orders/WO-003');
  assert.equal(list.body.estimates.filter((e) => e.type === 'scope_change').length, 1);
});

test('正常：两种模式对比接口', async () => {
  const r = await jsonFetch('/api/compare-modes');
  assert.equal(r.status, 200);
  assert.ok(r.body.scope_separate);
  assert.ok(r.body.phase_replan);
});

test('正常：静态首页可访问且包含证据属性标记', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /data-evidence-result/);
  assert.match(html, /运行原估时评估/);
  assert.match(html, /补录一次范围变化/);
  assert.match(html, /查看误差分解/);
});

// ---------------- 异常路径 ----------------

test('异常：非法 JSON 返回 400 INVALID_JSON', async () => {
  const r = await jsonFetch('/api/estimates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'INVALID_JSON');
});

test('异常：重复 baseline 返回 400 BASELINE_EXISTS', async () => {
  const r = await jsonFetch('/api/estimates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: 'WO-001', type: 'baseline', hours: 99, timestamp: '2026-11-20T09:00:00.000Z' }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'BASELINE_EXISTS');
});

test('异常：非法工时返回 400 INVALID_HOURS', async () => {
  const r = await jsonFetch('/api/estimates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: 'WO-009', type: 'baseline', hours: 0, timestamp: '2026-11-20T09:00:00.000Z' }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'INVALID_HOURS');
});

test('异常：乱序时间戳返回 400 TIMESTAMP_ORDER', async () => {
  const r = await jsonFetch('/api/estimates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: 'WO-001', type: 'scope_change', hours: 4, timestamp: '2020-01-01T00:00:00.000Z' }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'TIMESTAMP_ORDER');
});

test('异常：非法 mode 返回 400 INVALID_MODE', async () => {
  const r = await jsonFetch('/api/evaluate?mode=nope');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'INVALID_MODE');
});

test('异常：不存在的工单返回 404', async () => {
  const r = await jsonFetch('/api/orders/NOPE/timeline');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'ORDER_NOT_FOUND');
});

test('异常：未知路由返回 404，已注册路径的错误方法返回 405', async () => {
  const r = await jsonFetch('/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'ROUTE_NOT_FOUND');

  const res = await fetch(base + '/api/health', { method: 'DELETE' });
  assert.equal(res.status, 405);
});
