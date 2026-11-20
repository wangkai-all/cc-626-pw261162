// domain.test.js — 领域层正常与异常用例（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  addEstimate,
  addActual,
  evaluate,
  getTimeline,
  decomposeOrder,
  decomposeAll,
  compareModes,
  buildSeedFixtures,
  scaleOf,
  DomainError,
  NotFoundError,
  MODE_SEPARATE,
  MODE_REPLAN,
} from '../src/domain.js';

const T0 = '2026-11-01T09:00:00.000Z';
const T1 = '2026-11-02T09:00:00.000Z';
const T2 = '2026-11-03T09:00:00.000Z';
const T3 = '2026-11-04T09:00:00.000Z';

function seedOne() {
  const store = createStore();
  addEstimate(store, { orderId: 'A', type: 'baseline', hours: 40, timestamp: T0 });
  return store;
}

test('正常：估时与实际独立留版，补录不改写原目标', () => {
  const store = seedOne();
  const scope = addEstimate(store, {
    orderId: 'A', type: 'scope_change', hours: 8, timestamp: T1, note: '追加',
  });
  const actual = addActual(store, { orderId: 'A', hours: 46, timestamp: T2 });

  assert.equal(scope.id, 'EST-2');
  assert.equal(scope.cumulativeForecast, 48);
  assert.equal(actual.id, 'ACT-1');

  const order = store.orders.get('A');
  const baseline = order.estimates.find((e) => e.type === 'baseline');
  assert.equal(baseline.hours, 40); // 原目标原样保留
  assert.deepEqual(
    order.estimates.map((e) => `${e.type}:${e.hours}`),
    ['baseline:40', 'scope_change:8'],
  );
});

test('正常：范围单列模式 baseline 对核心实际，追加量单列', () => {
  const store = seedOne();
  addEstimate(store, { orderId: 'A', type: 'scope_change', hours: 8, timestamp: T1 });
  addActual(store, { orderId: 'A', hours: 46, timestamp: T2 });
  addActual(store, { orderId: 'A', hours: 9, timestamp: T3, note: 'scope' });

  const result = evaluate(store, MODE_SEPARATE);
  const row = result.groups.flatMap((g) => g.orders).find((r) => r.orderId === 'A');
  assert.equal(row.forecastHours, 40);
  assert.equal(row.actualHours, 46);          // 核心实际不含 scope 实际
  assert.equal(row.scopeAddedHours, 8);
  assert.equal(row.forecastError, 6);         // 46 - 40
  assert.equal(row.coveragePct, 46 / 40);
});

test('正常：阶段重估模式用最新累计预测对总实际', () => {
  const store = seedOne();
  addEstimate(store, { orderId: 'A', type: 'scope_change', hours: 8, timestamp: T1 });
  addActual(store, { orderId: 'A', hours: 55, timestamp: T2 });

  const result = evaluate(store, MODE_REPLAN);
  const row = result.groups.flatMap((g) => g.orders).find((r) => r.orderId === 'A');
  assert.equal(row.forecastHours, 48);
  assert.equal(row.actualHours, 55);
  assert.equal(row.forecastError, 7);         // 55 - 48
  assert.equal(row.coveragePct, 55 / 48);
});

test('正常：按工单规模分桶', () => {
  assert.equal(scaleOf(24), 'S');
  assert.equal(scaleOf(25), 'M');
  assert.equal(scaleOf(72), 'M');
  assert.equal(scaleOf(73), 'L');
  assert.equal(scaleOf(200), 'L');
});

test('正常：合成数据按规模分组统计误差与覆盖', () => {
  const { store } = buildSeedFixtures();
  const result = evaluate(store, MODE_SEPARATE);
  const keys = result.groups.map((g) => g.scale).sort();
  assert.deepEqual(keys, ['L', 'M', 'S']);

  const m = result.groups.find((g) => g.scale === 'M');
  assert.equal(m.orderCount, 2); // WO-002、WO-003
  assert.ok(m.mape > 0);
  assert.ok(m.coveragePct > 0);

  // 总体加权 MAPE = 绝对误差合计 / 预测合计
  const o = result.overall;
  assert.ok(Math.abs(o.weightedMape - o.sumAbsErrorHours / o.sumForecastHours) < 1e-12);
  assert.equal(o.evaluatedOrders, 6);
  assert.equal(o.totalOrders, 8);
});

