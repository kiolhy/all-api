/**
 * 探测用的底层请求。
 *
 * 和正式调用共用同一套出网护栏：
 * - 域名白名单 / 私网拦截（assertEgressAllowed）
 * - 禁止跟随跳转（redirect: 'manual'）
 * - 超时与响应大小上限
 * - 密钥由平台配置注入，不经过 LLM
 * - 响应做脱敏
 *
 * 区别：探测只关心「返回长什么样」，不关心业务是否成功，
 * 所以 4xx/5xx 也把响应体带回来，供分析 Agent 判断。
 */

import type { EndpointRecord, Param, PlatformRecord } from '../schema/asset.ts';
import { buildRequest } from '../invoke/build.ts';
import { assertEgressAllowed, assertSafePath } from '../invoke/guard.ts';
import { makeResolver } from '../invoke/engine.ts';
import { scrubSecrets } from '../invoke/redact.ts';
import { loadConfig } from '../config.ts';
import { safeJsonParse } from '../util/json.ts';

export type ProbeResult =
  | {
      ok: true;
      status: number;
      latencyMs: number;
      body: unknown;
      truncated: boolean;
      /** 响应体是错误响应（4xx/5xx），不能当作接口正常返回结构 */
      errorResponse: boolean;
    }
  | {
      ok: false;
      status: number;
      latencyMs: number;
      error: string;
    };

const PROBE_MAX_BYTES = 256 * 1024;

/** 探测时用的最小 EndpointRecord（草稿还没入库） */
function draftEndpoint(input: {
  method: string;
  pathTemplate: string;
  params: Param[];
}): EndpointRecord {
  return {
    id: 'probe',
    platformId: 'probe',
    platformSlug: 'probe',
    slug: 'probe',
    group: 'probe',
    method: input.method as EndpointRecord['method'],
    pathTemplate: input.pathTemplate,
    summary: '',
    description: '',
    params: input.params,
    body: null,
    response: {
      contentType: 'application/json',
      pick: [],
      unwrap: null,
      transform: null,
      redactFields: [],
      maxBytes: PROBE_MAX_BYTES,
    },
    sideEffect: 'read',
    sensitivity: 'low',
    tags: [],
    examples: [],
    notes: '',
    exposure: 'closed',
    allowedKeyIds: [],
    publicName: '',
    status: 'draft',
    version: 1,
    contentHash: '',
    sourceKind: 'manual',
    sourceRef: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
      truncated = true;
      break;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

export async function probeEndpoint(input: {
  platform: PlatformRecord;
  method: string;
  pathTemplate: string;
  params: Param[];
  args: Record<string, unknown>;
}): Promise<ProbeResult> {
  const cfg = loadConfig();
  const started = Date.now();
  const endpoint = draftEndpoint(input);

  let plaintexts: string[] = [];
  try {
    const { resolve, plaintexts: collected } = makeResolver();
    plaintexts = collected;
    const built = buildRequest({
      platform: input.platform,
      endpoint,
      args: input.args,
      secretValue: resolve,
    });

    const target = new URL(built.url);
    assertSafePath(target.pathname);
    assertEgressAllowed(input.platform, target, cfg.allowPrivateEgress);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.egressTimeoutMs);
    let res: Response;
    try {
      res = await fetch(built.url, {
        method: built.method,
        headers: built.headers,
        body: built.body ?? undefined,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        status: res.status,
        latencyMs: Date.now() - started,
        error: `上游返回 ${res.status} 跳转，已阻断`,
      };
    }

    const { text, truncated } = await readCapped(res, PROBE_MAX_BYTES);
    let body: unknown = safeJsonParse(text, text);

    // 样本原样保留（控制台里要看到真实数据），只挡网关自己注入的密钥明文。
    // 业务字段（手机号/邮箱/地址…）不再打码 —— 那是上游的真实数据。
    // 发给第三方模型前会在 analyze.ts 里再打一次码。
    const echoed = plaintexts.filter((v) => typeof v === 'string' && v.length >= 8);
    if (echoed.length) {
      const json = typeof body === 'string' ? body : JSON.stringify(body);
      const cleaned = scrubSecrets(json, echoed);
      if (cleaned !== json) body = typeof body === 'string' ? cleaned : safeJsonParse(cleaned, body);
    }

    return {
      ok: true,
      status: res.status,
      latencyMs: Date.now() - started,
      body,
      truncated,
      errorResponse: !res.ok,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: (err as Error).message,
    };
  }
}
