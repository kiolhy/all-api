/**
 * 一条命令跑完全部验收：类型检查 → 单测 → 前端构建 → 三组端到端。
 *
 * 自己把假上游和网关拉起来（已经跑着就直接复用），跑完只关自己起的进程。
 * 任何一步非 0 立即停，退出码非 0。
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;
const spawned = [];
let failed = false;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function run(cmd, args, label) {
  return new Promise((res) => {
    process.stdout.write(`${c.bold('▶ ' + label)}\n`);
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    p.on('error', (err) => {
      console.log(c.red(`  spawn 失败: ${err.message}`));
      res(1);
    });
    p.on('exit', (code) => res(code ?? 1));
  });
}

async function alive(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensure(label, healthUrl, args) {
  if (await alive(healthUrl)) {
    console.log(c.dim(`· ${label} 已在运行，复用`));
    return;
  }
  console.log(c.dim(`· 启动 ${label} …`));
  const p = spawn(NODE, args, { cwd: ROOT, stdio: 'ignore' });
  spawned.push(p);
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    if (await alive(healthUrl)) {
      console.log(c.dim(`· ${label} 就绪`));
      return;
    }
    if (p.exitCode !== null) throw new Error(`${label} 启动即退出（code ${p.exitCode}）`);
  }
  throw new Error(`${label} 启动超时`);
}

function cleanup() {
  for (const p of spawned) {
    if (p.exitCode === null) {
      try {
        p.kill('SIGTERM');
      } catch {
        /* 已经没了 */
      }
    }
  }
  spawned.length = 0;
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

const steps = [
  ['类型检查', NODE, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']],
  [
    '单元测试',
    NODE,
    [
      '--test',
      '--test-timeout=60000',
      ...readdirSync(resolve(ROOT, 'packages/core/test'))
        .filter((f) => f.endsWith('.test.ts'))
        .map((f) => `packages/core/test/${f}`),
    ],
  ],
  ['前端构建', NODE, ['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/web/vite.config.ts']],
  ['冒烟测试', NODE, ['scripts/smoke.mjs']],
  ['批量导入', NODE, ['scripts/batch-import-test.mjs']],
  ['批量发布预览', NODE, ['scripts/bulk-preview-test.mjs']],
];

try {
  await ensure('假上游 :8899', 'http://127.0.0.1:8899/api/v1/orders', ['fixtures/mock-upstream/src/index.ts']);
  await ensure('网关 :8778', 'http://127.0.0.1:8778/api/health', [
    '--env-file-if-exists=.env',
    'apps/server/src/index.ts',
  ]);

  for (const [label, cmd, args] of steps) {
    const code = await run(cmd, args, label);
    if (code !== 0) {
      console.log(c.red(`\n✖ 卡在「${label}」，退出码 ${code}`));
      failed = true;
      break;
    }
  }
} catch (err) {
  console.log(c.red(`✖ ${err.message}`));
  failed = true;
} finally {
  cleanup();
}

console.log(failed ? c.red('\n✖ 验收未通过') : c.green('\n✔ 全部通过'));
process.exit(failed ? 1 : 0);
