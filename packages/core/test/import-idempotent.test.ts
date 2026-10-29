import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

const { resetDbForTests, closeDb } = await import('../src/db/client.ts');
const { endpoints, tools } = await import('../src/db/repos.ts');
const { runImport } = await import('../src/import/pipeline.ts');

/**
 * 重复导入同一份文档必须幂等。
 *
 * 曾经的 bug：pipeline 在 classify 之前就 `uniqueSlug(platformId, slug)`，
 * 而它没排除「自己」。于是第二次导入时草稿 slug 和自己冲突 →
 * 被顶成 `_2`，第三次 `_3`，工具名跟着一路漂。
 */

const SPEC = {
  openapi: '3.0.0',
  info: { title: 'Idem Demo', version: '1.0.0' },
  servers: [{ url: 'http://127.0.0.1:8899' }],
  paths: {
    '/api/v1/users/{id}': {
      get: {
        operationId: 'getUser',
        summary: '查用户',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
    '/api/v1/orders': {
      get: {
        operationId: 'listOrders',
        summary: '订单列表',
        parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }],
      },
    },
  },
};

const importOnce = () =>
  runImport({
    text: JSON.stringify(SPEC),
    kind: 'openapi',
    useAi: false,
    autoPublish: true,
    probeUpstream: false,
  });

before(() => {
  resetDbForTests();
});

after(() => {
  closeDb();
});

test('第一次导入：两个接口按 operationId 命名', async () => {
  const result = await importOnce();
  assert.equal(result.stats.parsed, 2);
  const slugs = endpoints.list().map((e) => e.slug).sort();
  assert.deepEqual(slugs, ['get_user', 'list_orders']);
});

test('第二次导入同一份文档：slug 不变，不产生重复接口', async () => {
  const before = endpoints.list().length;
  const result = await importOnce();

  const slugs = endpoints.list().map((e) => e.slug).sort();
  assert.deepEqual(slugs, ['get_user', 'list_orders'], `slug 漂了：${slugs.join(', ')}`);
  assert.equal(endpoints.list().length, before, '不该新增接口');
  // 内容完全一致 → 全部判为 duplicate，不会重复发布
  assert.equal(result.stats.duplicates, 2);
});

test('第三次导入仍然稳定，工具名不出现 _2 后缀', async () => {
  await importOnce();
  const slugs = endpoints.list().map((e) => e.slug).sort();
  assert.deepEqual(slugs, ['get_user', 'list_orders']);

  const names = tools.list().map((t) => t.name).sort();
  assert.deepEqual(names, ['idem_demo__get_user', 'idem_demo__list_orders'], names.join(', '));
  assert.ok(!names.some((n) => /_\d+$/.test(n)), '工具名不该带 _2 之类的去重后缀');
});

/**
 * 批次内冲突。
 *
 * classify 用 dedupeKey(input)（形如 `GET /api/v1/x ?`）查 batchSeen，
 * 但 pipeline 当初存的是 `${method} ${pathTemplate}` —— 两边键格式不同，
 * 冲突分支永远进不去，同一批里两条一样的请求会被当成两个新接口。
 */
test('同一批里两条相同请求：一个 new，一个 conflict', async () => {
  resetDbForTests();
  const text = [
    "curl 'http://127.0.0.1:8899/api/v1/slow'",
    "curl 'http://127.0.0.1:8899/api/v1/slow'",
  ].join('\n');

  const result = await runImport({
    text,
    kind: 'curl',
    useAi: false,
    autoPublish: false,
    probeUpstream: false,
  });

  assert.equal(result.stats.parsed, 2);
  assert.equal(result.stats.conflicts, 1, '批次内重复必须被判成 conflict');
  assert.equal(result.stats.candidates, 2);
  // 冲突的不会入库，只有一个新接口
  assert.equal(endpoints.list().length, 0, 'autoPublish=false 时不该落库');
});
