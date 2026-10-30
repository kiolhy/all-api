/**
 * 分析 Agent
 *
 * 职责：拿到「接口定义 + 真实响应样本」后，判断这个接口到底做什么，
 * 并产出给人看的备注（notes）和给 AI 看的说明（summary/description）。
 *
 * 和原来的 enrich 的区别：
 * - enrich 只看路径和参数名，靠猜
 * - 这个 Agent 看真实返回的数据，能说出「返回的是订单列表，每条含订单号、
 *   金额、状态」，备注里能写清业务含义和注意事项
 */

import { z } from 'zod';
import type { LlmConfig } from '../config.ts';
import type { NormalizedDraft } from '../import/types.ts';
import type { ProbeOutcome } from './probe.ts';
import { chatJson } from '../ai/client.ts';
import { looksLikeUpstreamPath } from '../tools/describe.ts';
import { redactByKeyName } from '../invoke/redact.ts';

/**
 * 宽松 schema。
 *
 * 真实模型经常：
 * - 少给 keyFields 里的 meaning
 * - 把 cautions 写成字符串而不是数组
 * - sensitivity 写成「中等」而不是 medium
 * - i 写成字符串
 *
 * 严格 schema 会让**整批**作废。所以这里每个字段都用 .catch() 兜底，
 * 单个字段不合法就丢该字段，不影响其它字段和同批其它接口。
 */
const lenientString = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((v) => String(v))
  .catch('');

const AnalysisItemSchema = z.object({
  i: z.coerce.number().int().catch(-1),
  purpose: lenientString.optional(),
  notes: lenientString.optional(),
  summary: lenientString.optional(),
  description: lenientString.optional(),
  returnsWhat: lenientString.optional(),
  /** 关键字段：缺 meaning 也保留 name */
  keyFields: z
    .array(
      z
        .object({
          name: lenientString.optional(),
          meaning: lenientString.optional(),
        })
        .catch({}),
    )
    .catch([])
    .optional(),
  /** cautions 允许字符串或数组 */
  cautions: z
    .union([z.array(lenientString), lenientString.transform((s) => (s ? [s] : []))])
    .catch([])
    .optional(),
  publicName: lenientString.optional(),
  sensitivity: z
    .union([z.enum(['low', 'medium', 'high']), z.string()])
    .transform((v) => {
      const s = String(v).toLowerCase();
      if (s.includes('high') || s.includes('高')) return 'high' as const;
      if (s.includes('low') || s.includes('低')) return 'low' as const;
      if (s.includes('medium') || s.includes('中')) return 'medium' as const;
      return undefined;
    })
    .optional()
    .catch(undefined),
});

/** items 也宽松：不是数组就当空 */
const AnalysisResponseSchema = z.object({
  items: z.array(z.unknown()).catch([]),
});

export type AnalysisStats = {
  aiUsed: boolean;
  analyzed: number;
  skipped: number;
  errors: string[];
};

const BATCH = 6;

const SYSTEM = `你是 API 语义分析专家。用户会给你一批接口定义，其中部分带有**真实调用返回的响应样本**。
你的任务是判断每个接口实际做什么，并写出准确的中文备注。

关键要求：
1. 有真实响应样本（probe.sample）时，**必须依据样本内容**判断，不要靠路径猜。
   例如样本返回 {"list":[{"orderId":"A1","amount":99,"status":"paid"}]}，
   就应该判断为「查询订单列表，返回订单号、金额、支付状态」。
2. 如果 probe 里是 errorSample 而不是 sample，说明上游返回了 4xx/5xx。
   **错误响应不能代表接口正常返回结构**，必须按路径和参数保守推测，
   并在 notes 里注明「探测返回 {status}，未能获取正常响应，按路径推测」。
3. 没有样本（probe 为 null / skipped / failed）时，只能基于路径和参数做保守判断，
   并在 notes 里注明「未经实际调用验证」。
4. 绝对不要编造样本里不存在的字段。

输出 JSON：{"items":[{"i":0,...}]}，不要 markdown 代码块。每个 item 字段：

- i：对应输入序号，必填
- purpose：一句话说清这个接口做什么，≤40 字
- notes：**给人看的备注**，2-4 句。要包含：业务含义、返回什么数据、使用时要注意什么。
  这是运维/对接人员看的，要具体，不要空话。没有样本时结尾加「（未经实际调用验证）」
- summary：给 AI 看的一句话祈使句，≤30 字，如「按用户 ID 查询用户详情」
- description：给 AI 看的 1-3 句，说明用途和关键参数
- returnsWhat：返回数据的业务含义，一句话
- keyFields：从样本里挑 2-6 个关键字段，说明业务含义（没有样本就不给）
- cautions：调用前须知，如「会消耗配额」「数据有时间延迟」「需要先申请权限」（没有就不给）
- publicName：建议的对外工具名，小写字母+下划线，语义化，如 query_user、list_orders。
  **不要**包含上游路径痕迹（不要 api、v1、get_ 这类前缀）
- sensitivity：涉及个人信息/资金/密钥用 high；写操作用 medium；公开查询用 low`;

