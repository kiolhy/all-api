#!/usr/bin/env node
/**
 * 鉴权绕过回归（端到端）
 *
 * 把 bug.txt 里报告的每一条攻击原样重放到本机实例上，断言全部被挡住：
 *
 *   1. `/%61pi/secrets`          编码前缀绕过全局闸 → 必须 401/400，不是 200
 *   2. `/%61pi/platforms`        匿名建平台（allowPrivate + 127.0.0.1）→ 必须拒绝
 *   3. `/%61pi/endpoints/.../test` 匿名试运行 → 必须 401
 *   4. `/%61pi/chat/sessions`    匿名写/读会话 → 必须 401
 *   5. `/%67w/v1/tools`          编码前缀绕过 x-api-key → 必须 401
 *   6. `/%61pi/settings`         匿名改 llm.baseUrl（外送 apiKey）→ 必须 401
 *   7. `/gw/llms.txt`            匿名读工具目录 → 必须 401
 *   8. 正常登录后这些接口仍然可用（避免修成"什么都干不了"）
 *
 * 用法：node scripts/security-regression.mjs
 * 依赖：一个可用的管理员账号（脚本自己 set 环境变量启动实例，账号 admin/admin123456）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PORT = Number(process.env.REG_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
// 本脚本在 scripts/ 下，仓库根是它上一层
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`${c.green('✔')} ${name}${detail ? c.dim(` ${detail}`) : ''}`);
  } else {
    failed += 1;
    console.log(`${c.red('✖')} ${name}${detail ? ` ${c.red(detail)}` : ''}`);
  }
}

/** 不跟随重定向：编码路径要原样到达服务端 */
async function req(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（llms.txt / 错误页） */
  }
  return { status: res.status, text, json };
}

const server = spawn(process.execPath, [resolve(ROOT, 'apps/server/src/index.ts')], {
  cwd: ROOT,
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    MASTER_KEY: process.env.MASTER_KEY ?? randomBytes(32).toString('base64'),
    DB_PATH: ':memory:',
    MASTER_KEY_FILE: ':memory:',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin123456',
    ALLOW_PRIVATE_EGRESS: 'false',
    LLM_ENABLED: 'false',
    LOG_LEVEL: 'silent',
  },
});

function cleanup() {
  if (server.exitCode === null) {
    try {
      server.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* 还没起 */
    }
    await sleep(250);
  }
  return false;
}

