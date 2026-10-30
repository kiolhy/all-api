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

/**
 * 假上游端口：刻意避开 8899（本机常被小米音频共享等软件占用）。
 * 可用环境变量覆盖，便于并行跑或换机。
 */
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 18899);
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

/**
 * 网关端口。固定 8778 是历史约定（.env、前端代理、文档都指向它），
 * 但允许用 GATEWAY_PORT 覆盖，避免端口被占时整个验收跑不起来。
 */
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 8778);
const GATEWAY_BASE = `http://127.0.0.1:${GATEWAY_PORT}`;

/**
 * 验收环境变量。
 *
 * - ALLOW_PRIVATE_EGRESS：假上游在 127.0.0.1，验收必须允许私网出网
 * - LLM_ALLOW_PRIVATE：AI 链路用本机桩模型，同理需要放开"LLM 走私有地址"
 * - MOCK_PORT / MOCK_BASE：下游脚本统一从这里取假上游地址
 *
 * 这几个开关默认关闭（生产默认安全）；验收脚本显式打开，
 * 所以它们不会被"顺手部署"到线上。
 */
const VERIFY_ENV = {
  ...process.env,
  ALLOW_PRIVATE_EGRESS: 'true',
  LLM_ALLOW_PRIVATE: 'true',
  MOCK_PORT: String(MOCK_PORT),
  MOCK_BASE,
  GATEWAY_BASE,
  // 网关自己也听这个端口（PORT 是服务端的启动参数）
  PORT: String(GATEWAY_PORT),
};

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function run(cmd, args, label) {
  return new Promise((res) => {
    process.stdout.write(`${c.bold('▶ ' + label)}\n`);
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env: VERIFY_ENV });
    p.on('error', (err) => {
      console.log(c.red(`  spawn 失败: ${err.message}`));
      res(1);
    });
    p.on('exit', (code) => res(code ?? 1));
  });
}

/**
 * 探测端口上是不是**我们自己**的服务。
 *
 * 只用 `r.ok` 判断是不够的：端口可能被别的程序占着（真实的坑：
 * 小米的 MiPCAudio 常驻监听 8899，返回裸 TCP 导致 fetch 抛协议错）。
 * 那种情况下 ensure() 会以为"已在运行，复用"，然后拿一个完全无关的服务
 * 去跑验收，最后报出一堆莫名其妙的失败。
 *
 * 所以要求响应能被解析成预期形状（默认是 JSON 且带 ok:true），
 * 不是就当成"没跑"，让 spawn 去撞端口冲突、把问题当场暴露出来。
 */
async function alive(url, expectJson = true) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    if (!expectJson) return true;
    const ct = r.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return false;
    const body = await r.json().catch(() => null);
    return Boolean(body && typeof body === 'object');
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
  const p = spawn(NODE, args, { cwd: ROOT, stdio: 'ignore', env: VERIFY_ENV });
  spawned.push(p);
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    if (await alive(healthUrl)) {
      console.log(c.dim(`· ${label} 就绪`));
      return;
    }
    if (p.exitCode !== null) {
      throw new Error(
        `${label} 启动即退出（code ${p.exitCode}）。` +
          `常见原因：端口被别的程序占用（本机 8899/8778 常被外部软件占用），先释放端口再重试。`,
      );
    }
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
  ['AI 链路', NODE, ['scripts/ai-e2e-test.mjs']],
];

try {
  await ensure(`假上游 :${MOCK_PORT}`, `${MOCK_BASE}/api/v1/orders`, ['fixtures/mock-upstream/src/index.ts']);
  await ensure(`网关 :${GATEWAY_PORT}`, `${GATEWAY_BASE}/api/health`, [
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
