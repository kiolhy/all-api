/**
 * 清理测试 / 探测留下的垃圾资产。
 *
 * 用法：
 *   node scripts/cleanup-test-data.mjs            # 只看，不删
 *   node scripts/cleanup-test-data.mjs --apply    # 真的删
 *
 * 认哪些算垃圾（可以用环境变量覆盖）：
 *   CLEANUP_SLUG_RE     接口 slug 正则，默认 ^(probe|test|demo|tmp|smoke|verify|km_probe)[_-]
 *   CLEANUP_PATH_RE     接口路径正则，默认 /(probe|test|demo|tmp|smoke|verify)(/|$)
 *   CLEANUP_PLATFORM_RE 平台 slug 正则，默认 ^(x?127|localhost|mock|test|probe|batch_demo|tmp)
 *   CLEANUP_KEEP        永不删除的 slug，逗号分隔，默认 get_api_v1_orders
 *   CLEANUP_JOB_DAYS    整理记录保留天数，默认 7；0 表示不清理整理记录
 *   CLEANUP_JOB_RE      整理记录 inputRef 正则，命中即视为探测残留（不看到期时间）
 *
 * 平台只在「名下已经没有接口」时才删，避免把真实资产连带干掉。
 */
const B = process.env.HUB_BASE_URL || 'http://127.0.0.1:8778';
const USER = process.env.HUB_USER || 'admin';
const PASS = process.env.HUB_PASS || 'admin123456';
const APPLY = process.argv.includes('--apply');

