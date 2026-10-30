// 测试用假上游/桩模型在本机回环：显式打开私网出网（生产默认关闭）
process.env.ALLOW_PRIVATE_EGRESS = 'true';
process.env.LLM_ALLOW_PRIVATE = 'true';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { LlmConfig } from '../src/config.ts';
import type { NormalizedDraft } from '../src/import/types.ts';
import { parseCurl } from '../src/import/curl.ts';
import { specToDraft } from '../src/import/normalize.ts';
import { analyzeDrafts } from '../src/agents/analyze.ts';
import { nameDrafts } from '../src/agents/naming.ts';

/**
 * 这组测试专门覆盖「真实模型返回的脏数据」。
 *
 * 背景：接真实 LLM 时，模型经常少给字段、类型写错、结构不符，
 * 早期严格 schema 会让**整批**接口作废（实测 aiEnriched: 0）。
 */

let llm: Server;
let llmPort = 0;
let mode = 'partial';

before(async () => {
  llm = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as {
        messages?: Array<{ role: string; content: string }>;
      };
      const system = parsed.messages?.[0]?.content ?? '';
      const payload = JSON.parse(parsed.messages?.[1]?.content ?? '{}') as {
        items?: Array<{ i: number }>;
      };
      const items = payload.items ?? [];

      let content: string;
      if (system.includes('语义分析专家')) {
        if (mode === 'partial') {
          // 真实模型常见毛病：keyFields 缺 meaning、cautions 是字符串、sensitivity 是中文
          content = JSON.stringify({
            items: items.map((it) => ({
              i: it.i,
              notes: '返回订单数据',
              keyFields: [{ name: 'orderId' }], // 缺 meaning
              cautions: '会消耗配额', // 字符串而非数组
              sensitivity: '中等', // 中文而非 medium
              publicName: 'list_orders',
            })),
          });
        } else if (mode === 'missing-i') {
          // 完全缺 i 字段
          content = JSON.stringify({ items: [{ notes: '无序号' }] });
        } else if (mode === 'wrong-shape') {
          // 顶层结构不对
          content = JSON.stringify({ result: [{ i: 0, notes: '放错层了' }] });
        } else if (mode === 'mixed') {
          // 一半好一半坏
          content = JSON.stringify({
            items: [
              { i: 0, notes: '正常的一条', publicName: 'good_one' },
              { notes: '缺 i 的坏条' },
              { i: 1, notes: '另一条正常的', publicName: 'good_two' },
            ],
          });
        } else {
          content = JSON.stringify({ items: [] });
        }
      } else if (system.includes('对外命名专家')) {
        if (mode === 'partial') {
          content = JSON.stringify({
            items: items.map((it) => ({
              i: it.i,
              publicName: 'list_orders',
              paramDescriptions: { page: 123 }, // 数字而非字符串
              paramTypes: { page: 'integer' },
              paramRequired: 'page', // 字符串而非数组
            })),
          });
        } else {
          content = JSON.stringify({ items: [] });
        }
      } else {
        content = JSON.stringify({ items: [] });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  const addr = llm.address();
  llmPort = typeof addr === 'object' && addr ? addr.port : 0;
});

after(async () => {
  await new Promise<void>((r) => llm.close(() => r()));
});

function cfg(): LlmConfig {
  return {
    enabled: true,
    baseUrl: `http://127.0.0.1:${llmPort}/v1`,
    apiKey: 'stub',
    model: 'stub',
    timeoutMs: 5000,
    concurrency: 1,
  };
}

function drafts(n: number): NormalizedDraft[] {
  return Array.from({ length: n }, (_, i) => {
    const specs = parseCurl(`curl 'http://127.0.0.1:1/api/v1/orders${i}'`);
    const d = specToDraft(specs[0]!, { platformSlug: 'demo', platformName: 'Demo' });
    assert.ok(d, 'curl 应能解析出草稿');
    d.endpoint.params = [];
    return d;
  });
}

test('脏数据：缺 meaning / cautions 是字符串 / sensitivity 是中文 —— 仍能分析', async () => {
  mode = 'partial';
  const ds = drafts(3);
  const stats = await analyzeDrafts(cfg(), ds, []);

  assert.equal(stats.analyzed, 3, '三条都应被分析，不能整批作废');
  assert.equal(stats.skipped, 0);
  // 缺 meaning 时只写字段名
  assert.match(ds[0]!.endpoint.notes, /关键字段：orderId/);
  // cautions 字符串被包成数组
  assert.match(ds[0]!.endpoint.notes, /注意：会消耗配额/);
  // 中文敏感度被映射
  assert.equal(ds[0]!.endpoint.sensitivity, 'medium');
  assert.equal(ds[0]!.endpoint.publicName, 'list_orders');
});

test('脏数据：命名结果参数说明是数字、必填是字符串 —— 仍能命名', async () => {
  mode = 'partial';
  const ds = drafts(2);
  ds[0]!.endpoint.params = [
    { name: 'page', in: 'query', type: 'string', required: false, description: '' },
  ];
  const stats = await nameDrafts(cfg(), ds);

  assert.equal(stats.named, 2, '两条都应命名');
  // 数字被转成字符串
  assert.equal(ds[0]!.endpoint.params[0]!.description, '123');
  assert.equal(ds[0]!.endpoint.params[0]!.type, 'integer');
});

test('脏数据：一半好一半坏 —— 好的那些照常生效', async () => {
  mode = 'mixed';
  const ds = drafts(2);
  const stats = await analyzeDrafts(cfg(), ds, []);

  assert.equal(stats.analyzed, 2, '两条有效记录都要生效');
  assert.equal(ds[0]!.endpoint.publicName, 'good_one');
  assert.equal(ds[1]!.endpoint.publicName, 'good_two');
  assert.ok(
    stats.errors.some((e) => e.includes('无法解析')),
    '坏的那条应被记入错误，而不是静默丢弃',
  );
});

test('脏数据：全部缺 i —— 报错但不崩，草稿保持原样', async () => {
  mode = 'missing-i';
  const ds = drafts(2);
  const before = ds[0]!.endpoint.summary;
  const stats = await analyzeDrafts(cfg(), ds, []);

  assert.equal(stats.analyzed, 0);
  assert.equal(ds[0]!.endpoint.summary, before, '解析失败不应污染草稿');
  assert.ok(stats.errors.length > 0);
});

test('脏数据：顶层结构不对 —— 错误信息里带出实际字段，便于排查', async () => {
  mode = 'wrong-shape';
  const ds = drafts(2);
  const stats = await analyzeDrafts(cfg(), ds, []);

  assert.equal(stats.analyzed, 0);
  const joined = stats.errors.join(' ');
  assert.match(joined, /result/, '应报出模型实际返回的顶层字段');
});

test('脏数据：模型返回空 items —— 有明确错误信息', async () => {
  mode = 'empty';
  const ds = drafts(2);
  const stats = await analyzeDrafts(cfg(), ds, []);

  assert.equal(stats.analyzed, 0);
  assert.ok(stats.errors.length > 0, '应说明模型没返回 items');
});

/* ────────── LLM 未启用时必须说清楚原因 ────────── */

test('LLM 未启用：分析 Agent 给出明确原因，不是静默跳过', async () => {
  const off: LlmConfig = { ...cfg(), enabled: false };
  const ds = drafts(2);
  const stats = await analyzeDrafts(off, ds, []);

  assert.equal(stats.analyzed, 0);
  assert.equal(stats.skipped, 2);
  assert.equal(stats.errors.length, 1, '应有一条说明');
  assert.match(stats.errors[0]!, /LLM 未启用/);
  assert.match(stats.errors[0]!, /备注和接口介绍不会生成/);
});

test('LLM 未启用：没有 apiKey 也算未启用', async () => {
  const noKey: LlmConfig = { ...cfg(), apiKey: '' };
  const ds = drafts(1);
  const stats = await analyzeDrafts(noKey, ds, []);

  assert.equal(stats.analyzed, 0);
  assert.match(stats.errors[0] ?? '', /LLM 未启用/);
});

test('LLM 未启用：命名 Agent 也给出明确原因', async () => {
  const off: LlmConfig = { ...cfg(), enabled: false };
  const ds = drafts(2);
  const stats = await nameDrafts(off, ds);

  assert.equal(stats.named, 0);
  assert.equal(stats.errors.length, 1);
  assert.match(stats.errors[0]!, /LLM 未启用/);
});

test('LLM 未启用：草稿的备注仍有规则兜底，不是空串', async () => {
  const off: LlmConfig = { ...cfg(), enabled: false };
  const ds = drafts(2);
  await analyzeDrafts(off, ds, []);

  for (const d of ds) {
    assert.ok(d.endpoint.notes.trim().length > 0, '备注不能为空');
    assert.match(d.endpoint.notes, /未经 AI 分析/);
  }
});
