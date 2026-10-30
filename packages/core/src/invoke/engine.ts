import type { EndpointRecord, PlatformRecord } from '../schema/asset.ts';
import { audit, endpoints, platforms, secrets, tools } from '../db/repos.ts';
import { loadConfig } from '../config.ts';
import { collectSecretRefs, decryptSecret } from '../secrets/vault.ts';
import { newId, nowIso, safeJsonParse, stableStringify } from '../util/json.ts';
import { buildRequest } from './build.ts';
import { cacheGet, cacheSet } from './cache.ts';
import {
  assertBreaker,
  assertEgressAllowed,
  assertSafePath,
  consumeRate,
  hubError,
  recordBreaker,
} from './guard.ts';
import { redactPaths, scrubAll, scrubSecrets } from './redact.ts';
import { shapeResponse } from './transform.ts';

export type Channel = 'rest' | 'mcp' | 'chat' | 'console';

/** 令牌作用域：非空时按白名单限制 */
export type KeyScopes = { platforms?: string[]; tools?: string[] };

export type InvokeRequest = {
  platformSlug: string;
  endpointSlug: string;
  args: Record<string, unknown>;
  channel: Channel;
  apiKeyId?: string | null;
  toolName?: string;
  requestId?: string;
  /** 调用方令牌的作用域，用于二次收窄 */
  scopes?: KeyScopes;
};

/**
 * 接口开放策略校验。
 * console 通道 = 控制台试运行，始终放行（方便调试未开放接口）。
 */
export function assertEndpointAccess(
  endpoint: EndpointRecord,
  channel: Channel,
  apiKeyId: string | null | undefined,
  scopes?: KeyScopes,
): void {
  if (channel === 'console') return;

  if (endpoint.exposure === 'closed') {
    throw hubError('endpoint_closed', `接口未对外开放：${endpoint.slug}`, 403);
  }
  if (endpoint.exposure === 'restricted') {
    const allowed = endpoint.allowedKeyIds ?? [];
    if (!apiKeyId || !allowed.includes(apiKeyId)) {
      throw hubError('endpoint_restricted', `接口仅对指定令牌开放：${endpoint.slug}`, 403);
    }
  }
  if (scopes) {
    const tools = scopes.tools ?? [];
    const plats = scopes.platforms ?? [];
    if (tools.length && endpoint.slug && !tools.includes(`${endpoint.platformSlug}/${endpoint.slug}`)) {
      throw hubError('scope_forbidden', '当前令牌无权调用该接口', 403);
    }
    if (plats.length && !plats.includes(endpoint.platformSlug)) {
      throw hubError('scope_forbidden', '当前令牌无权访问该平台', 403);
    }
  }
}

export type InvokeResult = {
  ok: boolean;
  status: number;
  data: unknown;
  meta: {
    requestId: string;
    latencyMs: number;
    cached: boolean;
    upstreamHost: string;
    errorCode?: string;
  };
};

export function makeResolver(): { resolve: (name: string) => string; plaintexts: string[] } {
  const plaintexts: string[] = [];
  const cache = new Map<string, string>();
  const resolve = (name: string): string => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const blob = secrets.getCipher(name);
    if (!blob) throw hubError('missing_secret', `密钥库缺少 ${name}`, 500);
    const plain = decryptSecret(blob);
    cache.set(name, plain);
    plaintexts.push(plain);
    return plain;
  };
  return { resolve, plaintexts };
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean; bytes: number }> {
  if (!res.body) return { text: '', truncated: false, bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      const room = maxBytes - (bytes - value.byteLength);
      if (room > 0) chunks.push(value.subarray(0, room));
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf), truncated, bytes: total };
}

