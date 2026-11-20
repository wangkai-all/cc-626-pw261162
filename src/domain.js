// domain.js
// 纯领域逻辑 + 内存留版存储。不依赖任何第三方模块，结果全部由本文件实际计算得出。
//
// 留版原则：
//   - 计划工时（baseline / replan）、追加需求（scope_change）、实际工时（actual）是三条独立的追加流；
//   - 所有记录只追加、不可改写，评估永远以最初 baseline 为预测起点；
//   - 补录追加事项只会新增一条 scope_change 记录，不会改动原目标。

export const ESTIMATE_TYPES = Object.freeze(['baseline', 'replan', 'scope_change']);
export const MODE_SEPARATE = 'scope_separate'; // 范围变动单列：baseline 对核心实际，追加量单列
export const MODE_REPLAN = 'phase_replan';     // 阶段重估：累计预测对总实际
export const EVAL_MODES = Object.freeze([MODE_SEPARATE, MODE_REPLAN]);

const SCALE_BUCKETS = [
  { key: 'S', label: '小工单', max: 24 },
  { key: 'M', label: '中等工单', max: 72 },
  { key: 'L', label: '大工单', max: Infinity },
];

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export class NotFoundError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NotFoundError';
    this.code = code;
  }
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function requireHoursByType(value, field, type) {
  if (!isFiniteNumber(value)) {
    throw new DomainError('INVALID_HOURS', `${field} 必须是数字`);
  }
  // baseline 与 scope_change 只能为正；replan 允许负值（阶段下调），但不能为 0
  if (value === 0) {
    throw new DomainError('INVALID_HOURS', `${field} 不能为 0`);
  }
  if (type !== 'replan' && value < 0) {
    throw new DomainError('INVALID_HOURS', `${field} 为负工时只允许出现在 replan（阶段重估下调）`);
  }
}

function validateTimestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new DomainError('INVALID_TIMESTAMP', `${field} 不是合法的 ISO 时间戳`);
  }
  return Date.parse(value);
}

// ---------- 内存存储（追加式留版） ----------

export function createStore() {
  return { orders: new Map() };
}

function getOrCreateOrder(store, orderId) {
  let order = store.orders.get(orderId);
  if (!order) {
    order = { id: orderId, estimates: [], actuals: [] };
    store.orders.set(orderId, order);
  }
  return order;
}

function validateEstimatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new DomainError('INVALID_PAYLOAD', '请求体必须是对象');
  }
  const { orderId, type, hours, timestamp, note } = payload;
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    throw new DomainError('INVALID_ORDER', 'orderId 必须是非空字符串');
  }
  if (!ESTIMATE_TYPES.includes(type)) {
    throw new DomainError('INVALID_TYPE', `type 必须是 ${ESTIMATE_TYPES.join('/')} 之一`);
  }
  requireHoursByType(hours, 'hours', type);
  const ts = validateTimestamp(timestamp, 'timestamp');
  if (note !== undefined && typeof note !== 'string') {
    throw new DomainError('INVALID_NOTE', 'note 必须是字符串');
  }
  return { orderId: orderId.trim(), type, hours, timestamp, ts, note: note ?? '' };
}

/**
 * 追加一条估时记录（计划工时 / 阶段重估 / 追加需求共用，类型区分、各自独立留版）。
 * 返回被追加的记录（含不可变 id 与累计值）。
 */
export function addEstimate(store, payload) {
  const rec = validateEstimatePayload(payload);
  const order = getOrCreateOrder(store, rec.orderId);

  if (rec.type === 'baseline' && order.estimates.some((e) => e.type === 'baseline')) {
    throw new DomainError('BASELINE_EXISTS', `工单 ${rec.orderId} 已有 baseline，原目标不可改写`);
  }

  const lastTs = Math.max(
    0,
    ...order.estimates.map((e) => e.ts),
    ...order.actuals.map((a) => a.ts),
  );
  if (order.estimates.length > 0 && rec.ts < lastTs) {
    throw new DomainError('TIMESTAMP_ORDER', '新记录的时间戳不能早于该工单已有记录');
  }

  const id = `EST-${order.estimates.length + 1}`;
  const priorCumulative = order.estimates.length
    ? order.estimates[order.estimates.length - 1].cumulativeForecast
    : 0;
  if (priorCumulative + rec.hours < 0) {
    throw new DomainError('INVALID_HOURS', '重估下调后累计预测工时不能为负');
  }
  const saved = {
    id,
    orderId: rec.orderId,
    type: rec.type,
    hours: rec.hours,
    timestamp: rec.timestamp,
    ts: rec.ts,
    note: rec.note,
    cumulativeForecast: priorCumulative + rec.hours,
  };
  order.estimates.push(saved);
  return structuredClone(saved);
}

