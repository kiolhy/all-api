import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { LlmConfig } from '../src/config.ts';
import type { PlatformRecord } from '../src/schema/asset.ts';
import type { NormalizedDraft } from '../src/import/types.ts';
import { parseCurl } from '../src/import/curl.ts';
import { specToDraft } from '../src/import/normalize.ts';
import { probeSkipReason, probeDrafts } from '../src/agents/probe.ts';
import { analyzeDrafts } from '../src/agents/analyze.ts';
import { nameDrafts, sanitizeName } from '../src/agents/naming.ts';

/* ───────────── stub LLM ───────────── */

let llm: Server;
let llmPort = 0;
let lastLlmPayload: unknown = null;

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
        items?: Array<{ i: number; probe?: unknown }>;
      };
      lastLlmPayload = parsed.messages?.[1]?.content;

      let items: unknown[];
      if (system.includes('语义分析专家')) {
        // 分析 Agent：区分「有正常样本」「只有错误样本」「无样本」三种情况
        items = (payload.items ?? []).map((it: { i: number; probe?: any }) => {
          const probe = it.probe;
          const hasSample = Boolean(probe && probe.sample);
          const hasErrorSample = Boolean(probe && probe.errorSample);
          if (hasSample) {
            return {
              i: it.i,
              purpose: '查询订单列表',
              notes: '返回订单列表，含订单号、金额、支付状态。数据实时。',
              summary: '查询订单列表',
              description: '分页查询订单，返回订单号与金额。',
              returnsWhat: '订单数组',
              keyFields: [{ name: 'orderId', meaning: '订单号' }],
              cautions: ['会消耗上游配额'],
              publicName: 'list_orders',
              sensitivity: 'medium',
            };
          }
          if (hasErrorSample) {
            // 错误响应：必须降级，不能把 error/hint 当字段
            return {
              i: it.i,
              purpose: '按路径推测的接口',
              notes: `探测返回 ${probe.status}，未能获取正常响应，按路径推测。`,
              summary: '查询用户',
              description: '按 ID 查询用户。',
              publicName: 'query_user',
              sensitivity: 'medium',
            };
          }
          return {
            i: it.i,
            purpose: '未知用途',
            notes: '基于路径推测，未经实际调用验证',
            summary: '未知接口',
            description: '按路径推测。',
            publicName: 'query_unknown',
            sensitivity: 'low',
          };
        });
      } else if (system.includes('对外命名专家')) {
        items = (payload.items ?? []).map((it) => {
          // 用路径里带 leaky 的草稿触发「模型把上游路径抄回来」的分支
          const leaky = JSON.stringify(it).includes('leaky');
          return {
            i: it.i,
            publicName: leaky ? 'leaky_tool' : 'list_orders',
            description: leaky
              ? 'GET /api/v1/leaky 这个接口用来查东西'
              : '分页查询订单列表，返回订单号与金额。',
            paramDescriptions: { page: leaky ? '参考 GET /api/v1/leaky?page=1' : '页码，从 1 开始' },
            paramRequired: [],
            paramTypes: { page: 'integer' },
          };
        });
      } else {
        items = [];
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }));
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
    apiKey: 'stub-key',
    model: 'stub',
    timeoutMs: 5000,
    concurrency: 1,
  };
}

/* ───────────── stub 上游 ───────────── */

let upstream: Server;
let upstreamPort = 0;
let upstreamHits: string[] = [];

before(async () => {
  upstream = createServer((req, res) => {
    upstreamHits.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith('/v1/orders')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          list: [
            { orderId: 'A1001', amount: 99.5, status: 'paid', userPhone: '13800001111' },
            { orderId: 'A1002', amount: 20, status: 'pending', userPhone: '13800002222' },
          ],
          total: 2,
        }),
      );
      return;
    }
    if (req.url?.startsWith('/v1/boom')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const addr = upstream.address();
  upstreamPort = typeof addr === 'object' && addr ? addr.port : 0;
});

