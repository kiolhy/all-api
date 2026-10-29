import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildMockUpstream } from '../../../fixtures/mock-upstream/src/index.ts';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const { resetDbForTests, closeDb } = await import('../src/db/client.ts');
const { platforms, endpoints, tools, secrets } = await import('../src/db/repos.ts');
const { encryptSecret } = await import('../src/secrets/vault.ts');
const { invokeTool, testEndpoint } = await import('../src/invoke/engine.ts');
const { publishAndCompile, runImport } = await import('../src/import/pipeline.ts');

let upstream: Awaited<ReturnType<typeof buildMockUpstream>>;
let upstreamPort = 0;

function baseUrl(): string {
  return `http://127.0.0.1:${upstreamPort}`;
}

const EMPTY_RESPONSE = {
  contentType: 'application/json',
  pick: [] as string[],
  unwrap: null as string | null,
  transform: null as string | null,
  redactFields: [] as string[],
  maxBytes: 2 * 1024 * 1024,
};

function makePlatform(slug = 'mock') {
  return platforms.create({
    slug,
    name: 'Mock 平台',
    baseUrl: baseUrl(),
    authKind: 'none',
    authConfig: {},
    defaultHeaders: {},
    egressAllowHosts: ['127.0.0.1'],
    rateLimit: { qps: 50, daily: 100000 },
    allowPrivate: true,
    notes: '测试用',
  });
}

function simpleEndpoint(
  platformId: string,
  slug: string,
  path: string,
  over: {
    exposure?: 'open' | 'restricted' | 'closed';
    allowedKeyIds?: string[];
    publicName?: string;
    params?: unknown[];
  } = {},
) {
  return endpoints.create(platformId, {
    slug,
    group: 'x',
    method: 'GET',
    pathTemplate: path,
    summary: '',
    description: '',
    params: (over.params ?? []) as never,
    body: null,
    response: EMPTY_RESPONSE,
    sideEffect: 'read',
    sensitivity: 'low',
    tags: [],
    examples: [],
    notes: '',
    exposure: over.exposure ?? 'open',
    allowedKeyIds: over.allowedKeyIds ?? [],
    publicName: over.publicName ?? '',
  });
}

function makeUserEndpoint(platformId: string, slug = 'get_user') {
  const ep = endpoints.create(platformId, {
    slug,
    group: 'user',
    method: 'GET',
    pathTemplate: '/api/v1/users/{userId}',
    summary: '获取用户信息',
    description: '按 id 查用户',
    params: [
      { name: 'userId', in: 'path', type: 'string', required: true, description: '用户 id' },
      {
        name: 'Authorization',
        in: 'header',
        type: 'string',
        required: true,
        description: '鉴权头，由密钥库自动注入，调用方无需填写',
        default: 'Bearer ${secret:mock_authorization}',
        secretRef: 'mock_authorization',
      },
    ] as never,
    body: null,
    response: EMPTY_RESPONSE,
    sideEffect: 'read',
    sensitivity: 'low',
    tags: ['user'],
    examples: [],
    notes: '',
    exposure: 'open',
    allowedKeyIds: [],
    publicName: '',
  });
  secrets.put('mock_authorization', encryptSecret('sk-test-token'), '测试密钥');
  return ep;
}

before(async () => {
  resetDbForTests();
  upstream = await buildMockUpstream();
  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const addr = upstream.server.address();
  upstreamPort = typeof addr === 'object' && addr ? addr.port : 0;
});

after(async () => {
  await upstream?.close();
  closeDb();
});

test('端到端：带密钥调用上游并脱敏', async () => {
  const platform = makePlatform();
  const ep = makeUserEndpoint(platform.id);
  publishAndCompile(ep.id);
  const tool = tools.byEndpoint(ep.id)!;
  const result = await invokeTool(tool.name, { userId: '42' }, 'rest');
  assert.equal(result.ok, true, JSON.stringify(result.data));
  const data = result.data as { data: { name: string; token: string } };
  assert.equal(data.data.name, '用户42');
  assert.equal(data.data.token, '***');
  assert.equal(result.meta.upstreamHost, '');
});

