import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { PROJECT_ROOT } from '@aah/core';

/**
 * 在线更新：基于 git。
 *
 * 这是「源码直跑」的部署形态（Node 直接执行 .ts，没有编译产物），
 * 所以更新 = `git pull` + 重建前端 bundle + 重启进程。
 * 不做二进制自替换 —— 那需要另一套签名与原子切换，对单机自用不值当。
 */

type GitRun = { ok: boolean; out: string; err: string };

function bin(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function run(
  file: string,
  args: string[],
  timeoutMs: number,
  useShell = false,
): Promise<GitRun> {
  return new Promise((done) => {
    execFile(
      file,
      args,
      {
        cwd: PROJECT_ROOT,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        // Windows 上 npm/npx 是 .cmd，Node 不允许直接 spawn（抛 EINVAL），
        // 必须交给 shell。参数都是仓库内的相对路径，不含空格与元字符。
        shell: useShell,
        env: {
          ...process.env,
          // 绝不等待交互输入：没有凭证就立刻失败，而不是把请求挂死
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_ASKPASS: 'echo',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          done({
            ok: false,
            out: String(stdout ?? '').trim(),
            err: String(stderr ?? '').trim() || error.message,
          });
          return;
        }
        done({ ok: true, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() });
      },
    );
  });
}

const git = (args: string[], timeoutMs = 20000) => run('git', args, timeoutMs);

export type UpdateState = {
  /** 当前版本（来自根 package.json） */
  version: string;
  isGit: boolean;
  branch: string;
  commit: string;
  shortCommit: string;
  commitSubject: string;
  commitDate: string;
  /** 工作区有未提交改动时为 true，此时不允许更新（会覆盖本地修改） */
  dirty: boolean;
  remote: string;
  upstream: string;
  hasUpstream: boolean;
  /** 落后远程几个提交 */
  behind: number;
  ahead: number;
  latestCommit: string;
  latestSubject: string;
  canUpdate: boolean;
  /** 面向用户的一句话说明 */
  message: string;
  checkedAt: string | null;
};

let lastCheck: { at: number; state: UpdateState } | null = null;
const CHECK_TTL_MS = 30_000;

function readVersion(): string {
  try {
    // 根 package.json 的 version 是唯一版本号来源
    const pkg = JSON.parse(readFileSync(`${PROJECT_ROOT}/package.json`, 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function blank(version: string, message: string): UpdateState {
  return {
    version,
    isGit: false,
    branch: '',
    commit: '',
    shortCommit: '',
    commitSubject: '',
    commitDate: '',
    dirty: false,
    remote: '',
    upstream: '',
    hasUpstream: false,
    behind: 0,
    ahead: 0,
    latestCommit: '',
    latestSubject: '',
    canUpdate: false,
    message,
    checkedAt: null,
  };
}

/** 只读本地信息，不联网。 */
export async function localState(): Promise<UpdateState> {
  const version = readVersion();
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') {
    return blank(version, '当前目录不是 git 仓库，无法在线更新');
  }

  const [branch, commit, subject, date, status, remote] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['rev-parse', 'HEAD']),
    git(['log', '-1', '--format=%s']),
    git(['log', '-1', '--format=%cI']),
    // 只看已跟踪文件的改动：未跟踪的文件（草稿、日志、bug.txt 之类）
    // 不会被 pull 覆盖，拿它们挡住更新等于把在线更新永久禁用。
    git(['status', '--porcelain', '--untracked-files=no']),
    git(['remote', 'get-url', 'origin']),
  ]);

  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);

  const state = blank(version, '尚未检查更新');
  state.isGit = true;
  state.branch = branch.ok ? branch.out : '';
  state.commit = commit.ok ? commit.out : '';
  state.shortCommit = state.commit.slice(0, 7);
  state.commitSubject = subject.ok ? subject.out : '';
  state.commitDate = date.ok ? date.out : '';
  state.dirty = status.ok && status.out.length > 0;
  state.remote = remote.ok ? remote.out : '';
  state.hasUpstream = upstream.ok && upstream.out.length > 0;
  state.upstream = state.hasUpstream ? upstream.out : state.branch ? `origin/${state.branch}` : '';
  state.canUpdate = state.isGit && !state.dirty;
  state.message = state.dirty
    ? '有未提交的本地改动，更新会覆盖它们'
    : '已提交，可以检查更新';
  return state;
}

