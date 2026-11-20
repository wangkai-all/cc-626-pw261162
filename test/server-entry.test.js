// server-entry.test.js — 验证入口读取 PORT 并绑定 127.0.0.1（子进程）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(__dirname, '..', 'server.js');

function waitForLine(child, marker, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待服务启动超时')), timeoutMs);
    const onData = (chunk) => {
      const text = chunk.toString();
      if (text.includes(marker)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(text);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => process.stderr.write(c));
  });
}

function probePort(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

test('入口：PORT=0 时启动、绑定 127.0.0.1 并响应健康检查', async () => {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PORT: '0' },
    cwd: path.join(__dirname, '..'),
  });
  try {
    const output = await waitForLine(child, '已启动');
    const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(match, '启动日志应包含 127.0.0.1:端口');
    const port = Number(match[1]);
    assert.ok(port > 0);

    assert.equal(await probePort(port, '127.0.0.1'), true);

    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.orderCount, 8); // 启动即载入合成数据
  } finally {
    child.kill('SIGTERM');
  }
});

test('入口：默认端口 3000（未设 PORT）', async () => {
  const env = { ...process.env };
  delete env.PORT;
  const child = spawn(process.execPath, [ENTRY], { env, cwd: path.join(__dirname, '..') });
  try {
    const output = await waitForLine(child, '已启动');
    assert.match(output, /http:\/\/127\.0\.0\.1:3000/);
  } finally {
    child.kill('SIGTERM');
  }
});

test('异常：PORT 非法时进程报错退出', async () => {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PORT: 'not-a-port' },
    cwd: path.join(__dirname, '..'),
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.notEqual(code, 0);
});
