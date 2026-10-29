#!/usr/bin/env node
/**
 * MCP 冒烟测试：以 stdio 方式拉起 apps/mcp，走完 initialize → tools/list → tools/call。
 * 用法：node scripts/mcp-smoke.mjs [toolName] [argsJson]
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const key = process.env.HUB_API_KEY ?? (existsSync('.smoke-key') ? readFileSync('.smoke-key', 'utf8').trim() : '');
const toolName = process.argv[2];
const toolArgs = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const child = spawn(process.execPath, ['apps/mcp/src/index.ts'], {
  env: { ...process.env, GATEWAY_URL: 'http://127.0.0.1:8778', HUB_API_KEY: key },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('[raw]', line);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else {
      console.log('[notify]', JSON.stringify(msg).slice(0, 300));
    }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[stderr] ${c}`));

function rpc(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

try {
  const init = await rpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '1.0.0' },
  });
  console.log('initialize →', init.result?.serverInfo);

  notify('notifications/initialized', {});

  const list = await rpc(2, 'tools/list', {});
  const tools = list.result?.tools ?? [];
  console.log('tools/list →', tools.length, '个：', tools.map((t) => t.name).join(', '));

  if (toolName) {
    const call = await rpc(3, 'tools/call', { name: toolName, arguments: toolArgs });
    const text = call.result?.content?.[0]?.text ?? JSON.stringify(call.result);
    console.log('tools/call →', text.slice(0, 600));
    console.log('isError →', call.result?.isError ?? false);
  }

  const res = await rpc(4, 'resources/list', {});
  console.log('resources/list →', (res.result?.resources ?? []).length, '个');
} catch (err) {
  console.error('MCP 冒烟失败：', err.message);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 200));
  child.kill();
  process.exit(process.exitCode ?? 0);
}