test('正常：缺实际或缺 baseline 的工单被剔除并给出原因', () => {
  const { store } = buildSeedFixtures();
  const result = evaluate(store, MODE_SEPARATE);
  const excluded = Object.fromEntries(result.excluded.map((x) => [x.orderId, x.reason]));
  assert.match(excluded['WO-007'], /实际/);
  assert.match(excluded['WO-008'], /baseline/);
  assert.equal(result.overall.dataCoveragePct, 6 / 8);
});

test('正常：同一单两个更正保留完整时间线与差异区间', () => {
  const { store } = buildSeedFixtures();
  const tl = getTimeline(store, 'WO-004');
  assert.equal(tl.correctionCount, 2);
  assert.deepEqual(
    tl.corrections.map((c) => c.type),
    ['scope_change', 'replan'],
  );
  // 累计预测：80 -> 104 -> 96
  const forecasts = tl.events.filter((e) => e.kind === 'estimate').map((e) => e.cumulativeForecast);
  assert.deepEqual(forecasts, [80, 104, 96]);
  assert.equal(tl.envelope.min, 80);
  assert.equal(tl.envelope.max, 104);
  assert.equal(tl.envelope.width, 24);
  assert.equal(tl.envelope.first, 80);
  assert.equal(tl.envelope.latest, 96);
  assert.equal(tl.envelope.drift, 16);
});

test('正常：时间线合并估时与实际并按时间排序', () => {
  const { store } = buildSeedFixtures();
  const tl = getTimeline(store, 'WO-001');
  const ts = tl.events.map((e) => e.ts);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  const actualEvent = tl.events.find((e) => e.kind === 'actual');
  assert.equal(actualEvent.cumulativeActual, 18);
});

test('正常：误差分解恒等式闭合（两种模式）', () => {
  const { store } = buildSeedFixtures();
  for (const mode of [MODE_SEPARATE, MODE_REPLAN]) {
    const all = decomposeAll(store, mode);
    for (const d of all.perOrder) {
      assert.ok(Math.abs(d.identityCheck) < 1e-9, `${d.orderId} ${mode} 未闭合`);
    }
  }

  const rep = decomposeOrder(store, 'WO-004', MODE_REPLAN);
  assert.equal(rep.baselineHours, 80);
  assert.equal(rep.components.scopeChange, 24);
  assert.equal(rep.components.replan, -8);
  assert.equal(rep.actualTotalHours, 98);
  assert.equal(rep.finalForecastHours, 96);
  assert.equal(rep.components.residual, 2); // 98 - 96
});

test('正常：两种模式并排比较', () => {
  const { store } = buildSeedFixtures();
  const cmp = compareModes(store);
  assert.equal(cmp[MODE_SEPARATE].overall.orderCount, 6);
  assert.equal(cmp[MODE_REPLAN].overall.orderCount, 6);
  assert.notEqual(
    cmp[MODE_SEPARATE].overall.sumForecastHours,
    cmp[MODE_REPLAN].overall.sumForecastHours,
  );
});

test('正常：replan 允许负值下调，但累计预测不能为负', () => {
  const store = seedOne();
  const r = addEstimate(store, { orderId: 'A', type: 'replan', hours: -10, timestamp: T1 });
  assert.equal(r.cumulativeForecast, 30);
  assert.throws(
    () => addEstimate(store, { orderId: 'A', type: 'replan', hours: -35, timestamp: T2 }),
    (e) => e instanceof DomainError && e.code === 'INVALID_HOURS',
  );
});

