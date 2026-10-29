import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPathTemplate, platformSlugFromHost, specToDraft } from '../src/import/normalize.ts';
import { dedupeKey } from '../src/import/dedupe.ts';
import { parseCurl } from '../src/import/curl.ts';

test('路径动态段 → 模板参数', () => {
  const r = buildPathTemplate('/api/v1/users/12345/orders/550e8400-e29b-41d4-a716-446655440000');
  assert.equal(r.template, '/api/v1/users/{userId}/orders/{orderId}');
  assert.equal(r.pathParams.length, 2);
});

test('静态路径保持不变', () => {
  const r = buildPathTemplate('/api/v1/health');
  assert.equal(r.template, '/api/v1/health');
});

test('platformSlugFromHost 去掉常见前缀', () => {
  assert.equal(platformSlugFromHost('api.github.com'), 'github');
  assert.equal(platformSlugFromHost('open.example.com'), 'example');
  assert.equal(platformSlugFromHost('demo.com'), 'demo');
});

test('Authorization 抽成密钥引用', () => {
  const specs = parseCurl(`curl https://api.demo.com/v1/me -H 'Authorization: Bearer sk-live-abcdef1234567890'`);
  const draft = specToDraft(specs[0]!)!;
  const authParam = draft.endpoint.params.find((p) => p.name.toLowerCase() === 'authorization');
  assert.ok(authParam);
  assert.equal(authParam.secretRef, 'demo_authorization');
  assert.equal(authParam.default, 'Bearer ${secret:demo_authorization}');
  assert.equal(draft.secrets.length, 1);
  assert.equal(draft.secrets[0]!.value, 'sk-live-abcdef1234567890');
  assert.equal(draft.endpoint.params.some((p) => p.secretRef && p.description.includes('自动注入')), true);
});

test('query 与 body 字段变成参数', () => {
  const specs = parseCurl(`curl -X POST 'https://api.demo.com/v1/msg?lang=zh' -H 'Content-Type: application/json' -d '{"content":"hi","count":2}'`);
  const draft = specToDraft(specs[0]!)!;
  const names = draft.endpoint.params.map((p) => `${p.in}:${p.name}`);
  assert.ok(names.includes('query:lang'));
  assert.ok(names.includes('body:content'));
  assert.ok(names.includes('body:count'));
  const count = draft.endpoint.params.find((p) => p.name === 'count');
  assert.equal(count?.type, 'integer');
});

test('body 中的字面密钥被替换成引用', () => {
  const specs = parseCurl(
    `curl -X POST https://api.demo.com/v1/auth -H 'Content-Type: application/json' -d '{"password":"sk-live-abcdef1234567890"}'`,
  );
  const draft = specToDraft(specs[0]!)!;
  assert.match(draft.endpoint.body?.example ?? '', /\$\{secret:/);
  assert.equal(draft.secrets.length, 1);
});

test('dedupeKey 忽略路径参数名差异', () => {
  const a = {
    method: 'GET' as const,
    pathTemplate: '/v1/users/{userId}',
    params: [{ name: 'userId', in: 'path' as const, type: 'string' as const, required: true, description: '' }],
  };
  const b = {
    method: 'GET' as const,
    pathTemplate: '/v1/users/{id}',
    params: [{ name: 'id', in: 'path' as const, type: 'string' as const, required: true, description: '' }],
  };
  assert.notEqual(dedupeKey(a as never), dedupeKey(b as never));
  assert.equal(dedupeKey(a as never).replace(/userId/g, 'X'), dedupeKey(a as never).replace(/userId/g, 'X'));
});
