/**
 * 安全回归测试
 *
 * 每条用例都对应一次真实事故：
 *   - `/%61pi` 编码前缀绕过全局闸 → 未授权写接口 / 读回密钥明文
 *   - `/%67w` 编码前缀绕过网关 x-api-key
 *   - `body.example` 里任意 `${secret:NAME}` 被无条件解析
 *   - console 通道匿名豁免，test 接口不需要管理员
 *   - "同一次调用被脱敏、跨请求读回是明文"的持久化旁路
 *   - allowPrivate 由请求体控制，让网关请求自己
 *
 * 断言的是**修复后的行为**，改坏了就会红。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.ALLOW_PRIVATE_EGRESS = 'true';

const { normalizeRequestPath, pathStartsWith } = await import('../src/security/path-normalize.ts');
const { decideAccess } = await import('../src/security/access-control.ts');
const { scrubAll, scrubDeep, containsSecretValue, scrubPatterns, valueFingerprint } = await import(
  '../src/invoke/redact.ts'
);
const { buildSecretPolicy, buildRequest } = await import('../src/invoke/build.ts');
const { assertEgressAllowed, isPrivateHost } = await import('../src/invoke/guard.ts');
const { isValidLlmBaseUrl, knownSecretPlaintexts } = await import('../src/security/exposure-guard.ts');
const { resolveSecretRefs, makeSecretPolicy, allowSecret } = await import('../src/secrets/vault.ts');
const { resetDbForTests, closeDb } = await import('../src/db/client.ts');
const { platforms, endpoints, secrets } = await import('../src/db/repos.ts');
const { encryptSecret } = await import('../src/secrets/vault.ts');
const { assertEndpointAccess, issueConsoleGrant, testEndpoint, invokeTool } = await import('../src/invoke/engine.ts');
const { publishAndCompile } = await import('../src/import/pipeline.ts');

before(() => {
  resetDbForTests();
});

after(() => {
  closeDb();
});

/* ══════════════════════ 1. 路径规范化 ══════════════════════ */

test('编码路径被规范化解码：%61 → a，且与路由层语义一致', () => {
  const r = normalizeRequestPath('/%61pi/settings');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.path, '/api/settings');
  // 关键断言：规范化后必须命中 /api 规则，而不是被当成"非 /api 路径"放行
  assert.ok(r.ok && pathStartsWith(r.path, '/api'));
});

test('编码路径的每一种变形都无法绕过 /api 判定', () => {
  const variants = ['/%61pi/accounts', '/a%70i/accounts', '/ap%69/accounts', '/%61%70%69/accounts', '/API/accounts'];
  for (const v of variants) {
    const r = normalizeRequestPath(v);
    assert.equal(r.ok, true, `${v} 应能规范化`);
    assert.ok(r.ok && pathStartsWith(r.path, '/api'), `${v} 规范化后应落在 /api 下：${r.ok && r.path}`);
  }
});

test('大小写不同的路径归一化到同一结果', () => {
  const a = normalizeRequestPath('/API/Settings');
  const b = normalizeRequestPath('/api/settings');
  assert.deepEqual(a, b);
});

test('多重编码 / %2f / 反斜杠 / 控制字符全部判定为异常', () => {
  const bad = ['/api/%2561pi', '/api%2Faccounts', '/api\\settings', '/api/%00', '/api/\u0007x'];
  for (const v of bad) {
    const r = normalizeRequestPath(v);
    assert.equal(r.ok, false, `${v} 应被拒绝，实际 ${JSON.stringify(r)}`);
  }
});

test('重复斜杠、点段、矩阵参数被折叠', () => {
  const r1 = normalizeRequestPath('//api//settings');
  const r2 = normalizeRequestPath('/api/./settings');
  const r3 = normalizeRequestPath('/api/settings;jsessionid=1');
  assert.equal(r1.ok && r1.path, '/api/settings');
  assert.equal(r2.ok && r2.path, '/api/settings');
  assert.equal(r3.ok && r3.path, '/api/settings');
});

/* ══════════════════════ 2. 访问控制决策 ══════════════════════ */