after(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

function platform(): PlatformRecord {
  return {
    id: 'plat-1',
    slug: 'demo',
    name: 'Demo',
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    authKind: 'none',
    authConfig: {},
    defaultHeaders: {},
    egressAllowHosts: [],
    rateLimit: { qps: 10, daily: 10000 },
    allowPrivate: true,
    notes: '',
    siteTitle: '',
    siteIcon: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function draftFrom(curl: string): NormalizedDraft {
  const specs = parseCurl(curl);
  const d = specToDraft(specs[0]!, { platformSlug: 'demo', platformName: 'Demo' });
  assert.ok(d, 'curl 应能解析出草稿');
  return d;
}

/* ───────────── 探测 Agent ───────────── */

test('探测：只读接口会被真实请求，并带回样本', async () => {
  upstreamHits = [];
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders?page=1'`);
  d.endpoint.sideEffect = 'read';
  d.endpoint.params = [{ name: 'page', in: 'query', type: 'string', required: false, description: '', example: '1' }];

  const stats = await probeDrafts([d], () => platform(), { maxProbes: 5 });

  assert.equal(stats.attempted, 1);
  assert.equal(stats.succeeded, 1);
  assert.equal(stats.outcomes[0]!.status, 200);
  assert.match(stats.outcomes[0]!.sample, /orderId/);
  assert.deepEqual(stats.outcomes[0]!.topLevelKeys, ['list', 'total']);
  assert.ok(upstreamHits.some((h) => h.includes('/v1/orders')));
});

test('探测：写操作一律跳过，不打上游', async () => {
  upstreamHits = [];
  const d = draftFrom(`curl -X POST 'http://127.0.0.1:${upstreamPort}/v1/orders' -d '{"a":1}'`);
  d.endpoint.sideEffect = 'write';

  const stats = await probeDrafts([d], () => platform(), { maxProbes: 5 });

  assert.equal(stats.attempted, 0);
  assert.equal(stats.skipped, 1);
  assert.match(stats.outcomes[0]!.skippedReason ?? '', /写操作/);
  assert.equal(upstreamHits.length, 0, '写操作不应发出任何请求');
});

test('探测：必填参数缺样例值时跳过，不瞎猜', async () => {
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders'`);
  d.endpoint.sideEffect = 'read';
  d.endpoint.params = [{ name: 'userId', in: 'query', type: 'string', required: true, description: '' }];

  assert.match(probeSkipReason(d) ?? '', /userId/);
  const stats = await probeDrafts([d], () => platform(), { maxProbes: 5 });
  assert.equal(stats.attempted, 0);
  assert.equal(stats.skipped, 1);
});

test('探测：上游 500 不抛异常，记录失败', async () => {
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/boom'`);
  d.endpoint.sideEffect = 'read';
  d.endpoint.params = [];

  const stats = await probeDrafts([d], () => platform(), { maxProbes: 5 });
  assert.equal(stats.attempted, 1);
  // 5xx 仍返回响应体，供分析判断
  assert.equal(stats.outcomes[0]!.status, 500);
});

test('探测：超出上限的接口不请求', async () => {
  upstreamHits = [];
  const drafts = Array.from({ length: 5 }, () => {
    const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders'`);
    d.endpoint.sideEffect = 'read';
    d.endpoint.params = [];
    return d;
  });

  const stats = await probeDrafts(drafts, () => platform(), { maxProbes: 2 });
  assert.equal(stats.attempted, 2);
  assert.equal(stats.skipped, 3);
  assert.equal(upstreamHits.length, 2);
});

test('探测：响应里的手机号被脱敏', async () => {
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders'`);
  d.endpoint.sideEffect = 'read';
  d.endpoint.params = [];

  const stats = await probeDrafts([d], () => platform(), { maxProbes: 5 });
  assert.equal(stats.succeeded, 1);
  assert.doesNotMatch(stats.outcomes[0]!.sample, /13800001111/);
});

/* ───────────── 分析 Agent ───────────── */

test('分析：有真实样本时，备注依据样本内容', async () => {
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders'`);
  d.endpoint.params = [];

  const stats = await analyzeDrafts(cfg(), [d], [
    {
      index: 0,
      ok: true,
      status: 200,
      latencyMs: 12,
      sample: '{"list":[{"orderId":"A1001","amount":99.5}]}',
      topLevelKeys: ['list'],
    },
  ]);

  assert.equal(stats.analyzed, 1);
  assert.equal(d.endpoint.summary, '查询订单列表');
  assert.match(d.endpoint.notes, /订单号/);
  assert.match(d.endpoint.notes, /关键字段/);
  assert.match(d.endpoint.notes, /注意/);
  assert.equal(d.endpoint.publicName, 'list_orders');
  assert.equal(d.endpoint.sensitivity, 'medium');
});

test('分析：没有样本时，备注注明未验证', async () => {
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders'`);
  d.endpoint.params = [];

  const stats = await analyzeDrafts(cfg(), [d], []);
  assert.equal(stats.analyzed, 1);
  assert.match(d.endpoint.notes, /未经实际调用验证/);
});

test('探测：4xx/5xx 响应标记为 errorResponse，不当正常结构', async () => {
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/boom'`);
  d.endpoint.sideEffect = 'read';
  d.endpoint.params = [];

  const stats = await probeDrafts([d], () => platform(), { maxProbes: 5 });
  assert.equal(stats.outcomes[0]!.status, 500);
  assert.equal(stats.outcomes[0]!.errorResponse, true, '5xx 必须标记为错误响应');
});

test('探测：2xx 响应不标记为 errorResponse', async () => {
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders'`);
  d.endpoint.sideEffect = 'read';
  d.endpoint.params = [];

  const stats = await probeDrafts([d], () => platform(), { maxProbes: 5 });
  assert.equal(stats.outcomes[0]!.status, 200);
  assert.equal(stats.outcomes[0]!.errorResponse, false);
});

test('分析：错误响应不被当作接口正常返回结构', async () => {
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/users/42'`);
  d.endpoint.params = [];

  await analyzeDrafts(cfg(), [d], [
    {
      index: 0,
      ok: true,
      status: 404,
      latencyMs: 5,
      sample: '{"error":"not found","hint":"check path"}',
      topLevelKeys: ['error', 'hint'],
      errorResponse: true,
    },
  ]);

  // 备注必须体现「探测失败」，而不是把 error/hint 当字段
  assert.match(d.endpoint.notes, /未经实际调用验证|探测返回/);
  assert.doesNotMatch(d.endpoint.notes, /关键字段：error/);
});

test('分析：LLM 未启用时优雅跳过', async () => {
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders'`);
  const stats = await analyzeDrafts({ ...cfg(), enabled: false }, [d], []);
  assert.equal(stats.analyzed, 0);
  assert.equal(stats.skipped, 1);
});

/* ───────────── 命名 Agent ───────────── */

test('命名：生成对外名与参数说明', async () => {
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders?page=1'`);
  d.endpoint.params = [{ name: 'page', in: 'query', type: 'string', required: false, description: '' }];

  const stats = await nameDrafts(cfg(), [d]);
  assert.equal(stats.named, 1);
  assert.equal(d.endpoint.publicName, 'list_orders');
  assert.equal(d.endpoint.params[0]!.description, '页码，从 1 开始');
  assert.equal(d.endpoint.params[0]!.type, 'integer');
});

test('命名：同时产出对外描述', async () => {
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders?page=1'`);
  d.endpoint.params = [{ name: 'page', in: 'query', type: 'string', required: false, description: '' }];

  await nameDrafts(cfg(), [d]);
  assert.equal(d.endpoint.description, '分页查询订单列表，返回订单号与金额。');
});

test('命名：模型把上游路径抄回来时，描述和参数说明都不收', async () => {
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/leaky?page=1'`);
  d.endpoint.params = [{ name: 'page', in: 'query', type: 'string', required: false, description: '' }];
  d.endpoint.description = '';

  await nameDrafts(cfg(), [d]);

  // 模型给的是 `GET /api/v1/leaky 这个接口用来查东西`
  assert.equal(d.endpoint.description, '', '带路径的描述必须丢弃');
  assert.equal(d.endpoint.params[0]!.description, '', '带路径的参数说明必须丢弃');
  // 名字本身仍是干净的（sanitizeName 会剥掉上游痕迹）
  assert.equal(d.endpoint.publicName, 'leaky_tool');
});

test('命名：分析 Agent 已给的名字不会跟自己撞名', async () => {
  // 曾经把 needsNaming 里的草稿也塞进 used，于是「自己」和「自己」撞名，
  // 每个已由分析 Agent 起好名的接口都会白得一个 _2 后缀。
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders?page=1'`);
  d.endpoint.params = [{ name: 'page', in: 'query', type: 'string', required: false, description: '' }];
  d.endpoint.publicName = 'list_orders';

  const stats = await nameDrafts(cfg(), [d]);

  assert.equal(d.endpoint.publicName, 'list_orders', '不该变成 list_orders_2');
  assert.equal(stats.renamed.length, 0, stats.renamed.join(','));
});

test('命名：不覆盖分析 Agent 写的描述', async () => {
  // 分析 Agent 看过真实响应样本，写得比命名 Agent 准
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders?page=1'`);
  d.endpoint.params = [{ name: 'page', in: 'query', type: 'string', required: false, description: '' }];
  d.endpoint.description = '按页拉取订单，返回订单号、金额和支付状态。只读，可安全重试。';

  await nameDrafts(cfg(), [d]);

  assert.equal(d.endpoint.description, '按页拉取订单，返回订单号、金额和支付状态。只读，可安全重试。');
});

test('命名：撞名自动加后缀', async () => {
  const a = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders'`);
  const b = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders2'`);
  a.endpoint.params = [];
  b.endpoint.params = [];

  const stats = await nameDrafts(cfg(), [a, b]);
  assert.equal(stats.named, 2);
  // 两个都叫 list_orders，第二个应被改名
  assert.notEqual(a.endpoint.publicName, b.endpoint.publicName);
  assert.match(stats.renamed.join(','), /list_orders/);
});

test('命名清洗：剥掉上游痕迹', () => {
  assert.equal(sanitizeName('api_v1_get_user'), 'get_user');
  assert.equal(sanitizeName('GET User Profile'), 'get_user_profile');
  assert.equal(sanitizeName('list_orders_v2'), 'list_orders');
  assert.equal(sanitizeName('123bad'), '');
  assert.equal(sanitizeName(''), '');
});

test('命名清洗：拒绝纯数字开头', () => {
  assert.equal(sanitizeName('9lives'), '');
  assert.equal(sanitizeName('_hidden'), 'hidden');
});

/* ───────────── 端到端 ───────────── */

test('端到端：探测 → 分析 → 命名 串起来', async () => {
  const { runAgents } = await import('../src/agents/index.ts');
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders'`);
  d.endpoint.sideEffect = 'read';
  d.endpoint.params = [];

  const report = await runAgents(cfg(), [d], () => platform(), { maxProbes: 5 });

  assert.equal(report.probe.succeeded, 1);
  assert.equal(report.analyze.analyzed, 1);
  assert.equal(report.naming.named, 1);
  assert.equal(d.endpoint.publicName, 'list_orders');
  assert.match(d.endpoint.notes, /订单/);
  assert.ok(report.summary.includes('探测'));
});

test('端到端：关闭探测后仍能分析和命名', async () => {
  const { runAgents } = await import('../src/agents/index.ts');
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders'`);
  d.endpoint.sideEffect = 'read';
  d.endpoint.params = [];

  const report = await runAgents(cfg(), [d], () => platform(), { probe: false });
  assert.equal(report.probe.attempted, 0);
  assert.equal(report.analyze.analyzed, 1);
  assert.equal(report.naming.named, 1);
});

test('端到端：LLM 关闭时整条链路降级，不报错', async () => {
  const { runAgents } = await import('../src/agents/index.ts');
  const d = draftFrom(`curl 'http://127.0.0.1:${upstreamPort}/v1/orders'`);
  d.endpoint.sideEffect = 'read';
  d.endpoint.params = [];

  const report = await runAgents({ ...cfg(), enabled: false }, [d], () => platform(), {
    probe: false,
  });
  assert.equal(report.analyze.analyzed, 0);
  assert.equal(report.naming.named, 0);
  assert.equal(report.summary, '未启用 AI 增强');
});