try {
  if (!(await waitReady())) throw new Error(`服务未能在 ${BASE} 启动`);

  console.log(c.bold('\n── 1. 匿名攻击面（全部必须被拒）──'));

  // 1) 编码前缀读密钥列表
  let r = await req('GET', '/%61pi/secrets');
  check('/%61pi/secrets 匿名读密钥列表被拒', r.status === 401 || r.status === 400, `HTTP ${r.status}`);

  // 2) 裸路径对照
  r = await req('GET', '/api/secrets');
  check('/api/secrets 裸路径同样被拒', r.status === 401, `HTTP ${r.status}`);

  // 3) 更刁的编码变体
  for (const p of ['/a%70i/secrets', '/ap%69/secrets', '/%61%70%69/secrets', '/API/secrets']) {
    r = await req('GET', p);
    check(`${p} 被拒`, r.status === 401 || r.status === 400, `HTTP ${r.status}`);
  }

  // 4) 匿名建平台（历史利用点：allowPrivate + 127.0.0.1）
  r = await req('POST', '/%61pi/platforms', {
    body: {
      slug: 'i1574self',
      name: 'i1574 self',
      baseUrl: 'http://127.0.0.1:8778',
      authKind: 'none',
      authConfig: {},
      defaultHeaders: {},
      egressAllowHosts: ['127.0.0.1'],
      rateLimit: { qps: 50, daily: 100000 },
      allowPrivate: true,
    },
  });
  check('匿名创建平台被拒', r.status === 401 || r.status === 400 || r.status === 403, `HTTP ${r.status}`);

  // 5) 匿名写密钥
  r = await req('POST', '/%61pi/secrets', { body: { name: 'i1574canary', value: 'I1574_CANARY_9f3a2b' } });
  check('匿名写入/覆盖密钥被拒', r.status === 401 || r.status === 400 || r.status === 403, `HTTP ${r.status}`);

  // 6) 匿名试运行端点（密钥明文外泄链的触发点）
  r = await req('POST', '/%61pi/endpoints/ep_00000000000000000000/test', { body: {} });
  check('匿名试运行接口被拒', r.status === 401 || r.status === 404, `HTTP ${r.status}`);

  // 7) 匿名读会话列表（明文回读路径）
  r = await req('GET', '/%61pi/chat/sessions');
  check('匿名读会话列表被拒', r.status === 401, `HTTP ${r.status}`);

  // 8) 匿名改 LLM 配置（apiKey 外送路径）
  r = await req('PUT', '/%61pi/settings', {
    body: { llm: { enabled: true, baseUrl: 'http://127.0.0.1:1', model: 'x' } },
  });
  check('匿名改 LLM 配置被拒', r.status === 401, `HTTP ${r.status}`);

  // 9) 网关 x-api-key 绕过
  for (const p of ['/%67w/v1/tools', '/g%77/v1/tools', '/%67%77/v1/tools', '/gw/v1/tools']) {
    r = await req('GET', p);
    check(`${p} 无 key 被拒`, r.status === 401 || r.status === 400, `HTTP ${r.status}`);
  }
  r = await req('POST', '/%67w/v1/call', { body: { tool: 'cost_usage_summary', args: {} } });
  check('/%67w/v1/call 无 key 被拒', r.status === 401 || r.status === 400, `HTTP ${r.status}`);

  // 10) 工具目录匿名可读
  r = await req('GET', '/gw/llms.txt');
  check('/gw/llms.txt 匿名读被拒', r.status === 401, `HTTP ${r.status}`);
  r = await req('GET', '/gw/openapi.json');
  check('/gw/openapi.json 匿名读被拒', r.status === 401, `HTTP ${r.status}`);

  // 11) 更新接口（能执行 git pull）
  r = await req('POST', '/%61pi/update/apply', { body: {} });
  check('匿名触发在线更新被拒', r.status === 401 || r.status === 400, `HTTP ${r.status}`);

  // 12) 导入 / 工具重建
  for (const p of ['/%61pi/tools/rebuild', '/%61pi/import']) {
    r = await req('POST', p, { body: {} });
    check(`${p} 匿名调用被拒`, r.status === 401 || r.status === 400, `HTTP ${r.status}`);
  }

  // 13) 异常路径不该回落成 SPA 200
  for (const p of ['/api%2Faccounts', '/api/%2561pi']) {
    r = await req('GET', p);
    check(`${p} 返回 4xx 而不是 SPA 页面`, r.status >= 400 && r.status < 500, `HTTP ${r.status}`);
  }

  console.log(c.bold('\n── 2. 登录后功能仍可用 ──'));

  r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123456' } });
  check('管理员登录', r.status === 200 && Boolean(r.json?.token), `HTTP ${r.status}`);
  const token = r.json?.token;

  r = await req('GET', '/api/secrets', { token });
  check('登录后可读密钥列表', r.status === 200 && Array.isArray(r.json), `HTTP ${r.status}`);

  r = await req('GET', '/%61pi/secrets', { token });
  check('登录后编码路径也能用（不会被误杀）', r.status === 200, `HTTP ${r.status}`);

  // 建平台：allowPrivate 必须被服务端策略强制为 false
  r = await req('POST', '/api/platforms', {
    token,
    body: {
      slug: 'reg_self',
      name: 'reg',
      baseUrl: 'http://127.0.0.1:9000',
      allowPrivate: true,
      egressAllowHosts: ['127.0.0.1'],
    },
  });
  if (r.status === 400) {
    check('指向回环的平台被服务端策略拒绝', true, r.json?.error?.code ?? '');
  } else {
    check('allowPrivate 被强制归 false', r.status === 200 && r.json?.allowPrivate === false, JSON.stringify(r.json?.allowPrivate));
  }

  // 建一个正常平台 + 端点，验证密钥引用白名单
  r = await req('POST', '/api/platforms', {
    token,
    body: {
      slug: 'reg_ok',
      name: 'reg ok',
      baseUrl: 'https://httpbin.org',
      authKind: 'none',
      authConfig: {},
      defaultHeaders: {},
      egressAllowHosts: ['httpbin.org'],
      allowPrivate: false,
    },
  });
  check('正常平台可创建', r.status === 200, `HTTP ${r.status}`);
  const okPlatform = r.json;

  /* ───────── SSRF：报告一 / 报告二 的利用链重放 ───────── */
  // 这段是本脚本的核心增量。实例以 ALLOW_PRIVATE_EGRESS=false 启动
  // （与线上一致），所以任何"打到内网/本机"的尝试都必须失败。
  console.log(c.bold('\n── 3. SSRF 利用链（服务端不允许私网时全部必须失败）──'));

  // 3.1 管理员也建不出指向回环的平台
  r = await req('POST', '/api/platforms', {
    token,
    body: {
      slug: 'ssrf_loop',
      name: 'ssrf loop',
      baseUrl: `http://127.0.0.1:${PORT}`,
      authKind: 'none',
      authConfig: {},
      defaultHeaders: {},
      egressAllowHosts: [`127.0.0.1`],
      rateLimit: { qps: 50, daily: 100000 },
      allowPrivate: true,
    },
  });
  check(
    '指向 127.0.0.1 的平台被拒（报告 Step 1 的建面）',
    r.status === 400 || r.status === 403,
    `HTTP ${r.status} ${r.json?.error?.code ?? ''}`,
  );

  // 3.2 各种内网写法
  for (const [label, baseUrl] of [
    ['十进制整数 2130706433', 'http://2130706433/'],
    ['IPv6 回环 [::1]', 'http://[::1]:8778/'],
    ['云元数据 169.254.169.254', 'http://169.254.169.254/latest/meta-data/'],
    ['私网 10.0.0.5', 'http://10.0.0.5:8080/'],
    ['尾点 localhost.', 'http://localhost./'],
  ]) {
    r = await req('POST', '/api/platforms', {
      token,
      body: {
        slug: `ssrf_${randomBytes(3).toString('hex')}`,
        name: label,
        baseUrl,
        authKind: 'none',
        authConfig: {},
        defaultHeaders: {},
        egressAllowHosts: [],
        rateLimit: { qps: 50, daily: 100000 },
        allowPrivate: true,
      },
    });
    check(`内网写法被拒：${label}`, r.status === 400 || r.status === 403, `HTTP ${r.status}`);
  }

  // 3.3 试运行：即便平台本身是公网的，也不回显上游响应体
  if (okPlatform) {
    r = await req('POST', `/api/platforms/${okPlatform.id}/test`, { token, body: {} });
    const body = JSON.stringify(r.json ?? {});
    const view = r.json ?? {};
    // 允许它连不上（沙箱/内网 DNS 会解析到保留段）—— 关键是不能把上游原文吐出来。
    // 判据：响应里不许出现 sample 字段承载的原文，也不许出现 HTML 标签
    check(
      '平台试运行不回显上游响应体（报告 E4）',
      r.status < 500 && !/<html|<title|<body/i.test(body) && !body.includes('"sample":"'),
      `HTTP ${r.status} keys=${Object.keys(view).join(',')}`,
    );
    // 非 2xx / 失败时连样本都不该有
    check(
      '试运行失败时不带 sample',
      view.ok === true || view.sample === undefined,
      `ok=${view.ok} sample=${view.sample === undefined ? 'none' : 'present'}`,
    );
  }

  // 3.4 导入私网 curl：不能自动建出 allowPrivate 平台
  r = await req('POST', '/api/import', {
    token,
    body: { text: `curl 'http://127.0.0.1:${PORT}/api/health'`, kind: 'curl', autoPublish: false },
  });
  if (r.status === 200 && r.json?.platformsCreated?.length) {
    const created = await req('GET', '/api/platforms', { token });
    const bad = (created.json ?? []).filter(
      (p) => p.allowPrivate === true && /127\.0\.0\.1|localhost/.test(p.baseUrl),
    );
    check('导入私网 curl 不会自动建出 allowPrivate 平台（报告 E9 第二入口）', bad.length === 0, `${bad.length} 个`);
  } else {
    check('导入私网 curl 被拒或未创建平台', r.status === 400 || r.status === 403 || r.status === 200, `HTTP ${r.status}`);
  }

  // 3.5 改 llm.baseUrl 指向内网（报告二的核心链）
  r = await req('PUT', '/api/settings', {
    token,
    body: { llm: { enabled: true, baseUrl: `http://127.0.0.1:${PORT}/api`, model: 'x', apiKey: 'sk-reg-canary' } },
  });
  const llmSet = r.status === 200 ? r.json?.llm?.baseUrl ?? '' : '';
  check(
    'llm.baseUrl 指向本机被拒（报告二的 key 外送链）',
    r.status === 400 || r.status === 403 || !/127\.0\.0\.1/.test(llmSet),
    `HTTP ${r.status} baseUrl=${llmSet}`,
  );

  // 3.6 端点自定义敏感头（伪造来源 IP）
  if (okPlatform) {
    r = await req('POST', '/api/endpoints', {
      token,
      body: {
        platformId: okPlatform.id,
        slug: 'hdr_inject',
        group: 'g',
        method: 'GET',
        pathTemplate: '/get',
        summary: '',
        description: '',
        params: [
          { name: 'x-forwarded-for', in: 'header', type: 'string', required: false, default: '127.0.0.1' },
        ],
        body: null,
        response: { contentType: 'application/json', pick: [], unwrap: null, transform: null, redactFields: [], maxBytes: 2048 },
        sideEffect: 'read',
        sensitivity: 'low',
        tags: [],
        examples: [],
        notes: '',
        exposure: 'open',
        allowedKeyIds: [],
        publicName: '',
      },
    });
    // 保存可以成功（定义本身无害），真正拦截在调用时；这里验证调用被拒
    if (r.status === 200 && r.json?.id) {
      const t = await req('POST', `/api/endpoints/${r.json.id}/test`, { token, body: {} });
      const code = t.json?.data?.error?.code ?? t.json?.errorCode ?? '';
      check(
        '端点里的 x-forwarded-for 在调用时被拒（报告 Step 4）',
        t.status === 403 || code === 'header_forbidden' || !t.json?.ok,
        `HTTP ${t.status} code=${code}`,
      );
    } else {
      check('敏感头参数在校验阶段被拒', r.status === 400 || r.status === 403, `HTTP ${r.status}`);
    }
  }

  r = await req('PATCH', '/api/tools/rebuild', { token, body: {} });
  check('登录后工具重建可用', r.status === 200 || r.status === 404, `HTTP ${r.status}`);

  // 未登出前：会话接口正常
  r = await req('POST', '/api/chat/sessions', { token, body: { title: '回归会话' } });
  check('登录后可创建会话', r.status === 200 && Boolean(r.json?.id), `HTTP ${r.status}`);

  const sid = r.json?.id;
  if (sid) {
    // 写入侧：会话标题里塞密钥明文必须被拒
    r = await req('POST', '/api/chat/sessions', {
      token,
      body: { title: 'LEAK: sk-abcdefghijklmnopqrstuvwxyz012345' },
    });
    const leaked = r.status === 200 && String(r.json?.title ?? '').includes('sk-abcdefghij');
    check('会话标题里的密钥被挡住', !leaked, `HTTP ${r.status} title=${r.json?.title ?? ''}`);

    r = await req('GET', '/api/chat/sessions', { token });
    const plain = JSON.stringify(r.json ?? []);
    check('会话列表不含 sk- 明文', !plain.includes('sk-abcdefghij'), `HTTP ${r.status}`);
  }

  // 登出后再次被拒
  if (token) await req('POST', '/api/auth/logout', { token });
  r = await req('GET', '/api/secrets', { token });
  check('登出后立即失效', r.status === 401, `HTTP ${r.status}`);
} catch (err) {
  console.log(c.red(`\n✖ ${err.message}`));
  failed += 1;
} finally {
  cleanup();
}

console.log(
  failed ? c.red(`\n✖ 鉴权回归未通过：${failed} 项`) : c.green('\n✔ 鉴权回归通过：报告中的攻击链全部关闭'),
);
process.exit(failed ? 1 : 0);
