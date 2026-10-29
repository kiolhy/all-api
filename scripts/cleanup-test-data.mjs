/**
 * 清理测试过程中造出来的接口 / 平台。
 *
 * 只删本会话测试生成的那些：Batch Demo 平台下的、路径带 slow-/redirect- 时间戳的，
 * 以及早期手动测试留下的 /api/v1/slow、/api/v1/redirect、/api/v1/echo、/api/v1/big。
 * 保留用户自己的 query_orders（原 get_api_v1_orders）。
 */
const B = 'http://127.0.0.1:8778';
const j = async (r) => {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};

const l = await j(await fetch(`${B}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123456' }),
}));
const A = { authorization: `Bearer ${l.token}` };

const [eps, pfs, tools] = await Promise.all(
  ['/api/endpoints', '/api/platforms', '/api/tools'].map((p) => fetch(B + p, { headers: A }).then((r) => r.json())),
);

const KEEP_SLUGS = new Set(['get_api_v1_orders']);
const TEST_PATH = /\/api\/v1\/(slow|redirect|echo|big|users)(-|$|\/)/;
const TEST_PLATFORM = /^(x127|batch_demo)/;

const toDelete = eps.filter(
  (e) => !KEEP_SLUGS.has(e.slug) && (TEST_PATH.test(e.pathTemplate) || /_(2|3|4)$/.test(e.slug)),
);

console.log(`接口 ${eps.length} 个，准备删除 ${toDelete.length} 个：`);
for (const e of toDelete) console.log(`  - ${e.method.padEnd(5)} ${e.pathTemplate}  (slug ${e.slug})`);

for (const e of toDelete) {
  const r = await fetch(`${B}/api/endpoints/${e.id}`, { method: 'DELETE', headers: A });
  if (!r.ok) console.log(`  ! 删除失败 ${e.slug}: ${r.status} ${await r.text()}`);
  await r.text();
}

const after = await j(await fetch(`${B}/api/endpoints`, { headers: A }));
const afterTools = await j(await fetch(`${B}/api/tools`, { headers: A }));
console.log(`\n剩余接口 ${after.length} 个、工具 ${afterTools.length} 个：`);
for (const e of after) console.log(`  · ${e.method.padEnd(5)} ${e.pathTemplate}  (slug ${e.slug})`);

// 平台：Batch Demo 空了就删
for (const p of pfs) {
  if (!TEST_PLATFORM.test(p.slug)) continue;
  const used = after.some((e) => e.platformId === p.id);
  if (used) {
    console.log(`  保留平台 ${p.name}（还有接口）`);
    continue;
  }
  const r = await fetch(`${B}/api/platforms/${p.id}`, { method: 'DELETE', headers: A });
  console.log(`  删除空平台 ${p.name}: ${r.status}`);
  await r.text();
}