/**
 * 追加一条实际工时记录（与估时流独立留版）。
 */
export function addActual(store, payload) {
  if (!payload || typeof payload !== 'object') {
    throw new DomainError('INVALID_PAYLOAD', '请求体必须是对象');
  }
  const { orderId, hours, timestamp, note } = payload;
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    throw new DomainError('INVALID_ORDER', 'orderId 必须是非空字符串');
  }
  if (!isFiniteNumber(hours) || hours <= 0) {
    throw new DomainError('INVALID_HOURS', '实际工时必须是大于 0 的数字');
  }
  const ts = validateTimestamp(timestamp, 'timestamp');
  if (note !== undefined && typeof note !== 'string') {
    throw new DomainError('INVALID_NOTE', 'note 必须是字符串');
  }
  const order = getOrCreateOrder(store, orderId.trim());
  const lastTs = Math.max(
    0,
    ...order.estimates.map((e) => e.ts),
    ...order.actuals.map((a) => a.ts),
  );
  if ((order.estimates.length > 0 || order.actuals.length > 0) && ts < lastTs) {
    throw new DomainError('TIMESTAMP_ORDER', '新记录的时间戳不能早于该工单已有记录');
  }
  const saved = {
    id: `ACT-${order.actuals.length + 1}`,
    orderId: order.id,
    hours,
    timestamp,
    ts,
    note: note ?? '',
  };
  order.actuals.push(saved);
  return structuredClone(saved);
}

export function getOrder(store, orderId) {
  const order = store.orders.get(orderId);
  if (!order) {
    throw new NotFoundError('ORDER_NOT_FOUND', `工单 ${orderId} 不存在`);
  }
  return structuredClone(order);
}

export function listOrders(store) {
  return Array.from(store.orders.values()).map((o) => structuredClone(o));
}

// ---------- 汇总辅助 ----------

function sums(order) {
  const baseline = order.estimates
    .filter((e) => e.type === 'baseline')
    .reduce((s, e) => s + e.hours, 0);
  const scopeHours = order.estimates
    .filter((e) => e.type === 'scope_change')
    .reduce((s, e) => s + e.hours, 0);
  const replanHours = order.estimates
    .filter((e) => e.type === 'replan')
    .reduce((s, e) => s + e.hours, 0);
  const actualTotal = order.actuals.reduce((s, a) => s + a.hours, 0);
  // 核心实际：未标注 scope 的实际工时（追加需求对应的实际以 note 标记 scope）
  const coreActual = order.actuals
    .filter((a) => a.note !== 'scope')
    .reduce((s, a) => s + a.hours, 0);
  const scopeActual = actualTotal - coreActual;
  const finalForecast = order.estimates.length
    ? order.estimates[order.estimates.length - 1].cumulativeForecast
    : 0;
  return { baseline, scopeHours, replanHours, actualTotal, coreActual, scopeActual, finalForecast };
}

export function scaleOf(baselineHours) {
  const bucket = SCALE_BUCKETS.find((b) => baselineHours <= b.max);
  return bucket.key;
}

export function scaleLabel(key) {
  return SCALE_BUCKETS.find((b) => b.key === key)?.label ?? key;
}

function isComplete(order) {
  return (
    order.estimates.some((e) => e.type === 'baseline') &&
    order.actuals.length > 0
  );
}

// ---------- 时间线与差异区间 ----------

/**
 * 把估时流与实际流合并成一条不可变时间线，并计算预测差异区间。
 * 同一单有两个（或多个）更正时，每个版本在此逐点保留。
 */