test('正常：空存储评估返回空分组', () => {
  const result = evaluate(createStore(), MODE_SEPARATE);
  assert.deepEqual(result.groups, []);
  assert.equal(result.overall.orderCount, 0);
  assert.equal(result.overall.mape, null);
});

// ---------------- 异常路径 ----------------

test('异常：重复 baseline 被拒绝，原目标不可改写', () => {
  const store = seedOne();
  assert.throws(
    () => addEstimate(store, { orderId: 'A', type: 'baseline', hours: 50, timestamp: T1 }),
    (e) => e instanceof DomainError && e.code === 'BASELINE_EXISTS',
  );
  assert.equal(store.orders.get('A').estimates.length, 1);
});

test('异常：非法工时（非数字、零、负的非 replan）', () => {
  const store = seedOne();
  assert.throws(
    () => addEstimate(store, { orderId: 'B', type: 'baseline', hours: '8', timestamp: T0 }),
    (e) => e.code === 'INVALID_HOURS',
  );
  assert.throws(
    () => addEstimate(store, { orderId: 'B', type: 'baseline', hours: 0, timestamp: T0 }),
    (e) => e.code === 'INVALID_HOURS',
  );
  assert.throws(
    () => addEstimate(store, { orderId: 'B', type: 'scope_change', hours: -4, timestamp: T1 }),
    (e) => e.code === 'INVALID_HOURS',
  );
  assert.throws(
    () => addActual(store, { orderId: 'A', hours: -1, timestamp: T2 }),
    (e) => e.code === 'INVALID_HOURS',
  );
});

test('异常：非法类型 / 非法时间戳 / 空工单', () => {
  const store = seedOne();
  assert.throws(
    () => addEstimate(store, { orderId: 'A', type: 'guess', hours: 4, timestamp: T1 }),
    (e) => e.code === 'INVALID_TYPE',
  );
  assert.throws(
    () => addEstimate(store, { orderId: 'A', type: 'replan', hours: 4, timestamp: 'not-a-date' }),
    (e) => e.code === 'INVALID_TIMESTAMP',
  );
  assert.throws(
    () => addEstimate(store, { orderId: '  ', type: 'replan', hours: 4, timestamp: T1 }),
    (e) => e.code === 'INVALID_ORDER',
  );
  assert.throws(
    () => addEstimate(store, null),
    (e) => e.code === 'INVALID_PAYLOAD',
  );
});

test('异常：时间戳乱序被拒绝', () => {
  const store = seedOne(); // baseline 在 T0
  assert.throws(
    () => addEstimate(store, { orderId: 'A', type: 'scope_change', hours: 8, timestamp: '2026-10-31T09:00:00.000Z' }),
    (e) => e.code === 'TIMESTAMP_ORDER',
  );
  addActual(store, { orderId: 'A', hours: 10, timestamp: T2 });
  assert.throws(
    () => addActual(store, { orderId: 'A', hours: 5, timestamp: T1 }),
    (e) => e.code === 'TIMESTAMP_ORDER',
  );
});

test('异常：非法评估模式', () => {
  const store = seedOne();
  assert.throws(() => evaluate(store, 'wild'), (e) => e.code === 'INVALID_MODE');
  assert.throws(() => decomposeAll(store, 'wild'), (e) => e.code === 'INVALID_MODE');
});

test('异常：读取不存在的工单', () => {
  const store = createStore();
  assert.throws(() => getTimeline(store, 'NOPE'), (e) => e instanceof NotFoundError && e.code === 'ORDER_NOT_FOUND');
  assert.throws(() => decomposeOrder(store, 'NOPE'), (e) => e instanceof NotFoundError);
});

test('异常：合成数据自身全部完整工单可分解且闭合', () => {
  const { store } = buildSeedFixtures();
  const result = evaluate(store, MODE_SEPARATE);
  const completeIds = result.groups.flatMap((g) => g.orders.map((r) => r.orderId));
  for (const id of completeIds) {
    const d = decomposeOrder(store, id, MODE_REPLAN);
    assert.ok(Math.abs(d.identityCheck) < 1e-9);
  }
});
