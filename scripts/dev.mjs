#!/usr/bin/env node
/** 同时启动网关服务与控制台 dev server */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const node = process.execPath;
const env = { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'development' };

const children = [];

function run(name, cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit', env, shell: false });
  child.on('exit', (code) => {
    console.log(`[${name}] 退出，code=${code}`);
    if (code !== 0) shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('server', node, ['--env-file-if-exists=.env', 'apps/server/src/index.ts']);

if (existsSync('apps/web/index.html')) {
  run('web', node, ['./node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts']);
} else {
  console.log('[web] 未找到 apps/web/index.html，跳过前端 dev server');
}
