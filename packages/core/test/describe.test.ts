import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coerceExample,
  looksLikeUpstreamPath,
  paramHint,
  sanitizePublicText,
  semanticLabel,
  stripPathParenthetical,
} from '../src/tools/describe.ts';
import { compileTool } from '../src/tools/compile.ts';

const param = (over: Record<string, unknown> = {}) =>
  ({
    name: 'page',
    in: 'query',
    type: 'number',
    required: false,
    description: '',
    ...over,
  }) as never;

const endpoint = (over: Record<string, unknown> = {}) =>
  ({
    id: 'ep_test',
    platformId: 'pf_test',
    platformSlug: 'demo',
    slug: 'get_api_v1_orders',
    method: 'GET',
    pathTemplate: '/api/v1/orders',
    group: 'default',
    summary: '',
    description: '',
    notes: '',
    params: [],
    body: null,
    sideEffect: 'read',
    sensitivity: 'low',
    tags: [],
    examples: [],
    exposure: 'open',
    allowedKeyIds: [],
    publicName: '',
    ...over,
  }) as never;

/* ────────────────────────── 路径识别 ────────────────────────── */

test('认得上游路径的各种写法', () => {
  for (const s of [
    'GET /api/v1/orders',
    'POST /api/v1/echo',
    '/api/v1/orders',
    '/v1/users',
    'https://api.github.com/users',
    '/users/{id}',
  ]) {
    assert.equal(looksLikeUpstreamPath(s), true, s);
  }
});

test('正常中文说明不会被误判', () => {
  for (const s of ['查询订单列表', '按 ID 查询 users 详情', '', '订单 / 退款相关接口']) {
    assert.equal(looksLikeUpstreamPath(s), false, s);
  }
});

/* ────────────────────────── 文案清洗 ────────────────────────── */

test('标题是上游路径时换成语义说法', () => {
  assert.equal(sanitizePublicText('GET /api/v1/orders', '查询 orders 列表'), '查询 orders 列表');
});

test('正常标题原样保留', () => {
  assert.equal(sanitizePublicText('查询订单列表', '查询 orders 列表'), '查询订单列表');
});

test('空标题走兜底', () => {
  assert.equal(sanitizePublicText('', '查询 orders 列表'), '查询 orders 列表');
  assert.equal(sanitizePublicText(null, '查询 orders 列表'), '查询 orders 列表');
});

test('semanticLabel 不带路径', () => {
  assert.equal(semanticLabel('GET', '/api/v1/orders'), '查询 orders 列表');
  assert.equal(semanticLabel('GET', '/api/v1/orders/{id}'), '按 ID 查询 orders 详情');
  assert.equal(semanticLabel('POST', '/api/v1/orders'), '创建 orders');
  assert.equal(semanticLabel('DELETE', '/api/v1/orders/{id}'), '删除 orders');
  assert.equal(semanticLabel('GET', '/'), '查询接口');
});

test('stripPathParenthetical 抠掉括号里的方法+路径', () => {
  assert.equal(stripPathParenthetical('查询 orders 列表（GET /api/v1/orders）'), '查询 orders 列表');
  assert.equal(stripPathParenthetical('查询 orders 列表 (GET /api/v1/orders)'), '查询 orders 列表');
  assert.equal(stripPathParenthetical('没有括号补丁'), '没有括号补丁');
  assert.equal(stripPathParenthetical(''), '');
});

/* ────────────────────────── 参数说明 ────────────────────────── */

test('常见参数名给出可读说明', () => {
  assert.match(paramHint(param({ name: 'page' })), /页码/);
  assert.match(paramHint(param({ name: 'limit' })), /每页/);
  assert.match(paramHint(param({ name: 'per_page' })), /每页/);
  assert.match(paramHint(param({ name: 'offset' })), /跳过/);
  assert.match(paramHint(param({ name: 'keyword' })), /搜索/);
  assert.match(paramHint(param({ name: 'userId' })), /标识/);
  assert.match(paramHint(param({ name: 'order_id' })), /标识/);
  assert.match(paramHint(param({ name: 'sort_by' })), /排序/);
});

test('枚举参数把可选值列出来', () => {
  const hint = paramHint(param({ name: 'status', type: 'enum', enum: ['open', 'closed'] }));
  assert.match(hint, /状态/);
  assert.match(hint, /open/);
  assert.match(hint, /closed/);
});

test('不认识的参数名按位置兜底，不留空', () => {
  const hint = paramHint(param({ name: 'xyzzy', in: 'body' }));
  assert.equal(hint, '请求体字段');
  assert.ok(hint.length > 0);
});

/* ────────────────────────── 示例值类型纠正 ────────────────────────── */

test('number 参数的字符串示例被转成数字', () => {
  assert.equal(coerceExample('1', 'number'), 1);
  assert.equal(coerceExample('2.5', 'integer'), 2.5);
  assert.equal(coerceExample('abc', 'number'), undefined);
});

test('boolean 示例按字面转', () => {
  assert.equal(coerceExample('true', 'boolean'), true);
  assert.equal(coerceExample('false', 'boolean'), false);
  assert.equal(coerceExample('yes', 'boolean'), undefined);
});

/* ────────────────────────── 编译结果 ────────────────────────── */

test('编译后 title / description 不含上游路径', () => {
  const tool = compileTool(
    endpoint({
      summary: 'GET /api/v1/orders',
      description: '',
      params: [param({ name: 'page', example: '1' })],
    }),
  );

  assert.equal(tool.title, '查询 orders 列表');
  assert.doesNotMatch(tool.description, /\/api\//);
  assert.doesNotMatch(tool.description, /GET\s+\//);
});

test('参数没说明时编译出兜底说明', () => {
  const tool = compileTool(
    endpoint({
      params: [param({ name: 'page' }), param({ name: 'limit' })],
    }),
  );
  const props = (tool.inputSchema as { properties: Record<string, { description?: string }> }).properties;
  assert.match(props.page.description ?? '', /页码/);
  assert.match(props.limit.description ?? '', /每页/);
});

test('AI 给了说明就以 AI 为准', () => {
  const tool = compileTool(
    endpoint({ params: [param({ name: 'page', description: '第几页，从 1 开始，默认 1' })] }),
  );
  const props = (tool.inputSchema as { properties: Record<string, { description?: string }> }).properties;
  assert.equal(props.page.description, '第几页，从 1 开始，默认 1');
});

test('示例值进 schema 时类型正确', () => {
  const tool = compileTool(endpoint({ params: [param({ name: 'page', example: '1' })] }));
  const props = (tool.inputSchema as { properties: Record<string, { examples?: unknown[] }> }).properties;
  assert.deepEqual(props.page.examples, [1]);
});

test('描述里带参数清单，MCP 不渲染 schema 也能看懂', () => {
  const tool = compileTool(endpoint({ params: [param({ name: 'page', required: true })] }));
  assert.match(tool.description, /参数：/);
  assert.match(tool.description, /page（query，必填）/);
});
