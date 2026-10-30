import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackNotes } from '../src/import/normalize.ts';

/**
 * 规则兜底备注。
 *
 * 背景：以前 notes 默认是空串，LLM 没开时用户整理完什么都看不到。
 * 现在至少给一句可读说明，并明确标注「未经 AI 分析」。
 */

test('GET 列表：查询 X 列表', () => {
  const n = fallbackNotes('GET', '/api/v1/orders');
  assert.match(n, /查询 orders 列表/);
});

test('备注里不再带上游路径', () => {
  // notes 会经 /gw/v1/me 递给调用方，带路径等于把上游结构送出去
  const n = fallbackNotes('GET', '/api/v1/orders');
  assert.doesNotMatch(n, /\/api\//);
  assert.doesNotMatch(n, /\/v1\//);
  assert.doesNotMatch(n, /GET\s+\//);
});

test('GET 末尾是参数：按 ID 查详情', () => {
  assert.match(fallbackNotes('GET', '/api/v1/orders/{id}'), /按 ID 查询 orders 详情/);
  assert.match(fallbackNotes('GET', '/api/v1/users/:userId'), /按 ID 查询 users 详情/);
});

test('中间有参数但末尾是资源：仍然算列表', () => {
  const n = fallbackNotes('GET', '/api/v1/users/{id}/orders');
  assert.match(n, /查询 orders 列表/);
  assert.doesNotMatch(n, /详情/);
});

test('写操作动词正确', () => {
  assert.match(fallbackNotes('POST', '/api/v1/orders'), /创建 orders/);
  assert.match(fallbackNotes('PUT', '/api/v1/orders/{id}'), /更新 orders/);
  assert.match(fallbackNotes('PATCH', '/api/v1/orders/{id}'), /更新 orders/);
  assert.match(fallbackNotes('DELETE', '/api/v1/orders/{id}'), /删除 orders/);
});

test('方法大小写不敏感', () => {
  assert.match(fallbackNotes('get', '/api/orders'), /查询 orders 列表/);
  assert.match(fallbackNotes('post', '/api/orders'), /创建 orders/);
});

test('版本号段不会被当成资源名', () => {
  const n = fallbackNotes('GET', '/api/v2/orders');
  assert.match(n, /查询 orders 列表/);
  assert.doesNotMatch(n, /查询 v2/);
});

test('总是带「未经 AI 分析」标注', () => {
  for (const [m, p] of [
    ['GET', '/api/v1/orders'],
    ['POST', '/api/v1/orders'],
    ['GET', '/'],
    ['GET', ''],
  ] as const) {
    assert.match(fallbackNotes(m, p), /未经 AI 分析/, `${m} ${p}`);
  }
});

test('空路径/根路径不抛异常', () => {
  assert.doesNotThrow(() => fallbackNotes('GET', '/'));
  assert.doesNotThrow(() => fallbackNotes('GET', ''));
  assert.match(fallbackNotes('GET', '/'), /查询接口/);
});

test('只有参数没有资源段时也能给说明', () => {
  const n = fallbackNotes('GET', '/{id}');
  assert.ok(n.length > 0);
  assert.match(n, /未经 AI 分析/);
});

test('两行结构：第一行说明，第二行标注', () => {
  const lines = fallbackNotes('GET', '/api/v1/orders').split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /查询 orders 列表/);
  assert.match(lines[1]!, /规则生成/);
});
