import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeOpenapi, parseOpenapi } from '../src/import/openapi.ts';
import { looksLikeHar, parseHar } from '../src/import/har.ts';

const spec = {
  openapi: '3.0.0',
  info: { title: 'Demo API' },
  servers: [{ url: 'https://api.demo.com/v1' }],
  paths: {
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        summary: '获取用户',
        tags: ['user'],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'fields', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/orders': {
      post: {
        operationId: 'createOrder',
        summary: '创建订单',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { sku: { type: 'string' } } } } },
        },
        responses: { '201': {} },
      },
    },
  },
};

test('识别并解析 OpenAPI', () => {
  const text = JSON.stringify(spec);
  assert.equal(looksLikeOpenapi(text), true);
  const drafts = parseOpenapi(text);
  assert.equal(drafts.length, 2);

  const getUser = drafts.find((d) => d.endpoint.slug === 'get_user')!;
  assert.ok(getUser);
  assert.equal(getUser.endpoint.method, 'GET');
  assert.equal(getUser.endpoint.pathTemplate, '/v1/users/{id}');
  assert.equal(getUser.platformBaseUrl, 'https://api.demo.com');
  assert.equal(getUser.endpoint.group, 'user');
  assert.equal(getUser.endpoint.sideEffect, 'read');
  assert.ok(getUser.endpoint.params.some((p) => p.name === 'fields' && p.in === 'query'));

  const createOrder = drafts.find((d) => d.endpoint.slug === 'create_order')!;
  assert.equal(createOrder.endpoint.method, 'POST');
  assert.equal(createOrder.endpoint.sideEffect, 'write');
  assert.ok(createOrder.endpoint.body);
});

test('YAML 形式也能解析', () => {
  const yaml = `openapi: 3.0.0
info:
  title: Yaml API
servers:
  - url: https://api.yaml-demo.com
paths:
  /ping:
    get:
      operationId: ping
      responses:
        '200': {}
`;
  assert.equal(looksLikeOpenapi(yaml), true);
  const drafts = parseOpenapi(yaml);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.endpoint.pathTemplate, '/ping');
});

test('HAR 过滤静态资源并去重', () => {
  const har = {
    log: {
      entries: [
        {
          request: {
            method: 'GET',
            url: 'https://api.demo.com/v1/list?page=1',
            headers: [{ name: 'Accept', value: 'application/json' }],
            queryString: [{ name: 'page', value: '1' }],
          },
          response: { status: 200, content: { mimeType: 'application/json' } },
          _resourceType: 'xhr',
        },
        {
          request: { method: 'GET', url: 'https://api.demo.com/static/app.js', headers: [] },
          response: { status: 200, content: { mimeType: 'application/javascript' } },
          _resourceType: 'script',
        },
        {
          request: {
            method: 'GET',
            url: 'https://api.demo.com/v1/list?page=1',
            headers: [],
            queryString: [{ name: 'page', value: '1' }],
          },
          response: { status: 200, content: { mimeType: 'application/json' } },
          _resourceType: 'fetch',
        },
      ],
    },
  };
  const text = JSON.stringify(har);
  assert.equal(looksLikeHar(text), true);
  const specs = parseHar(text);
  assert.equal(specs.length, 1);
  assert.equal(specs[0]!.url, 'https://api.demo.com/v1/list');
});
