/**
 * 本地全链路冒烟：把控制台 API、网关、文档端点、更新端点全跑一遍
 */
const BASE = process.env.GATEWAY_BASE ?? 'http://127.0.0.1:8778';
let pass = 0, fail = 0;
const check = (n, c, e = '') => {
  c ? (console.log(`  ✔ ${n}${e ? ' — ' + e : ''}`), pass++) : (console.log(`  ✖ ${n}${e ? ' — ' + e : ''}`), fail++);
};
const section = (t) => console.log(`\n── ${t} ──`);

const j = async (res) => {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
};

section('1. 健康检查与登录');
const health = await j(await fetch(`${BASE}/api/health`));
check('health ok', health.ok === true);
check('版本 0.2.0', health.version === '0.2.0', health.version);
check('鉴权模式是账号', health.auth === 'account');

const badLogin = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'wrong' }),
});
check('错误密码被拒', badLogin.status === 401, String(badLogin.status));
await badLogin.text();

const login = await j(await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123456' }),
}));
check('登录拿到会话', Boolean(login.token), login.token?.slice(0, 8) + '…');
const A = { authorization: `Bearer ${login.token}` };
const H = { ...A, 'content-type': 'application/json' };

const noAuth = await fetch(`${BASE}/api/tools`);
check('未登录访问被拒 401', noAuth.status === 401, String(noAuth.status));
await noAuth.text();

section('2. 控制台数据');
const [stats, platforms, endpoints, tools, keys, audits, settings] = await Promise.all([
  j(await fetch(`${BASE}/api/stats`, { headers: A })),
  j(await fetch(`${BASE}/api/platforms`, { headers: A })),
  j(await fetch(`${BASE}/api/endpoints`, { headers: A })),
  j(await fetch(`${BASE}/api/tools`, { headers: A })),
  j(await fetch(`${BASE}/api/api-keys`, { headers: A })),
  j(await fetch(`${BASE}/api/audit?limit=5`, { headers: A })),
  j(await fetch(`${BASE}/api/settings`, { headers: A })),
]);
check('stats 有平台', stats.platforms >= 1, String(stats.platforms));
check('平台列表', Array.isArray(platforms) && platforms.length >= 1, `${platforms.length} 个`);
check('接口列表', Array.isArray(endpoints) && endpoints.length >= 1, `${endpoints.length} 个`);
check('工具列表', Array.isArray(tools) && tools.length >= 1, `${tools.length} 个`);
check('令牌列表', Array.isArray(keys), `${keys.length} 个`);
check('审计列表', Array.isArray(audits), `${audits.length} 条`);
check('设置可读', Boolean(settings.egress), `allowPrivate=${settings.egress?.allowPrivate}`);

// 库里有多个工具时别盲取 tools[0]：不同接口入参不同，随便拿一个可能不吃 page
const t0 =
  tools.find((t) => t.inputSchema?.properties?.page) ??
  tools.find((t) => !(t.inputSchema?.required?.length ?? 0)) ??
  tools[0];
const hasPage = Boolean(t0.inputSchema?.properties?.page);
const args = hasPage ? { page: 1 } : {};
const qs = hasPage ? '?page=1' : '';
const upstreamPort = new URL(process.env.MOCK_BASE ?? 'http://127.0.0.1:18899').port;
check(
  '工具名不暴露上游',
  !t0.name.includes(upstreamPort) && !t0.name.includes('127_0_0_1'),
  t0.name,
);
check('工具含 inputSchema', Boolean(t0.inputSchema?.properties !== undefined));

section('3. 新建令牌 → 走网关');
const created = await j(await fetch(`${BASE}/api/api-keys`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ label: `smoke-${Date.now()}`, quotaLimit: 0, quotaPeriod: 'total', expiresAt: null }),
}));
check('创建令牌返回明文', Boolean(created.key), created.key?.slice(0, 12) + '…');
const GK = { 'x-api-key': created.key, 'content-type': 'application/json' };

const gwTools = await fetch(`${BASE}/gw/v1/tools`, { headers: { 'x-api-key': created.key } });
check('网关 /gw/v1/tools', gwTools.status === 200, String(gwTools.status));
const gwToolsBody = await j(gwTools);
check('网关工具清单非空', (Array.isArray(gwToolsBody) ? gwToolsBody.length : gwToolsBody?.tools?.length) >= 1);

// 对外文案不许带上游路径：网关把域名掩了，title/description 里再写 `GET /api/v1/x` 等于白掩
const UPSTREAM_PATH_RE = /\/api\/|\/v\d+\/|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//;
const gwList = Array.isArray(gwToolsBody) ? gwToolsBody : (gwToolsBody?.tools ?? []);
const leakyText = gwList.filter(
  (t) => UPSTREAM_PATH_RE.test(t.title ?? '') || UPSTREAM_PATH_RE.test(t.description ?? ''),
);
check('工具标题/描述不含上游路径', leakyText.length === 0, leakyText.map((t) => t.name).join(',') || '干净');

const missingParamDesc = gwList.flatMap((t) =>
  Object.entries(t.inputSchema?.properties ?? {})
    .filter(([, schema]) => !String(schema?.description ?? '').trim())
    .map(([k]) => `${t.name}.${k}`),
);
check('每个入参都有说明', missingParamDesc.length === 0, missingParamDesc.join(',') || '全部有');