export function getTimeline(store, orderId) {
  const order = store.orders.get(orderId);
  if (!order) {
    throw new NotFoundError('ORDER_NOT_FOUND', `工单 ${orderId} 不存在`);
  }
  const estimateEvents = order.estimates.map((e) => ({
    kind: 'estimate',
    recordId: e.id,
    type: e.type,
    timestamp: e.timestamp,
    ts: e.ts,
    hours: e.hours,
    cumulativeForecast: e.cumulativeForecast,
    note: e.note,
  }));
  const actualEvents = (() => {
    let cum = 0;
    return order.actuals.map((a) => {
      cum += a.hours;
      return {
        kind: 'actual',
        recordId: a.id,
        timestamp: a.timestamp,
        ts: a.ts,
        hours: a.hours,
        cumulativeActual: cum,
        note: a.note,
      };
    });
  })();

  const events = [...estimateEvents, ...actualEvents].sort((a, b) => a.ts - b.ts);

  const forecastPoints = estimateEvents.map((e) => e.cumulativeForecast);
  const envelope = forecastPoints.length
    ? {
        min: Math.min(...forecastPoints),
        max: Math.max(...forecastPoints),
        width: Math.max(...forecastPoints) - Math.min(...forecastPoints),
        first: forecastPoints[0],
        latest: forecastPoints[forecastPoints.length - 1],
        drift: forecastPoints[forecastPoints.length - 1] - forecastPoints[0],
      }
    : null;

  const corrections = order.estimates
    .filter((e) => e.type !== 'baseline')
    .map((e) => ({
      recordId: e.id,
      type: e.type,
      timestamp: e.timestamp,
      deltaHours: e.hours,
      cumulativeForecast: e.cumulativeForecast,
      note: e.note,
    }));

  return {
    orderId,
    events,
    corrections,
    correctionCount: corrections.length,
    envelope,
  };
}

// ---------- 单工单评估（两种模式） ----------

function evalSeparate(order) {
  const s = sums(order);
  const forecastError = s.coreActual - s.baseline;
  const metrics = {
    mode: MODE_SEPARATE,
    baselineHours: s.baseline,
    forecastHours: s.baseline,
    scopeAddedHours: s.scopeHours,
    replanHours: s.replanHours,
    actualHours: s.coreActual,
    scopeActualHours: s.scopeActual,
    actualTotalHours: s.actualTotal,
    forecastError,
    absForecastError: Math.abs(forecastError),
    errorPct: s.baseline === 0 ? null : forecastError / s.baseline,
    absErrorPct: s.baseline === 0 ? null : Math.abs(forecastError) / s.baseline,
    coveragePct: s.baseline === 0 ? null : s.coreActual / s.baseline,
  };
  return metrics;
}

function evalReplan(order) {
  const s = sums(order);
  const forecastError = s.actualTotal - s.finalForecast;
  const metrics = {
    mode: MODE_REPLAN,
    baselineHours: s.baseline,
    forecastHours: s.finalForecast,
    scopeAddedHours: s.scopeHours,
    replanHours: s.replanHours,
    actualHours: s.actualTotal,
    actualTotalHours: s.actualTotal,
    forecastError,
    absForecastError: Math.abs(forecastError),
    errorPct: s.finalForecast === 0 ? null : forecastError / s.finalForecast,
    absErrorPct: s.finalForecast === 0 ? null : Math.abs(forecastError) / s.finalForecast,
    coveragePct: s.finalForecast === 0 ? null : s.actualTotal / s.finalForecast,
  };
  return metrics;
}

function evaluateOrder(order, mode) {
  const s = sums(order);
  const base = {
    orderId: order.id,
    scale: scaleOf(s.baseline),
    scaleLabel: scaleLabel(scaleOf(s.baseline)),
    baselineHours: s.baseline,
    scopeAddedHours: s.scopeHours,
    replanHours: s.replanHours,
    actualTotalHours: s.actualTotal,
  };
  const modeMetrics = mode === MODE_REPLAN ? evalReplan(order) : evalSeparate(order);
  return { ...base, ...modeMetrics };
}

// ---------- 分组与总体统计（按工单规模比较误差和覆盖） ----------