test('控制台通道可见上游主机', async () => {
  const platform = platforms.bySlug('mock')!;
  const ep = endpoints.bySlug(platform.id, 'get_user')!;
  const result = await testEndpoint(ep.id, { userId: '1' });
  assert.equal(result.ok, true);
  assert.match(result.meta.upstreamHost, /127\.0\.0\.1/);
});

test('缺少必填参数被拒绝', async () => {
  const platform = platforms.bySlug('mock')!;
  const ep = endpoints.bySlug(platform.id, 'get_user')!;
  const tool = tools.byEndpoint(ep.id)!;
  const result = await invokeTool(tool.name, {}, 'rest');
  assert.equal(result.ok, false);
  assert.equal((result.data as { error: { code: string } }).error.code, 'missing_arg');
});

test('路径参数不会被示例值静默填充（回归）', async () => {
  const platform = makePlatform('nofallback');
  const ep = simpleEndpoint(platform.id, 'get_by_id', '/api/v1/users/{userId}', {
    params: [{ name: 'userId', in: 'path', type: 'string', required: true, description: '', example: '42' }],
  });
  publishAndCompile(ep.id);
  const tool = tools.byEndpoint(ep.id)!;
  const result = await invokeTool(tool.name, {}, 'rest');
  assert.equal(result.ok, false);
  assert.equal(
    (result.data as { error: { code: string } }).error.code,
    'missing_arg',
    '不能拿 example 当真实入参去调上游',
  );
});

test('未声明参数被拒绝', async () => {
  const platform = platforms.bySlug('mock')!;
  const ep = endpoints.bySlug(platform.id, 'get_user')!;
  const tool = tools.byEndpoint(ep.id)!;
  const result = await invokeTool(tool.name, { userId: '1', evil: 'x' }, 'rest');
  assert.equal(result.ok, false);
  assert.equal((result.data as { error: { code: string } }).error.code, 'unknown_arg');
});

test('路径穿越被拒绝', async () => {
  const platform = platforms.bySlug('mock')!;
  const ep = endpoints.bySlug(platform.id, 'get_user')!;
  const tool = tools.byEndpoint(ep.id)!;
  const result = await invokeTool(tool.name, { userId: '../../admin' }, 'rest');
  assert.equal(result.ok, false);
  assert.equal((result.data as { error: { code: string } }).error.code, 'invalid_arg');
});

test('出网白名单外的主机被拦截', async () => {
  const platform = platforms.create({
    slug: 'blocked',
    name: 'Blocked',
    baseUrl: baseUrl(),
    authKind: 'none',
    authConfig: {},
    defaultHeaders: {},
    egressAllowHosts: ['example.com'],
    rateLimit: { qps: 10, daily: 1000 },
    allowPrivate: true,
    notes: '',
  });
  const ep = simpleEndpoint(platform.id, 'probe', '/api/v1/orders');
  publishAndCompile(ep.id);
  const tool = tools.byEndpoint(ep.id)!;
  const result = await invokeTool(tool.name, {}, 'rest');
  assert.equal(result.ok, false);
  const code = (result.data as { error: { code: string } }).error.code;
  assert.equal(code, 'egress_host_blocked', `实际：${code}`);
});

test('私网地址默认禁止', async () => {
  const platform = platforms.create({
    slug: 'private-demo',
    name: 'Private',
    baseUrl: baseUrl(),
    authKind: 'none',
    authConfig: {},
    defaultHeaders: {},
    egressAllowHosts: ['127.0.0.1'],
    rateLimit: { qps: 10, daily: 1000 },
    allowPrivate: false,
    notes: '',
  });
  const ep = simpleEndpoint(platform.id, 'private_ep', '/api/v1/orders');
  publishAndCompile(ep.id);
  const tool = tools.byEndpoint(ep.id)!;
  const result = await invokeTool(tool.name, {}, 'rest');
  assert.equal(result.ok, false);
  assert.equal((result.data as { error: { code: string } }).error.code, 'egress_private_blocked');
});

