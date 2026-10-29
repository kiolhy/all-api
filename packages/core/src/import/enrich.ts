import { z } from 'zod';
import type { LlmConfig } from '../config.ts';
import type { NormalizedDraft } from './types.ts';
import { chatJson } from '../ai/client.ts';
import { slugify } from './normalize.ts';

const EnrichItemSchema = z.object({
  i: z.number().int(),
  slug: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  group: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sideEffect: z.enum(['read', 'write']).optional(),
  sensitivity: z.enum(['low', 'medium', 'high']).optional(),
  paramDescriptions: z.record(z.string()).optional(),
  paramTypes: z.record(z.string()).optional(),
  paramRequired: z.array(z.string()).optional(),
});

const EnrichResponseSchema = z.object({ items: z.array(EnrichItemSchema) });

export type EnrichStats = {
  aiUsed: boolean;
  enriched: number;
  skipped: number;
  errors: string[];
};

const BATCH = 20;

const SYSTEM = `你是 API 资产整理专家。用户会给你一批从真实请求里还原出来的接口草稿（方法、路径模板、参数、请求体样例）。
你的任务是给每个接口补充语义信息，让 AI 助手能理解并正确调用它。

要求：
1. 只输出 JSON 对象：{"items":[{"i":0,...}]}，不要任何解释、不要 markdown 代码块。
2. 每个 item 必须带 i（对应输入序号）。
3. slug：小写字母/数字/下划线，语义化动词_名词（如 get_user_profile、search_orders），不要用数字开头。
4. summary：一句中文祈使句，说清「做什么 + 返回什么」，≤30 字。
5. description：中文 1-3 句，说明用途、关键参数含义、注意事项；如果从路径/参数看是写操作，要提醒会修改数据。
6. group：业务分组（中文或英文小写单词均可，如 user、order、content）。
7. tags：2-4 个中文短标签。
8. sideEffect：只读查询用 read，任何会改数据/发消息/下单的用 write。
9. sensitivity：涉及个人信息、资金、密钥的用 high；写操作用 medium；公开查询用 low。
10. paramDescriptions：键是参数名，值是中文说明；paramTypes 键是参数名，值是 string/number/integer/boolean/array/object 之一；paramRequired 是必填参数名数组。
11. 不要编造输入里不存在的参数。`;

export async function enrichDrafts(cfg: LlmConfig, drafts: NormalizedDraft[]): Promise<EnrichStats> {
  const stats: EnrichStats = { aiUsed: false, enriched: 0, skipped: 0, errors: [] };
  if (!cfg.enabled || !cfg.apiKey || drafts.length === 0) {
    stats.skipped = drafts.length;
    return stats;
  }

  for (let start = 0; start < drafts.length; start += BATCH) {
    const batch = drafts.slice(start, start + BATCH);
    const payload = batch.map((d, i) => ({
      i,
      method: d.endpoint.method,
      path: d.endpoint.pathTemplate,
      params: d.endpoint.params.map((p) => ({
        name: p.name,
        in: p.in,
        type: p.type,
        required: p.required,
        ...(p.example !== undefined && typeof p.example !== 'object' ? { example: p.example } : {}),
      })),
      bodySample: d.endpoint.body?.example ? d.endpoint.body.example.slice(0, 600) : null,
      host: d.platformBaseUrl,
    }));

    const result = await chatJson<unknown>(cfg, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({ platform: batch[0].platformName, items: payload }) },
    ]);

    if (!result.ok) {
      stats.errors.push(result.error);
      stats.skipped += batch.length;
      continue;
    }

    const parsed = EnrichResponseSchema.safeParse(result.value);
    if (!parsed.success) {
      stats.errors.push(`返回结构不符：${parsed.error.issues[0]?.message ?? 'unknown'}`);
      stats.skipped += batch.length;
      continue;
    }

    for (const item of parsed.data.items) {
      const draft = batch[item.i];
      if (!draft) continue;
      applyEnrichment(draft, item);
      stats.enriched += 1;
      stats.aiUsed = true;
    }
    const covered = new Set(parsed.data.items.map((x) => x.i));
    stats.skipped += batch.filter((_, i) => !covered.has(i)).length;
  }

  return stats;
}

type EnrichItem = z.infer<typeof EnrichItemSchema>;

function applyEnrichment(draft: NormalizedDraft, item: EnrichItem): void {
  const ep = draft.endpoint;
  if (item.slug) {
    const candidate = slugify(item.slug);
    if (candidate && candidate !== ep.slug) ep.slug = candidate;
  }
  if (item.summary) ep.summary = item.summary.trim();
  if (item.description) ep.description = item.description.trim();
  if (item.group) ep.group = slugify(item.group, ep.group);
  if (item.tags?.length) ep.tags = [...new Set([...ep.tags, ...item.tags])].slice(0, 6);
  if (item.sideEffect) ep.sideEffect = item.sideEffect;
  if (item.sensitivity) ep.sensitivity = item.sensitivity;

  for (const p of ep.params) {
    const desc = item.paramDescriptions?.[p.name];
    if (desc && !p.secretRef) p.description = desc;
    const type = item.paramTypes?.[p.name];
    if (type && ['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(type)) {
      p.type = type as typeof p.type;
    }
  }
  if (item.paramRequired?.length) {
    const required = new Set(item.paramRequired);
    for (const p of ep.params) {
      if (p.secretRef) continue;
      p.required = required.has(p.name);
    }
  }
}

/** 纯文本/文档 → 接口草稿（LLM 抽取） */
export async function extractDraftsFromText(
  cfg: LlmConfig,
  text: string,
  hint: { platformSlug?: string; platformName?: string; baseUrl?: string },
): Promise<{ drafts: Array<{ method: string; path: string; summary: string; params: Array<{ name: string; in: string; required: boolean; description: string }> }>; error?: string }> {
  const system = `你是 API 文档解析器。从用户给出的文档/说明里抽取 HTTP 接口清单。
只输出 JSON：{"drafts":[{"method":"GET","path":"/v1/xxx","summary":"中文一句话","params":[{"name":"id","in":"path","required":true,"description":"中文说明"}]}]}
规则：path 用 {name} 表示路径参数；in 只能是 path/query/header/body；不要编造文档里没有的接口；没有接口就返回 {"drafts":[]}。`;

  const result = await chatJson<unknown>(cfg, [
    { role: 'system', content: system },
    {
      role: 'user',
      content: JSON.stringify({
        platform: hint.platformName ?? hint.platformSlug ?? '',
        baseUrl: hint.baseUrl ?? '',
        document: text.slice(0, 12000),
      }),
    },
  ]);

  if (!result.ok) return { drafts: [], error: result.error };

  const schema = z.object({
    drafts: z.array(
      z.object({
        method: z.string(),
        path: z.string(),
        summary: z.string().optional(),
        params: z
          .array(
            z.object({
              name: z.string(),
              in: z.string().optional(),
              required: z.boolean().optional(),
              description: z.string().optional(),
            }),
          )
          .optional(),
      }),
    ),
  });
  const parsed = schema.safeParse(result.value);
  if (!parsed.success) return { drafts: [], error: '抽取结果结构不符' };

  return {
    drafts: parsed.data.drafts.map((d) => ({
      method: d.method.toUpperCase(),
      path: d.path,
      summary: d.summary ?? '',
      params: (d.params ?? []).map((p) => ({
        name: p.name,
        in: p.in ?? 'query',
        required: Boolean(p.required),
        description: p.description ?? '',
      })),
    })),
  };
}
