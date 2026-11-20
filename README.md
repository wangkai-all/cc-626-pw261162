# 工单估时留版与误差评估（本地演示）

只用 Node.js 内置模块实现，无第三方依赖。计划工时、追加需求、实际工时三条记录**独立追加留版**，
评估时保持最初预测起点，追加事项不会改写原目标。

## 启动

```bash
node server.js          # 默认 http://127.0.0.1:3000
PORT=3100 node server.js # 端口取自环境变量 PORT，始终绑定 127.0.0.1
```

启动即载入 `src/domain.js` 中 `buildSeedFixtures()` 的合成数据（8 个工单，含两个异常工单）。

## 测试

```bash
npm test                # 等价于 node --test "test/**/*.test.js"
```

40 个用例，覆盖正常计算与全部异常分支（重复 baseline、非法工时/类型/时间戳、乱序、404、405、PORT 非法等）。

## 页面三个操作

- **运行原估时评估**：按规模（S ≤24h / M 25–72h / L >72h）分组比较误差与覆盖，支持两种口径切换。
- **补录一次范围变化**：向指定工单只追加一条 `scope_change`（或 `replan`）记录，可选同时补录实际工时；原 baseline 不变。
- **查看误差分解**：计划误差 / 范围变动 / 重估调整 / 残余误差四分量，附恒等式闭合检查（identityCheck 应为 0）。

业务结果区 `#result` 每次渲染都把后端原始 JSON 写入 **`data-evidence-result`** 属性，
便于核对任意操作前后的内容差异。页面只渲染，结果全部由后端实际计算。

## 两种评估口径

| 口径 | 预测值 | 实际值 | 范围变动处理 |
| --- | --- | --- | --- |
| `scope_separate` 范围变动单列（默认） | 原 baseline | 核心实际（note=scope 的实际不计入） | 单列为独立分量，不混入计划误差 |
| `phase_replan` 阶段重估 | 最新累计预测（baseline+scope+replan） | 实际总工时 | 纳入预测演进，残余 = 总实际 − 最新预测 |

## 同一单两个更正的时间线与差异区间

合成数据 `WO-004` 演示该情形：baseline 80h → 追加税务对接 +24h（累计 104h）→ 复用组件下调 −8h（累计 96h）。
`GET /api/orders/WO-004/timeline` 返回逐点时间线、更正列表与差异区间
（min 80 / max 104 / 宽度 24 / 首末漂移 +16），所有历史版本保留、不被覆盖。

## 合成数据说明

| 工单 | 规模 | 情形 |
| --- | --- | --- |
| WO-001 | S | 正常轻微超支（16→18） |
| WO-002 | M | 节约（40→34） |
| WO-003 | M | 一次追加需求，适合页面补录演示 |
| WO-004 | L | **两个更正**（scope_change + 负 replan），时间线/区间演示 |
| WO-005 | L | 重估后仍超支（120+16 vs 148） |
| WO-006 | S | 实际少于计划（20→15） |
| WO-007 | M | 异常：只有计划没有实际，评估剔除 |
| WO-008 | S | 异常：无 baseline 直接有实际，评估剔除 |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/evaluate?mode=scope_separate|phase_replan` | 分组+总体误差与覆盖 |
| GET | `/api/decompose?mode=...` | 误差分解（含闭合检查） |
| GET | `/api/orders/:id/timeline` | 留版时间线与预测差异区间 |
| GET | `/api/orders/:id/decompose?mode=...` | 单工单分解 |
| GET | `/api/compare-modes` | 两种口径并排对比 |
| POST | `/api/estimates` | 追加估时记录（body 缺省 type=scope_change） |
| POST | `/api/actuals` | 追加实际工时 |
| POST | `/api/reset` | 恢复初始合成数据 |

领域错误返回 `400 {error, message}`，不存在资源返回 `404`，方法不允许返回 `405`。
