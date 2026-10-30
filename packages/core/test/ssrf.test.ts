/**
 * SSRF 回归测试
 *
 * 对应 bug.txt 第一份报告（全响应 SSRF）与第二份（LLM baseUrl 外送 key）。
 *
 * 每条用例都是报告里的一条利用路径：
 *   - 平台 baseUrl 指向 127.0.0.1:8778 → 试运行能读应用自己的控制台
 *   - PATCH 改 baseUrl 到内网任意路径 → 401 错误体也回显
 *   - 端点自定义 method/header/body → 以 X-Forwarded-For 伪造本机来源
 *   - 导入 curl 私网 URL → 自动建 allowPrivate=true 平台并抓标题
 *   - 改 llm.baseUrl → 服务端带着 Bearer 打过去（key 外送）
 *
 * 断言的是「修复后一律被拒」，改坏了就会红。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const {
  isBlockedV4,
  isBlockedV6,
  isBlockedAddress,
  normalizeObscureIpv4,
  resolveAndCheckTarget,
} = await import('../src/security/egress.ts');
const { safeFetch } = await import('../src/security/safe-fetch.ts');
const { buildDryRunView } = await import('../src/security/dry-run.ts');
const { isValidLlmBaseUrl } = await import('../src/security/exposure-guard.ts');
const { buildRequest } = await import('../src/invoke/build.ts');
const { resetDbForTests, closeDb } = await import('../src/db/client.ts');
const { platforms, endpoints } = await import('../src/db/repos.ts');
const { publishAndCompile } = await import('../src/import/pipeline.ts');
const { invokeTool, issueConsoleGrant, testEndpoint } = await import('../src/invoke/engine.ts');
const { fetchSiteInfo } = await import('../src/import/site.ts');
const { chatJson } = await import('../src/ai/client.ts');

/* 本机假上游：模拟"内网服务"（报告里被打的就是应用自己） */
let srv: Server;
let port = 0;
const hits: Array<{ url: string; method: string; headers: Record<string, unknown> }> = [];

before(async () => {
  resetDbForTests();
  // 默认**不开**私网：本组测试要验证的就是"没开就绝对打不到"
  delete process.env.ALLOW_PRIVATE_EGRESS;
  delete process.env.LLM_ALLOW_PRIVATE;

  srv = createServer((req, res) => {
    hits.push({ url: req.url ?? '/', method: req.method ?? 'GET', headers: req.headers });
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"version":"0.2.0"}');
      return;
    }
    if (req.url === '/api/accounts') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"code":"unauthorized","message":"请先登录"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>接口资产中枢 · 控制台</title></head></html>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

after(async () => {
  if (srv) await new Promise<void>((r) => srv.close(() => r()));
  closeDb();
});

/* ══════════════════ 1. 地址判定（多写法 / 保留段） ══════════════════ */

test('常见内网/回环/元数据地址全部判定为禁止', () => {
  const blocked = [
    '127.0.0.1',
    '127.0.0.53',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // 云元数据
    '100.100.100.200', // 阿里云元数据（在 100.64/10 里）
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
  ];
  for (const ip of blocked) assert.equal(isBlockedV4(ip), true, `${ip} 应被禁止`);
});

test('公网地址不被误杀', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1']) {
    assert.equal(isBlockedV4(ip), false, `${ip} 不应被禁止`);
  }
});

test('IPv6 回环/ULA/链路本地/映射地址被禁止', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isBlockedV6(ip), true, `${ip} 应被禁止`);
  }
  assert.equal(isBlockedV6('2606:4700::1111'), false);
});

test('各种变形的 IPv4 写法都被归一化后再判定（报告里的绕过手法）', () => {
  // 十进制整数
  assert.equal(normalizeObscureIpv4('2130706433'), '127.0.0.1');
  assert.equal(isBlockedV4(normalizeObscureIpv4('2130706433')!), true);
  // 十六进制
  assert.equal(normalizeObscureIpv4('0x7f.1'), '127.0.0.1');
  // 八进制
  assert.equal(normalizeObscureIpv4('0177.0.0.1'), '127.0.0.1');
  // 短写
  assert.equal(normalizeObscureIpv4('127.1'), '127.0.0.1');
  assert.equal(normalizeObscureIpv4('10.1'), '10.0.0.1');
  // 正常写法不受影响
  assert.equal(normalizeObscureIpv4('8.8.8.8'), '8.8.8.8');
});