function aggregate(rows, allOrders, mode) {
  const count = rows.length;
  const sumForecast = rows.reduce((x, r) => x + r.forecastHours, 0);
  const sumActual = rows.reduce((x, r) => x + r.actualHours, 0);
  const sumError = rows.reduce((x, r) => x + r.forecastError, 0);
  const sumAbsError = rows.reduce((x, r) => x + r.absForecastError, 0);
  const mape = count === 0 ? null : rows.reduce((x, r) => x + r.absErrorPct, 0) / count;
  const meanErrorPct = count === 0 ? null : rows.reduce((x, r) => x + r.errorPct, 0) / count;
  const weightedMape = sumForecast === 0 ? null : sumAbsError / sumForecast;
  const coveragePct = sumForecast === 0 ? null : sumActual / sumForecast;

  // 覆盖率：全部工单中有多少具备 baseline 与实际（可纳入评估）
  const withBaseline = allOrders.filter((o) => o.estimates.some((e) => e.type === 'baseline')).length;
  const evaluated = count;
  const totalOrders = allOrders.length;

  return {
    mode,
    orderCount: count,
    totalOrders,
    sumForecastHours: sumForecast,
    sumActualHours: sumActual,
    sumErrorHours: sumError,
    sumAbsErrorHours: sumAbsError,
    meanErrorPct,
    mape,
    weightedMape,
    coveragePct,
    evaluatedOrders: evaluated,
    ordersWithBaseline: withBaseline,
    dataCoveragePct: totalOrders === 0 ? null : evaluated / totalOrders,
  };
}

/**
 * 运行一次评估。mode 决定按阶段重估还是把范围变动单列。
 * 始终保持预测起点：任何模式下 baseline 都原样参与，不被追加事项改写。
 */
export function evaluate(store, mode = MODE_SEPARATE) {
  if (!EVAL_MODES.includes(mode)) {
    throw new DomainError('INVALID_MODE', `mode 必须是 ${EVAL_MODES.join('/')} 之一`);
  }
  const all = listOrders(store);
  const excluded = all
    .filter((o) => !isComplete(o))
    .map((o) => ({
      orderId: o.id,
      reason: !o.estimates.some((e) => e.type === 'baseline')
        ? '缺少 baseline 计划工时'
        : '缺少实际工时',
    }));

  const rows = all.filter(isComplete).map((o) => evaluateOrder(o, mode));
  const groups = SCALE_BUCKETS.map((b) => {
    const groupRows = rows.filter((r) => r.scale === b.key);
    return {
      scale: b.key,
      scaleLabel: b.label,
      ...aggregate(groupRows, all, mode),
      orders: groupRows,
    };
  }).filter((g) => g.orderCount > 0);

  return {
    mode,
    generatedAt: new Date().toISOString(),
    groups,
    overall: aggregate(rows, all, mode),
    excluded,
  };
}

// ---------- 误差分解 ----------

/**
 * 单工单误差分解：计划误差 + 范围变动 + 重估调整 + 残余误差，恒等式闭合。
 */
export function decomposeOrder(store, orderId, mode = MODE_SEPARATE) {
  if (!EVAL_MODES.includes(mode)) {
    throw new DomainError('INVALID_MODE', `mode 必须是 ${EVAL_MODES.join('/')} 之一`);
  }
  const order = store.orders.get(orderId);
  if (!order) {
    throw new NotFoundError('ORDER_NOT_FOUND', `工单 ${orderId} 不存在`);
  }
  const s = sums(order);
  const planError = s.coreActual - s.baseline;

  let residual;
  let residualDenominator;
  if (mode === MODE_REPLAN) {
    residual = s.actualTotal - s.finalForecast;
    residualDenominator = s.finalForecast;
  } else {
    residual = planError; // 单列模式下残余即计划误差，范围变动不混入
    residualDenominator = s.baseline;
  }

  // 恒等式闭合检查（期望为 0，浮点容差内）：
  //   阶段重估：baseline + 范围变动 + 重估调整 + 残余误差 == 实际总工时
  //   范围单列：baseline + 残余(=计划误差) == 核心实际，范围量不混入
  const identityCheck =
    mode === MODE_REPLAN
      ? s.baseline + s.scopeHours + s.replanHours + residual - s.actualTotal
      : s.baseline + residual - s.coreActual;

  return {
    orderId,
    mode,
    baselineHours: s.baseline,
    coreActualHours: s.coreActual,
    scopeAddedHours: s.scopeHours,
    scopeActualHours: s.scopeActual,
    replanHours: s.replanHours,
    finalForecastHours: s.finalForecast,
    actualTotalHours: s.actualTotal,
    components: {
      planError,              // 核心实际 - 原计划
      scopeChange: s.scopeHours,
      replan: s.replanHours,
      residual,               // 模式相关的最终残余误差
    },
    residualPct: residualDenominator === 0 ? null : residual / residualDenominator,
    identityCheck,            // 恒等式闭合检查，期望为 0（浮点容差内）
  };
}

/**
 * 分组/总体的误差分解汇总（各分量求和）。
 */