/** 联网检查：fetch 后比较领先/落后。 */
export async function checkUpdate(force = false): Promise<UpdateState> {
  if (!force && lastCheck && Date.now() - lastCheck.at < CHECK_TTL_MS) {
    return lastCheck.state;
  }

  const state = await localState();
  const stamp = new Date().toISOString();

  if (!state.isGit) {
    state.checkedAt = stamp;
    lastCheck = { at: Date.now(), state };
    return state;
  }
  if (!state.remote) {
    state.message = '没有配置 origin 远程，无法检查更新';
    state.checkedAt = stamp;
    lastCheck = { at: Date.now(), state };
    return state;
  }

  const fetched = await git(['fetch', '--quiet', '--prune', 'origin'], 30000);
  if (!fetched.ok) {
    state.message = `拉取远程失败：${fetched.err.split('\n')[0] || '网络或凭证问题'}`;
    state.checkedAt = stamp;
    lastCheck = { at: Date.now(), state };
    return state;
  }

  const ref = state.hasUpstream ? '@{u}' : `origin/${state.branch}`;
  const exists = await git(['rev-parse', '--verify', '--quiet', ref]);
  if (!exists.ok) {
    state.message = `远程还没有 ${state.branch} 分支（仓库是空的？）`;
    state.checkedAt = stamp;
    lastCheck = { at: Date.now(), state };
    return state;
  }

  const behind = await git(['rev-list', '--count', `HEAD..${ref}`]);
  const ahead = await git(['rev-list', '--count', `${ref}..HEAD`]);
  const latest = await git(['log', '-1', '--format=%H%n%s', ref]);

  state.behind = behind.ok ? Number(behind.out) || 0 : 0;
  state.ahead = ahead.ok ? Number(ahead.out) || 0 : 0;
  const [lc, ls] = latest.ok ? latest.out.split('\n') : ['', ''];
  state.latestCommit = lc ?? '';
  state.latestSubject = ls ?? '';

  if (state.dirty) {
    state.message = '有未提交的本地改动，更新会覆盖它们';
    state.canUpdate = false;
  } else if (state.behind > 0) {
    state.canUpdate = true;
    state.message = `落后远程 ${state.behind} 个提交`;
  } else {
    state.canUpdate = false;
    state.message = state.ahead > 0 ? `已是最新（本地领先 ${state.ahead} 个提交）` : '已是最新';
  }

  state.checkedAt = stamp;
  lastCheck = { at: Date.now(), state };
  return state;
}

export type UpdateStep = {
  name: string;
  ok: boolean;
  /** 命令失败时的关键输出；成功时通常为空 */
  detail: string;
  skipped?: boolean;
};

export type ApplyResult = {
  ok: boolean;
  restarted: boolean;
  /** 需要重启才能生效 */
  restartRequired: boolean;
  before: { commit: string; shortCommit: string };
  after: { commit: string; shortCommit: string };
  steps: UpdateStep[];
  message: string;
};

/**
 * 执行更新。
 *
 * 只走 fast-forward，绝不产生本地合并提交 —— 单机部署出现冲突时让人来处理，
 * 而不是留一个半合并的仓库。
 */