export async function analyzeDrafts(
  cfg: LlmConfig,
  drafts: NormalizedDraft[],
  probes: ProbeOutcome[],
): Promise<AnalysisStats> {
  const stats: AnalysisStats = { aiUsed: false, analyzed: 0, skipped: 0, errors: [] };
  if (!cfg.enabled || !cfg.apiKey) {
    stats.skipped = drafts.length;
    stats.errors.push('LLM 未启用，跳过 AI 分析（备注和接口介绍不会生成）');
    return stats;
  }
  if (drafts.length === 0) return stats;

  const probeByIndex = new Map(probes.map((p) => [p.index, p]));

  for (let start = 0; start < drafts.length; start += BATCH) {
    const batch = drafts.slice(start, start + BATCH);
    const payload = batch.map((d, i) => {
      const probe = probeByIndex.get(start + i);
      // 样本在库里是原始值（控制台要看真实数据），发给第三方模型前把 PII 打码
      const forLlm = (s: string): string => {
        try {
          return JSON.stringify(redactByKeyName(JSON.parse(s)));
        } catch {
          return s;
        }
      };
      return {
        i,
        method: d.endpoint.method,
        path: d.endpoint.pathTemplate,
        params: d.endpoint.params.map((p) => ({
          name: p.name,
          in: p.in,
          type: p.type,
          required: p.required,
          ...(p.description ? { description: p.description } : {}),
        })),
        // 关键：把真实响应样本给模型
        // 4xx/5xx 的响应体只是错误信息，明确标注，避免模型把它当正常结构
        probe: probe?.ok
          ? probe.errorResponse
            ? {
                status: probe.status,
                errorSample: forLlm(probe.sample),
                note: '这是错误响应，不能代表接口正常返回结构，请按路径保守推测',
              }
            : {
                status: probe.status,
                topLevelKeys: probe.topLevelKeys,
                sample: forLlm(probe.sample),
              }
          : probe?.error
            ? { failed: probe.error }
            : probe?.skippedReason
              ? { skipped: probe.skippedReason }
              : null,
      };
    });

    const result = await chatJson<unknown>(cfg, [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({ platform: batch[0]!.platformName, items: payload }),
      },
    ]);

    if (!result.ok) {
      stats.errors.push(result.error);
      stats.skipped += batch.length;
      continue;
    }

    const parsed = AnalysisResponseSchema.safeParse(result.value);
    if (!parsed.success) {
      stats.errors.push(`分析结果不是预期的 JSON 对象：${parsed.error.issues[0]?.message ?? 'unknown'}`);
      stats.skipped += batch.length;
      continue;
    }

    if (parsed.data.items.length === 0 && batch.length > 0) {
      // 模型返回了 JSON，但没有 items —— 把实际结构记下来，方便排查
      const raw = result.value;
      const keys =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? Object.keys(raw as object).slice(0, 8).join('、')
          : Array.isArray(raw)
            ? `数组(${raw.length})`
            : typeof raw;
      stats.errors.push(`模型未返回 items 字段（实际顶层：${keys}）`);
      stats.skipped += batch.length;
      continue;
    }

    // 逐条解析：单条坏掉不影响同批其它接口
    const covered = new Set<number>();
    let badItems = 0;
    for (const raw of parsed.data.items) {
      const one = AnalysisItemSchema.safeParse(raw);
      if (!one.success) {
        badItems += 1;
        continue;
      }
      const item = one.data;
      if (!Number.isInteger(item.i) || item.i < 0) {
        badItems += 1;
        continue;
      }
      const draft = batch[item.i];
      if (!draft) {
        badItems += 1;
        continue;
      }
      applyAnalysis(draft, item);
      covered.add(item.i);
      stats.analyzed += 1;
      stats.aiUsed = true;
    }
    if (badItems > 0) {
      stats.errors.push(`有 ${badItems} 条分析结果无法解析，已跳过`);
    }
    stats.skipped += batch.filter((_, i) => !covered.has(i)).length;
  }

  return stats;
}

type AnalysisItem = z.infer<typeof AnalysisItemSchema>;

function applyAnalysis(draft: NormalizedDraft, item: AnalysisItem): void {
  const ep = draft.endpoint;

  // 模型可能把 `GET /api/v1/orders` 原样抄回来当标题 —— 这种不收，
  // 让它落到 compileTool 的语义兜底（「查询 orders 列表」）。
  const summary = item.summary?.trim() ?? '';
  if (summary && !looksLikeUpstreamPath(summary)) ep.summary = summary;

  const desc = item.description?.trim() ?? '';
  if (desc && !looksLikeUpstreamPath(desc)) ep.description = desc;

  // 备注：把 purpose / notes / returnsWhat / keyFields / cautions 组装成一段人话
  const parts: string[] = [];
  if (item.notes?.trim()) {
    parts.push(item.notes.trim());
  } else if (item.purpose?.trim()) {
    // 模型只给了 purpose 没给 notes 时，用 purpose 兜底
    parts.push(item.purpose.trim());
  }
  if (item.returnsWhat?.trim() && !item.notes?.includes(item.returnsWhat)) {
    parts.push(`返回：${item.returnsWhat.trim()}`);
  }
  if (item.keyFields?.length) {
    const fields = item.keyFields
      .filter((f) => f.name)
      .map((f) => (f.meaning ? `${f.name}（${f.meaning}）` : f.name))
      .join('、');
    if (fields) parts.push(`关键字段：${fields}`);
  }
  if (item.cautions?.length) {
    const cautions = item.cautions.filter(Boolean);
    if (cautions.length) parts.push(`注意：${cautions.join('；')}`);
  }
  if (parts.length) ep.notes = parts.join('\n');

  if (item.publicName?.trim()) {
    const name = item.publicName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
    if (name && /^[a-z]/.test(name)) ep.publicName = name.slice(0, 64);
  }

  if (item.sensitivity) ep.sensitivity = item.sensitivity;
}