const re = (envName, fallback) => new RegExp(process.env[envName] || fallback, 'i');
const SLUG_RE = re('CLEANUP_SLUG_RE', '^(probe|test|demo|tmp|smoke|verify|km_probe)[_-]');
const PATH_RE = re('CLEANUP_PATH_RE', '/(probe|test|demo|tmp|smoke|verify)(/|$)');
const PLATFORM_RE = re('CLEANUP_PLATFORM_RE', '^(x?127|localhost|mock|test|probe|batch_demo|tmp)');
const KEEP = new Set(
  (process.env.CLEANUP_KEEP || 'get_api_v1_orders')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
/** 整理记录保留天数：0 = 不动整理记录 */
const JOB_DAYS = Number(process.env.CLEANUP_JOB_DAYS ?? 7);
const JOB_RE = new RegExp(process.env.CLEANUP_JOB_RE || '^(check|smoke|batch|ai-e2e|verify)', 'i');

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  const login = await json(
    await fetch(`${B}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    }),
  );

  if (!login || !login.token) {
    console.error('登录失败，先确认服务在跑、账号密码对：', login);
    process.exitCode = 1;
    return;
  }

  const A = { authorization: `Bearer ${login.token}` };
  const get = (path) => fetch(B + path, { headers: A }).then(json);

  const [endpoints, platforms] = await Promise.all([get('/api/endpoints'), get('/api/platforms')]);
  if (!Array.isArray(endpoints) || !Array.isArray(platforms)) {
    console.error('拉列表失败：', endpoints, platforms);
    process.exitCode = 1;
    return;
  }

  const platformById = new Map(platforms.map((p) => [p.id, p]));

  /** 命中规则的接口 */
  const junkEndpoints = endpoints.filter((e) => {
    if (KEEP.has(e.slug)) return false;
    if (SLUG_RE.test(e.slug)) return true;
    if (PATH_RE.test(e.pathTemplate || '')) return true;
    const platform = platformById.get(e.platformId);
    return Boolean(platform && PLATFORM_RE.test(platform.slug));
  });

  /** 平台名就是探测地址（127.0.0.1:8899 之类）的，整块都算测试残留 */
  const junkPlatforms = platforms.filter((p) => PLATFORM_RE.test(p.slug) && !KEEP.has(p.slug));

  /**
   * 整理记录（import_job）残留。
   *
   * 验收脚本每跑一次都会留几条记录，时间一长「整理记录」页全是跑测试留下的行，
   * 用户看到的就是「那条完成却 0% 的记录还在」。这里按两条规则清：
   *   - inputRef 命中 CLEANUP_JOB_RE（就是脚本自己造的）
   *   - 或者已经超过 CLEANUP_JOB_DAYS 天
   * 还在跑（queued/running）的一律不碰。
   */
  const jobs = JOB_DAYS > 0 || process.env.CLEANUP_JOB_RE ? await get('/api/import/jobs') : [];
  const cutoff = Date.now() - JOB_DAYS * 24 * 60 * 60 * 1000;
  const junkJobs = (Array.isArray(jobs) ? jobs : []).filter((job) => {
    if (job.status === 'queued' || job.status === 'running') return false;
    if (JOB_RE.test(job.inputRef || '')) return true;
    if (JOB_DAYS <= 0) return false;
    const t = Date.parse(job.createdAt || '');
    return Number.isFinite(t) && t < cutoff;
  });

  console.log(`目标：${B}`);
  console.log(`接口 ${endpoints.length} 个，命中 ${junkEndpoints.length} 个`);
  for (const e of junkEndpoints) {
    console.log(`  - ${String(e.method).padEnd(6)} ${e.pathTemplate}  (slug ${e.slug}, status ${e.status})`);
  }
  console.log(`平台 ${platforms.length} 个，测试类 ${junkPlatforms.length} 个（只在名下没有接口时才删）`);
  for (const p of junkPlatforms) console.log(`  - ${p.slug}  (${p.name})`);
  console.log(
    `整理记录 ${Array.isArray(jobs) ? jobs.length : 0} 条，命中 ${junkJobs.length} 条` +
      (JOB_DAYS > 0 ? `（保留最近 ${JOB_DAYS} 天）` : '（不按天数清理）'),
  );
  for (const job of junkJobs.slice(0, 10)) {
    console.log(`  - ${job.status.padEnd(8)} ${job.progress ?? 0}%  ${job.inputRef || '(无输入)'}  ${job.createdAt}`);
  }
  if (junkJobs.length > 10) console.log(`  … 还有 ${junkJobs.length - 10} 条`);

  if (junkEndpoints.length === 0 && junkPlatforms.length === 0 && junkJobs.length === 0) {
    console.log('\n没有需要清理的东西。');
    return;
  }

  if (!APPLY) {
    console.log('\n这是预演。确认无误后加 --apply 再跑一次。');
    return;
  }

  let removedEndpoints = 0;
  for (const e of junkEndpoints) {
    const res = await fetch(`${B}/api/endpoints/${e.id}`, { method: 'DELETE', headers: A });
    if (res.ok) removedEndpoints += 1;
    else console.log(`  ! 删除接口失败 ${e.slug}: ${res.status} ${await res.text()}`);
    await res.text();
  }

  // 删完接口再删平台，且只删空平台
  const remaining = await get('/api/endpoints');
  const stillUsed = new Set((Array.isArray(remaining) ? remaining : []).map((e) => e.platformId));
  let removedPlatforms = 0;
  for (const p of junkPlatforms) {
    if (stillUsed.has(p.id)) {
      console.log(`  保留平台 ${p.slug}：名下还有接口`);
      continue;
    }
    const res = await fetch(`${B}/api/platforms/${p.id}`, { method: 'DELETE', headers: A });
    if (res.ok) removedPlatforms += 1;
    else console.log(`  ! 删除平台失败 ${p.slug}: ${res.status} ${await res.text()}`);
    await res.text();
  }

  const [epsAfter, toolsAfter, pfsAfter] = await Promise.all([
    get('/api/endpoints'),
    get('/api/tools'),
    get('/api/platforms'),
  ]);

  // 整理记录最后删：先删资产，记录里的候选引用已经没意义了
  let removedJobs = 0;
  for (const job of junkJobs) {
    const res = await fetch(`${B}/api/import/jobs/${job.id}`, { method: 'DELETE', headers: A });
    if (res.ok) removedJobs += 1;
    else console.log(`  ! 删除整理记录失败 ${job.id}: ${res.status} ${await res.text()}`);
    await res.text();
  }

  console.log(
    `\n删除接口 ${removedEndpoints} 个、平台 ${removedPlatforms} 个、整理记录 ${removedJobs} 条；` +
      `剩余接口 ${epsAfter.length}、工具 ${toolsAfter.length}、平台 ${pfsAfter.length}。`,
  );
  for (const e of epsAfter) console.log(`  · ${String(e.method).padEnd(6)} ${e.pathTemplate}  (slug ${e.slug})`);
}

await main();
