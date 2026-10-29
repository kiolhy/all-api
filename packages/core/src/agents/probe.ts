/**
 * 探测 Agent
 *
 * 职责：在整理接口时，对只读接口发一次真实请求，拿到真实响应样本。
 * 有了真实响应，后续的分析 Agent 才能判断「这个接口到底返回什么、是干什么用的」，
 * 而不是靠路径猜。
 *
 * 安全约束（很重要，因为这是**自动**发请求）：
 * 1. 只探测 read 类接口；write/DELETE 一律不碰，避免误改数据。
 * 2. 只探测「所有必填参数都有可用样例值」的接口；缺参数就跳过，不瞎猜。
 * 3. 走和正式调用完全相同的出网护栏（域名白名单、私网拦截、超时、大小上限）。
 * 4. 响应体先脱敏再交给 LLM，且截断。
 * 5. 探测失败不影响整理流程，只记录原因。
 */

import type { PlatformRecord } from '../schema/asset.ts';
import type { NormalizedDraft } from '../import/types.ts';
import { probeEndpoint } from '../invoke/probe.ts';

export type ProbeOutcome = {
  /** 草稿在数组里的下标 */
  index: number;
  ok: boolean;
  status: number;
  latencyMs: number;
  /** 脱敏后的响应样本（JSON 文本，已截断） */
  sample: string;
  /** 顶层字段名，帮助分析 Agent 判断结构 */
  topLevelKeys: string[];
  /**
   * 响应是 4xx/5xx。
   * 这类响应体只是错误信息，**不能**当作接口的正常返回结构，
   * 分析 Agent 必须据此降级为「按路径推测」。
   */
  errorResponse?: boolean;
  /** 失败原因 */
  error?: string;
  /** 为什么没探测 */
  skippedReason?: string;
};

export type ProbeStats = {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  outcomes: ProbeOutcome[];
};

const MAX_SAMPLE_CHARS = 2000;

/** 从响应里提取顶层字段名，帮助 LLM 理解结构 */
function topLevelKeysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    const first = value[0];
    if (first && typeof first === 'object') return Object.keys(first as object).slice(0, 20);
    return [];
  }
  if (value && typeof value === 'object') return Object.keys(value as object).slice(0, 20);
  return [];
}

/**
 * 判断这个接口能不能安全地自动探测。
 * 返回 null 表示可以探测，否则返回跳过原因。
 */
export function probeSkipReason(draft: NormalizedDraft): string | null {
  const ep = draft.endpoint;

  // 1. 只碰只读接口
  if (ep.sideEffect !== 'read') return '写操作，不自动探测';
  if (ep.method !== 'GET' && ep.method !== 'HEAD') return `方法 ${ep.method} 不自动探测`;

  // 2. 必填参数必须都有样例值
  for (const p of ep.params) {
    if (p.secretRef) continue; // 密钥由网关注入
    if (!p.required) continue;
    const hasExample = p.example !== undefined && p.example !== null && p.example !== '';
    const hasDefault = p.default !== undefined && p.default !== null && p.default !== '';
    if (!hasExample && !hasDefault) {
      return `必填参数 ${p.name} 没有样例值，跳过探测`;
    }
  }

  return null;
}

/** 把草稿的样例值组装成探测用的入参 */
function buildProbeArgs(draft: NormalizedDraft): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const p of draft.endpoint.params) {
    if (p.secretRef) continue;
    const value =
      p.default !== undefined && p.default !== null && p.default !== ''
        ? p.default
        : p.example;
    if (value !== undefined && value !== null && value !== '') {
      args[p.name] = value;
    }
  }
  return args;
}

/**
 * 批量探测一批草稿。
 * platform 需要已经落地（有 id / baseUrl / 出网配置）。
 */
export async function probeDrafts(
  drafts: NormalizedDraft[],
  platformFor: (draft: NormalizedDraft) => PlatformRecord | null,
  opts: { maxProbes?: number; concurrency?: number } = {},
): Promise<ProbeStats> {
  const stats: ProbeStats = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    outcomes: [],
  };

  const maxProbes = opts.maxProbes ?? 12;
  const concurrency = Math.max(1, opts.concurrency ?? 3);

  // 先筛出可探测的
  const queue: Array<{ index: number; draft: NormalizedDraft; platform: PlatformRecord }> = [];
  drafts.forEach((draft, index) => {
    const reason = probeSkipReason(draft);
    if (reason) {
      stats.skipped += 1;
      stats.outcomes.push({
        index,
        ok: false,
        status: 0,
        latencyMs: 0,
        sample: '',
        topLevelKeys: [],
        skippedReason: reason,
      });
      return;
    }
    const platform = platformFor(draft);
    if (!platform) {
      stats.skipped += 1;
      stats.outcomes.push({
        index,
        ok: false,
        status: 0,
        latencyMs: 0,
        sample: '',
        topLevelKeys: [],
        skippedReason: '平台未落地',
      });
      return;
    }
    queue.push({ index, draft, platform });
  });

  // 限制探测数量，避免一次导入打爆上游
  const limited = queue.slice(0, maxProbes);
  for (const item of queue.slice(maxProbes)) {
    stats.skipped += 1;
    stats.outcomes.push({
      index: item.index,
      ok: false,
      status: 0,
      latencyMs: 0,
      sample: '',
      topLevelKeys: [],
      skippedReason: `超出单次探测上限（${maxProbes}），未探测`,
    });
  }

  // 并发跑，但每个都独立失败
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= limited.length) return;
      const { index, draft, platform } = limited[i]!;
      stats.attempted += 1;

      const args = buildProbeArgs(draft);
      const result = await probeEndpoint({
        platform,
        method: draft.endpoint.method,
        pathTemplate: draft.endpoint.pathTemplate,
        params: draft.endpoint.params,
        args,
      });

      if (!result.ok) {
        stats.failed += 1;
        stats.outcomes.push({
          index,
          ok: false,
          status: result.status,
          latencyMs: result.latencyMs,
          sample: '',
          topLevelKeys: [],
          error: result.error,
        });
        continue;
      }

      stats.succeeded += 1;
      const json = JSON.stringify(result.body);
      stats.outcomes.push({
        index,
        ok: true,
        status: result.status,
        latencyMs: result.latencyMs,
        sample: json.length > MAX_SAMPLE_CHARS ? `${json.slice(0, MAX_SAMPLE_CHARS)}…` : json,
        topLevelKeys: topLevelKeysOf(result.body),
        errorResponse: result.errorResponse,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, limited.length) }, () => worker()));
  stats.outcomes.sort((a, b) => a.index - b.index);
  return stats;
}
