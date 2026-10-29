/** 验证「全部采纳」前的预览数字与服务端实际行为一致 */
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
const H = { ...A, 'content-type': 'application/json' };

// 两条一模一样的 curl + 一条不同的 → 批次内应产生 1 个 conflict
// 路径带时间戳，保证每次跑都是全新接口，不被上一轮判重干扰
const tag = Date.now().toString(36);
const text = [
  `curl 'http://127.0.0.1:8899/api/v1/slow-${tag}'`,
  `curl 'http://127.0.0.1:8899/api/v1/slow-${tag}'`,
  `curl 'http://127.0.0.1:8899/api/v1/redirect-${tag}'`,
].join('\n');

const run = await j(await fetch(`${B}/api/import`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ text, kind: 'curl', wait: true, autoPublish: false, useAi: false, probeUpstream: false }),
}));

const d = await j(await fetch(`${B}/api/import/jobs/${run.jobId}`, { headers: A }));
const c = d.candidates ?? [];
const pend = c.filter((x) => x.decision === 'pending');

// 与 ImportPage 里 bulkPreview 完全相同的算法
const preview = {
  create: pend.filter((x) => x.diffKind === 'new').length,
  update: pend.filter((x) => x.diffKind === 'modified').length,
  conflict: pend.filter((x) => x.diffKind === 'conflict').length,
  duplicate: pend.filter((x) => x.diffKind === 'duplicate').length,
  skippedAtImport: run.stats?.duplicates ?? 0,
};

console.log('候选 diffKind:', c.map((x) => x.diffKind).join(', ') || '(空)');
console.log('预览:', JSON.stringify(preview));

const res = await j(await fetch(`${B}/api/import/jobs/${run.jobId}/accept-all`, {
  method: 'POST', headers: H, body: '{}',
}));
console.log('实际:', JSON.stringify(res));

const ok = res.created === preview.create && res.updated === preview.update;
console.log(ok ? '✔ 预览与实际一致' : '✖ 预览与实际不一致');
console.log(preview.conflict > 0 ? '✔ 冲突被正确计入预览并跳过' : '✖ 没造出冲突，用例无效');

// 再跑一次同一个 job：new 的已被采纳，只剩冲突项仍为 pending 等人工处理
const d2 = await j(await fetch(`${B}/api/import/jobs/${run.jobId}`, { headers: A }));
const pend2 = (d2.candidates ?? []).filter((x) => x.decision === 'pending');
const ok2 = pend2.length === preview.conflict && pend2.every((x) => x.diffKind === 'conflict');
console.log(
  '二次查看 pending:',
  pend2.length,
  ok2 ? '✔ 只剩冲突项待处理' : `✖ 期望只剩 ${preview.conflict} 个 conflict`,
);
