// server.js — 启动入口
// 用法：node server.js （端口取自环境变量 PORT，默认 3000；仅绑定 127.0.0.1）

import { createApp } from './src/http-server.js';
import { createStore, buildSeedFixtures } from './src/domain.js';

const PORT = resolvePort(process.env.PORT);
const HOST = '127.0.0.1';

function resolvePort(raw) {
  if (raw === undefined || raw === '') return 3000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`PORT 必须是 0-65535 的整数，收到: ${raw}`);
  }
  return n;
}

const store = createStore();
const seeded = buildSeedFixtures();
store.orders = seeded.store.orders;

const server = createApp(store);

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  console.log(`pointwise-delivery 已启动: http://${HOST}:${actualPort}`);
  console.log(`已载入合成工单 ${store.orders.size} 个（含缺实际/缺 baseline 的异常工单）`);
});

export { server };