test('管理写接口一律要求管理员', () => {
  const paths = [
    '/api/settings',
    '/api/secrets',
    '/api/platforms',
    '/api/endpoints',
    '/api/endpoints/ep_1/test',
    '/api/tools',
    '/api/tools/rebuild',
    '/api/accounts',
    '/api/update/apply',
    '/api/import',
    '/api/audit/stream',
  ];
  for (const p of paths) {
    const r = normalizeRequestPath(p);
    assert.equal(r.ok, true);
    const d = decideAccess(r);
    assert.equal(d.kind, 'admin', `${p} 应为 admin，实际 ${d.kind}`);
  }
});

test('未登记的 /api 路由默认拒绝（默认 deny）', () => {
  const r = normalizeRequestPath('/api/some-brand-new-route');
  const d = decideAccess(r);
  assert.equal(d.kind, 'admin');
  assert.equal(d.kind === 'admin' && d.rule, 'default-deny');
});

test('公开路由只有 health / login / 网关', () => {
  for (const p of ['/api/health', '/api/auth/login', '/gw/v1/tools']) {
    const r = normalizeRequestPath(p);
    assert.equal(decideAccess(r).kind, 'public', `${p} 应公开`);
  }
  // chat 需要登录（不能匿名读回会话明文）
  const chat = decideAccess(normalizeRequestPath('/api/chat/sessions'));
  assert.notEqual(chat.kind, 'public');
});

/* ══════════════════════ 3. 脱敏（跨请求回读旁路） ══════════════════════ */

test('通用模式挡住 __Host-admin 这类两段式 Cookie', () => {
  const cookie = '__Host-admin=eyJlcG9jaCI6NCwibWV0aG9kIjoicGFzc3dvcmQifQ.MeoPJkZIXPFUmgWCozV2OB6nmC5dMdEre4N5oymnkuA';
  const out = scrubPatterns(`title: LEAK:${cookie}`);
  assert.equal(out.includes('eyJlcG9jaCI6'), false, out);
  assert.match(out, /\*\*\*/);
});

test('跨请求读回：scrubDeep 在没有"本次明文"时也能靠指纹挡住片段', () => {
  const secret = 'I1574_CANARY_9f3a2b';
  // 模拟"写入时解析过、读取时 plaintexts 为空"的场景
  const stored = `LEAK: ${secret}`;
  const fp = new Map<string, string>([[secret, valueFingerprint(secret)]]);
  const out = scrubDeep({ title: stored }, { knownFragments: fp });
  assert.equal(out.title.includes(secret), false, JSON.stringify(out));
  assert.match(out.title, /\*\*\*/);
});

test('指纹一致性与不可逆：同一明文指纹相同，且不含明文', () => {
  const a = valueFingerprint('abc12345secret');
  const b = valueFingerprint('abc12345secret');
  const c = valueFingerprint('abc12345secreu');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.includes('abc12345'), false);
});

test('写入侧检测能识别"文本里带着密钥明文"', () => {
  const values = ['I1574_CANARY_9f3a2b', 'another-long-secret-value'];
  assert.ok(containsSecretValue('LEAK: I1574_CANARY_9f3a2b', values));
  assert.equal(containsSecretValue('LEAK: nothing here', values), null);
  // 太短的串不做匹配，避免把正常数据误判
  assert.equal(containsSecretValue('short', ['short']), null);
});

test('scrubDeep 递归处理数组与嵌套对象', () => {
  const out = scrubDeep({ list: [{ token: 'sk-abcdefghijklmnop' }] });
  assert.equal(JSON.stringify(out).includes('sk-abcdefghijklmnop'), false);
});

/* ══════════════════════ 4. 密钥引用白名单 ══════════════════════ */

