/**
 * 给「独立验收库」灌最小种子数据。
 *
 * 验收现在跑在临时库（DB_PATH=data/verify-<pid>.db）上，跑完就删 —— 好处是不再往
 * 生产库写 probe_/test_ 残留，代价是新库是空的，而 smoke.mjs 需要至少一个平台、
 * 一个接口、一个工具才能跑通。
 *
 * 所以这里只建「冒烟真正用到的那一条」：假上游的一个 GET 订单列表，带 page 参数。
 * 幂等：已经有了就跳过。
 *
 * 只由 scripts/verify.mjs 在自己拉起网关时调用，不对外暴露成 npm script。
 */
const BASE = process.env.GATEWAY_BASE ?? 'http://127.0.0.1:8778';
const MOCK_BASE = process.env.MOCK_BASE ?? 'http://127.0.0.1:18899';

const PLATFORM_SLUG = 'verify_mock';
const ENDPOINT_SLUG = 'get_api_v1_orders';

const j = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const login = await j(
  await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' }),
  }),
);
if (!login.token) {
  console.error('✖ 种子数据：登录失败', login);
  process.exit(1);
}
const H = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };

const platforms = await j(await fetch(`${BASE}/api/platforms`, { headers: H }));
let platform = Array.isArray(platforms) ? platforms.find((p) => p.slug === PLATFORM_SLUG) : null;

if (!platform) {
  const created = await j(
    await fetch(`${BASE}/api/platforms`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        slug: PLATFORM_SLUG,
        name: '验收假上游',
        baseUrl: MOCK_BASE,
        authKind: 'none',
        authConfig: {},
        defaultHeaders: {},
        egressAllowHosts: [],
        allowPrivate: true,
        notes: 'scripts/verify.mjs 自动创建，随临时库一起删除',
      }),
    }),
  );
  if (!created.id) {
    console.error('✖ 种子数据：建平台失败', created);
    process.exit(1);
  }
  platform = created;
}

const endpoints = await j(await fetch(`${BASE}/api/endpoints`, { headers: H }));
const exists = Array.isArray(endpoints) && endpoints.some((e) => e.slug === ENDPOINT_SLUG);

if (!exists) {
  const created = await j(
    await fetch(`${BASE}/api/endpoints`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        platformId: platform.id,
        slug: ENDPOINT_SLUG,
        group: 'orders',
        method: 'GET',
        pathTemplate: '/api/v1/orders',
        summary: '订单列表',
        description: '验收用：假上游的订单列表',
        params: [
          {
            name: 'page',
            in: 'query',
            type: 'integer',
            required: false,
            description: '页码',
            example: 1,
          },
        ],
        sideEffect: 'read',
        exposure: 'open',
        // 跟生产库里的种子保持一致：ai-e2e-test 收尾会检查这条还在、且没被改动
        publicName: 'query_orders',
        tags: ['verify'],
      }),
    }),
  );
  if (!created.id) {
    console.error('✖ 种子数据：建接口失败', created);
    process.exit(1);
  }
}

console.log(`· 验收库种子就绪（平台 ${PLATFORM_SLUG} / 接口 ${ENDPOINT_SLUG}）`);