test('上游 5xx 归一化', async () => {
  const platform = platforms.bySlug('mock')!;
  const ep = simpleEndpoint(platform.id, 'boom', '/api/v1/boom');
  publishAndCompile(ep.id);
  const tool = tools.byEndpoint(ep.id)!;
  const result = await invokeTool(tool.name, {}, 'rest');
  assert.equal(result.ok, false);
  assert.equal((result.data as { error: { code: string } }).error.code, 'upstream_error');
});

test('上游 3xx 跳转被阻断', async () => {
  const platform = platforms.bySlug('mock')!;
  const ep = simpleEndpoint(platform.id, 'redirect', '/api/v1/redirect');
  publishAndCompile(ep.id);
  const tool = tools.byEndpoint(ep.id)!;
  const result = await invokeTool(tool.name, {}, 'rest');
  assert.equal(result.ok, false);
  assert.equal((result.data as { error: { code: string } }).error.code, 'upstream_redirect');
});

test('一键整理：curl → 候选 → 自动发布 → 可调用', async () => {
  const curl = `curl '${baseUrl()}/api/v1/orders?limit=2'`;
  const job = await runImport({
    text: curl,
    kind: 'curl',
    platformSlug: 'fromcurl',
    useAi: false,
    autoPublish: true,
  });
  assert.equal(job.stats.parsed, 1);
  assert.equal(job.stats.candidates, 1);
  const ep = endpoints.list({ platformId: platforms.bySlug('fromcurl')!.id })[0]!;
  const tool = tools.byEndpoint(ep.id)!;
  const result = await invokeTool(tool.name, { limit: 1 }, 'rest');
  assert.equal(result.ok, true, JSON.stringify(result.data));
});

/* ────────────── 开放策略 ────────────── */

test('exposure=closed 对外不可调用，但控制台可试运行', async () => {
  const platform = makePlatform('closeddemo');
  const ep = simpleEndpoint(platform.id, 'closed_ep', '/api/v1/orders', { exposure: 'closed' });
  publishAndCompile(ep.id);
  const tool = tools.byEndpoint(ep.id)!;

  const outside = await invokeTool(tool.name, {}, 'rest');
  assert.equal(outside.ok, false);
  assert.equal((outside.data as { error: { code: string } }).error.code, 'endpoint_closed');

  const consoleRun = await testEndpoint(ep.id, {});
  assert.equal(consoleRun.ok, true, '控制台试运行应放行');
});

test('exposure=restricted 只放行指定令牌', async () => {
  const platform = makePlatform('restricteddemo');
  const ep = simpleEndpoint(platform.id, 'restricted_ep', '/api/v1/orders', {
    exposure: 'restricted',
    allowedKeyIds: ['ak_allowed'],
  });
  publishAndCompile(ep.id);
  const tool = tools.byEndpoint(ep.id)!;

  const denied = await invokeTool(tool.name, {}, 'rest', 'ak_other');
  assert.equal(denied.ok, false);
  assert.equal((denied.data as { error: { code: string } }).error.code, 'endpoint_restricted');

  const noKey = await invokeTool(tool.name, {}, 'rest', null);
  assert.equal(noKey.ok, false);
  assert.equal((noKey.data as { error: { code: string } }).error.code, 'endpoint_restricted');

  const allowed = await invokeTool(tool.name, {}, 'rest', 'ak_allowed');
  assert.equal(allowed.ok, true, JSON.stringify(allowed.data));
});

test('令牌 scopes 收窄生效', async () => {
  const platform = platforms.bySlug('mock')!;
  let ep = endpoints.bySlug(platform.id, 'get_orders');
  if (!ep) {
    const created = simpleEndpoint(platform.id, 'get_orders', '/api/v1/orders');
    publishAndCompile(created.id);
    ep = endpoints.bySlug(platform.id, 'get_orders')!;
  }
  const tool = tools.byEndpoint(ep.id)!;

  const denied = await invokeTool(tool.name, {}, 'rest', 'ak_x', { platforms: ['other'] });
  assert.equal(denied.ok, false);
  assert.equal((denied.data as { error: { code: string } }).error.code, 'scope_forbidden');

  const ok = await invokeTool(tool.name, {}, 'rest', 'ak_x', { platforms: ['mock'] });
  assert.equal(ok.ok, true, JSON.stringify(ok.data));
});
