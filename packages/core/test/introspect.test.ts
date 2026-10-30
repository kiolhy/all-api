// 测试用假上游在本机回环：显式打开私网出网开关（生产默认关闭）
process.env.ALLOW_PRIVATE_EGRESS = 'true';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const { resetDbForTests, closeDb } = await import('../src/db/client.ts');
const { endpoints, platforms, apiKeys, tools } = await import('../src/db/repos.ts');
const { compileTool } = await import('../src/tools/compile.ts');

const EMPTY_RESPONSE = {
  contentType: 'application/json',
  pick: [],
  unwrap: null,
  transform: null,
  redactFields: [],
  maxBytes: 2097152,
};

let platformId = '';

function makeEndpoint(over: {
  slug: string;
  publicName?: string;
  exposure?: 'open' | 'restricted' | 'closed';
  allowedKeyIds?: string[];
  summary?: string;
  notes?: string;
}): string {
  const ep = endpoints.create(platformId, {
    slug: over.slug,
    group: 'x',
    method: 'GET',
    pathTemplate: `/api/v1/${over.slug}`,
    summary: over.summary ?? '',
    description: '',
    params: [],
    body: null,
    response: EMPTY_RESPONSE,
    sideEffect: 'read',
    sensitivity: 'low',
    tags: [],
    examples: [],
    notes: over.notes ?? '',
    exposure: over.exposure ?? 'open',
    allowedKeyIds: over.allowedKeyIds ?? [],
    publicName: over.publicName ?? '',
  });
  // 发布并编译出工具
  endpoints.publish(ep.id, 'test');
  const record = endpoints.get(ep.id)!;
  const compiled = compileTool(record);
  tools.upsert({
    endpointId: ep.id,
    name: compiled.name,
    title: compiled.title,
    description: compiled.description,
    inputSchema: compiled.inputSchema,
    cacheTtl: compiled.cacheTtl,
    annotations: compiled.annotations,
  });
  return ep.id;
}

/** 复刻网关 visibleTo 的判定 */
function visibleEndpoints(keyId: string) {
  const eps = endpoints.list({ status: 'published' });
  return eps.filter((ep) => {
    if (ep.exposure === 'closed') return false;
    if (ep.exposure === 'restricted') return (ep.allowedKeyIds ?? []).includes(keyId);
    return true;
  });
}

before(() => {
  resetDbForTests();
  const platform = platforms.create({
    slug: 'demo',
    name: 'Demo',
    baseUrl: 'http://127.0.0.1:8899',
    authKind: 'none',
    authConfig: {},
    egressAllowHosts: [],
    defaultHeaders: {},
    rateLimit: { qps: 0, daily: 0 },
    allowPrivate: true,
    notes: '',
  });
  platformId = platform.id;
});

after(() => {
  closeDb();
});

function newKey(label: string): string {
  return apiKeys.create({
    label,
    prefix: `hub_live_${label}`,
    keyHash: `hash_${label}_${Math.random().toString(36).slice(2)}`,
    scopes: {},
    accountId: null,
  });
}

test('自省：公开接口对任何 Key 可见', () => {
  const keyId = newKey('k1');
  makeEndpoint({ slug: 'open_one', publicName: 'list_things' });
  const visible = visibleEndpoints(keyId);
  assert.ok(visible.some((e) => e.slug === 'open_one'));
});

test('自省：关闭的接口对任何 Key 都不可见', () => {
  const keyId = newKey('k2');
  makeEndpoint({ slug: 'closed_one', exposure: 'closed' });
  const visible = visibleEndpoints(keyId);
  assert.ok(!visible.some((e) => e.slug === 'closed_one'));
});

test('自省：指定令牌只对被勾选的 Key 可见', () => {
  const keyA = newKey('ka');
  const keyB = newKey('kb');
  makeEndpoint({ slug: 'restricted_one', exposure: 'restricted', allowedKeyIds: [keyA] });

  assert.ok(visibleEndpoints(keyA).some((e) => e.slug === 'restricted_one'));
  assert.ok(!visibleEndpoints(keyB).some((e) => e.slug === 'restricted_one'));
});

test('自省：返回的对外名不含上游痕迹', () => {
  const keyId = newKey('k3');
  makeEndpoint({ slug: 'get_api_v1_users_user_id', publicName: 'query_user' });
  const visible = visibleEndpoints(keyId);
  const ep = visible.find((e) => e.slug === 'get_api_v1_users_user_id');
  assert.ok(ep);
  assert.equal(ep.publicName, 'query_user');
  // 对外名里不应出现上游路径片段
  assert.ok(!ep.publicName.includes('api'));
  assert.ok(!ep.publicName.includes('get_'));
});

test('自省：备注字段能带出来', () => {
  const keyId = newKey('k4');
  makeEndpoint({
    slug: 'noted_one',
    publicName: 'noted',
    summary: '有备注的接口',
    notes: '这个接口需要先申请权限，联系人：张三',
  });
  const visible = visibleEndpoints(keyId);
  const ep = visible.find((e) => e.slug === 'noted_one');
  assert.ok(ep);
  assert.equal(ep.notes, '这个接口需要先申请权限，联系人：张三');
});

test('自省：两个 Key 看到的接口集合不同', () => {
  const keyA = newKey('setA');
  const keyB = newKey('setB');
  makeEndpoint({ slug: 'only_a', exposure: 'restricted', allowedKeyIds: [keyA] });
  makeEndpoint({ slug: 'only_b', exposure: 'restricted', allowedKeyIds: [keyB] });
  makeEndpoint({ slug: 'everyone', exposure: 'open' });

  const aSlugs = visibleEndpoints(keyA).map((e) => e.slug);
  const bSlugs = visibleEndpoints(keyB).map((e) => e.slug);

  assert.ok(aSlugs.includes('only_a'));
  assert.ok(!aSlugs.includes('only_b'));
  assert.ok(bSlugs.includes('only_b'));
  assert.ok(!bSlugs.includes('only_a'));
  assert.ok(aSlugs.includes('everyone'));
  assert.ok(bSlugs.includes('everyone'));
});

test('自省：未配对外名时用中性前缀，不带上游 host', () => {
  const keyId = newKey('k5');
  makeEndpoint({ slug: 'no_alias' });
  const tool = tools.byEndpoint(endpoints.list().find((e) => e.slug === 'no_alias')!.id);
  assert.ok(tool);
  // 平台 slug 由 host 推导（demo / x127_8899），不能进对外工具名。
  // 不知道用户起的中文名时一律用 api 前缀，名字由用户在工具页改。
  assert.equal(tool.name, 'api__no_alias');
  assert.ok(!tool.name.includes('8899'));
});
