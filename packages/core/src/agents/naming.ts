/**
 * 命名 Agent
 *
 * 职责：为每个接口生成**对外工具名**和**参数说明**。
 *
 * 为什么单独一个 Agent：
 * - 对外名是安全边界，必须与上游路径解耦，不能让模型「照着路径抄」
 * - 命名要全局唯一，需要看到整批接口才能避免撞名
 * - 参数说明要面向调用方，措辞和内部备注不同
 */

import { z } from 'zod';
import type { LlmConfig } from '../config.ts';
import type { NormalizedDraft } from '../import/types.ts';
import { chatJson } from '../ai/client.ts';
import { looksLikeUpstreamPath } from '../tools/describe.ts';

/** 宽松 schema：模型给什么就收什么，缺字段不影响其它 */
const lenientString = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((v) => String(v))
  .catch('');

const NamingItemSchema = z.object({
  i: z.coerce.number().int().catch(-1),
  publicName: lenientString.optional(),
  description: lenientString.optional(),
  paramDescriptions: z.record(z.unknown()).catch({}).optional(),
  paramRequired: z
    .union([z.array(lenientString), lenientString.transform((s) => (s ? [s] : []))])
    .catch([])
    .optional(),
  paramTypes: z.record(z.unknown()).catch({}).optional(),
});

/** items 宽松：不是数组就当空 */
const NamingResponseSchema = z.object({
  items: z.array(z.unknown()).catch([]),
});

export type NamingStats = {
  aiUsed: boolean;
  named: number;
  skipped: number;
  errors: string[];
  /** 重名后自动加后缀的接口 */
  renamed: string[];
};

const BATCH = 20;

const SYSTEM = `你是 API 对外命名专家。用户要把他人的接口包装成自己的网关对外提供，
所以对外名**绝对不能泄露上游信息**。

输出 JSON：{"items":[{"i":0,...}]}，不要 markdown 代码块。

每个 item 字段：
- i：输入序号，必填
- publicName：对外工具名。规则：
  · 只用小写字母、数字、下划线
  · 动词_名词 结构，如 query_user、list_orders、create_ticket、cancel_order
  · 长度 3-48 字符
  · **禁止**出现：api、v1、v2、rest、http、get_（作为前缀时）、post_、上游域名片段、上游产品名
  · 同一批里必须互不相同
  · 要让人一眼看懂做什么，但看不出背后是谁
- paramDescriptions：键是参数名，值是给调用方看的中文说明，说清「传什么、什么格式」
  · 每个非密钥参数都要给，不许留空
  · 举例：page → "页码，从 1 开始"；limit → "每页条数，默认 20，最大 100"；userId → "用户唯一标识"
  · 同样不许出现上游路径、域名、版本号
- description：给调用方看的一两句功能说明，说清「做什么、什么时候用、有什么副作用」
  · 不要复述路径，不要出现 api / v1 / http 这类字样
  · 有写操作就点明「会修改数据」
- paramRequired：必填参数名数组
- paramTypes：参数名 → string/number/integer/boolean/array/object 之一

示例：
  GET /api/v1/users/{userId}  → publicName: "query_user"
  POST /api/v1/orders         → publicName: "create_order"
  GET /api/v1/orders?page=1   → publicName: "list_orders"`;