export function decomposeAll(store, mode = MODE_SEPARATE) {
  if (!EVAL_MODES.includes(mode)) {
    throw new DomainError('INVALID_MODE', `mode 必须是 ${EVAL_MODES.join('/')} 之一`);
  }
  const all = listOrders(store);
  const complete = all.filter(isComplete);
  const perOrder = complete.map((o) => decomposeOrder(store, o.id, mode));
  const sum = (key) => perOrder.reduce((x, d) => x + d.components[key], 0);
  return {
    mode,
    orderCount: perOrder.length,
    components: {
      planError: sum('planError'),
      scopeChange: sum('scopeChange'),
      replan: sum('replan'),
      residual: sum('residual'),
    },
    perOrder,
  };
}

/**
 * 两种模式并排比较：同一批工单在「范围单列」与「阶段重估」下的差异。
 */
export function compareModes(store) {
  return {
    [MODE_SEPARATE]: evaluate(store, MODE_SEPARATE),
    [MODE_REPLAN]: evaluate(store, MODE_REPLAN),
  };
}

// ---------- 合成数据 ----------

function est(orderId, type, hours, timestamp, note = '') {
  return { orderId, type, hours, timestamp, note };
}
function act(orderId, hours, timestamp, note = '') {
  return { orderId, hours, timestamp, note };
}

/**
 * 构造可复现全部题面情形的合成数据：
 *   WO-001 小工单、正常轻微超支；
 *   WO-002 中等工单、节约；
 *   WO-003 中等工单、一次追加需求（演示补录范围变化）；
 *   WO-004 大工单、同一单两个更正（一次 scope_change + 一次 replan），用于时间线与差异区间；
 *   WO-005 大工单、重估后仍超支；
 *   WO-006 小工单、实际少于计划；
 *   WO-007 异常：只有计划没有实际（覆盖率剔除演示）；
 *   WO-008 异常：未设 baseline 直接有实际（评估剔除演示）。
 */
export function buildSeedFixtures() {
  const estimates = [
    est('WO-001', 'baseline', 16, '2026-11-01T09:00:00.000Z', '接口联调'),
    act('WO-001', 18, '2026-11-03T18:00:00.000Z'),

    est('WO-002', 'baseline', 40, '2026-11-01T09:00:00.000Z', '报表模块'),
    act('WO-002', 34, '2026-11-05T18:00:00.000Z'),

    est('WO-003', 'baseline', 48, '2026-11-02T09:00:00.000Z', '订单改造'),
    act('WO-003', 46, '2026-11-06T12:00:00.000Z'),
    est('WO-003', 'scope_change', 8, '2026-11-06T15:00:00.000Z', '客户临时加的导出格式'),
    act('WO-003', 9, '2026-11-07T17:00:00.000Z', 'scope'),

    est('WO-004', 'baseline', 80, '2026-11-01T09:00:00.000Z', '计费系统一期'),
    est('WO-004', 'scope_change', 24, '2026-11-04T10:00:00.000Z', '追加税务对接'),
    est('WO-004', 'replan', -8, '2026-11-08T10:00:00.000Z', '复用组件下调 8h'),
    act('WO-004', 78, '2026-11-09T18:00:00.000Z'),
    act('WO-004', 20, '2026-11-10T18:00:00.000Z', 'scope'),

    est('WO-005', 'baseline', 120, '2026-11-01T09:00:00.000Z', '数据迁移'),
    est('WO-005', 'replan', 16, '2026-11-06T09:00:00.000Z', '脏数据清洗加量'),
    act('WO-005', 148, '2026-11-12T18:00:00.000Z'),

    est('WO-006', 'baseline', 20, '2026-11-03T09:00:00.000Z', '脚本整理'),
    act('WO-006', 15, '2026-11-04T18:00:00.000Z'),

    est('WO-007', 'baseline', 32, '2026-11-05T09:00:00.000Z', '未完工工单'),

    act('WO-008', 12, '2026-11-06T18:00:00.000Z', '漏建计划的工单'),
  ];

  const seedStore = createStore();
  const addedEstimates = [];
  const addedActuals = [];
  for (const item of estimates) {
    if (item.type) {
      addedEstimates.push(addEstimate(seedStore, item));
    } else {
      addedActuals.push(addActual(seedStore, item));
    }
  }
  return { store: seedStore, addedEstimates, addedActuals };
}
