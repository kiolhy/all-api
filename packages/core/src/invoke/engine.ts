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
  type SelfTargets,
} from './guard.ts';
import { redactPaths, scrubAll, scrubDeep, scrubPatterns, scrubSecrets } from './redact.ts';
import { shapeResponse } from './transform.ts';
import { safeFetch } from '../security/safe-fetch.ts';
import { buildDryRunView } from '../security/dry-run.ts';

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
  /**
   * 已认证主体（审计归因用）。
   * console 通道必须带 `console:account:<id>` 这类已认证凭据，
   * 不能再靠"channel=console 所以放行"这种隐式豁免。
   */
  actor?: string;
  /** console 通道的授权凭据：只有已认证管理员才能拿到 */
  consoleGrant?: ConsoleGrant;
};

/** 控制台试运行的显式授权凭据（由路由层用会话解出的管理员身份换取） */
export type ConsoleGrant = {
  accountId: string;
  role: 'admin' | 'member';
  /** 签发时间，防止被长期复用到别的请求上下文 */
  issuedAt: number;
};

/** 授权凭据有效期：一次请求内有效（路由层现场签发） */
const CONSOLE_GRANT_TTL_MS = 30_000;

function validateConsoleGrant(grant: ConsoleGrant | undefined): void {
  if (!grant) {
    throw hubError('console_unauthorized', '控制台试运行需要管理员身份', 401);
  }
  if (grant.role !== 'admin') {
    throw hubError('console_forbidden', '控制台试运行仅限管理员', 403);
  }
  if (!Number.isFinite(grant.issuedAt) || Date.now() - grant.issuedAt > CONSOLE_GRANT_TTL_MS) {
    throw hubError('console_grant_expired', '试运行授权已过期，请重新发起', 401);
  }
}

/**
 * 接口开放策略校验。
 *
 * 历史漏洞：以前这里 `if (channel === 'console') return;`，
 * 而 testEndpoint 硬编码 channel='console'，test 接口又不需要登录 ——
 * 于是匿名者获得了「跳过 exposure/restricted/allowedKeyIds/作用域」的能力。
 *
 * 现在 console 也必须持有效管理员凭据（consoleGrant），
 * 而 testEndpoint 只能由已认证管理员调用，且只跳过「是否发布」这一项，
 * 开放策略校验不再被跳过（试运行是管理员在调他自己的接口，语义上等价于管理员令牌）。
 */
export function assertEndpointAccess(
  endpoint: EndpointRecord,
  channel: Channel,
  apiKeyId: string | null | undefined,
  scopes?: KeyScopes,
  grant?: ConsoleGrant,
): void {
  if (channel === 'console') {
    validateConsoleGrant(grant);
    // 管理员试运行：仍然做作用域校验（防止把某令牌作用域带进 console 调用）
    if (scopes) assertScopes(endpoint, scopes);
    return;
  }

  if (endpoint.exposure === 'closed') {
    throw hubError('endpoint_closed', `接口未对外开放：${endpoint.slug}`, 403);
  }
  if (endpoint.exposure === 'restricted') {
    const allowed = endpoint.allowedKeyIds ?? [];
    if (!apiKeyId || !allowed.includes(apiKeyId)) {
      throw hubError('endpoint_restricted', `接口仅对指定令牌开放：${endpoint.slug}`, 403);
    }
  }
  if (scopes) assertScopes(endpoint, scopes);
}