export async function nameDrafts(
  cfg: LlmConfig,
  drafts: NormalizedDraft[],
): Promise<NamingStats> {
  const stats: NamingStats = {
    aiUsed: false,
    named: 0,
    skipped: 0,
    errors: [],
    renamed: [],
  };
  if (!cfg.enabled || !cfg.apiKey) {
    stats.skipped = drafts.length;
    stats.errors.push('LLM 未启用，跳过对外命名（将回退到平台__接口）');
    return stats;
  }
  if (drafts.length === 0) return stats;

  // 已有对外名（分析 Agent 可能已经给过），撞车时以「本批内唯一」为准
  const used = new Set<string>();

  // 分析 Agent 已经给全对外名和参数说明的接口，不必再问一次模型。
  // 真实 LLM 一次调用动辄 20-30 秒，省一次就是实打实的等待时间。
  const needsNaming = drafts.filter((d) => {
    const hasName = Boolean(sanitizeName(d.endpoint.publicName));
    const paramsDescribed = d.endpoint.params.every((p) => p.secretRef || p.description.trim());
    return !(hasName && paramsDescribed);
  });
  const alreadyDone = drafts.length - needsNaming.length;
  if (alreadyDone > 0) {
    stats.named += alreadyDone;
    stats.aiUsed = true;
    for (const d of drafts) {
      const name = sanitizeName(d.endpoint.publicName);
      if (name) used.add(name);
    }
  }
  if (needsNaming.length === 0) return stats;

  for (let start = 0; start < needsNaming.length; start += BATCH) {
    const batch = needsNaming.slice(start, start + BATCH);
    const payload = batch.map((d, i) => ({
      i,
      method: d.endpoint.method,
      path: d.endpoint.pathTemplate,
      summary: d.endpoint.summary || '',
      description: d.endpoint.description || '',
      params: d.endpoint.params.map((p) => ({
        name: p.name,
        in: p.in,
        type: p.type,
        required: p.required,
      })),
    }));

    const result = await chatJson<unknown>(cfg, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({ items: payload }) },
    ]);

    if (!result.ok) {
      stats.errors.push(result.error);
      stats.skipped += batch.length;
      continue;
    }

    const parsed = NamingResponseSchema.safeParse(result.value);
    if (!parsed.success) {
      stats.errors.push(`命名结果不是预期的 JSON 对象：${parsed.error.issues[0]?.message ?? 'unknown'}`);
      stats.skipped += batch.length;
      continue;
    }

    // 逐条解析：单条坏掉不影响同批其它接口
    let badItems = 0;
    for (const raw of parsed.data.items) {
      const one = NamingItemSchema.safeParse(raw);
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

      // 分析 Agent 已经给过名字且没撞车 → 保留，不覆盖
      const existing = sanitizeName(draft.endpoint.publicName);
      let name = existing || sanitizeName(item.publicName);
      if (!name) {
        stats.skipped += 1;
        continue;
      }
      // 撞名就加序号
      if (used.has(name)) {
        let n = 2;
        while (used.has(`${name}_${n}`)) n += 1;
        stats.renamed.push(`${name} → ${name}_${n}`);
        name = `${name}_${n}`;
      }
      used.add(name);
      draft.endpoint.publicName = name;

      applyParamHints(draft, item);
      applyDescription(draft, item);
      stats.named += 1;
      stats.aiUsed = true;
    }
    if (badItems > 0) {
      stats.errors.push(`有 ${badItems} 条命名结果无法解析，已跳过`);
    }
  }

  return stats;
}

/** 清洗对外名：只留合法字符，去掉上游痕迹 */
export function sanitizeName(raw: string | undefined): string {
  if (!raw) return '';
  let name = raw.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!name || !/^[a-z]/.test(name)) return '';
  // 循环剥离上游痕迹前缀：api_v1_get_user → get_user
  let prev = '';
  while (prev !== name) {
    prev = name;
    name = name.replace(/^(api|rest|http|https|v\d+|gw|gateway)_+/g, '');
  }
  // 剥离尾部版本号
  name = name.replace(/_+v\d+$/g, '');
  if (!name || !/^[a-z]/.test(name)) return '';
  return name.slice(0, 64);
}

type NamingItem = z.infer<typeof NamingItemSchema>;

/** 模型给的对外描述：有内容且不含上游痕迹才收 */
function applyDescription(draft: NormalizedDraft, item: NamingItem): void {
  const text = (item.description ?? '').trim();
  if (!text) return;
  if (looksLikeUpstreamPath(text)) return;
  draft.endpoint.description = text.slice(0, 600);
}

function applyParamHints(draft: NormalizedDraft, item: NamingItem): void {
  const ep = draft.endpoint;
  for (const p of ep.params) {
    if (p.secretRef) continue;
    const desc = item.paramDescriptions?.[p.name];
    const descText = typeof desc === 'string' ? desc.trim() : desc == null ? '' : String(desc).trim();
    // 模型有时会把 `GET /api/v1/orders` 抄进参数说明 —— 这种一律丢掉，
    // 让 compileTool 的 paramHint 兜底，而不是把上游路径递给调用方。
    if (descText && !looksLikeUpstreamPath(descText)) p.description = descText;

    const type = item.paramTypes?.[p.name];
    const typeText = typeof type === 'string' ? type.trim() : '';
    if (['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(typeText)) {
      p.type = typeText as typeof p.type;
    }
  }
  if (item.paramRequired?.length) {
    const required = new Set(item.paramRequired.filter(Boolean));
    for (const p of ep.params) {
      if (p.secretRef) continue;
      p.required = required.has(p.name);
    }
  }
}