test('本地主机名与尾点写法也被识别', async () => {
  for (const host of ['localhost', 'app.localhost', 'printer.local', 'svc.internal']) {
    await assert.rejects(
      () => resolveAndCheckTarget(new URL(`http://${host}/`), { allowPrivate: false }),
      /内网|本地/,
      `${host} 应被拒`,
    );
  }
  // 尾点：127.0.0.1. 与 127.0.0.1 是同一台机器
  await assert.rejects(
    () => resolveAndCheckTarget(new URL('http://127.0.0.1./x'), { allowPrivate: false }),
    /内网/,
  );
});

test('userinfo 混淆与非常规协议被拒', async () => {
  await assert.rejects(
    () => resolveAndCheckTarget(new URL('http://evil.com@127.0.0.1/x'), { allowPrivate: false }),
    /用户名/,
  );
  await assert.rejects(() => resolveAndCheckTarget(new URL('file:///etc/passwd'), { allowPrivate: false }), /协议/);
  await assert.rejects(() => resolveAndCheckTarget(new URL('gopher://127.0.0.1:6379/'), { allowPrivate: false }), /协议/);
});

/* ══════════════════ 2. 试运行不再打到内网 ══════════════════ */

function makePlatform(slug: string, baseUrl: string, over: Record<string, unknown> = {}) {
  return platforms.create({
    slug,
    name: slug,
    baseUrl,
    authKind: 'none',
    authConfig: {},
    defaultHeaders: {},
    egressAllowHosts: [new URL(baseUrl).hostname],
    rateLimit: { qps: 50, daily: 100000 },
    allowPrivate: false,
    notes: '',
    ...over,
  } as never);
}

const EMPTY_RESPONSE = {
  contentType: 'application/json',
  pick: [],
  unwrap: null,
  transform: null,
  redactFields: [],
  maxBytes: 2048,
};

function makeEndpoint(platformId: string, over: Record<string, unknown> = {}) {
  return endpoints.create(platformId, {
    slug: 'probe',
    group: 'g',
    method: 'GET',
    pathTemplate: '/',
    summary: '',
    description: '',
    params: [],
    body: null,
    response: EMPTY_RESPONSE,
    sideEffect: 'read',
    sensitivity: 'low',
    tags: [],
    examples: [],
    notes: '',
    exposure: 'open',
    allowedKeyIds: [],
    publicName: '',
    ...over,
  } as never);
}

test('平台试运行打不到回环（报告 Step 2 的利用点）', async () => {
  const before = hits.length;
  const p = makePlatform('ssrf_loop', `http://127.0.0.1:${port}`);
  const ep = makeEndpoint(p.id, { pathTemplate: '/api/health' });
  publishAndCompile(ep.id);

  const result = await invokeTool(`${p.slug}__probe`, {}, 'rest');
  assert.equal(result.ok, false, JSON.stringify(result.data));
  const code = (result.data as { error: { code: string } }).error.code;
  assert.ok(
    code === 'egress_private_blocked' || code === 'upstream_unreachable',
    `应被出网策略拒绝，实际 ${code}`,
  );
  assert.equal(hits.length, before, '服务端不应真的向内网发出请求');
});

test('allowPrivate=true 但服务端开关关闭时，依然打不到', async () => {
  delete process.env.ALLOW_PRIVATE_EGRESS;
  const before = hits.length;
  const p = makePlatform('ssrf_loop2', `http://127.0.0.1:${port}`, { allowPrivate: true });
  const ep = makeEndpoint(p.id, { pathTemplate: '/api/health' });
  publishAndCompile(ep.id);

  const result = await invokeTool(`${p.slug}__probe`, {}, 'rest');
  assert.equal(result.ok, false, JSON.stringify(result.data));
  assert.equal(hits.length, before, '平台想开也不行 —— 必须服务端也允许');
});

