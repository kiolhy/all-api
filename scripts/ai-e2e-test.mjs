/**
 * AI 链路端到端实测。
 *
 * 本机没有可用的模型 Key，所以这里起一个 **OpenAI 兼容的桩**，
 * 让网关按真实代码路径去调用它：设置页配置 → chatJson → 提示词 →
 * 解析 → 应用到接口 → 编译工具 → 网关对外。
 *
 * 桩返回的是「一个称职的模型应该给出的东西」，用来验证：
 *   1. 配置能存能生效（PUT /api/settings → loadConfig → agent → /api/health）
 *   2. 分析结果真的落到 endpoint.summary / description / notes
 *   3. 命名结果真的落到 publicName / 参数说明 / 参数类型
 *   4. 编译出的工具标题、描述、入参说明都干净且可读
 *   5. 模型把上游路径抄回来时会被丢掉，落回规则兜底
 *
 * 用独立路径（/api/v1/ai-*），跑完按 id 清掉，不碰已有接口。
 */
import { createServer } from 'node:http';

const BASE = 'http://127.0.0.1:8778';
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`); pass++; }
  else { console.log(`  ✖ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const j = async (r) => {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};

/* ────────────────── OpenAI 兼容桩 ────────────────── */

let mode = 'good'; // good | leaky
let calls = 0;

const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const messages = parsed.messages ?? [];
    const system = messages[0]?.content ?? '';
    const payload = JSON.parse(messages[1]?.content ?? '{}');
    const items = payload.items ?? [];
    calls++;

    const answer = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: obj }) } }] }));
    };

    if (system.includes('语义分析专家')) {
      return answer(items.map((it) => {
        const blob = JSON.stringify(it); // 字段名不猜，直接看内容
        if (mode === 'leaky') {
          const path = it.path ?? it.pathTemplate ?? '/api/v1/x';
          return {
            i: it.i,
            summary: `${it.method ?? 'GET'} ${path}`,
            description: `这是 ${path} 接口，直接调用即可`,
            notes: `上游路径 ${path}`,
            publicName: 'bad_tool',
            sensitivity: 'low',
          };
        }
        if (/invoices/.test(blob)) {
          return {
            i: it.i,
            summary: '查询发票列表',
            description: '按页拉取发票记录，返回发票号、金额和开具状态。只读，可安全重试。',
            notes: '数据实时，单次最多 100 条。金额单位为元。',
            returnsWhat: '发票数组',
            keyFields: [{ name: 'invoiceId', meaning: '发票号' }],
            publicName: 'list_invoices',
            sensitivity: 'medium',
          };
        }
        return {
          i: it.i,
          summary: '查询会员详情',
          description: '按会员标识查询单个会员的资料。只读。',
          notes: '不存在的会员返回 404。',
          returnsWhat: '会员对象',
          keyFields: [{ name: 'id', meaning: '会员标识' }],
          publicName: 'query_member',
          sensitivity: 'medium',
        };
      }));
    }

    if (system.includes('对外命名专家')) {
      return answer(items.map((it) => {
        const blob = JSON.stringify(it);
        if (mode === 'leaky') {
          const path = it.path ?? it.pathTemplate ?? '/api/v1/x';
          return {
            i: it.i,
            publicName: 'bad_tool',
            description: `调用 GET ${path} 即可`,
            paramDescriptions: { page: `见 ${path}`, limit: `见 ${path}`, id: `见 ${path}` },
            paramRequired: [],
            paramTypes: {},
          };
        }
        const isInvoice = /invoices/.test(blob);
        return {
          i: it.i,
          publicName: isInvoice ? 'list_invoices' : 'query_member',
          description: isInvoice
            ? '分页查询发票列表，返回发票号、金额与开具状态。只读操作，可安全重试。'
            : '按会员标识查询单个会员的资料。只读操作。',
          paramDescriptions: {
            page: '页码，从 1 开始，默认 1',
            limit: '每页条数，默认 20，最大 100',
            id: '会员唯一标识',
          },
          paramRequired: [],
          paramTypes: { page: 'integer', limit: 'integer' },
        };
      }));
    }

    answer([]);
  });
});

await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;
console.log(`桩模型监听 127.0.0.1:${stubPort}\n`);

/* ────────────────── 登录 ────────────────── */

const login = await j(await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123456' }),
}));
const A = { authorization: `Bearer ${login.token}` };
const H = { ...A, 'content-type': 'application/json' };
const get = (p) => fetch(BASE + p, { headers: A }).then(j);
const del = (p) => fetch(BASE + p, { method: 'DELETE', headers: A }).then((r) => r.text());

/* 先清掉上次跑剩的 ai-* 测试接口 */
for (const e of await get('/api/endpoints')) {
  if (/^\/api\/v1\/ai-/.test(e.pathTemplate)) await del(`/api/endpoints/${e.id}`);
}
const before = new Set((await get('/api/endpoints')).map((e) => e.id));

