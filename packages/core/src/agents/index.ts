/**
 * Agent 编排器
 *
 * 把三个 Agent 串成一条流水线：
 *
 *   1. 探测 Agent   → 真实请求上游，拿响应样本
 *   2. 分析 Agent   → 看样本，判断用途，写备注
 *   3. 命名 Agent   → 生成对外名和参数说明
 *
 * 设计原则：
 * - 每一步失败都不阻断后续（探测失败 → 分析仍可基于路径做保守判断）
 * - 每一步都可单独关闭
 * - LLM 未启用时，整条链路优雅降级为「只做规则解析」
 */

import type { LlmConfig } from '../config.ts';
import type { PlatformRecord } from '../schema/asset.ts';
import type { NormalizedDraft } from '../import/types.ts';
import { probeDrafts, type ProbeStats } from './probe.ts';
import { analyzeDrafts, type AnalysisStats } from './analyze.ts';
import { nameDrafts, type NamingStats } from './naming.ts';

export type AgentOptions = {
  /** 是否探测上游（默认 true） */
  probe?: boolean;
  /** 是否做语义分析（默认 true） */
  analyze?: boolean;
  /** 是否生成对外名（默认 true） */
  naming?: boolean;
  /** 单次最多探测几个接口 */
  maxProbes?: number;
  /** 探测并发 */
  probeConcurrency?: number;
  /** 单个 AI 步骤的超时（毫秒），默认 45 秒 */
  aiTimeoutMs?: number;
  /** AI 步骤失败后重试几次，默认 1 */
  aiRetries?: number;
  /** 步骤回调，用来给前端报进度 */
  onStep?: (key: 'probe' | 'analyze' | 'naming', patch: StepPatch) => void;
};

const DEFAULT_AI_TIMEOUT_MS = Number(process.env.AI_STEP_TIMEOUT_MS ?? 45000);
const DEFAULT_AI_RETRIES = Number(process.env.AI_STEP_RETRIES ?? 1);

/**
 * 给 AI 步骤套一层超时 + 重试 + 降级。
 *
 * 卡住过的场景：上游模型不返回，整条一键整理就挂在那里，控制台只看到「分析中」。
 * 现在超时或报错都会重试一次，两次都不行就返回 fallback，把原因写进 errors，
 * 让流程继续往下走，界面上能看到「降级了、为什么」。
 */
async function runWithGuard<T>(
  label: string,
  run: () => Promise<T>,
  fallback: T,
  errors: string[],
  timeoutMs: number,
  retries: number,
): Promise<T> {
  const once = async (): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label}超时（${Math.round(timeoutMs / 1000)} 秒没有返回）`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([run(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const attempts = Math.max(0, retries) + 1;
  const reasons: string[] = [];
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await once();
    } catch (err) {
      reasons.push(`第 ${i + 1} 次：${(err as Error).message}`);
    }
  }
  errors.push(`${label}失败，已降级为规则解析（${reasons.join('；')}）`);
  return fallback;
}

export type StepPatch = {
  status?: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
};

export type AgentReport = {
  probe: ProbeStats;
  analyze: AnalysisStats;
  naming: NamingStats;
  /** 整体耗时 */
  elapsedMs: number;
  /** 一句话总结，给控制台显示 */
  summary: string;
};

/**
 * 跑完整流水线。
 * platformFor 用来把草稿映射到已落地的平台（探测需要 baseUrl 和出网配置）。
 */
export async function runAgents(
  cfg: LlmConfig,
  drafts: NormalizedDraft[],
  platformFor: (draft: NormalizedDraft) => PlatformRecord | null,
  opts: AgentOptions = {},
): Promise<AgentReport> {
  const started = Date.now();
  const emptyProbe: ProbeStats = { attempted: 0, succeeded: 0, failed: 0, skipped: 0, outcomes: [] };
  const emptyAnalyze: AnalysisStats = { aiUsed: false, analyzed: 0, skipped: 0, errors: [] };
  const emptyNaming: NamingStats = { aiUsed: false, named: 0, skipped: 0, errors: [], renamed: [] };

  // ── 1. 探测 ──
  let probe = emptyProbe;
  if (opts.probe !== false && drafts.length > 0) {
    opts.onStep?.('probe', { status: 'running', detail: '正在请求只读接口' });
    probe = await probeDrafts(drafts, platformFor, {
      maxProbes: opts.maxProbes,
      concurrency: opts.probeConcurrency,
    });
    opts.onStep?.('probe', {
      status: probe.attempted === 0 ? 'skipped' : 'done',
      detail:
        probe.attempted === 0
          ? `无可探测接口（跳过 ${probe.skipped}）`
          : `成功 ${probe.succeeded}/${probe.attempted}${probe.failed > 0 ? `，失败 ${probe.failed}` : ''}`,
    });
  } else {
    opts.onStep?.('probe', { status: 'skipped', detail: '已关闭探测' });
  }

  // ── 2. 分析 ──
  let analyze = emptyAnalyze;
  if (opts.analyze !== false) {
    opts.onStep?.('analyze', { status: 'running', detail: '正在判断用途并写备注' });
    const fallback: AnalysisStats = { aiUsed: false, analyzed: 0, skipped: drafts.length, errors: [] };
    analyze = await runWithGuard(
      'AI 分析',
      () => analyzeDrafts(cfg, drafts, probe.outcomes),
      fallback,
      fallback.errors,
      opts.aiTimeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
      opts.aiRetries ?? DEFAULT_AI_RETRIES,
    );
    opts.onStep?.('analyze', {
      status: analyze.analyzed === 0 ? 'skipped' : 'done',
      detail:
        analyze.analyzed === 0
          ? analyze.errors[0] ?? '未分析（LLM 未启用或无结果）'
          : `已分析 ${analyze.analyzed} 个接口`,
    });
  } else {
    opts.onStep?.('analyze', { status: 'skipped', detail: '已关闭' });
  }

  // ── 3. 命名 ──
  let naming = emptyNaming;
  if (opts.naming !== false) {
    opts.onStep?.('naming', { status: 'running', detail: '正在生成对外名' });
    const fallback: NamingStats = {
      aiUsed: false,
      named: 0,
      skipped: drafts.length,
      errors: [],
      renamed: [],
    };
    naming = await runWithGuard(
      'AI 命名',
      () => nameDrafts(cfg, drafts),
      fallback,
      fallback.errors,
      opts.aiTimeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
      opts.aiRetries ?? DEFAULT_AI_RETRIES,
    );
    opts.onStep?.('naming', {
      status: naming.named === 0 ? 'skipped' : 'done',
      detail:
        naming.named === 0
          ? naming.errors[0] ?? '未命名'
          : `已命名 ${naming.named} 个${naming.renamed.length ? `（${naming.renamed.length} 个重名已调整）` : ''}`,
    });
  } else {
    opts.onStep?.('naming', { status: 'skipped', detail: '已关闭' });
  }

  const elapsedMs = Date.now() - started;
  const parts: string[] = [];
  if (probe.attempted > 0) {
    parts.push(`探测 ${probe.succeeded}/${probe.attempted} 成功`);
  }
  if (analyze.analyzed > 0) parts.push(`分析 ${analyze.analyzed} 个`);
  if (naming.named > 0) parts.push(`命名 ${naming.named} 个`);
  if (parts.length === 0) parts.push('未启用 AI 增强');

  return {
    probe,
    analyze,
    naming,
    elapsedMs,
    summary: parts.join('，'),
  };
}
