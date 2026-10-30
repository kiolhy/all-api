/**
 * 验证 import_job 收尾时的进度/步骤落定。
 *
 * 真实事故：整理记录里有一条 status=done 却显示 0% 的任务。
 * 根因是 finish() 只改 status，没管 steps 和 progress —— 最后一个步骤如果
 * 因为 AI 超时没跑完，steps 里就留着 running/pending，progress 卡在 50% 以下。
 *
 * 跑法：node scripts/check-job-progress.mjs
 */
// 用内存库，绝不碰 data/hub.db\nprocess.env.DB_PATH = ':memory:';

const { importJobs } = await import('../packages/core/src/db/repos.ts');

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`);
    pass++;
  } else {
    console.log(`  ✖ ${name}${extra ? ' — ' + extra : ''}`);
    fail++;
  }
};

const STEPS = [
  { key: 'fetch', label: '抓取', status: 'pending' },
  { key: 'parse', label: '解析', status: 'pending' },
  { key: 'analyze', label: 'AI 分析', status: 'pending' },
  { key: 'naming', label: 'AI 命名', status: 'pending' },
];

console.log('\n── 1. 正常跑完：done 必须是 100% ──');
{
  const job = importJobs.create('curl', 'check', STEPS);
  importJobs.setStatus(job.id, 'running');
  importJobs.setStep(job.id, 'fetch', { status: 'done' });
  importJobs.setStep(job.id, 'parse', { status: 'done' });
  importJobs.setStep(job.id, 'analyze', { status: 'done' });
  importJobs.setStep(job.id, 'naming', { status: 'done' });
  importJobs.finish(job.id, 'done', {}, null, true);
  const after = importJobs.get(job.id);
  check('status 是 done', after.status === 'done', after.status);
  check('progress 是 100', after.progress === 100, String(after.progress));
  check('没有残留 running/pending', after.steps.every((s) => s.status === 'done' || s.status === 'skipped'));
}

console.log('\n── 2. 最后一步卡住但任务标 done：也要收成 100% ──');
{
  const job = importJobs.create('curl', 'check', STEPS);
  importJobs.setStatus(job.id, 'running');
  importJobs.setStep(job.id, 'fetch', { status: 'done' });
  importJobs.setStep(job.id, 'parse', { status: 'done' });
  importJobs.setStep(job.id, 'analyze', { status: 'running' });
  // naming 一直没动
  const before = importJobs.get(job.id);
  check('收尾前确实是 50%', before.progress === 50, String(before.progress));
  importJobs.finish(job.id, 'done', {}, null, false);
  const after = importJobs.get(job.id);
  check('收尾后 progress 是 100', after.progress === 100, String(after.progress));
  check(
    'running/pending 都被落成 skipped',
    after.steps.every((s) => s.status === 'done' || s.status === 'skipped'),
    after.steps.map((s) => `${s.key}:${s.status}`).join(' '),
  );
}

console.log('\n── 3. 失败收尾：不伪造 100%，但也不能留 running ──');
{
  const job = importJobs.create('curl', 'check', STEPS);
  importJobs.setStatus(job.id, 'running');
  importJobs.setStep(job.id, 'fetch', { status: 'done' });
  importJobs.setStep(job.id, 'parse', { status: 'running' });
  importJobs.finish(job.id, 'failed', {}, '上游 500', false);
  const after = importJobs.get(job.id);
  check('status 是 failed', after.status === 'failed', after.status);
  check('progress 不是 100', after.progress < 100, String(after.progress));
  check('没有残留 running/pending', after.steps.every((s) => s.status !== 'running' && s.status !== 'pending'));
  check('error 有值', after.error === '上游 500', String(after.error));
}

console.log(`\n${fail === 0 ? '✔ 全部通过' : '✖ 有失败'}：通过 ${pass}，失败 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
