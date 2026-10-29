/**
 * 提交前密钥审计：扫描暂存区内容，确认没有把凭据带进仓库
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (console.log(`  ✔ ${n}${e ? ' — ' + e : ''}`), pass++) : (console.log(`  ✖ ${n}${e ? ' — ' + e : ''}`), fail++); };

console.log('=== 1. 敏感路径必须被忽略 ===');
const mustIgnore = ['.env', 'data/hub.db', 'data/master.key', 'data/hub.db-wal', 'node_modules'];
for (const p of mustIgnore) {
  let ignored = false;
  try { git('check-ignore', '-q', p); ignored = true; } catch { ignored = false; }
  check(`${p} 被忽略`, ignored);
}

console.log('\n=== 2. 暂存区不能出现敏感路径 ===');
const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
check('暂存文件数 > 0', staged.length > 0, `${staged.length} 个`);
const bad = staged.filter((f) =>
  /^data\//.test(f) || /^\.env$/.test(f) || /\.(db|key|sqlite3?|pem)(-wal|-shm)?$/.test(f) || /node_modules/.test(f),
);
check('没有敏感文件被暂存', bad.length === 0, bad.join(', ') || '干净');

console.log('\n=== 3. 关键文件确实被排除 ===');
for (const f of ['data/hub.db', 'data/master.key', '.env']) {
  check(`${f} 不在暂存列表`, !staged.includes(f));
}

console.log('\n=== 4. 暂存内容里的真实密钥扫描 ===');
// 读出本地真实主密钥，确认它没出现在任何暂存文件里
let realMaster = '';
try { realMaster = readFileSync(`${root}/data/master.key`, 'utf8').trim(); } catch { /* 没有就算了 */ }
check('读到本地主密钥用于比对', realMaster.length > 0, `${realMaster.length} 字符`);

const patterns = [
  { name: '本地主密钥明文', re: realMaster ? new RegExp(realMaster.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : null },
  { name: 'hub_live_ 令牌明文', re: /hub_live_[0-9a-f]{20,}/ },
  { name: 'OpenAI 风格 key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: '私钥块', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
];

for (const p of patterns) {
  if (!p.re) { check(`${p.name}：无样本，跳过`, true); continue; }
  const hits = [];
  for (const f of staged) {
    if (/\.(png|jpg|jpeg|ico|woff2?|gif)$/i.test(f)) continue;
    let text;
    try { text = readFileSync(`${root}/${f}`, 'utf8'); } catch { continue; }
    if (p.re.test(text)) hits.push(f);
  }
  check(`无「${p.name}」`, hits.length === 0, hits.join(', ') || '未命中');
}

console.log('\n=== 5. .env.example 不应含真实值 ===');
try {
  const ex = readFileSync(`${root}/.env.example`, 'utf8');
  check('.env.example 存在', true);
  const keyLine = ex.split('\n').find((l) => /^LLM_API_KEY=./.test(l));
  check('LLM_API_KEY 为空', !keyLine, keyLine ?? '空');
  const hubLine = ex.split('\n').find((l) => /^HUB_API_KEY=./.test(l));
  check('HUB_API_KEY 为空', !hubLine, hubLine ?? '空');
  check('不再有 ADMIN_TOKEN', !/^ADMIN_TOKEN=/m.test(ex));
  check('端口是 8778', /^PORT=8778$/m.test(ex));
} catch {
  check('.env.example 存在', false);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