export async function applyUpdate(): Promise<ApplyResult> {
  const before = await localState();
  const steps: UpdateStep[] = [];

  if (!before.isGit) {
    return {
      ok: false,
      restarted: false,
      restartRequired: false,
      before: { commit: '', shortCommit: '' },
      after: { commit: '', shortCommit: '' },
      steps: [{ name: '检查仓库', ok: false, detail: '当前目录不是 git 仓库' }],
      message: '无法更新：不是 git 仓库',
    };
  }
  if (before.dirty) {
    return {
      ok: false,
      restarted: false,
      restartRequired: false,
      before: { commit: before.commit, shortCommit: before.shortCommit },
      after: { commit: before.commit, shortCommit: before.shortCommit },
      steps: [{ name: '检查工作区', ok: false, detail: '有未提交的本地改动，先提交或还原再更新' }],
      message: '无法更新：工作区不干净',
    };
  }

  if (!before.branch || before.branch === 'HEAD') {
    return {
      ok: false,
      restarted: false,
      restartRequired: false,
      before: { commit: before.commit, shortCommit: before.shortCommit },
      after: { commit: before.commit, shortCommit: before.shortCommit },
      steps: [{ name: '检查分支', ok: false, detail: '当前处于游离 HEAD，先切到一个分支再更新' }],
      message: '无法更新：不在任何分支上',
    };
  }

  // 没有上游跟踪时 `git pull` 会直接报 "no tracking information"，
  // 必须显式给出 remote 和分支
  const pullArgs = before.hasUpstream
    ? ['pull', '--ff-only']
    : ['pull', '--ff-only', 'origin', before.branch];
  const pull = await git(pullArgs, 120000);
  steps.push({
    name: `git ${pullArgs.join(' ')}`,
    ok: pull.ok,
    detail: pull.ok ? '' : pull.err.split('\n').slice(0, 4).join(' '),
  });
  if (!pull.ok) {
    return {
      ok: false,
      restarted: false,
      restartRequired: false,
      before: { commit: before.commit, shortCommit: before.shortCommit },
      after: { commit: before.commit, shortCommit: before.shortCommit },
      steps,
      message: '拉取失败，仓库未改变',
    };
  }

  const after = await localState();
  const changed = before.commit !== after.commit;

  if (!changed) {
    steps.push({ name: '比对提交', ok: true, detail: '已是最新，无需重建', skipped: true });
    return {
      ok: true,
      restarted: false,
      restartRequired: false,
      before: { commit: before.commit, shortCommit: before.shortCommit },
      after: { commit: after.commit, shortCommit: after.shortCommit },
      steps,
      message: '已经是最新版本',
    };
  }

  // 依赖变了才装，否则白等几分钟
  const diff = await git(['diff', '--name-only', `${before.commit}..${after.commit}`]);
  const files = diff.ok ? diff.out.split('\n').filter(Boolean) : [];
  const depsChanged =
    files.includes('package.json') ||
    files.includes('package-lock.json') ||
    files.some((f) => f.endsWith('/package.json'));

  if (depsChanged) {
    const install = await run(bin('npm'), ['install', '--no-audit', '--no-fund'], 600000, true);
    steps.push({
      name: 'npm install',
      ok: install.ok,
      detail: install.ok ? '' : install.err.split('\n').slice(0, 4).join(' '),
    });
    if (!install.ok) {
      return {
        ok: false,
        restarted: false,
        restartRequired: true,
        before: { commit: before.commit, shortCommit: before.shortCommit },
        after: { commit: after.commit, shortCommit: after.shortCommit },
        steps,
        message: '代码已更新，但依赖安装失败，需要手动处理后重启',
      };
    }
  } else {
    steps.push({ name: 'npm install', ok: true, detail: '依赖未变化，跳过', skipped: true });
  }

  // 前端 dist 不入库，必须重建，否则页面还是旧的
  if (existsSync(`${PROJECT_ROOT}/apps/web/vite.config.ts`)) {
    const build = await run(
      bin('npx'),
      ['vite', 'build', '--config', 'apps/web/vite.config.ts'],
      300000,
      true,
    );
    steps.push({
      name: '重建前端',
      ok: build.ok,
      detail: build.ok ? '' : build.err.split('\n').slice(0, 4).join(' '),
    });
  } else {
    steps.push({ name: '重建前端', ok: true, detail: '未找到前端工程，跳过', skipped: true });
  }

  const allOk = steps.every((s) => s.ok);
  return {
    ok: allOk,
    restarted: false,
    restartRequired: true,
    before: { commit: before.commit, shortCommit: before.shortCommit },
    after: { commit: after.commit, shortCommit: after.shortCommit },
    steps,
    message: allOk
      ? `已更新 ${before.shortCommit} → ${after.shortCommit}，重启后生效`
      : '代码已更新，但有步骤失败，检查上方输出后重启',
  };
}