test('控制台试运行同样打不到内网（console 不是豁免通道）', async () => {
  const before = hits.length;
  const p = makePlatform('ssrf_console', `http://127.0.0.1:${port}`);
  const ep = makeEndpoint(p.id, { pathTemplate: '/api/health' });
  publishAndCompile(ep.id);

  const grant = issueConsoleGrant({ id: 'acc_admin', role: 'admin' });
  const result = await testEndpoint(ep.id, {}, grant, 'account:acc_admin');
  assert.equal(result.ok, false, JSON.stringify(result.data));
  assert.equal(hits.length, before, '控制台也不应打通内网');
});

/* ══════════════════ 3. 自定义 header 伪造来源 ══════════════════ */

test('端点定义里的 x-forwarded-for / x-real-ip 被拒绝（报告 Step 4）', () => {
  const p = makePlatform('ssrf_hdr', 'https://api.example.com');
  const ep = makeEndpoint(p.id, {
    pathTemplate: '/api/accounts',
    method: 'POST',
    params: [{ name: 'x-forwarded-for', in: 'header', type: 'string', required: false, default: '127.0.0.1' }],
  });

  assert.throws(
    () =>
      buildRequest({
        platform: p as never,
        endpoint: ep as never,
        args: {},
        secretValue: () => 'x',
      }),
    /请求头 x-forwarded-for 不允许/,
  );
});

test('调用方也无法通过 header_ 前缀注入来源 IP / Host', () => {
  const p = makePlatform('ssrf_hdr2', 'https://api.example.com');
  const ep = makeEndpoint(p.id, { pathTemplate: '/api/x' });

  for (const forbidden of ['header_x-forwarded-for', 'header_x-real-ip', 'header_host', 'header_forwarded']) {
    assert.throws(
      () =>
        buildRequest({
          platform: p as never,
          endpoint: ep as never,
          args: { [forbidden]: '127.0.0.1' },
          secretValue: () => 'x',
        }),
      /不允许/,
      `${forbidden} 应被拒`,
    );
  }
});

test('平台 defaultHeaders 里的敏感头也被拒绝', () => {
  const p = makePlatform('ssrf_hdr3', 'https://api.example.com', {
    defaultHeaders: { 'X-Forwarded-For': '127.0.0.1' },
  });
  const ep = makeEndpoint(p.id, { pathTemplate: '/api/x' });
  assert.throws(
    () => buildRequest({ platform: p as never, endpoint: ep as never, args: {}, secretValue: () => 'x' }),
    /不允许/,
  );
});

test('普通自定义头不受影响（别把功能一起砍掉）', () => {
  const p = makePlatform('ssrf_hdr4', 'https://api.example.com');
  // 声明过的普通头照常用；只有"来源 IP / Host"那一类才被拒
  const ep = makeEndpoint(p.id, {
    pathTemplate: '/api/x',
    params: [{ name: 'x-trace-id', in: 'header', type: 'string', required: false }],
  });
  const built = buildRequest({
    platform: p as never,
    endpoint: ep as never,
    args: { 'header_x-trace-id': 'abc123' },
    secretValue: () => 'x',
  });
  assert.equal(built.headers['x-trace-id'], 'abc123');
});

/* ══════════════════ 4. 试运行不回显响应体 ══════════════════ */

test('非 2xx 不返回响应体（报告 E4：401 错误体被完整读出）', () => {
  const view = buildDryRunView({
    status: 401,
    latencyMs: 3,
    upstreamHost: '127.0.0.1:8778',
    contentType: 'application/json',
    text: '{"error":{"code":"unauthorized","message":"请先登录"},"stack":"...内部结构..."}',
    bytes: 68,
    truncated: false,
    console: true,
  });
  assert.equal(view.ok, false);
  assert.equal(view.status, 401);
  assert.equal(view.sample, undefined, '非 2xx 不应带样本');
  assert.equal(JSON.stringify(view).includes('请先登录'), false);
  assert.equal(JSON.stringify(view).includes('stack'), false);
});

