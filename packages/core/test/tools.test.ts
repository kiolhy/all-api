import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTool, toolName } from '../src/tools/compile.ts';
import type { EndpointRecord } from '../src/schema/asset.ts';

function ep(over: Partial<EndpointRecord> = {}): EndpointRecord {
  return {
    id: 'ep_1',
    platformId: 'pf_1',
    platformSlug: 'demo',
    slug: 'get_user',
    group: 'user',
    method: 'GET',
    pathTemplate: '/v1/users/{userId}',
    summary: '获取用户',
    description: '按 id 查用户',
    params: [
      { name: 'userId', in: 'path', type: 'string', required: true, description: '用户 id' },
      {
        name: 'Authorization',
        in: 'header',
        type: 'string',
        required: true,
        description: '鉴权头，由密钥库自动注入',
        default: 'Bearer ${secret:demo_auth}',
        secretRef: 'demo_auth',
      },
      { name: 'verbose', in: 'query', type: 'boolean', required: false, description: '' },
    ],
    body: null,
    response: {
      contentType: 'application/json',
      pick: [],
      unwrap: null,
      transform: null,
      redactFields: [],
      maxBytes: 1024,
    },
    sideEffect: 'read',
    sensitivity: 'low',
    tags: [],
    examples: [],
    notes: '',
    exposure: 'open',
    allowedKeyIds: [],
    publicName: '',
    status: 'published',
    version: 1,
    contentHash: 'x',
    sourceKind: 'manual',
    sourceRef: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('工具名保留 platform__endpoint 双下划线', () => {
  assert.equal(toolName('demo', 'get_user'), 'demo__get_user');
  assert.equal(toolName('api-demo', 'get-user'), 'api_demo__get_user');
  assert.equal(toolName('demo', 'get_user').includes('__'), true);
});

test('工具名超长时仍保留分隔符', () => {
  const long = toolName('a'.repeat(40), 'b'.repeat(40));
  assert.ok(long.length <= 64);
  assert.ok(long.includes('__'));
});

test('密钥参数不进入 AI 入参 schema', () => {
  const t = compileTool(ep());
  const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.ok('userId' in props);
  assert.ok('verbose' in props);
  assert.equal('Authorization' in props, false);
  assert.equal('header_Authorization' in props, false);
  assert.deepEqual((t.inputSchema as { required: string[] }).required, ['userId']);
  assert.equal(t.annotations.readOnly, true);
  assert.equal(t.annotations.destructive, false);
});

test('写接口标注为 destructive/非只读', () => {
  const t = compileTool(ep({ method: 'DELETE', sideEffect: 'write', slug: 'del_user' }));
  assert.equal(t.annotations.readOnly, false);
  assert.equal(t.annotations.destructive, true);
  assert.equal(t.cacheTtl, 0);
});

test('描述里说明鉴权自动注入', () => {
  const t = compileTool(ep());
  assert.match(t.description, /鉴权由网关自动注入/);
});