const call = await j(await fetch(`${BASE}/gw/v1/call`, {
  method: 'POST', headers: GK,
  body: JSON.stringify({ tool: t0.name, args }),
}));
check('按工具名调用成功', call.ok === true, `status=${call.ok}`);
check('返回有 data', 'data' in call);
check('返回有 meta.requestId', Boolean(call.meta?.requestId));
check('console 通道不泄露上游 host', !call.meta?.upstreamHost, JSON.stringify(call.meta?.upstreamHost ?? ''));

const direct = await fetch(`${BASE}/gw/v1/${t0.name}${qs}`, { headers: { 'x-api-key': created.key } });
check('直连路径调用', direct.status === 200, String(direct.status));
await direct.text();

const noKey = await fetch(`${BASE}/gw/v1/call`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tool: t0.name, args: {} }),
});
check('无令牌被拒 401', noKey.status === 401, String(noKey.status));
await noKey.text();

const badTool = await j(await fetch(`${BASE}/gw/v1/call`, {
  method: 'POST', headers: GK, body: JSON.stringify({ tool: 'no_such_tool', args: {} }),
}));
check('不存在的工具报错', badTool.ok === false, badTool.error?.code ?? '');

section('4. 给 AI 的自助端点');
for (const [path, name] of [
  ['/gw/llms.txt', 'llms.txt'],
  ['/gw/openapi.json', 'openapi.json'],
  ['/gw/v1/me', 'me'],
]) {
  const r = await fetch(`${BASE}${path}`, { headers: { 'x-api-key': created.key } });
  const body = await r.text();
  check(`${path} 可用`, r.status === 200 && body.length > 10, `${r.status}, ${body.length}B`);
}
const oa = await j(await fetch(`${BASE}/gw/openapi.json`, { headers: { 'x-api-key': created.key } }));
check('openapi 是 3.x', String(oa.openapi ?? '').startsWith('3.'), oa.openapi);

const me = await j(await fetch(`${BASE}/gw/v1/me`, { headers: { 'x-api-key': created.key } }));
const meLeaky = (me.endpoints ?? []).filter(
  (e) =>
    UPSTREAM_PATH_RE.test(e.title ?? '') ||
    UPSTREAM_PATH_RE.test(e.description ?? '') ||
    UPSTREAM_PATH_RE.test(e.notes ?? ''),
);
check('自省里标题/描述/备注都不含上游路径', meLeaky.length === 0, meLeaky.map((e) => e.name).join(',') || '干净');

const oaLeaky = Object.values(oa.paths ?? {}).filter((p) =>
  UPSTREAM_PATH_RE.test(p?.get?.summary ?? ''),
);
check('openapi summary 不含上游路径', oaLeaky.length === 0, `${oaLeaky.length} 个`);

section('5. 早期失败也要留痕');
const before = (await j(await fetch(`${BASE}/api/audit?limit=50`, { headers: A }))).length;
await fetch(`${BASE}/gw/v1/definitely_missing`, { headers: { 'x-api-key': created.key } }).then((r) => r.text());
const afterList = await j(await fetch(`${BASE}/api/audit?limit=50`, { headers: A }));
check('失败调用写入了审计', afterList.length >= before, `${before} → ${afterList.length}`);
check('最新一条是失败记录', afterList[0]?.ok === false || afterList[0]?.errorCode, afterList[0]?.errorCode ?? '');

section('6. SSE 实时流');
for (const [path, name] of [
  ['/api/audit/stream', '审计流'],
  ['/api/import/stream', '导入流'],
]) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${BASE}${path}`, { headers: A, signal: ctrl.signal });
    const reader = r.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value ?? new Uint8Array());
    check(`${name} 可订阅`, r.status === 200 && text.includes('data:'), text.slice(0, 60).replace(/\n/g, ' '));
    await reader.cancel().catch(() => {});
  } catch (e) {
    check(`${name} 可订阅`, false, String(e).slice(0, 60));
  } finally {
    clearTimeout(timer);
  }
}

section('7. 更新端点');
const local = await j(await fetch(`${BASE}/api/update`, { headers: A }));
check('本地状态可读', local.isGit === true);
check('版本与 health 一致', local.version === health.version, `${local.version}/${health.version}`);
check('分支是 main', local.branch === 'main', local.branch);
check('远程指向 GitHub', String(local.remote).includes('github.com/kiolhy/all-api'), local.remote);
const upd401 = await fetch(`${BASE}/api/update/check`);
check('未登录不能检查更新', upd401.status === 401, String(upd401.status));
await upd401.text();

const gwUpdate = await fetch(`${BASE}/gw/v1/call`, {
  method: 'POST', headers: GK, body: JSON.stringify({ tool: 'update', args: {} }),
});
check('网关碰不到更新端点', gwUpdate.status === 401 || (await j(gwUpdate))?.ok === false, String(gwUpdate.status));

section('8. 前端静态资源');
const index = await fetch(`${BASE}/`);
const html = await index.text();
check('首页可访问', index.status === 200 && html.includes('<div id="root"'));
const m = html.match(/assets\/[^"']+\.js/);
check('引用了构建产物', Boolean(m), m?.[0] ?? '');
if (m) {
  const jsRes = await fetch(`${BASE}/${m[0]}`);
  const js = await jsRes.text();
  check('bundle 可下载', jsRes.status === 200 && js.length > 100000, `${Math.round(js.length / 1024)}KB`);
  for (const kw of ['交给其他 AI', '版本与更新', '检查更新', '复制接入包']) {
    check(`bundle 含「${kw}」`, js.includes(kw));
  }
}

section('9. 清理本次测试令牌');
const del = await fetch(`${BASE}/api/api-keys/${created.id}`, { method: 'DELETE', headers: A });
check('删除测试令牌', del.status === 200 || del.status === 204, String(del.status));
await del.text();

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