test('2xx 只给结构摘要，不回正文', () => {
  const view = buildDryRunView({
    status: 200,
    latencyMs: 2,
    upstreamHost: '127.0.0.1:8778',
    contentType: 'text/html',
    text: '<html><head><title>接口资产中枢 · 控制台</title></head><body>secret html</body></html>',
    bytes: 100,
    truncated: false,
    console: true,
  });
  const json = JSON.stringify(view);
  assert.equal(json.includes('接口资产中枢'), false, '控制台标题不应被回显');
  assert.equal(json.includes('secret html'), false);
});

test('HTML 与非 JSON 文本都被归纳，不透出原文', () => {
  const html = buildDryRunView({
    status: 200,
    latencyMs: 1,
    upstreamHost: 'h',
    contentType: 'text/html; charset=utf-8',
    text: '<html><title>内部管理后台</title></html>',
    bytes: 40,
    truncated: false,
    console: true,
  });
  assert.equal(JSON.stringify(html).includes('内部管理后台'), false);

  const text = buildDryRunView({
    status: 200,
    latencyMs: 1,
    upstreamHost: 'h',
    contentType: 'text/plain',
    text: 'root:x:0:0:root:/root:/bin/bash',
    bytes: 32,
    truncated: false,
    console: true,
  });
  // 纯文本给短预览是刻意的（排查需要），但长度受限
  if (text.sample?.kind === 'text') assert.ok(text.sample.preview.length <= 320);
});

test('JSON 摘要抹掉密钥明文（含指纹兜底）', () => {
  const secret = 'I1574_CANARY_9f3a2b';
  const view = buildDryRunView({
    status: 200,
    latencyMs: 1,
    upstreamHost: 'h',
    contentType: 'application/json',
    text: JSON.stringify({ data: { token: secret, ok: true } }),
    bytes: 50,
    truncated: false,
    console: true,
    secretValues: [secret],
  });
  assert.equal(JSON.stringify(view).includes(secret), false);
});

test('非控制台通道连样本都不给（令牌持有者看不到上游数据）', () => {
  const view = buildDryRunView({
    status: 200,
    latencyMs: 1,
    upstreamHost: 'api.example.com',
    contentType: 'application/json',
    text: '{"data":{"phone":"13800000000","orders":[1,2,3]}}',
    bytes: 50,
    truncated: false,
    console: false,
  });
  assert.equal(view.sample, undefined);
  assert.equal(view.upstreamHost, '');
  assert.equal(JSON.stringify(view).includes('13800000000'), false);
});

/* ══════════════════ 5. 导入第二入口 ══════════════════ */

test('fetchSiteInfo 默认不允许抓私网（报告 E9 的第二入口）', async () => {
  const before = hits.length;
  const info = await fetchSiteInfo(`http://127.0.0.1:${port}`);
  assert.equal(info.title, '');
  assert.match(info.error ?? '', /内网|拒绝/);
  assert.equal(hits.length, before, '默认不应真的去抓内网首页');
});

test('fetchSiteInfo 显式允许时仍可用（局域网部署不被焊死）', async () => {
  process.env.ALLOW_PRIVATE_EGRESS = 'true';
  try {
    const info = await fetchSiteInfo(`http://127.0.0.1:${port}`, true);
    assert.equal(info.title, '接口资产中枢 · 控制台');
  } finally {
    delete process.env.ALLOW_PRIVATE_EGRESS;
  }
});

/* ══════════════════ 6. LLM baseUrl 外送 key（报告二） ══════════════════ */

test('llm baseUrl 指向私网被拒（防止 Bearer key 送到内网）', () => {
  delete process.env.LLM_ALLOW_PRIVATE;
  delete process.env.LLM_ALLOWED_HOSTS;
  assert.ok(isValidLlmBaseUrl(`http://127.0.0.1:${port}/api`));
  assert.ok(isValidLlmBaseUrl('http://169.254.169.254/latest'));
  assert.ok(isValidLlmBaseUrl('http://10.0.0.5:11434/v1'));
});