// 中途炸了也要把配置和数据还原，否则应用会一直指着一个已经关掉的桩
const createdIds = [];
let createdKeyId = null;
// 原始 LLM 配置：baseUrl / model 也要还原，不然下次开 AI 会指向死桩
const origLlm = (await get('/api/settings')).llm ?? {};

try {
console.log('=== 1. 配置 LLM 并确认生效 ===');
await fetch(`${BASE}/api/settings`, {
  method: 'PUT', headers: H,
  body: JSON.stringify({ llm: { enabled: true, baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiKey: 'stub-key', model: 'stub-model' } }),
}).then(j);

const health = await j(await fetch(`${BASE}/api/health`));
check('health 立刻反映新配置', health.llm?.enabled === true && health.llm?.model === 'stub-model',
  `enabled=${health.llm?.enabled} model=${health.llm?.model}`);

const settings = await get('/api/settings');
check('设置页读到同一份配置', settings.llm?.enabled === true && settings.llm?.model === 'stub-model');
check('apiKey 不以明文返回', !JSON.stringify(settings).includes('stub-key'));

/* ────────────────── 2. 称职的模型 ────────────────── */

console.log('\n=== 2. 称职的模型：整理后文案可读、不带路径 ===');
const run = await j(await fetch(`${BASE}/api/import`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    text: [
      `curl 'http://127.0.0.1:8899/api/v1/ai-invoices?page=1&limit=20'`,
      `curl 'http://127.0.0.1:8899/api/v1/ai-members/{id}'`,
    ].join('\n'),
    kind: 'curl', wait: true, useAi: true, autoPublish: true, probeUpstream: false,
  }),
}));
check('导入完成', Boolean(run.jobId), run.jobId);
check('桩模型被调用', calls >= 2, `${calls} 次`);

const eps = await get('/api/endpoints');
const tools = await get('/api/tools');
const fresh = eps.filter((e) => !before.has(e.id));
const invEp = fresh.find((e) => e.pathTemplate.includes('ai-invoices'));
const memEp = fresh.find((e) => e.pathTemplate.includes('ai-members'));
check('两个接口都是新建的', fresh.length === 2 && Boolean(invEp && memEp), `新建 ${fresh.length} 个`);
if (invEp) createdIds.push(invEp.id);
if (memEp) createdIds.push(memEp.id);

console.log('\n  ── 接口层 ──');
console.log(`  summary:     ${invEp?.summary}`);
console.log(`  description: ${invEp?.description}`);
console.log(`  notes:       ${String(invEp?.notes).replace(/\n/g, ' / ')}`);
console.log(`  publicName:  ${invEp?.publicName}`);
console.log(`  params:      ${JSON.stringify(invEp?.params?.map((p) => `${p.name}:${p.type}:${p.description}`))}`);

check('summary 来自 AI', invEp?.summary === '查询发票列表', invEp?.summary);
check('description 来自 AI', /按页拉取发票/.test(invEp?.description ?? ''));
check('notes 来自 AI', /数据实时/.test(invEp?.notes ?? ''));
check('publicName 来自 AI', invEp?.publicName === 'list_invoices', invEp?.publicName);
const pageParam = invEp?.params?.find((p) => p.name === 'page');
check('参数说明来自 AI', /页码/.test(pageParam?.description ?? ''), pageParam?.description);
check('参数类型被 AI 修正为 integer', pageParam?.type === 'integer', pageParam?.type);

console.log('\n  ── 工具层（调用方看到的）──');
const invTool = tools.find((t) => t.endpointId === invEp?.id);
const memTool = tools.find((t) => t.endpointId === memEp?.id);
console.log(`  name:        ${invTool?.name}`);
console.log(`  title:       ${invTool?.title}`);
console.log(`  description: ${String(invTool?.description).replace(/\n/g, ' ⏎ ')}`);
console.log(`  page:        ${JSON.stringify(invTool?.inputSchema?.properties?.page)}`);

check('工具名是 AI 起的', invTool?.name === 'list_invoices', invTool?.name);
check('第二个工具名也是 AI 起的', memTool?.name === 'query_member', memTool?.name);
check('工具标题可读', invTool?.title === '查询发票列表', invTool?.title);
check('工具描述含 AI 说明', /只读/.test(invTool?.description ?? ''));
check('入参有 AI 说明', /页码/.test(invTool?.inputSchema?.properties?.page?.description ?? ''));
check('入参示例类型正确', typeof invTool?.inputSchema?.properties?.page?.examples?.[0] === 'number',
  JSON.stringify(invTool?.inputSchema?.properties?.page?.examples));

/* ────────────────── 3. 网关出口 ────────────────── */