function parseBody(text: string, contentType: string): unknown {
  const ct = contentType.toLowerCase();
  if (ct.includes('json') || /^\s*[[{]/.test(text)) {
    const parsed = safeJsonParse<unknown>(text, undefined);
    if (parsed !== undefined) return parsed;
  }
  return text;
}

export async function invokeEndpoint(req: InvokeRequest): Promise<InvokeResult> {
  const cfg = loadConfig();
  const requestId = req.requestId ?? newId('rq');
  const started = Date.now();
  const channel = req.channel;

  let platform: PlatformRecord | null = null;
  let endpoint: EndpointRecord | null = null;
  let upstreamHost = '';
  let cached = false;
  const { resolve, plaintexts } = makeResolver();

  const finish = (result: {
    ok: boolean;
    status: number;
    data: unknown;
    errorCode?: string;
    respMeta?: Record<string, unknown>;
  }): InvokeResult => {
    const latencyMs = Date.now() - started;
    audit.append({
      ts: nowIso(),
      requestId,
      apiKeyId: req.apiKeyId ?? null,
      channel,
      toolName: req.toolName ?? (endpoint ? `${req.platformSlug}/${req.endpointSlug}` : req.platformSlug),
      endpointId: endpoint?.id ?? null,
      status: result.status,
      ok: result.ok,
      latencyMs,
      upstreamHost,
      errorCode: result.errorCode ?? null,
      reqMeta: { args: Object.keys(req.args), cached },
      respMeta: result.respMeta ?? {},
    });
    return {
      ok: result.ok,
      status: result.status,
      data: result.data,
      meta: {
        requestId,
        latencyMs,
        cached,
        // 对外通道不回显上游主机，避免泄露原始接口地址
        upstreamHost: channel === 'console' ? upstreamHost : '',
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      },
    };
  };

  try {
    platform = platforms.bySlug(req.platformSlug);
    if (!platform) throw hubError('platform_not_found', `平台不存在：${req.platformSlug}`, 404);
    endpoint = endpoints.bySlug(platform.id, req.endpointSlug);
    if (!endpoint) throw hubError('endpoint_not_found', `接口不存在：${req.endpointSlug}`, 404);
    if (endpoint.status !== 'published' && channel !== 'console') {
      throw hubError('endpoint_not_published', `接口未发布：${endpoint.slug}`, 409);
    }
    assertEndpointAccess(endpoint, channel, req.apiKeyId, req.scopes);

    consumeRate(`${req.apiKeyId ?? 'anon'}:${platform.slug}`, platform.rateLimit.qps, platform.rateLimit.daily);
    assertBreaker(`${platform.slug}:${endpoint.slug}`);

    const ttl = Math.max(endpoint.sideEffect === 'read' ? 0 : 0, tools.byEndpoint(endpoint.id)?.cacheTtl ?? 0);
    const cacheKey = `${platform.slug}:${endpoint.slug}:${stableStringify(req.args)}`;
    if (endpoint.sideEffect === 'read' && ttl > 0) {
      const hit = cacheGet<unknown>(cacheKey);
      if (hit.hit) {
        cached = true;
        return finish({ ok: true, status: 200, data: hit.value, respMeta: { cached: true } });
      }
    }

    const built = buildRequest({ platform, endpoint, args: req.args, secretValue: resolve });
    upstreamHost = built.upstreamHost;

    const target = new URL(built.url);
    assertSafePath(target.pathname);
    assertEgressAllowed(platform, target, cfg.allowPrivateEgress);

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
      recordBreaker(`${platform.slug}:${endpoint.slug}`, false);
      throw hubError('upstream_redirect', `上游返回 ${res.status} 跳转，已阻断（可能指向白名单外主机）`, 502);
    }

    const { text, truncated, bytes } = await readCapped(res, endpoint.response.maxBytes);
    recordBreaker(`${platform.slug}:${endpoint.slug}`, res.ok);

    if (!res.ok) {
      throw hubError('upstream_error', `上游返回 ${res.status}`, res.status >= 500 ? 502 : res.status);
    }

    let data = parseBody(text, res.headers.get('content-type') ?? '');
    data = shapeResponse(data, endpoint.response);

    // 上游返回的数据原样交给调用方，不做自动脱敏。
    //
    // 之前这里对响应跑了一遍 redactByKeyName：字段名里带 phone / email /
    // address / idcard / realname 之类就一律打成 ***，调用方拿到的是残缺数据。
    // 网关的职责是转发，不是替上游改写业务字段。
    //
    // 只保留两件必要的：
    //   1. redactFields —— 接口上显式配了的字段才打码（默认空，用户自己要求才生效）
    //   2. 网关自己注入的密钥明文万一被上游回显出来，必须挡掉
    //      只匹配长度 ≥ 8 的密钥，避免把普通数据里的短字符串误打成 ***
    data = redactPaths(data, endpoint.response.redactFields);
    const echoed = plaintexts.filter((v) => typeof v === 'string' && v.length >= 8);
    if (echoed.length) {
      const json = typeof data === 'string' ? data : JSON.stringify(data);
      const cleaned = scrubSecrets(json, echoed);
      if (cleaned !== json) data = typeof data === 'string' ? cleaned : safeJsonParse(cleaned, data);
    }

    if (endpoint.sideEffect === 'read' && ttl > 0) cacheSet(cacheKey, data, ttl);

    return finish({
      ok: true,
      status: res.status,
      data,
      respMeta: { bytes, truncated, cached: false },
    });
  } catch (err) {
    const e = err as HubErrorLike;
    const code = typeof e?.code === 'string' ? e.code : 'invoke_failed';
    const status = typeof e?.status === 'number' ? e.status : 500;
    const message = scrubAll(e?.message ?? String(err), plaintexts);
    recordBreaker(`${req.platformSlug}:${req.endpointSlug}`, false);
    return finish({
      ok: false,
      status,
      data: { error: { code, message } },
      errorCode: code,
      respMeta: { message },
    });
  }
}

type HubErrorLike = { code?: string; status?: number; message?: string };

/** 按工具名调用（MCP / 对话 / REST 统一入口） */
/**
 * 还没摸到具体接口就失败的调用（工具名写错、工具被禁用）。
 *
 * 以前这些直接 return，审计里什么都没有 —— 用户调错了工具名，
 * 在流水里看不到任何痕迹，只能干瞪眼。现在补一条审计，
 * 但 upstreamHost 留空（压根没出网）。
 */
function earlyFailure(input: {
  toolName: string;
  channel: Channel;
  apiKeyId?: string | null;
  status: number;
  errorCode: string;
  message: string;
}): InvokeResult {
  const requestId = newId('rq');
  const latencyMs = 0;

  audit.append({
    ts: nowIso(),
    requestId,
    apiKeyId: input.apiKeyId ?? null,
    channel: input.channel,
    toolName: input.toolName,
    endpointId: null,
    status: input.status,
    ok: false,
    latencyMs,
    upstreamHost: '',
    errorCode: input.errorCode,
    reqMeta: { early: true },
    respMeta: {},
  });

  return {
    ok: false,
    status: input.status,
    data: { error: { code: input.errorCode, message: input.message } },
    meta: {
      requestId,
      latencyMs,
      cached: false,
      upstreamHost: '',
      errorCode: input.errorCode,
    },
  };
}

export async function invokeTool(
  toolName: string,
  args: Record<string, unknown>,
  channel: Channel,
  apiKeyId?: string | null,
  scopes?: KeyScopes,
): Promise<InvokeResult> {
  const tool = tools.byName(toolName);
  if (!tool) {
    return earlyFailure({
      toolName,
      channel,
      apiKeyId,
      status: 404,
      errorCode: 'tool_not_found',
      message: `工具不存在：${toolName}`,
    });
  }
  if (!tool.enabled) {
    return earlyFailure({
      toolName,
      channel,
      apiKeyId,
      status: 409,
      errorCode: 'tool_disabled',
      message: `工具已禁用：${toolName}`,
    });
  }
  return invokeEndpoint({
    platformSlug: tool.platformSlug,
    endpointSlug: tool.endpointSlug,
    args: args ?? {},
    channel,
    apiKeyId,
    toolName,
    scopes,
  });
}

/** 控制台试运行：允许调用未发布接口 */
export async function testEndpoint(
  endpointId: string,
  args: Record<string, unknown>,
): Promise<InvokeResult> {
  const ep = endpoints.get(endpointId);
  if (!ep) {
    return {
      ok: false,
      status: 404,
      data: { error: { code: 'endpoint_not_found', message: '接口不存在' } },
      meta: { requestId: newId('rq'), latencyMs: 0, cached: false, upstreamHost: '', errorCode: 'endpoint_not_found' },
    };
  }
  return invokeEndpoint({
    platformSlug: ep.platformSlug,
    endpointSlug: ep.slug,
    args,
    channel: 'console',
  });
}

export function secretNamesUsedBy(endpoint: EndpointRecord, platform: PlatformRecord): string[] {
  const set = collectSecretRefs(endpoint.params);
  collectSecretRefs(endpoint.body, set);
  collectSecretRefs(platform.authConfig, set);
  collectSecretRefs(platform.defaultHeaders, set);
  return [...set];
}
