/**
 * 试运行结果的「最小化」输出
 *
 * 真实事故：`POST /api/platforms/{id}/test` 把上游响应体原样回显给调用方，
 * 包括 401 的错误 JSON、整套控制台 HTML。配合"能指向任意地址"，
 * 盲测立刻升级成"全响应读取"，SSRF 的信息获取成本降到最低。
 *
 * 现在按状态分隔对待：
 *   - 2xx：返回**结构摘要**（键名 + 类型 + 截断值），保留调试价值
 *   - 非 2xx：只回状态码与耗时，**不回 body**（错误体里恰恰是内部结构）
 *   - 一律脱敏：密钥明文、指纹、通用凭据模式
 */

import { safeJsonParse } from '../util/json.ts';
import { scrubAll, scrubDeep, valueFingerprint } from '../invoke/redact.ts';

/** 单个字符串值最多保留多少字符 */
const VALUE_PREVIEW = 160;
/** 结构摘要最多展开多少层 */
const MAX_DEPTH = 4;

export type SampleShape =
  | { kind: 'json'; shape: unknown }
  | { kind: 'text'; preview: string }
  | { kind: 'binary'; contentType: string; bytes: number }
  | { kind: 'empty' };

export type DryRunView = {
  ok: boolean;
  status: number;
  latencyMs: number;
  /** 上游主机：仅控制台（管理员）可见，对外通道一律留空 */
  upstreamHost: string;
  contentType: string;
  bytes: number;
  truncated: boolean;
  /**
   * 2xx 才有样本。非 2xx 一律不返回 —— 错误体的价值全在攻击者那边，
   * 排查只需状态码 + 错误码。
   */
  sample?: SampleShape;
  /** 非 2xx 时的稳定错误码，便于前端提示 */
  errorCode?: string;
  /** 一句话说明，不含上游返回的任何内容 */
  hint?: string;
};

/** 把一个 JSON 值压成"键名 + 类型 + 短预览"的结构，用于展示而不是原样透出 */
function summarize(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (typeof value === 'string') {
    return value.length > VALUE_PREVIEW ? `${value.slice(0, VALUE_PREVIEW)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length} 项]` : '{…}';
  if (Array.isArray(value)) {
    const head = value.slice(0, 3).map((v) => summarize(v, depth + 1));
    return value.length > 3 ? [...head, `… 共 ${value.length} 项`] : head;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 24);
    for (const [k, v] of entries) out[k] = summarize(v, depth + 1);
    const total = Object.keys(value as Record<string, unknown>).length;
    if (total > entries.length) out['…'] = `还有 ${total - entries.length} 个字段`;
    return out;
  }
  return String(value);
}

/**
 * 生成试运行视图。
 *
 * @param ctx.secretValues 本次调用解析出的密钥明文（用于精确抹除）
 * @param ctx.knownFragments 全量指纹（跨请求兜底）
 * @param ctx.console 是否控制台通道（只有控制台才回上游主机/样本）
 */
export function buildDryRunView(ctx: {
  status: number;
  latencyMs: number;
  upstreamHost: string;
  contentType: string;
  text: string;
  bytes: number;
  truncated: boolean;
  console: boolean;
  secretValues?: string[];
  knownFragments?: Map<string, string>;
}): DryRunView {
  const scrubOpts = {
    secretValues: ctx.secretValues ?? [],
    knownFragments: ctx.knownFragments,
  };
  const ok = ctx.status >= 200 && ctx.status < 300;

  const base: DryRunView = {
    ok,
    status: ctx.status,
    latencyMs: ctx.latencyMs,
    upstreamHost: ctx.console ? ctx.upstreamHost : '',
    contentType: ctx.contentType,
    bytes: ctx.bytes,
    truncated: ctx.truncated,
  };

  if (!ok) {
    return {
      ...base,
      errorCode: ctx.status === 0 ? 'upstream_unreachable' : `upstream_${ctx.status}`,
      // 刻意不回 body：错误响应里通常是内部鉴权结构、版本号、堆栈
      hint: ctx.status === 0 ? '上游不可达' : `上游返回 ${ctx.status}，响应体不回显`,
    };
  }

  // 非控制台通道：只给状态与体积，样本属于"上游真实数据"，不外泄给令牌持有者
  if (!ctx.console) {
    return base;
  }

  const ct = ctx.contentType.toLowerCase();
  if (!ctx.text.length) return { ...base, sample: { kind: 'empty' } };

  if (ct.includes('json') || /^\s*[[{]/.test(ctx.text)) {
    const parsed = safeJsonParse<unknown>(ctx.text, undefined);
    if (parsed !== undefined) {
      return { ...base, sample: { kind: 'json', shape: summarize(scrubDeep(parsed, scrubOpts)) } };
    }
  }

  if (ct.includes('html')) {
    // HTML 只说明"这是个页面"，不回正文：控制台 HTML 会暴露路由与版本
    return { ...base, sample: { kind: 'text', preview: '<HTML 页面，正文不回显>' } };
  }

  if (ct.startsWith('image/') || ct.startsWith('audio/') || ct.startsWith('video/') || ct.includes('octet-stream')) {
    return { ...base, sample: { kind: 'binary', contentType: ct.split(';')[0] ?? ct, bytes: ctx.bytes } };
  }

  const preview = scrubAll(ctx.text.slice(0, VALUE_PREVIEW * 2), scrubOpts.secretValues, {
    knownFragments: scrubOpts.knownFragments,
  });
  return { ...base, sample: { kind: 'text', preview } };
}

/** 便于测试：把一串密钥明文做成指纹表 */
export function fingerprintsOf(values: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of values) {
    if (typeof v === 'string' && v.length >= 8) out.set(v, valueFingerprint(v));
  }
  return out;
}
