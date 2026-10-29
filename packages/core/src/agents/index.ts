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
  /** 步骤回调，用来给前端报进度 */
  onStep?: (key: 'probe' | 'analyze' | 'naming', patch: StepPatch) => void;
};

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
    analyze = await analyzeDrafts(cfg, drafts, probe.outcomes);
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
    naming = await nameDrafts(cfg, drafts);
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
