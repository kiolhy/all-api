/**
 * 后台导入执行器
 *
 * 一键整理可能要跑几十秒（探测上游 + 多次 LLM 调用），不能占着 HTTP 请求。
 * 所以：
 *   1. 路由先建任务（queued）并立即返回 jobId
 *   2. 这里在后台跑流水线，逐步把状态写进 import_job
 *   3. 前端轮询 /api/import/jobs/:id 看进度
 *
 * 进程内只保留「正在跑」的任务句柄，历史记录全在数据库里，
 * 所以切页面、刷新、甚至关掉控制台都不影响后台继续跑。
 */

import { importJobs, type ImportStep } from '@aah/core';
import { makeSteps, runImport, type ImportOptions, type ImportStats } from '@aah/core';
import { EventEmitter } from 'node:events';

export type RunningJob = {
  jobId: string;
  startedAt: number;
  abort: AbortController;
};

const running = new Map<string, RunningJob>();

/* ────────── 任务事件总线 ──────────
 * 导入进度用 SSE 推给前端，不再让前端轮询。
 * 这里只做进程内广播：单机自用，不需要 Redis 之类的跨进程通道。
 */

export type JobEvent = {
  jobId: string;
  job: ReturnType<typeof getJob>;
  isRunning: boolean;
};

const bus = new EventEmitter();
// 多个页面/标签页同时订阅时别触发 MaxListeners 警告
bus.setMaxListeners(64);

/** 订阅任务变化，返回取消订阅函数 */
export function onJobEvent(fn: (event: JobEvent) => void): () => void {
  bus.on('job', fn);
  return () => {
    bus.off('job', fn);
  };
}

/** 重新读一遍任务并广播（步骤是 8 次 DB 读，可以忽略） */
function emitJob(jobId: string): void {
  bus.emit('job', {
    jobId,
    job: getJob(jobId),
    isRunning: running.has(jobId),
  } satisfies JobEvent);
}

/** 服务启动时调用：把上次异常退出遗留的 running 任务标为中断 */
export function recoverInterruptedJobs(): number {
  const n = importJobs.markInterrupted();
  if (n > 0) {
    console.warn(`[import] ${n} 个导入任务因服务重启被标记为中断`);
  }
  return n;
}

export function isRunning(jobId: string): boolean {
  return running.has(jobId);
}

export function runningCount(): number {
  return running.size;
}

export type StartResult = {
  jobId: string;
  status: 'queued';
};

/**
 * 建任务并在后台开跑。立即返回，不等流水线完成。
 */
export function startBackgroundImport(opts: ImportOptions): StartResult {
  const kind = opts.kind && opts.kind !== 'auto' ? opts.kind : 'text';
  const job = importJobs.create(kind, `${opts.text.length}B`, makeSteps());

  const abort = new AbortController();
  running.set(job.id, { jobId: job.id, startedAt: Date.now(), abort });
  emitJob(job.id);

  // 不 await：让 HTTP 立刻返回
  void (async () => {
    try {
      await runImport({
        ...opts,
        jobId: job.id,
        // 每完成一步就广播一次，前端立刻看到步骤变化
        onStep: () => emitJob(job.id),
      });
    } catch (err) {
      // runImport 内部已经兜底，这里只防最后一道
      const message = (err as Error).message;
      importJobs.finish(job.id, 'failed', {} as Record<string, unknown>, message, false);
    } finally {
      running.delete(job.id);
      emitJob(job.id);
    }
  })();

  return { jobId: job.id, status: 'queued' };
}

/** 任务列表（带步骤），供「整理记录」页 */
export function listJobs(limit = 50) {
  return importJobs.list(limit).map((job) => ({
    ...job,
    isRunning: running.has(job.id),
  }));
}

/** 单个任务详情 */
export function getJob(id: string) {
  const job = importJobs.get(id);
  if (!job) return null;
  return { ...job, isRunning: running.has(id) };
}

export type { ImportStep, ImportStats };
