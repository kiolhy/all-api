import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { LlmConfig } from '../src/config.ts';
import { parseCurl } from '../src/import/curl.ts';
import { specToDraft } from '../src/import/normalize.ts';
import { enrichDrafts } from '../src/import/enrich.ts';

/** 本地 stub LLM：模拟 OpenAI 兼容 /chat/completions */
let server: Server;
let port = 0;
let mode: 'good' | 'broken' = 'good';
let lastRequest: { messages?: Array<{ role: string; content: string }> } = {};

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastRequest = JSON.parse(body || '{}');
      const payload = JSON.parse(lastRequest.messages?.[1]?.content ?? '{}');
      const items = (payload.items ?? []).map((it: { i: number }) => ({
        i: it.i,
        slug: `get_user_profile_${it.i}`,
        summary: '查询用户资料',
        description: '按用户 id 查询资料，只读。',
        group: 'user',
        tags: ['用户', '查询'],
        sideEffect: 'read',
        sensitivity: 'medium',
        paramDescriptions: { userId: '用户唯一标识' },
        paramTypes: { userId: 'string' },
        paramRequired: ['userId'],
      }));
      const content =
        mode === 'good'
          ? JSON.stringify({ items })
          : '这不是 JSON';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function cfg(): LlmConfig {
  return {
    enabled: true,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'stub-key',
    model: 'stub',
    timeoutMs: 5000,
    concurrency: 1,
  };
}

test('AI 增强补全 slug / 描述 / 参数说明', async () => {
  mode = 'good';
  const specs = parseCurl(`curl 'https://api.demo.com/v1/users/42'`);
  const drafts = [specToDraft(specs[0]!)!];
  const before = drafts[0]!.endpoint.slug;
  const stats = await enrichDrafts(cfg(), drafts);

  assert.equal(stats.aiUsed, true);
  assert.equal(stats.enriched, 1);
  const ep = drafts[0]!.endpoint;
  assert.equal(ep.slug, 'get_user_profile_0');
  assert.notEqual(ep.slug, before);
  assert.equal(ep.summary, '查询用户资料');
  assert.equal(ep.group, 'user');
  assert.ok(ep.tags.includes('用户') && ep.tags.includes('查询'), `实际 tags: ${ep.tags.join(',')}`);
  const userId = ep.params.find((p) => p.name === 'userId');
  assert.equal(userId?.description, '用户唯一标识');
  assert.equal(userId?.required, true);

  // 请求体应是「系统提示 + 用户 JSON」，且只包含必要字段
  assert.equal(lastRequest.messages?.[0]?.role, 'system');
});

test('模型返回非 JSON 时降级，不抛错', async () => {
  mode = 'broken';
  const specs = parseCurl(`curl 'https://api.demo.com/v1/orders?limit=1'`);
  const drafts = [specToDraft(specs[0]!)!];
  const original = drafts[0]!.endpoint.summary;
  const stats = await enrichDrafts(cfg(), drafts);
  assert.equal(stats.aiUsed, false);
  assert.equal(stats.skipped, 1);
  assert.ok(stats.errors.length >= 1);
  // 规则解析结果保留
  assert.equal(drafts[0]!.endpoint.summary, original);
});

test('LLM 未启用时直接跳过', async () => {
  const specs = parseCurl(`curl 'https://api.demo.com/v1/ping'`);
  const drafts = [specToDraft(specs[0]!)!];
  const stats = await enrichDrafts({ ...cfg(), enabled: false }, drafts);
  assert.equal(stats.aiUsed, false);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.errors.length, 0);
});
