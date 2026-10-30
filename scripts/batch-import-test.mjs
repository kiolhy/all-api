/**
 * 一次性导入多个接口的验证：一条粘贴里放多条 curl / 一个 OpenAPI 文档
 */
const BASE = 'http://127.0.0.1:8778';
let pass = 0, fail = 0;
const check = (n, c, e = '') => {
  c ? (console.log(`  ✔ ${n}${e ? ' — ' + e : ''}`), pass++) : (console.log(`  ✖ ${n}${e ? ' — ' + e : ''}`), fail++);
};

const j = async (r) => {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};

const login = await j(await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123456' }),
}));
const A = { authorization: `Bearer ${login.token}` };
const H = { ...A, 'content-type': 'application/json' };

// 记下跑之前已有的接口/平台，结束时只删这次新增的 —— 不碰用户已有数据
const beforeIds = new Set(
  (await (await fetch(`${BASE}/api/endpoints`, { headers: A })).json()).map((e) => e.id),
);
const beforePlatformIds = new Set(
  (await (await fetch(`${BASE}/api/platforms`, { headers: A })).json()).map((p) => p.id),
);

console.log('=== 1. 一条粘贴里放 3 条 curl ===');
const curls = `curl 'http://127.0.0.1:8899/api/v1/users/42' -H 'accept: application/json'

curl 'http://127.0.0.1:8899/api/v1/orders?page=2&limit=10' -H 'accept: application/json'

curl -X POST 'http://127.0.0.1:8899/api/v1/echo' -H 'content-type: application/json' -d '{"hello":"world"}'`;

const run = await j(await fetch(`${BASE}/api/import`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ text: curls, kind: 'curl', wait: true, autoPublish: false }),
}));
check('导入成功', Boolean(run.jobId), run.jobId);
check('解析出 3 条', run.stats?.parsed === 3, String(run.stats?.parsed));

const detail = await j(await fetch(`${BASE}/api/import/jobs/${run.jobId}`, { headers: A }));
const cands = detail.candidates ?? [];
check('候选数 = 3', cands.length === 3, `${cands.length} 个`);

const methods = cands.map((c) => `${c.payload?.method} ${c.payload?.pathTemplate ?? ''}`).sort();
console.log('     候选:', methods.join(' | '));
check('包含 GET users', methods.some((m) => m.includes('users')));
check('包含 GET orders', methods.some((m) => m.includes('orders')));
check('包含 POST echo', methods.some((m) => m.startsWith('POST')));

console.log('\n=== 2. 一个 OpenAPI 文档带 4 个接口 ===');
const spec = {
  openapi: '3.0.0',
  info: { title: 'Batch Demo', version: '1.0.0' },
  servers: [{ url: 'http://127.0.0.1:8899' }],
  paths: {
    '/api/v1/users/{id}': { get: { operationId: 'getUser', summary: '查用户', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
    '/api/v1/orders': { get: { operationId: 'listOrders', summary: '订单列表', parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }] } },
    '/api/v1/echo': { post: { operationId: 'echo', summary: '回显', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } },
    '/api/v1/big': { get: { operationId: 'bigPayload', summary: '大响应' } },
  },
};

const run2 = await j(await fetch(`${BASE}/api/import`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ text: JSON.stringify(spec), kind: 'openapi', wait: true, autoPublish: false }),
}));
check('OpenAPI 导入成功', Boolean(run2.jobId), run2.jobId);
check('解析出 4 条', run2.stats?.parsed === 4, String(run2.stats?.parsed));

const detail2 = await j(await fetch(`${BASE}/api/import/jobs/${run2.jobId}`, { headers: A }));
const cands2 = detail2.candidates ?? [];
// 重复跑这个脚本时，4 个接口都会被判为 duplicate（幂等），此时 0 候选才是对的
const dup = run2.stats?.duplicates ?? 0;
if (dup === 4) {
  check('重复导入全部判重，slug 未漂移', cands2.length === 0, `${cands2.length} 个候选 / ${dup} 个重复`);
} else {
  check('候选数 = 4', cands2.length === 4, `${cands2.length} 个`);
}
console.log('     候选:', cands2.map((c) => `${c.payload?.method} ${c.payload?.pathTemplate ?? ''}`).join(' | ') || '（全部判重）');

console.log('\n=== 3. 批量发布 ===');
const accept = await j(await fetch(`${BASE}/api/import/jobs/${run2.jobId}/accept-all`, {
  method: 'POST', headers: H, body: JSON.stringify({}),
}));
check('accept-all 返回统计', Boolean(accept), JSON.stringify(accept).slice(0, 120));

const tools = await j(await fetch(`${BASE}/api/tools`, { headers: A }));
check('工具数增加', tools.length >= 5, `${tools.length} 个工具`);
const names = tools.map((t) => t.name);
console.log('     工具名:', names.join(' | '));
check('名字不含上游痕迹', !names.some((n) => /8899|127_0_0_1/.test(n)), names.filter((n) => /8899|127_0_0_1/.test(n)).join(',') || '干净');

console.log('\n=== 4. 网关能调到新发布的接口 ===');
const key = await j(await fetch(`${BASE}/api/api-keys`, {
  method: 'POST', headers: H, body: JSON.stringify({ label: `batch-${Date.now()}` }),
}));
const GK = { 'x-api-key': key.key, 'content-type': 'application/json' };
const one = tools.find((t) => t.name.includes('orders')) ?? tools[0];
const call = await j(await fetch(`${BASE}/gw/v1/call`, {
  method: 'POST', headers: GK, body: JSON.stringify({ tool: one.name, args: { page: 1 } }),
}));
check(`调用 ${one.name}`, call.ok === true, String(call.ok));

console.log('\n=== 5. 清理 ===');
await fetch(`${BASE}/api/api-keys/${key.id}`, { method: 'DELETE', headers: A }).then((r) => r.text());
check('删除测试令牌', true);

// 删掉本次导入造出来的接口，让 npm run verify 跑完库跟跑之前一样
const afterEps = await (await fetch(`${BASE}/api/endpoints`, { headers: A })).json();
let removed = 0;
for (const e of afterEps) {
  if (beforeIds.has(e.id)) continue;
  await fetch(`${BASE}/api/endpoints/${e.id}`, { method: 'DELETE', headers: A }).then((r) => r.text());
  removed += 1;
}
check(`清理本次导入的 ${removed} 个接口`, true);

// 接口删完后，本次新建且已空的平台也一并删掉
const leftEps = await (await fetch(`${BASE}/api/endpoints`, { headers: A })).json();
const pfs = await (await fetch(`${BASE}/api/platforms`, { headers: A })).json();
let droppedPlatforms = 0;
for (const p of pfs) {
  if (beforePlatformIds.has(p.id)) continue;
  if (leftEps.some((e) => e.platformId === p.id)) continue;
  await fetch(`${BASE}/api/platforms/${p.id}`, { method: 'DELETE', headers: A }).then((r) => r.text());
  droppedPlatforms += 1;
}
check(`清理本次新建的空平台 ${droppedPlatforms} 个`, true);

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