console.log('\n=== 3. 网关出口同样干净 ===');
const key = await j(await fetch(`${BASE}/api/api-keys`, {
  method: 'POST', headers: H, body: JSON.stringify({ label: `ai-e2e-${Date.now().toString(36)}` }),
}));
const GK = { 'x-api-key': key.key };
createdKeyId = key.id;
const gw = await j(await fetch(`${BASE}/gw/v1/tools`, { headers: GK }));
const gwInv = gw.find((t) => t.name === 'list_invoices');
check('/gw/v1/tools 里有 AI 起的名字', Boolean(gwInv));
const PATH_RE = /\/api\/|\/v\d+\/|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//;
check('网关文案不含上游路径', !PATH_RE.test(gwInv?.title ?? '') && !PATH_RE.test(gwInv?.description ?? ''), gwInv?.title);
check('网关入参有说明', /页码/.test(gwInv?.inputSchema?.properties?.page?.description ?? ''));

const call = await j(await fetch(`${BASE}/gw/v1/call`, {
  method: 'POST', headers: { ...GK, 'content-type': 'application/json' },
  body: JSON.stringify({ tool: 'list_invoices', args: { page: 1, limit: 5 } }),
}));
// 假上游没有 /api/v1/ai-invoices，会 502/404 —— 这里只验证「名字路由通了」
check('用 AI 起的名字能路由到上游', call.error?.code !== 'tool_not_found', JSON.stringify(call.error?.code ?? 'ok'));

/* ────────────────── 4. 不听话的模型 ────────────────── */

console.log('\n=== 4. 模型把上游路径抄回来：必须丢弃 ===');
mode = 'leaky';
const run2 = await j(await fetch(`${BASE}/api/import`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    text: `curl 'http://127.0.0.1:8899/api/v1/ai-receipts?page=2'`,
    kind: 'curl', wait: true, useAi: true, autoPublish: true, probeUpstream: false,
  }),
}));
check('导入完成', Boolean(run2.jobId), run2.jobId);

const eps2 = await get('/api/endpoints');
const tools2 = await get('/api/tools');
const badEp = eps2.find((e) => e.pathTemplate.includes('ai-receipts'));
const badTool = tools2.find((t) => t.endpointId === badEp?.id);
if (badEp) createdIds.push(badEp.id);

console.log(`  接口 summary:  ${badEp?.summary}   ← 内部字段，允许保留原文`);
console.log(`  接口 description: ${JSON.stringify(badEp?.description)}`);
console.log(`  工具 title:    ${badTool?.title}`);
console.log(`  工具 name:     ${badTool?.name}`);
console.log(`  工具 desc:     ${String(badTool?.description).replace(/\n/g, ' ⏎ ')}`);
console.log(`  page:          ${JSON.stringify(badTool?.inputSchema?.properties?.page)}`);

check('带路径的 description 被丢弃', badEp?.description === '', JSON.stringify(badEp?.description));
check('工具标题落回语义兜底', badTool?.title === '查询 ai-receipts 列表', badTool?.title);
check('工具描述不含路径', !PATH_RE.test(badTool?.description ?? ''));
check('参数说明落回规则兜底', /页码/.test(badTool?.inputSchema?.properties?.page?.description ?? ''),
  badTool?.inputSchema?.properties?.page?.description);

/* ────────────────── 5. 还原（无论成败都跑） ────────────────── */

} finally {
  console.log('\n=== 5. 还原配置与数据 ===');
  // baseUrl / model 一起还原；原来没存过 key 的才清除，避免误删用户已有的 key
  const restore = {
    enabled: Boolean(origLlm.enabled),
    ...(origLlm.baseUrl ? { baseUrl: origLlm.baseUrl } : {}),
    ...(origLlm.model ? { model: origLlm.model } : {}),
    ...(origLlm.apiKeySet ? {} : { clearApiKey: true }),
  };
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT', headers: H, body: JSON.stringify({ llm: restore }),
  }).then(j);
  const health2 = await j(await fetch(`${BASE}/api/health`));
  check('LLM 已还原为关闭', health2.llm?.enabled === false);
  const after = (await get('/api/settings')).llm ?? {};
  check('baseUrl 已还原', after.baseUrl === origLlm.baseUrl, after.baseUrl);
  check('model 已还原', after.model === origLlm.model, after.model);

  if (createdKeyId) await del(`/api/api-keys/${createdKeyId}`);
  for (const id of createdIds) await del(`/api/endpoints/${id}`);

  const left = await get('/api/endpoints');
  const leftovers = left.filter((e) => /^\/api\/v1\/ai-/.test(e.pathTemplate));
  check('测试接口已清理', leftovers.length === 0, `剩 ${left.length} 个接口，其中测试接口 ${leftovers.length} 个`);
  check('原有接口未被动过', left.some((e) => e.publicName === 'query_orders'));

  stub.close();
}

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