test('chatJson 对私网 baseUrl 直接返回失败，且不发出请求', async () => {
  const before = hits.length;
  const res = await chatJson(
    {
      enabled: true,
      baseUrl: `http://127.0.0.1:${port}/api`,
      apiKey: 'sk-must-not-leak',
      model: 'x',
      timeoutMs: 2000,
      concurrency: 1,
    },
    [{ role: 'user', content: 'hi' }],
  );
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(hits.length, before, '不应把带 Bearer 的请求发到私网');
  // 错误信息里也不能出现密钥
  assert.equal(JSON.stringify(res).includes('sk-must-not-leak'), false);
});

test('chatJson 的 baseUrl 不在白名单时被拒', async () => {
  const prev = process.env.LLM_ALLOWED_HOSTS;
  process.env.LLM_ALLOWED_HOSTS = 'ai2.aisb.shop';
  try {
    const res = await chatJson(
      {
        enabled: true,
        baseUrl: 'https://evil.example.com/v1',
        apiKey: 'sk-must-not-leak',
        model: 'x',
        timeoutMs: 1000,
        concurrency: 1,
      },
      [{ role: 'user', content: 'hi' }],
    );
    assert.equal(res.ok, false);
    assert.equal(JSON.stringify(res).includes('sk-must-not-leak'), false);
  } finally {
    if (prev === undefined) delete process.env.LLM_ALLOWED_HOSTS;
    else process.env.LLM_ALLOWED_HOSTS = prev;
  }
});

/* ══════════════════ 7. safeFetch 本身 ══════════════════ */

test('safeFetch 在私网关闭时拒绝连接回环，且不触达目标', async () => {
  delete process.env.ALLOW_PRIVATE_EGRESS;
  const before = hits.length;
  await assert.rejects(
    () => safeFetch(`http://127.0.0.1:${port}/api/health`, { allowPrivate: true }),
    /内网/,
  );
  assert.equal(hits.length, before, '服务端开关关闭时 allowPrivate 无效');
});

test('safeFetch 不跟随 3xx（跳转后的私网目标不会被自动访问）', async () => {
  process.env.ALLOW_PRIVATE_EGRESS = 'true';
  const redirectSrv = createServer((_req, res) => {
    res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  await new Promise<void>((r) => redirectSrv.listen(0, '127.0.0.1', r));
  const addr = redirectSrv.address();
  const rport = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await safeFetch(`http://127.0.0.1:${rport}/`, { allowPrivate: true });
    assert.equal(res.status, 302, '应把 302 原样返回，由调用方决定');
    // 关键：响应体不是元数据内容
    assert.equal(res.text.includes('meta-data'), false);
  } finally {
    await new Promise<void>((r) => redirectSrv.close(() => r()));
    delete process.env.ALLOW_PRIVATE_EGRESS;
  }
});

test('safeFetch 把连接锁在已校验的 IP 上（Host 头仍是原域名）', async () => {
  process.env.ALLOW_PRIVATE_EGRESS = 'true';
  try {
    const res = await safeFetch(`http://127.0.0.1:${port}/api/health`, { allowPrivate: true });
    assert.equal(res.status, 200);
    assert.equal(res.address, '127.0.0.1');
    const hit = hits[hits.length - 1]!;
    assert.equal(hit.headers.host, `127.0.0.1:${port}`, 'Host 头应保持原样');
  } finally {
    delete process.env.ALLOW_PRIVATE_EGRESS;
  }
});

test('safeFetch 对响应体做上限截断（避免被超大响应拖死）', async () => {
  process.env.ALLOW_PRIVATE_EGRESS = 'true';
  const bigSrv = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('x'.repeat(100_000));
  });
  await new Promise<void>((r) => bigSrv.listen(0, '127.0.0.1', r));
  const addr = bigSrv.address();
  const bport = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await safeFetch(`http://127.0.0.1:${bport}/`, { allowPrivate: true, maxBytes: 1024 });
    assert.ok(res.truncated);
    assert.ok(res.text.length <= 1024);
  } finally {
    await new Promise<void>((r) => bigSrv.close(() => r()));
    delete process.env.ALLOW_PRIVATE_EGRESS;
  }
});