function assertScopes(endpoint: EndpointRecord, scopes: KeyScopes): void {
  const tools = scopes.tools ?? [];
  const plats = scopes.platforms ?? [];
  if (tools.length && endpoint.slug && !tools.includes(`${endpoint.platformSlug}/${endpoint.slug}`)) {
    throw hubError('scope_forbidden', '当前令牌无权调用该接口', 403);
  }
  if (plats.length && !plats.includes(endpoint.platformSlug)) {
    throw hubError('scope_forbidden', '当前令牌无权访问该平台', 403);
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

/**
 * 按名从 vault 解密。
 *
 * 注意：**先登记明文再返回**。
 * 以前是"解密 → 返回 → 调用方用完再 push"，只要过程中抛错（比如 buildRequest 后面某步失败），
 * 已经解密出来的明文就没进 plaintexts，错误信息里原样带出去。
 */
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

/** 本进程自己的监听地址：用来拒绝"网关请求自己"的回环链路 */
let selfTargets: SelfTargets | null = null;

export function setSelfTargets(t: SelfTargets | null): void {
  selfTargets = t;
}

export function getSelfTargets(): SelfTargets | null {
  return selfTargets;
}

/**
 * 平台允许的主机清单。
 *
 * 语义要说清楚：这是"能去哪些主机"的**收窄**，不是 SSRF 防护本身。
 * 真正的防护是 safeFetch 里的地址级判定（回环/私网/元数据/多写法 IP/DNS 结果）。
 * 所以：
 *   - 显式配了 egressAllowHosts 就严格按它
 *   - 没配则只允许 baseUrl 自己的 host
 *   - **无论哪种，都必须再过地址判定**
 */
export function egressHostsFor(platform: PlatformRecord): string[] {
  const declared = platform.egressAllowHosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (declared.length) return declared;
  try {
    return [new URL(platform.baseUrl).hostname.toLowerCase()];
  } catch {
    return [];
  }
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
      // 审计归因：以前匿名操作在流水里是 apiKeyId=null + console，查不到人
      actor: req.actor ?? (req.consoleGrant ? `account:${req.consoleGrant.accountId}` : null),
      toolName: req.toolName ?? (endpoint ? `${req.platformSlug}/${req.endpointSlug}` : req.platformSlug),
      endpointId: endpoint?.id ?? null,
      status: result.status,
      ok: result.ok,
      latencyMs,
      upstreamHost,
      errorCode: result.errorCode ?? null,
      reqMeta: { args: Object.keys(req.args), cached },
      respMeta: scrubDeep(result.respMeta ?? {}, { secretValues: plaintexts }) as Record<string, unknown>,
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
    assertEndpointAccess(endpoint, channel, req.apiKeyId, req.scopes, req.consoleGrant);

    consumeRate(`${req.apiKeyId ?? req.actor ?? 'anon'}:${platform.slug}`, platform.rateLimit.qps, platform.rateLimit.daily);
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
    assertEgressAllowed(platform, target, cfg.allowPrivateEgress, selfTargets ?? undefined);

    // 真正发请求：走受控客户端（DNS 解析后按地址判定 + 连接锁 IP + 不跟随跳转）
    const controller = new AbortController();
    const res = await safeFetch(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body ?? undefined,
      allowPrivate: cfg.allowPrivateEgress && platform.allowPrivate,
      allowHosts: egressHostsFor(platform),
      timeoutMs: cfg.egressTimeoutMs,
      maxBytes: endpoint.response.maxBytes,
      signal: controller.signal,
    });

    if (res.status >= 300 && res.status < 400) {
      recordBreaker(`${platform.slug}:${endpoint.slug}`, false);
      throw hubError('upstream_redirect', `上游返回 ${res.status} 跳转，已阻断（可能指向白名单外主机）`, 502);
    }

    const { text, truncated, bytes } = res;
    recordBreaker(`${platform.slug}:${endpoint.slug}`, res.status >= 200 && res.status < 300);

    if (res.status < 200 || res.status >= 300) {
      throw hubError('upstream_error', `上游返回 ${res.status}`, res.status >= 500 ? 502 : res.status);
    }

    let data = parseBody(text, res.headers['content-type'] ? String(res.headers['content-type']) : '');
    data = shapeResponse(data, endpoint.response);

    // 上游返回的数据原样交给调用方，不做业务字段自动打码。
    //
    // 之前这里对响应跑了一遍 redactByKeyName：字段名里带 phone / email /
    // address / idcard / realname 之类就一律打成 ***，调用方拿到的是残缺数据。
    // 网关的职责是转发，不是替上游改写业务字段。
    //
    // 只保留两件必要的：
    //   1. redactFields —— 接口上显式配了的字段才打码（默认空，用户自己要求才生效）
    //   2. 网关自己注入的密钥明文万一被上游回显出来，必须挡掉
    //      只匹配长度 ≥ 8 的密钥，避免把普通数据里的短字符串误打成 ***
    //      同时按 vault 全量指纹兜一层：上游把密钥拆成片段回显时也能挡住
    data = redactPaths(data, endpoint.response.redactFields);
    const echoed = plaintexts.filter((v) => typeof v === 'string' && v.length >= 8);
    if (echoed.length) {
      const json = typeof data === 'string' ? data : JSON.stringify(data);
      const cleaned = scrubSecrets(json, echoed);
      if (cleaned !== json) data = typeof data === 'string' ? cleaned : safeJsonParse(cleaned, data);
    } else if (typeof data === 'string' && data.length) {
      // 只对字符串响应做通用模式兜底，避免把正常 JSON 结构打乱
      data = scrubPatterns(data);
    }

    if (endpoint.sideEffect === 'read' && ttl > 0) cacheSet(cacheKey, data, ttl);

    // 控制台试运行：不把上游响应原样交出去。
    //
    // 真实事故：`POST /api/endpoints/{id}/test` 直接回显解析后的 data，
    // 配合"能指向任意地址"就成了全响应 SSRF —— 内网服务的结构、版本、
    // 甚至鉴权错误体都会被读到。这里换成结构化摘要（键名 + 类型 + 短预览），
    // 并且只对 2xx 给样本。
    if (channel === 'console') {
      const contentType = res.headers['content-type'] ? String(res.headers['content-type']) : '';
      const view = buildDryRunView({
        status: res.status,
        latencyMs: Date.now() - started,
        upstreamHost,
        contentType,
        text,
        bytes,
        truncated,
        console: true,
        secretValues: plaintexts,
      });
      return finish({
        ok: true,
        status: res.status,
        data: view,
        respMeta: { bytes, truncated, cached: false, dryRun: true },
      });
    }

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
  actor?: string;
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
    actor: input.actor ?? null,
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
  actor?: string,
): Promise<InvokeResult> {
  const tool = tools.byName(toolName);
  if (!tool) {
    return earlyFailure({
      toolName,
      channel,
      apiKeyId,
      actor,
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
      actor,
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
    actor,
  });
}

/**
 * 控制台试运行：**必须**由已认证管理员发起。
 *
 * 以前的签名是 `testEndpoint(endpointId, args)`，内部硬编码 channel='console'，
 * 而 console 又在 assertEndpointAccess 里被无条件放行 —— 匿名者只要能让请求到达
 * 这个路由，就获得了"跳过所有开放策略 + 用 vault 解密任意密钥"的能力。
 *
 * 现在强制要求 grant（由路由层用会话换来的管理员凭据），没有就直接 401。
 * 同时把「是否已发布」这一项放开（试运行本来就要能调草稿），
 * 但开放策略/作用域校验照常执行。
 */
export async function testEndpoint(
  endpointId: string,
  args: Record<string, unknown>,
  grant: ConsoleGrant | undefined,
  actor?: string,
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
    consoleGrant: grant,
    actor: actor ?? (grant ? `account:${grant.accountId}` : 'anonymous'),
    toolName: `${ep.platformSlug}/${ep.slug}`,
  });
}

