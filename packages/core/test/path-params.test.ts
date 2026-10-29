import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPathTemplate, fallbackNotes } from '../src/import/normalize.ts';
import { parseCurl } from '../src/import/curl.ts';
import { specToDraft } from '../src/import/normalize.ts';

/**
 * 路径参数占位符识别。
 *
 * 真 bug：`new URL()` 把 `{id}` 编码成 `%7Bid%7D`，早期版本没还原，
 * 结果 `/orders/{id}` 被当成字面量路径 —— 备注写成「查询 %7Bid%7D 列表」，
 * 工具名里还带一串 `7_bid_7_d`。
 */

test('buildPathTemplate：还原 %7B%7D 编码的占位符', () => {
  const r = buildPathTemplate('/api/v1/orders/%7Bid%7D');
  assert.equal(r.template, '/api/v1/orders/{id}');
  assert.equal(r.pathParams.length, 1);
  assert.equal(r.pathParams[0]!.name, 'id');
});

test('buildPathTemplate：{id} 占位符不给样例值', () => {
  const r = buildPathTemplate('/orders/{id}');
  assert.equal(r.template, '/orders/{id}');
  assert.equal(r.pathParams[0]!.example, '', '占位符不是真实值，不能拿去探测');
});

test('buildPathTemplate：{order_id} 保留原名', () => {
  const r = buildPathTemplate('/orders/{order_id}');
  assert.equal(r.template, '/orders/{order_id}');
  assert.equal(r.pathParams[0]!.name, 'order_id');
});

test('buildPathTemplate：:id 写法也认', () => {
  const r = buildPathTemplate('/orders/:id');
  assert.equal(r.template, '/orders/{id}');
});

test('buildPathTemplate：真实 ID 仍然推断出名字和样例', () => {
  const r = buildPathTemplate('/orders/12345');
  assert.equal(r.template, '/orders/{orderId}');
  assert.equal(r.pathParams[0]!.example, '12345');
});

test('buildPathTemplate：UUID 照旧', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const r = buildPathTemplate(`/orders/${uuid}`);
  assert.equal(r.template, '/orders/{orderId}');
  assert.equal(r.pathParams[0]!.example, uuid);
});

test('buildPathTemplate：占位符重名自动加序号', () => {
  const r = buildPathTemplate('/a/{id}/b/{id}');
  assert.equal(r.template, '/a/{id}/b/{id2}');
  assert.deepEqual(r.pathParams.map((p) => p.name), ['id', 'id2']);
});

/* ────────── 端到端：curl 里带 {id} ────────── */

test('curl 带 {id}：模板正确、备注可读', () => {
  const specs = parseCurl(`curl 'http://127.0.0.1:8899/api/v1/orders/{id}'`);
  assert.equal(specs.length, 1);
  const d = specToDraft(specs[0]!, { platformSlug: 'demo', platformName: 'Demo' });
  assert.ok(d);
  assert.equal(d.endpoint.pathTemplate, '/api/v1/orders/{id}', '模板不能残留 %7B');
  assert.match(d.endpoint.notes, /按 ID 查询 orders 详情/, d.endpoint.notes.split('\n')[0]);
  const pathParam = d.endpoint.params.find((p) => p.in === 'path');
  assert.equal(pathParam?.name, 'id');
});

test('curl 带 {id}：工具名不含编码垃圾', () => {
  const specs = parseCurl(`curl 'http://127.0.0.1:8899/api/v1/orders/{id}'`);
  const d = specToDraft(specs[0]!, { platformSlug: 'demo', platformName: 'Demo' });
  assert.ok(d);
  assert.doesNotMatch(d.endpoint.slug, /7_bid_7|7Bid7D/i, d.endpoint.slug);
});

test('curl 普通列表：备注是「查询 X 列表」', () => {
  const specs = parseCurl(`curl 'http://127.0.0.1:8899/api/v1/orders?page=1'`);
  const d = specToDraft(specs[0]!, { platformSlug: 'demo', platformName: 'Demo' });
  assert.ok(d);
  assert.match(d.endpoint.notes, /查询 orders 列表/);
});

test('fallbackNotes 与模板一致', () => {
  const r = buildPathTemplate('/api/v1/orders/%7Bid%7D');
  assert.match(fallbackNotes('GET', r.template), /按 ID 查询 orders 详情/);
});