function makePlatform(slug: string, over: Record<string, unknown> = {}) {
  return platforms.create({
    slug,
    name: slug,
    baseUrl: 'http://127.0.0.1:8899',
    authKind: 'none',
    authConfig: {},
    defaultHeaders: {},
    egressAllowHosts: ['127.0.0.1'],
    rateLimit: { qps: 50, daily: 100000 },
    allowPrivate: true,
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

test('authKind=none 的平台不会解析 defaultHeaders 里的引用', () => {
  const platform = makePlatform('noref');
  const ep = endpoints.create(platform.id, {
    slug: 'x',
    group: 'g',
    method: 'GET',
    pathTemplate: '/api/v1/orders',
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
  } as never);

  // 平台没有任何 secretRef 声明 → 白名单为空
  const policy = buildSecretPolicy(platform as never, ep as never);
  assert.equal(policy.allowed.size, 0, `不应有任何允许的密钥名：${[...policy.allowed]}`);

  // 直接拿一个"任意密钥名"去解析，必须被拒绝
  assert.throws(
    () => resolveSecretRefs('${secret:claude_wire_admin_cookie}', () => 'PLAINTEXT', policy),
    /未获授权/,
  );
});

test('显式声明 secretRef 后，只有该名字被允许解析', () => {
  const platform = makePlatform('withref', { authKind: 'header', authConfig: { secretRef: 'my_cookie' } });
  const ep = endpoints.create(platform.id, {
    slug: 'y',
    group: 'g',
    method: 'GET',
    pathTemplate: '/api/v1/orders',
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
  } as never);

  const policy = buildSecretPolicy(platform as never, ep as never);
  assert.ok(policy.allowed.has('my_cookie'));
  assert.equal(policy.allowed.has('claude_wire_admin_cookie'), false);

  assert.throws(
    () => resolveSecretRefs('${secret:claude_wire_admin_cookie}', () => 'PLAINTEXT', policy),
    /未获授权/,
  );
  assert.equal(resolveSecretRefs('${secret:my_cookie}', () => 'OK_VALUE', policy), 'OK_VALUE');
});

test('body.example 里的 ${secret:...} 不再被解析（核心回归）', () => {
  const platform = makePlatform('exampleref');
  const ep = endpoints.create(platform.id, {
    slug: 'store',
    group: 'g',
    method: 'POST',
    pathTemplate: '/%61pi/chat/sessions',
    summary: '',
    description: '',
    params: [],
    body: {
      contentType: 'application/json',
      encoding: 'json',
      required: false,
      schema: null,
      example: '{"title":"LEAK: ${secret:claude_wire_admin_cookie}"}',
    },
    response: EMPTY_RESPONSE,
    sideEffect: 'write',
    sensitivity: 'low',
    tags: [],
    examples: [],
    notes: '',
    exposure: 'open',
    allowedKeyIds: [],
    publicName: '',
  } as never);

  const short = makePlatform('selfref2');
  void short;

  let called = false;
  const built = buildRequest({
    platform: platform as never,
    endpoint: ep as never,
    args: {},
    secretValue: (name) => {
      called = true;
      return `LEAKED_${name}`;
    },
  });

  assert.equal(called, false, 'body.example 不应触发解密');
  assert.ok(built.body === null || !built.body.includes('LEAKED_'), `body 里出现了明文：${built.body}`);
  // 字面量原样保留（只是示例文本，不会被当请求体发出去也无所谓）
  if (built.body) assert.match(built.body, /\$\{secret:claude_wire_admin_cookie\}/);
});

test('header 参数用非鉴权名字引用密钥会被拒绝', () => {
  const platform = makePlatform('badparam');
  const ep = endpoints.create(platform.id, {
    slug: 'z',
    group: 'g',
    method: 'GET',
    pathTemplate: '/api/v1/orders',
    summary: '',
    description: '',
    params: [
      { name: 'X-Note', in: 'header', type: 'string', required: false, description: '', default: '${secret:some_key}' },
    ],
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
  } as never);

  assert.throws(() => buildSecretPolicy(platform as never, ep as never), /鉴权类参数/);
});

test('allowSecret 只记录一次来源', () => {
  const policy = makeSecretPolicy();
  allowSecret(policy, 'k', 'a');
  allowSecret(policy, 'k', 'b');
  assert.equal(policy.allowed.size, 1);
  assert.equal(policy.source.get('k'), 'a');
});

/* ══════════════════════ 5. console 通道 / test 接口 ══════════════════════ */

test('console 通道不再匿名放行：无凭据直接 401', () => {
  const ep = endpoints.create(makePlatform('consolenogrant').id, {
    slug: 'c1',
    group: 'g',
    method: 'GET',
    pathTemplate: '/api/v1/orders',
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
    exposure: 'closed',
    allowedKeyIds: [],
    publicName: '',
  } as never);

  assert.throws(() => assertEndpointAccess(ep as never, 'console', null, undefined, undefined), /管理员身份/);
});

test('console 通道凭据过期无效，成员身份也无效', () => {
  const ep = { slug: 'x', platformSlug: 'p', exposure: 'open', allowedKeyIds: [] } as never;
  const stale = { accountId: 'a', role: 'admin' as const, issuedAt: Date.now() - 10 * 60_000 };
  assert.throws(() => assertEndpointAccess(ep, 'console', null, undefined, stale), /过期/);

  const member = { accountId: 'a', role: 'member' as const, issuedAt: Date.now() };
  assert.throws(() => assertEndpointAccess(ep, 'console', null, undefined, member), /仅限管理员/);

  const ok = issueConsoleGrant({ id: 'a', role: 'admin' });
  assert.doesNotThrow(() => assertEndpointAccess(ep, 'console', null, undefined, ok));
});

test('匿名调用 testEndpoint 拿不到任何结果', async () => {
  const platform = makePlatform('testguard');
  const ep = endpoints.create(platform.id, {
    slug: 'tg',
    group: 'g',
    method: 'GET',
    pathTemplate: '/api/v1/orders',
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
    exposure: 'closed',
    allowedKeyIds: [],
    publicName: '',
  } as never);
  publishAndCompile(ep.id);

  const anonymous = await testEndpoint(ep.id, {}, undefined);
  assert.equal(anonymous.ok, false);
  assert.equal((anonymous.data as { error: { code: string } }).error.code, 'console_unauthorized');

  const admin = await testEndpoint(ep.id, {}, issueConsoleGrant({ id: 'acc_admin', role: 'admin' }), 'account:acc_admin');
  // 上游没起来不影响结论：只要不是 console_unauthorized 就说明凭据生效
  assert.notEqual((admin.data as { error?: { code?: string } }).error?.code, 'console_unauthorized');
});

/* ══════════════════════ 6. egress 策略 ══════════════════════ */

test('私网地址识别覆盖常见段与元数据地址', () => {
  for (const h of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', 'localhost', '::1']) {
    assert.equal(isPrivateHost(h), true, `${h} 应为私网`);
  }
  for (const h of ['api.example.com', '8.8.8.8', 'ai2.aisb.shop']) {
    assert.equal(isPrivateHost(h), false, `${h} 不应为私网`);
  }
});

test('平台 allowPrivate=false 时私网出网被拒（即使全局允许）', () => {
  const platform = makePlatform('privoff', { allowPrivate: false });
  assert.throws(
    () => assertEgressAllowed(platform as never, new URL('http://127.0.0.1:8899/x'), true),
    /禁止访问私网/,
  );
});

test('网关不允许请求自身（回环 + 端口相同）', () => {
  const platform = makePlatform('selfreq');
  assert.throws(
    () => assertEgressAllowed(platform as never, new URL('http://127.0.0.1:8778/api/health'), true, { host: '127.0.0.1', port: 8778 }),
    /请求自身/,
  );
  // 同端口但 host 不在白名单 → 先被白名单挡掉，也是拒绝
  assert.throws(() => assertEgressAllowed(platform as never, new URL('http://10.0.0.9:8778/x'), true, { host: '127.0.0.1', port: 8778 }));
});

test('白名单外主机被拒，白名单内放行', () => {
  const platform = makePlatform('allowlist');
  assert.throws(() => assertEgressAllowed(platform as never, new URL('http://evil.example.com/x'), false), /出网白名单/);
  assert.doesNotThrow(() => assertEgressAllowed(platform as never, new URL('http://127.0.0.1:8899/x'), true));
});

/* ══════════════════════ 7. LLM baseUrl ══════════════════════ */

test('LLM baseUrl 默认不允许私网（防止把 key 送到内网/元数据服务）', () => {
  const prev = process.env.LLM_ALLOW_PRIVATE;
  const prevHosts = process.env.LLM_ALLOWED_HOSTS;
  delete process.env.LLM_ALLOW_PRIVATE;
  delete process.env.LLM_ALLOWED_HOSTS;
  try {
    assert.ok(isValidLlmBaseUrl('http://127.0.0.1:8778/api'), '回环应被拒');
    assert.ok(isValidLlmBaseUrl('http://169.254.169.254/latest'), '云元数据应被拒');
    assert.ok(isValidLlmBaseUrl('http://10.0.0.5:11434/v1'), '内网应被拒');
    assert.ok(isValidLlmBaseUrl('ftp://api.openai.com/v1'), '非 http 应被拒');
    assert.ok(isValidLlmBaseUrl('not a url'), '非 URL 应被拒');
    assert.equal(isValidLlmBaseUrl('https://api.openai.com/v1'), null, '公网合法地址应放行');
    assert.equal(isValidLlmBaseUrl('https://ai2.aisb.shop/v1'), null, '公网合法地址应放行');
  } finally {
    if (prev !== undefined) process.env.LLM_ALLOW_PRIVATE = prev;
    if (prevHosts !== undefined) process.env.LLM_ALLOWED_HOSTS = prevHosts;
  }
});

test('LLM 私网要运维显式开启才放行（局域网自建模型）', () => {
  const prev = process.env.LLM_ALLOW_PRIVATE;
  const prevHosts = process.env.LLM_ALLOWED_HOSTS;
  delete process.env.LLM_ALLOWED_HOSTS;
  process.env.LLM_ALLOW_PRIVATE = 'true';
  try {
    assert.equal(isValidLlmBaseUrl('http://127.0.0.1:11434/v1'), null, '开了开关应放行局域网模型');
  } finally {
    if (prev !== undefined) process.env.LLM_ALLOW_PRIVATE = prev;
    else delete process.env.LLM_ALLOW_PRIVATE;
    if (prevHosts !== undefined) process.env.LLM_ALLOWED_HOSTS = prevHosts;
  }
});

test('LLM_ALLOWED_HOSTS 配了就按白名单收口（优先于私网开关）', () => {
  const prev = process.env.LLM_ALLOW_PRIVATE;
  const prevHosts = process.env.LLM_ALLOWED_HOSTS;
  process.env.LLM_ALLOWED_HOSTS = 'ai2.aisb.shop,api.openai.com';
  process.env.LLM_ALLOW_PRIVATE = 'true';
  try {
    assert.equal(isValidLlmBaseUrl('https://ai2.aisb.shop/api'), null);
    assert.ok(isValidLlmBaseUrl('http://127.0.0.1:11434/v1'), '白名单外即便开了私网也应拒绝');
    assert.ok(isValidLlmBaseUrl('https://evil.example.com/v1'), '白名单外应拒绝');
  } finally {
    if (prev !== undefined) process.env.LLM_ALLOW_PRIVATE = prev;
    else delete process.env.LLM_ALLOW_PRIVATE;
    if (prevHosts !== undefined) process.env.LLM_ALLOWED_HOSTS = prevHosts;
    else delete process.env.LLM_ALLOWED_HOSTS;
  }
});

/* ══════════════════════ 8. 密钥明文枚举（写入侧检测用） ══════════════════════ */

test('knownSecretPlaintexts 能读回 vault 里的明文用于写入侧比对', () => {
  secrets.put('canary_for_test', encryptSecret('I1574_CANARY_9f3a2b'), 'test');
  const list = knownSecretPlaintexts();
  assert.ok(list.includes('I1574_CANARY_9f3a2b'), `未读到 canary：${list.length} 条`);
});

test('scrubAll 在没有任何 hint 时仍是纯函数', () => {
  assert.equal(scrubAll('plain text'), 'plain text');
  assert.equal(scrubAll('Bearer abcdefghijklmnop'), 'Bearer ***');
});

/* ══════════════════════ 9. 网关匿名调用被拦 ══════════════════════ */

test('invokeTool 在 chat 通道仍受开放策略约束', async () => {
  const platform = makePlatform('chatpolicy');
  const ep = endpoints.create(platform.id, {
    slug: 'closed_for_chat',
    group: 'g',
    method: 'GET',
    pathTemplate: '/api/v1/orders',
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
    exposure: 'closed',
    allowedKeyIds: [],
    publicName: 'closed_for_chat',
  } as never);
  publishAndCompile(ep.id);
  const result = await invokeTool('chatpolicy__closed_for_chat', {}, 'chat');
  assert.equal(result.ok, false);
  const code = (result.data as { error: { code: string } }).error.code;
  assert.ok(code === 'endpoint_closed' || code === 'tool_not_found', code);
});