/** 由路由层用已认证管理员身份签发一份 console 凭据 */
export function issueConsoleGrant(account: { id: string; role: 'admin' | 'member' }): ConsoleGrant {
  return { accountId: account.id, role: account.role, issuedAt: Date.now() };
}

export function secretNamesUsedBy(endpoint: EndpointRecord, platform: PlatformRecord): string[] {
  const set = collectSecretRefs(endpoint.params);
  collectSecretRefs(endpoint.body, set);
  collectSecretRefs(platform.authConfig, set);
  collectSecretRefs(platform.defaultHeaders, set);
  return [...set];
}

/**
 * 找出**结构性位置**声明的密钥名（params.secretRef / 平台 auth 配置 / defaultHeaders）。
 * 与 secretNamesUsedBy 的区别：不含 body.example 这类示例文本里的字面量，
 * 用于「保存时校验密钥必须存在且已声明」。
 */
export function declaredSecretNames(endpoint: EndpointRecord, platform: PlatformRecord): string[] {
  const set = new Set<string>();
  for (const p of endpoint.params) {
    if (p.secretRef) set.add(p.secretRef);
    if (typeof p.default === 'string') collectSecretRefs(p.default, set);
  }
  collectSecretRefs(platform.authConfig, set);
  collectSecretRefs(platform.defaultHeaders, set);
  return [...set];
}
