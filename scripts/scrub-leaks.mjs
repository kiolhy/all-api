#!/usr/bin/env node
/**
 * 历史泄露痕迹清理
 *
 * 修复代码只是止血；数据库里已经落盘的明文不会自己消失。
 * 报告里的泄漏链最终把密钥明文写进了 chat_session.title（以及可能的 chat_message），
 * 这段脚本负责：
 *
 *   1. 扫描 chat_session / chat_message / audit_log 里疑似密钥明文的内容
 *   2. 报告每一处命中（默认只报告，不改数据）
 *   3. --apply 时用统一的脱敏结果覆盖
 *   4. 列出「需要轮换」的密钥名（命令里带 LEAK: 前缀的那批）
 *
 * 用法：
 *   node scripts/scrub-leaks.mjs             # 只看报告
 *   node scripts/scrub-leaks.mjs --apply     # 真的写回
 *
 * 轮换提醒：数据库里出现过的密钥，必须当成已泄露 —— 清理只是把痕迹抹掉，
 * 谁在泄露窗口期里读到过，无从得知。
 */
import { setTimeout as sleep } from 'node:timers/promises';

process.env.NODE_ENV ??= 'production';

const { getDb } = await import('../packages/core/src/db/client.ts');
const { scrubAll, scrubPatterns, scrubDeep } = await import('../packages/core/src/invoke/redact.ts');
const { secrets } = await import('../packages/core/src/db/repos.ts');
const { decryptSecret } = await import('../packages/core/src/secrets/vault.ts');

const APPLY = process.argv.includes('--apply');
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/** 取所有已存密钥的明文，用于精确子串命中 */
function loadSecretValues() {
  const out = [];
  for (const meta of secrets.list()) {
    const blob = secrets.getCipher(meta.name);
    if (!blob) continue;
    try {
      const plain = decryptSecret(blob);
      // 太短的串（如 'true'）匹配起来会刷屏，跳过
      if (plain.length >= 8) out.push({ name: meta.name, value: plain });
    } catch {
      out.push({ name: meta.name, value: null });
    }
  }
  return out;
}

function hitsIn(text, values) {
  const hits = [];
  for (const { name, value } of values) {
    if (value && text.includes(value)) hits.push(name);
  }
  return hits;
}

const db = getDb();
const values = loadSecretValues();
const names = values.map((v) => v.name);

console.log(c.bold('\n── 密钥库现状 ──'));
if (!values.length) {
  console.log(c.dim('（vault 里没有密钥）'));
} else {
  for (const v of values) {
    console.log(`  ${v.name}${v.value ? '' : c.yellow('（解密失败，主密钥可能已更换）')}`);
  }
}

let totalHits = 0;
const leakedNames = new Set();

function scan(table, idCol, textCols, sql) {
  const rows = db.prepare(sql).all();
  let touched = 0;
  const updates = [];

  for (const row of rows) {
    const id = row[idCol];
    const combined = textCols.map((col) => String(row[col] ?? '')).join('\n');
    const exact = hitsIn(combined, values);
    // 通用模式（Bearer / sk- / 两段式 cookie）也要扫：可能不是我们 vault 里的值
    const patternScrubbed = textCols.map((col) => scrubPatterns(String(row[col] ?? '')));
    const patternChanged = patternScrubbed.some((v, i) => v !== String(row[textCols[i]] ?? ''));

    if (!exact.length && !patternChanged) continue;

    touched += 1;
    totalHits += 1;
    for (const n of exact) leakedNames.add(n);

    const preview = combined.replace(/\s+/g, ' ').slice(0, 100);
    console.log(
      `  ${c.red('!')} ${table}#${id} ${exact.length ? `含密钥明文 [${exact.join(', ')}]` : '含疑似凭据模式'}`,
    );
    console.log(c.dim(`      ${preview}`));

    const next = {};
    textCols.forEach((col, i) => {
      const original = String(row[col] ?? '');
      const cleaned = scrubAll(patternScrubbed[i]);
      if (cleaned !== original) next[col] = cleaned;
    });
    if (Object.keys(next).length) updates.push({ id, next });
  }

  if (!touched) {
    console.log(c.green(`  ✔ ${table} 未发现泄露痕迹`));
    return;
  }

  if (!APPLY) {
    console.log(c.yellow(`  → ${table} 有 ${updates.length} 行可清理（加 --apply 才会写回）`));
    return;
  }

  const stmt = new Map();
  for (const { id, next } of updates) {
    const cols = Object.keys(next);
    const key = `${table}:${cols.join(',')}`;
    if (!stmt.has(key)) {
      stmt.set(key, db.prepare(`update ${table} set ${cols.map((col) => `${col}=?`).join(', ')} where ${idCol}=?`));
    }
    stmt.get(key).run(...cols.map((col) => next[col]), id);
  }
  console.log(c.green(`  ✔ ${table} 已清理 ${updates.length} 行`));
}

console.log(c.bold('\n── 扫描泄露痕迹 ──'));
scan('chat_session', 'id', ['title'], 'select id, title from chat_session');
scan('chat_message', 'id', ['content'], 'select id, content from chat_message');
scan('audit_log', 'id', ['req_meta', 'resp_meta'], 'select id, req_meta, resp_meta from audit_log');
scan('platform', 'id', ['notes'], 'select id, notes from platform');

// 端点定义里如果直接把明文写死（而不是 ${secret:...}），同样要报出来
const epLeak = db.prepare('select id, slug, body, params from endpoint').all();
let epHits = 0;
for (const row of epLeak) {
  const text = String(row.body ?? '') + String(row.params ?? '');
  const exact = hitsIn(text, values);
  if (exact.length) {
    epHits += 1;
    totalHits += 1;
    exact.forEach((n) => leakedNames.add(n));
    console.log(`  ${c.red('!')} endpoint#${row.slug} 定义里写死了密钥明文 [${exact.join(', ')}]`);
  }
}
if (!epHits) console.log(c.green('  ✔ endpoint 定义未写死密钥明文'));

console.log(c.bold('\n── 结论 ──'));
if (!totalHits) {
  console.log(c.green('  ✔ 未发现落盘明文。'));
} else {
  console.log(`  命中 ${totalHits} 处${APPLY ? '（已清理）' : c.yellow('（未清理，用 --apply 执行）')}`);
}

if (leakedNames.size) {
  console.log(c.bold(`\n${c.yellow('⚠ 以下密钥必须轮换（视为已泄露）')}`));
  for (const n of leakedNames) console.log(`  - ${n}`);
  console.log(
    c.dim('  轮换后旧值立即作废：控制台「密钥」页覆盖同名项即可，无需删除重建（引用名不变）。'),
  );
  console.log(c.dim('  同时确认：上游那侧（例如 claude-wire 的 admin Cookie / LLM 的 apiKey）也要轮换。'));
}

await sleep(10);
process.exit(totalHits && !APPLY ? 1 : 0);
