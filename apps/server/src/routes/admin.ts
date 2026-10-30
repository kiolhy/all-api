import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import {
  EndpointInputSchema,
  PlatformInputSchema,
  acceptCandidate,
  accounts,
  apiKeys,
  assertEgressAllowed,
  audit,
  buildDryRunView,
  chats,
  compileTool,
  containsSecretValue,
  declaredSecretNames,
  decryptSecret,
  egressHostsFor,
  endpoints,
  importJobs,
  issueConsoleGrant,
  loadConfig,
  assertPublishable,
  ipAllowlistProblem,
  ipAllowed,
  isValidLlmBaseUrl,
  knownSecretPlaintexts,
  nowIso,
  platforms,
  publishAndCompile,
  rejectCandidate,
  runChat,
  runImport,
  safeFetch,
  scrubDeep,
  secrets,
  settings,
  sha256,
  testEndpoint,
  tools,
  encryptSecret,
  fetchSiteInfo,
  isBlockedV4,
  isBlockedV6,
  normalizeObscureIpv4,
} from '@aah/core';
import type { AccountRecord, ApiKeyRecord, EndpointInput, PlatformInput, QuotaPeriod } from '@aah/core';
import { startBackgroundImport, listJobs, getJob, isRunning, onJobEvent } from '../import-runner.ts';
import { actorOfRequest } from './identity.ts';

/** 业务错误码 → HTTP 状态码 */
const CODE_STATUS: Record<string, number> = {
  not_found: 404,
  job_running: 409,
  conflict: 409,
  settings_conflict: 409,
  forbidden: 403,
  unauthorized: 401,
};

function bad(message: string, code = 'bad_request') {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = CODE_STATUS[code] ?? 400;
  err.code = code;
  return err;
}

/** 取当前登录账号（由 app.ts 的 preHandler 挂上） */
function requireAccount(req: FastifyRequest): AccountRecord {
  const acc = (req as FastifyRequest & { account?: AccountRecord | null }).account;
  if (!acc) {
    const err = new Error('未登录') as Error & { statusCode: number; code: string };
    err.statusCode = 401;
    err.code = 'unauthorized';
    throw err;
  }
  return acc;
}

/**
 * 路由级管理员校验。
 *
 * app.ts 的规则表已经默认拒绝，但这里再自查一次是刻意的"纵深防御"：
 * 只要哪天规则表被改错、或者有人新挂了一条绕过规则表的路由，
 * 管理写接口也不会因此裸奔。真实事故里正是"只靠一层"导致整条链被穿透。
 */
function requireAdminAccount(req: FastifyRequest): AccountRecord {
  const acc = requireAccount(req);
  if (acc.role !== 'admin') {
    const err = new Error('需要管理员权限') as Error & { statusCode: number; code: string };
    err.statusCode = 403;
    err.code = 'forbidden';
    throw err;
  }
  return acc;
}

/** 管理员可操作任意令牌；成员只能动自己名下的 */
function assertKeyOwner(me: AccountRecord, key: ApiKeyRecord): void {
  if (me.role === 'admin') return;
  if (key.accountId !== me.id) {
    const err = new Error('无权操作他人的令牌') as Error & { statusCode: number; code: string };
    err.statusCode = 403;
    err.code = 'forbidden';
    throw err;
  }
}

/** 校验并去重 IP 白名单条目 */
function normalizeAllowlist(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw bad('ipAllowlist 必须是字符串数组');
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') throw bad('ipAllowlist 必须是字符串数组');
    const item = raw.trim();
    if (!item) continue;
    const problem = ipAllowlistProblem(item);
    if (problem) throw bad(problem);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/** 把 audit 里的 actor（account:xxx / key:xxx）翻成人看得懂的名字 */
function describeActor(actor: unknown): string | null {
  if (typeof actor !== 'string' || !actor) return null;
  const byAccount = /^account:(.+)$/.exec(actor);
  if (byAccount) {
    const acc = accounts.get(byAccount[1]!);
    if (acc) return `${acc.username}（${acc.role === 'admin' ? '管理员' : '成员'}）`;
  }
  return actor;
}

/** 设置页看到的 LLM 视图：不返回 apiKey 明文，只告诉有没有配 */
function llmView(cfg = loadConfig()) {
  const meta = settings.get<Record<string, unknown>>('llm', {});
  return {
    enabled: cfg.llm.enabled,
    baseUrl: cfg.llm.baseUrl,
    model: cfg.llm.model,
    apiKeySet: Boolean(cfg.llm.apiKey),
    timeoutMs: cfg.llm.timeoutMs,
    concurrency: cfg.llm.concurrency,
    /** 想开但没 apiKey，会提示用户 */
    blockedByApiKey: !cfg.llm.apiKey,
    /** 谁在什么时候改的：检查期间被别人改掉时能看出来 */
    updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : null,
    updatedBy: describeActor(meta.updatedBy),
  };
}

/**
 * egress 策略服务端化。
 *
 * 真实事故：`allowPrivate` / `egressAllowHosts` 完全由请求体决定，
 * 匿名者建一个 `baseUrl=http://127.0.0.1:8778` 且 `allowPrivate=true` 的平台，
 * 就让网关去请求自己 —— 于是"网关能不能进私网"变成了由攻击者配置。
 *
 * 现在三层：
 *   1. `allowPrivate` 只在服务端显式开启（ALLOW_PRIVATE_EGRESS=true）时才可能为真
 *   2. baseUrl 的 host 若解析到内网/保留地址，在**这块服务端策略**下直接拒绝保存
 *   3. egressAllowHosts 里出现本地主机名也拒绝（那是"允许去我自己的其它端口"）
 *
 * 注意：这里做的是**保存时**的静态检查（字面量 + 明显写法）。
 * 真正的运行时防护在 safeFetch 的地址级判定（DNS 解析后），
 * 两者不是替代关系 —— DNS rebinding 只能靠后者。
 */
function enforceEgressPolicy<T extends Partial<PlatformInput>>(input: T): T {
  const cfg = loadConfig();
  const out: T = { ...input };
  if (!cfg.allowPrivateEgress) out.allowPrivate = false;

  if (out.baseUrl) {
    let host = '';
    try {
      host = new URL(out.baseUrl).hostname.toLowerCase().replace(/\.+$/, '');
    } catch {
      /* 格式错误交给 zod 校验 */
    }
    if (host && !out.allowPrivate) {
      // 字面量 IP / 特殊主机名：在"不允许私网"的策略下不该被保存
      const bare = host.replace(/^\[|\]$/g, '');
      const isLocalName =
        bare === 'localhost' ||
        bare.endsWith('.localhost') ||
        bare.endsWith('.local') ||
        bare.endsWith('.internal') ||
        bare === '::1' ||
        bare === '0.0.0.0';
      const isLocalV4 = normalizeObscureIpv4(bare);
      if (isLocalName || (isLocalV4 && isBlockedV4(isLocalV4)) || (isIP(bare) === 6 && isBlockedV6(bare))) {
        throw bad(
          `平台地址 ${host} 指向本机/内网，当前服务端未允许私网出网（ALLOW_PRIVATE_EGRESS 未开启）`,
          'egress_private_blocked',
        );
      }
    }
  }

  if (Array.isArray(out.egressAllowHosts) && !out.allowPrivate) {
    for (const h of out.egressAllowHosts) {
      const bare = String(h).trim().toLowerCase().replace(/\.+$/, '');
      const ipv4 = normalizeObscureIpv4(bare);
      const blocked =
        bare === 'localhost' ||
        bare.endsWith('.localhost') ||
        bare.endsWith('.local') ||
        bare.endsWith('.internal') ||
        (ipv4 && isBlockedV4(ipv4)) ||
        (isIP(bare) === 6 && isBlockedV6(bare));
      if (blocked) {
        throw bad(`出网白名单里不允许出现本机/内网地址：${h}`, 'egress_private_blocked');
      }
    }
  }
  return out;
}

/**
 * 保存接口时校验 `${secret:...}` 只能出现在**声明过**的位置。
 *
 * 真实事故：`body.example` 里写 `${secret:任意名字}`，调用时会被无条件解析，
 * 于是"示例文本"成了"读取任意密钥的通道"。
 * 现在示例里的引用只是字面量（不会解析），但如果接口还声明了 secretRef，
 * 这里会顺手校验该密钥确实存在，避免保存后调用才发现配错。
 */
function assertNoExampleSecretRefs(input: EndpointInput, platform: PlatformInput | Awaited<ReturnType<typeof platforms.get>>): void {
  const declared = declaredSecretNames(
    { ...input, id: '', platformId: '', platformSlug: '', status: 'draft', version: 0, contentHash: '', sourceKind: 'manual', sourceRef: '', createdAt: '', updatedAt: '' } as never,
    platform as never,
  );
  for (const name of declared) {
    if (!secrets.getCipher(name)) {
      throw bad(`引用的密钥不存在：${name}`, 'missing_secret');
    }
  }
}

export function registerAdminRoutes(app: FastifyInstance): void {
  /* ───────────── 概览 ───────────── */
  app.get('/api/stats', async () => {
    const all = endpoints.list();
    return {
      platforms: platforms.list().length,
      endpoints: all.length,
      published: all.filter((e) => e.status === 'published').length,
      tools: tools.list().length,
      calls: audit.stats(),
    };
  });

  /* ───────────── 平台 ───────────── */
  app.get('/api/platforms', async () => platforms.list());

  app.post('/api/platforms', async (req) => {
    requireAdminAccount(req);
    const parsed = PlatformInputSchema.safeParse(req.body);
    if (!parsed.success) throw bad(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    if (platforms.bySlug(parsed.data.slug)) throw bad(`平台 slug 已存在：${parsed.data.slug}`);
    // 私网出网策略是服务端策略，不接受客户端声明（真实事故：allowPrivate 由请求体控制）
    return platforms.create(enforceEgressPolicy(parsed.data as PlatformInput));
  });

  app.get('/api/platforms/:id', async (req) => {
    const { id } = req.params as { id: string };
    const p = platforms.get(id);
    if (!p) throw bad('平台不存在', 'not_found');
    return p;
  });

  app.patch('/api/platforms/:id', async (req) => {
    requireAdminAccount(req);
    const { id } = req.params as { id: string };
    const parsed = PlatformInputSchema.partial().safeParse(req.body);
    if (!parsed.success) throw bad(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const updated = platforms.update(id, enforceEgressPolicy(parsed.data as Partial<PlatformInput>));
    if (!updated) throw bad('平台不存在', 'not_found');
    return updated;
  });

  app.delete('/api/platforms/:id', async (req) => {
    requireAdminAccount(req);
    const { id } = req.params as { id: string };
    platforms.remove(id);
    return { ok: true };
  });

  /**
   * 平台试运行。
   *
   * 真实事故：这个接口按用户可控的 baseUrl 出网，并把上游响应体（含非 2xx）
   * 原样回显给调用方 —— 匿名 + 编码前缀绕过，就成了全响应 SSRF，
   * 能读 127.0.0.1:8778 的控制台 HTML、/api/health、/gw/llms.txt。
   *
   * 现在：
   *   1. 只有管理员能调（requireAdminAccount 已加，规则表里也是 admin 级）
   *   2. 出网走 safeFetch：DNS 解析后按地址判定，私网/回环/元数据一律拒绝
   *   3. 响应只回结构化摘要，不回正文；非 2xx 连摘要都不给
   */
  app.post('/api/platforms/:id/test', async (req) => {
    const me = requireAdminAccount(req);
    const { id } = req.params as { id: string };
    const p = platforms.get(id);
    if (!p) throw bad('平台不存在', 'not_found');
    const started = Date.now();
    try {
      // 走和正式调用一致的出网护栏：白名单 / 私网 / 自引用拦截
      const target = new URL(p.baseUrl);
      assertEgressAllowed(p, target, loadConfig().allowPrivateEgress);
      const res = await safeFetch(p.baseUrl, {
        method: 'GET',
        headers: { Accept: 'application/json', ...p.defaultHeaders },
        allowPrivate: loadConfig().allowPrivateEgress && p.allowPrivate,
        allowHosts: egressHostsFor(p),
        timeoutMs: 6000,
        maxBytes: 256 * 1024,
      });
      // 审计：试运行是敏感动作，留痕才能回溯"谁在往哪儿打"
      audit.append({
        ts: nowIso(),
        requestId: `op_${randomBytes(8).toString('hex')}`,
        apiKeyId: null,
        channel: 'console',
        actor: `account:${me.id}`,
        toolName: `platforms/test:${p.slug}`,
        endpointId: null,
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        latencyMs: Date.now() - started,
        upstreamHost: res.host,
        errorCode: null,
        reqMeta: { baseUrl: p.baseUrl },
        respMeta: { bytes: res.bytes },
      });
      const view = buildDryRunView({
        status: res.status,
        latencyMs: Date.now() - started,
        upstreamHost: res.host,
        contentType: String(res.headers['content-type'] ?? ''),
        text: res.text,
        bytes: res.bytes,
        truncated: res.truncated,
        console: true,
      });
      return view;
    } catch (err) {
      const e = err as Error & { code?: string; status?: number };
      return {
        ok: false,
        status: 0,
        latencyMs: Date.now() - started,
        upstreamHost: '',
        contentType: '',
        bytes: 0,
        truncated: false,
        errorCode: e.code ?? 'upstream_unreachable',
        // 只说是哪一类问题，不回显任何内网细节
        hint: e.message,
      };
    }
  });

  /** 重新抓取站点标题（老平台名字还是域名时用） */
  app.post('/api/platforms/:id/refresh-title', async (req) => {
    requireAdminAccount(req);
    const { id } = req.params as { id: string };
    const p = platforms.get(id);
    if (!p) throw bad('平台不存在', 'not_found');

    const body = (req.body ?? {}) as { applyName?: boolean };
    // 只有平台被授权访问私网时才允许抓私网首页
    const info = await fetchSiteInfo(p.baseUrl, p.allowPrivate);
    if (info.title || info.icon) platforms.setSiteInfo(id, info.title, info.icon);

    // 默认只在名字还是「占位样」的时候才覆盖，避免冲掉用户手改的名字
    const looksAuto =
      !p.name || p.name === p.slug || /^[\d.]+(:\d+)?$/.test(p.name) || p.name.includes(p.slug);
    const applyName = body.applyName ?? looksAuto;
    if (info.title && applyName && p.name !== info.title) {
      platforms.update(id, { name: info.title });
    }

    const next = platforms.get(id)!;
    return {
      ok: Boolean(info.title),
      title: info.title,
      icon: info.icon,
      error: info.error ?? null,
      /** 最终名字是否就是站点标题 */
      appliedName: Boolean(info.title) && next.name === info.title,
      /** 这次是否真的改了名字 */
      renamed: next.name !== p.name,
      platform: next,
    };
  });

  /* ───────────── 接口资产 ───────────── */
  app.get('/api/endpoints', async (req) => {
    const q = req.query as { platformId?: string; status?: string; q?: string };
    return endpoints.list({ platformId: q.platformId, status: q.status, q: q.q });
  });

  app.post('/api/endpoints', async (req) => {
    requireAdminAccount(req);
    const body = req.body as { platformId?: unknown } & Record<string, unknown>;
    const platformId = typeof body.platformId === 'string' ? body.platformId : '';
    if (!platformId) throw bad('platformId 必须是非空字符串');
    const platform = platforms.get(platformId);
    if (!platform) throw bad('平台不存在', 'not_found');
    const parsed = EndpointInputSchema.safeParse(body);
    if (!parsed.success) throw bad(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    if (endpoints.bySlug(platformId, parsed.data.slug)) throw bad(`该平台下 slug 已存在：${parsed.data.slug}`);
    assertNoExampleSecretRefs(parsed.data as EndpointInput, platform);
    // 建完就发布，所以先校验形态，别留下一条发布不了的孤儿草稿
    assertPublishable(parsed.data);
    const ep = endpoints.create(platformId, parsed.data as EndpointInput, { sourceKind: 'manual' });
    publishAndCompile(ep.id);
    return endpoints.get(ep.id);
  });

  app.get('/api/endpoints/:id', async (req) => {
    const { id } = req.params as { id: string };
    const ep = endpoints.get(id);
    if (!ep) throw bad('接口不存在', 'not_found');
    return { ...ep, tool: tools.byEndpoint(ep.id) };
  });

  app.put('/api/endpoints/:id', async (req) => {
    requireAdminAccount(req);
    const { id } = req.params as { id: string };
    const parsed = EndpointInputSchema.safeParse(req.body);
    if (!parsed.success) throw bad(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const existing = endpoints.get(id);
    if (!existing) throw bad('接口不存在', 'not_found');
    const platform = platforms.get(existing.platformId);
    if (platform) assertNoExampleSecretRefs(parsed.data as EndpointInput, platform);
    // 已发布的接口改完就生效，读写属性和方法对不上同样不让存
    assertPublishable(parsed.data);
    const updated = endpoints.update(id, parsed.data as EndpointInput);
    if (!updated) throw bad('接口不存在', 'not_found');
    return updated;
  });

  app.delete('/api/endpoints/:id', async (req) => {
    requireAdminAccount(req);
    const { id } = req.params as { id: string };
    endpoints.remove(id);
    return { ok: true };
  });

  app.post('/api/endpoints/:id/publish', async (req) => {
    requireAdminAccount(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { note?: string };
    const published = publishAndCompile(id);
    if (!published) throw bad('接口不存在', 'not_found');
    if (body.note) endpoints.publish(id, body.note);
    return endpoints.get(id);
  });

  app.post('/api/endpoints/:id/archive', async (req) => {
    requireAdminAccount(req);
    const { id } = req.params as { id: string };
    endpoints.setStatus(id, 'archived');
    const tool = tools.byEndpoint(id);
    if (tool) tools.setEnabled(tool.id, false);
    return endpoints.get(id);
  });

  /**
   * 控制台试运行。
   *
   * 以前这个路由没有任何鉴权，而 testEndpoint 硬编码 channel='console'、
   * assertEndpointAccess 又对 console 无条件放行 —— 匿名者因此可以借网关之手
   * 解密 vault 里的任意密钥并出网。现在：
   *   1. 路由本身要求管理员（app.ts 的规则表里 /api/endpoints 已经是 admin 级）
   *   2. 这里再现场签发一份 console 凭据，让核心层独立校验一次
   */
  app.post('/api/endpoints/:id/test', async (req) => {
    const me = requireAdminAccount(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { args?: Record<string, unknown> };
    const grant = issueConsoleGrant({ id: me.id, role: me.role as 'admin' | 'member' });
    const result = await testEndpoint(id, body.args ?? {}, grant, `account:${me.id}`);
    return { ...result, data: scrubDeep(result.data, { secretValues: [] }) };
  });

  /* ───────────── 工具 ───────────── */
  app.get('/api/tools', async () => tools.list());

  app.patch('/api/tools/:id', async (req) => {
    requireAdminAccount(req);
    const { id } = req.params as { id: string };
    const tool = tools.get(id);
    if (!tool) throw bad('工具不存在', 'not_found');
    const body = (req.body ?? {}) as {
      name?: string;
      enabled?: boolean;
      title?: string;
      description?: string;
      cacheTtl?: number;
      namespace?: string;
    };

    // 工具名是调用方唯一看得到的标识，必须能改 ——
    // 自动生成的兜底名可能带着上游痕迹，改不了就只能删了重发。
    let name = tool.name;
    if (body.name !== undefined) {
      const next = body.name.trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(next)) {
        throw bad('工具名只能用字母、数字、下划线、短横线，长度 1–64', 'invalid_name');
      }
      const taken = tools.byName(next);
      if (taken && taken.id !== tool.id) throw bad(`名字 ${next} 已被其他工具占用`, 'name_taken');
      name = next;
    }

    return tools.upsert({
      endpointId: tool.endpointId,
      name,
      title: body.title ?? tool.title,
      description: body.description ?? tool.description,
      inputSchema: tool.inputSchema,
      cacheTtl: body.cacheTtl ?? tool.cacheTtl,
      annotations: tool.annotations,
      enabled: body.enabled ?? tool.enabled,
      namespace: body.namespace ?? tool.namespace,
    });
  });

  app.post('/api/tools/rebuild', async (req) => {
    requireAdminAccount(req);
    let rebuilt = 0;
    for (const ep of endpoints.list()) {
      if (ep.status !== 'published') continue;
      const platform = platforms.get(ep.platformId);
      const compiled = compileTool(ep, { platformName: platform?.name });
      const existing = tools.byEndpoint(ep.id);

      // 用户改过「对外名」就以它为准；没改过则保留工具页里手动改的名字
      let name = (ep.publicName ?? '').trim() ? compiled.name : (existing?.name ?? compiled.name);
      let i = 2;
      while (true) {
        const clash = tools.byName(name);
        if (!clash || clash.endpointId === ep.id) break;
        name = `${compiled.name}_${i}`.slice(0, 64);
        i += 1;
      }

      tools.upsert({
        endpointId: ep.id,
        name,
        title: compiled.title,
        description: compiled.description,
        inputSchema: compiled.inputSchema,
        cacheTtl: existing?.cacheTtl ?? compiled.cacheTtl,
        annotations: compiled.annotations,
        enabled: existing?.enabled ?? true,
      });
      rebuilt += 1;
    }
    return { rebuilt };
  });

  /* ───────────── 一键整理 ───────────── */
  app.post('/api/import', async (req) => {
    requireAdminAccount(req);
    const body = (req.body ?? {}) as {
      text?: string;
      kind?: string;
      platformSlug?: string;
      platformName?: string;
      useAi?: boolean;
      autoPublish?: boolean;
      probeUpstream?: boolean;
      maxProbes?: number;
      /** 同步等待完成（脚本/测试用）。默认 false，立即返回 jobId */
      wait?: boolean;
    };
    if (!body.text || !body.text.trim()) throw bad('请输入要整理的接口内容（curl / HAR / OpenAPI / 文档）');

    const opts = {
      text: body.text,
      kind: (body.kind as 'auto' | 'curl' | 'har' | 'openapi' | 'text') ?? 'auto',
      platformSlug: body.platformSlug || undefined,
      platformName: body.platformName || undefined,
      useAi: body.useAi !== false,
      autoPublish: Boolean(body.autoPublish),
      probeUpstream: body.probeUpstream !== false,
      maxProbes: typeof body.maxProbes === 'number' && body.maxProbes > 0 ? body.maxProbes : undefined,
    };

    if (body.wait) {
      // 同步模式：老行为，方便脚本一次性拿结果
      return runImport(opts);
    }
    // 默认异步：立即返回 jobId，后台继续跑
    return startBackgroundImport(opts);
  });

  /**
   * 导入任务事件流（SSE）
   *
   * 替代前端 1.2s/1.5s 轮询：服务端每完成一步就推一帧。
   * 首帧给全量快照，前端打开即渲染，不用等第一个事件。
   */
  app.get('/api/import/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (obj: unknown) => {
      // 客户端可能已经断开，写失败就忽略
      try {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        /* ignore */
      }
    };

    // 首帧快照
    send({ type: 'snapshot', jobs: listJobs(50) });

    const off = onJobEvent((event) => send({ type: 'job', ...event }));

    // 心跳：防止中间代理把空闲连接掐掉
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15000);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      off();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    return reply;
  });

  app.get('/api/import/jobs', async () => listJobs(100));

  app.get('/api/import/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) throw bad('任务不存在', 'not_found');
    return { job, candidates: importJobs.listCandidates(id) };
  });

  app.delete('/api/import/jobs/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (isRunning(id)) throw bad('任务正在运行，无法删除', 'job_running');
    const job = importJobs.get(id);
    if (!job) throw bad('任务不存在', 'not_found');
    importJobs.remove(id);
    return { ok: true };
  });

  app.post('/api/import/candidates/:id/accept', async (req) => {
    const { id } = req.params as { id: string };
    const res = acceptCandidate(id);
    if (!res) throw bad('候选不存在', 'not_found');
    return res;
  });

  app.post('/api/import/candidates/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    rejectCandidate(id);
    return { ok: true };
  });

  app.post('/api/import/jobs/:id/accept-all', async (req) => {
    const { id } = req.params as { id: string };
    const candidates = importJobs.listCandidates(id);
    let created = 0;
    let updated = 0;
    for (const c of candidates) {
      if (c.decision !== 'pending' || c.diffKind === 'duplicate' || c.diffKind === 'conflict') continue;
      const res = acceptCandidate(c.id);
      if (!res) continue;
      if (res.created) created += 1;
      else updated += 1;
    }
    return { created, updated };
  });

  /* ───────────── 密钥 / API Key ───────────── */
  app.get('/api/secrets', async () => secrets.list());

  app.post('/api/secrets', async (req) => {
    requireAdminAccount(req);
    const body = (req.body ?? {}) as { name?: string; value?: string; hint?: string };
    if (!body.name || !/^[A-Za-z0-9_.-]+$/.test(body.name)) throw bad('密钥名只能包含字母数字._-');
    if (!body.value) throw bad('密钥值不能为空');
    if (body.value.includes('${secret:')) throw bad('密钥值里不能再引用其他密钥', 'secret_ref_forbidden');
    const existed = Boolean(secrets.getCipher(body.name));
    secrets.put(body.name, encryptSecret(body.value), body.hint ?? '');
    audit.append({
      ts: new Date().toISOString(),
      requestId: `op_${randomBytes(8).toString('hex')}`,
      apiKeyId: null,
      channel: 'console',
      actor: actorOfRequest(req),
      toolName: `secrets/${existed ? 'rotate' : 'create'}:${body.name}`,
      endpointId: null,
      status: 200,
      ok: true,
      latencyMs: 0,
      upstreamHost: '',
      errorCode: null,
      reqMeta: { name: body.name, rotated: existed },
      respMeta: {},
    });
    return { ok: true, name: body.name };
  });

  app.delete('/api/secrets/:name', async (req) => {
    requireAdminAccount(req);
    const { name } = req.params as { name: string };
    secrets.remove(name);
    audit.append({
      ts: new Date().toISOString(),
      requestId: `op_${randomBytes(8).toString('hex')}`,
      apiKeyId: null,
      channel: 'console',
      actor: actorOfRequest(req),
      toolName: `secrets/delete:${name}`,
      endpointId: null,
      status: 200,
      ok: true,
      latencyMs: 0,
      upstreamHost: '',
      errorCode: null,
      reqMeta: { name },
      respMeta: {},
    });
    return { ok: true };
  });

  /* ───────────── API Key（令牌） ───────────── */

  // admin 看全部；member 只看自己名下
  app.get('/api/api-keys', async (req) => {
    const me = requireAccount(req);
    const list = me.role === 'admin' ? apiKeys.list() : apiKeys.listByAccount(me.id);
    return list.map((key) => ({ ...key, owner: key.accountId ? accounts.get(key.accountId) : null }));
  });

  app.post('/api/api-keys', async (req) => {
    const me = requireAccount(req);
    const body = (req.body ?? {}) as {
      label?: string;
      scopes?: { platforms?: string[]; tools?: string[] };
      accountId?: string | null;
      expiresAt?: string | null;
      quotaLimit?: number;
      quotaPeriod?: QuotaPeriod;
      ipAllowlist?: string[];
      notes?: string;
    };
    // 只有管理员能替别人建令牌
    const ownerId = me.role === 'admin' ? (body.accountId ?? me.id) : me.id;
    if (body.accountId && me.role !== 'admin' && body.accountId !== me.id) {
      throw bad('只能为自己创建令牌', 'forbidden');
    }
    if (ownerId && !accounts.get(ownerId)) throw bad('归属账号不存在', 'not_found');
    if (body.expiresAt) {
      const t = Date.parse(body.expiresAt);
      if (!Number.isFinite(t)) throw bad('过期时间格式不正确');
      if (t < Date.now()) throw bad('过期时间必须晚于当前时间');
    }
    const quotaLimit = Number(body.quotaLimit ?? 0);
    if (!Number.isFinite(quotaLimit) || quotaLimit < 0) throw bad('额度必须是不小于 0 的数字');

    const ipAllowlist = normalizeAllowlist(body.ipAllowlist);

    const raw = `hub_live_${randomBytes(24).toString('hex')}`;
    const id = apiKeys.create({
      label: body.label?.trim() || '默认令牌',
      prefix: raw.slice(0, 14),
      keyHash: sha256(raw),
      scopes: body.scopes ?? {},
      accountId: ownerId,
      expiresAt: body.expiresAt ?? null,
      quotaLimit,
      quotaPeriod: body.quotaPeriod ?? 'total',
      ipAllowlist,
      notes: body.notes ?? '',
    });
    return { id, key: raw };
  });

  app.patch('/api/api-keys/:id', async (req) => {
    const me = requireAccount(req);
    const { id } = req.params as { id: string };
    const key = apiKeys.get(id);
    if (!key) throw bad('令牌不存在', 'not_found');
    assertKeyOwner(me, key);

    const body = (req.body ?? {}) as {
      enabled?: boolean;
      label?: string;
      scopes?: { platforms?: string[]; tools?: string[] };
      expiresAt?: string | null;
      quotaLimit?: number;
      quotaPeriod?: QuotaPeriod;
      ipAllowlist?: string[];
      notes?: string;
      resetQuota?: boolean;
    };
    if (typeof body.enabled === 'boolean') apiKeys.setEnabled(id, body.enabled);
    if (body.resetQuota) apiKeys.resetQuota(id);

    const patch: Parameters<typeof apiKeys.update>[1] = {};
    if (body.label !== undefined) patch.label = body.label.trim() || key.label;
    if (body.scopes !== undefined) patch.scopes = body.scopes;
    if (body.ipAllowlist !== undefined) patch.ipAllowlist = normalizeAllowlist(body.ipAllowlist);
    if (body.expiresAt !== undefined) {
      if (body.expiresAt) {
        const t = Date.parse(body.expiresAt);
        if (!Number.isFinite(t)) throw bad('过期时间格式不正确');
      }
      patch.expiresAt = body.expiresAt;
    }
    if (body.quotaLimit !== undefined) {
      const v = Number(body.quotaLimit);
      if (!Number.isFinite(v) || v < 0) throw bad('额度必须是不小于 0 的数字');
      patch.quotaLimit = v;
    }
    if (body.quotaPeriod !== undefined) patch.quotaPeriod = body.quotaPeriod;
    if (body.notes !== undefined) patch.notes = body.notes;

    if (Object.keys(patch).length) apiKeys.update(id, patch);
    return { ok: true, key: apiKeys.get(id) };
  });

  app.delete('/api/api-keys/:id', async (req) => {
    const me = requireAccount(req);
    const { id } = req.params as { id: string };
    const key = apiKeys.get(id);
    if (!key) throw bad('令牌不存在', 'not_found');
    assertKeyOwner(me, key);
    apiKeys.remove(id);
    return { ok: true };
  });

  /** 某个令牌能看见哪些接口（控制台预览用） */
  app.get('/api/api-keys/:id/endpoints', async (req) => {
    const me = requireAccount(req);
    const { id } = req.params as { id: string };
    const key = apiKeys.get(id);
    if (!key) throw bad('令牌不存在', 'not_found');
    assertKeyOwner(me, key);

    const all = endpoints.list({ status: 'published' });
    const visible = all.filter((ep) => {
      if (ep.exposure === 'closed') return false;
      if (ep.exposure === 'restricted') return (ep.allowedKeyIds ?? []).includes(key.id);
      return true;
    });
    const toolByEndpoint = new Map(tools.list({ enabledOnly: true }).map((t) => [t.endpointId, t]));

    return visible.map((ep) => {
      const tool = toolByEndpoint.get(ep.id);
      return {
        id: ep.id,
        slug: ep.slug,
        publicName: ep.publicName,
        toolName: tool?.name ?? '',
        summary: ep.summary,
        notes: ep.notes,
        method: ep.method,
        sideEffect: ep.sideEffect,
        exposure: ep.exposure,
        platformSlug: ep.platformSlug,
        callable: Boolean(tool),
      };
    });
  });

  /* ───────────── 审计 / 设置 ───────────── */
  /**
   * 实时调用流水（SSE）
   *
   * 网关每调用一次就推一帧，概览页能看到请求实时滚进来。
   * 首帧给最近 20 条，打开页面立刻有内容，不用等第一次调用。
   */
  app.get('/api/audit/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (obj: unknown) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        /* 客户端已断开 */
      }
    };

    // 首帧：最近若干条，避免打开是空白
    send({ type: 'snapshot', records: scrubDeep(audit.list({ limit: 20 })) });

    const off = audit.subscribe((rec) => {
      // 控制台视图，和 GET /api/audit 一致：保留 upstreamHost 方便排查
      send({ type: 'record', record: scrubDeep(rec) });
    });

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15000);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      off();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    return reply;
  });

  app.get('/api/audit', async (req) => {
    requireAdminAccount(req);
    const q = req.query as { limit?: string; tool?: string };
    // 审计出口统一脱敏：errorCode/message 里可能夹带上游回显的密钥
    return scrubDeep(audit.list({ limit: q.limit ? Number(q.limit) : 100, tool: q.tool }));
  });

  app.get('/api/settings', async () => {
    const cfg = loadConfig();
    return {
      llm: llmView(cfg),
      egress: {
        allowPrivate: cfg.allowPrivateEgress,
        timeoutMs: cfg.egressTimeoutMs,
        maxBytes: cfg.egressMaxBytes,
      },
    };
  });

  app.put('/api/settings', async (req) => {
    requireAdminAccount(req);
    const body = (req.body ?? {}) as {
      llm?: {
        enabled?: boolean;
        baseUrl?: string;
        apiKey?: string;
        /** 显式清除已存的 apiKey（apiKey 传空字符串不等于清除） */
        clearApiKey?: boolean;
        model?: string;
        timeoutMs?: number;
        concurrency?: number;
      };
      /**
       * 乐观并发：前端提交它加载时看到的 updatedAt。
       * 不匹配说明期间被别人改过，直接拒绝，避免把别人的改动静默覆盖掉。
       * 不传则不做检查（脚本/接口直接调用）。
       */
      expectedUpdatedAt?: string | null;
    };
    const storedMeta = settings.get<Record<string, unknown>>('llm', {});
    const storedUpdatedAt = typeof storedMeta.updatedAt === 'string' ? storedMeta.updatedAt : null;
    if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== storedUpdatedAt) {
      const who = describeActor(storedMeta.updatedBy) ?? '别人';
      const when = storedUpdatedAt ?? '未知时间';
      throw bad(
        `LLM 配置已被 ${who} 在 ${when} 改过，你手上的是旧值。刷新页面确认后再保存。`,
        'settings_conflict',
      );
    }
    // LLM 的 apiKey 会被原样作为 Authorization 头发出去。
    // baseUrl 必须是受信主机，否则"改配置"就等于"把 key 送人"。
    if (body.llm?.baseUrl !== undefined) {
      const problem = isValidLlmBaseUrl(body.llm.baseUrl);
      if (problem) throw bad(problem, 'invalid_base_url');
    }
    const current = storedMeta;
    const next = { ...current, ...(body.llm ?? {}) } as Record<string, unknown>;
    // apiKey 留空表示「不修改」：保留已存的，不要删掉
    // 要清除必须显式传 clearApiKey: true
    const incoming = body.llm?.apiKey?.trim();
    if (body.llm?.clearApiKey) {
      delete next.apiKey;
      next.enabled = false;
    } else if (incoming) {
      next.apiKey = incoming;
    } else if (typeof current.apiKey === 'string' && current.apiKey) {
      next.apiKey = current.apiKey;
    } else {
      delete next.apiKey;
    }
    settings.set('llm', {
      ...next,
      updatedAt: new Date().toISOString(),
      updatedBy: actorOfRequest(req),
    });
    audit.append({
      ts: new Date().toISOString(),
      requestId: `op_${randomBytes(8).toString('hex')}`,
      apiKeyId: null,
      channel: 'console',
      actor: actorOfRequest(req),
      toolName: 'settings/update',
      endpointId: null,
      status: 200,
      ok: true,
      latencyMs: 0,
      upstreamHost: '',
      errorCode: null,
      reqMeta: { baseUrl: next.baseUrl, model: next.model, apiKeyChanged: Boolean(incoming) || Boolean(body.llm?.clearApiKey) },
      respMeta: {},
    });
    return { ok: true, llm: llmView() };
  });

  /* ───────────── 站内对话 ───────────── */

  /**
   * 会话标题/消息是"可回读的持久化文本"。
   *
   * 真实事故：服务端把解析后的密钥明文 POST 进会话标题落库，
   * 再用 GET 列表读回来 —— 写侧无校验、读侧无脱敏，脱敏彻底失效。
   * 现在两侧都堵：
   *   - 写侧：拒绝含已知密钥明文的文本
   *   - 读侧：统一 scrubDeep（明文 + 指纹 + 通用模式）
   */
  const secretRefusal = (text: string): void => {
    const hit = containsSecretValue(text, knownSecretPlaintexts());
    if (hit) throw bad('内容包含密钥明文，已拒绝写入', 'secret_value_forbidden');
  };

  app.post('/api/chat/sessions', async (req) => {
    requireAccount(req);
    const body = (req.body ?? {}) as { title?: string };
    const rawTitle = typeof body.title === 'string' ? body.title : '';
    if (rawTitle.length > 200) throw bad('会话标题最多 200 字');
    const title = scrubDeep(rawTitle);
    secretRefusal(title);
    return chats.createSession(title || '新会话');
  });

  app.get('/api/chat/sessions', async (req) => {
    requireAccount(req);
    return scrubDeep(chats.listSessions());
  });

  app.get('/api/chat/sessions/:id/messages', async (req) => {
    requireAccount(req);
    const { id } = req.params as { id: string };
    return scrubDeep(chats.listMessages(id));
  });

  app.delete('/api/chat/sessions/:id', async (req) => {
    requireAccount(req);
    const { id } = req.params as { id: string };
    chats.removeSession(id);
    return { ok: true };
  });

  app.post('/api/chat/sessions/:id/messages', async (req, reply) => {
    requireAccount(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { content?: string };
    if (!body.content?.trim()) throw bad('消息不能为空');
    secretRefusal(body.content);
    const session = chats.getSession(id);
    if (!session) throw bad('会话不存在', 'not_found');

    const cfg = loadConfig();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (obj: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(scrubDeep(obj))}\n\n`);
    };

    try {
      for await (const evt of runChat(cfg.llm, id, body.content)) {
        send(evt);
      }
    } catch (err) {
      send({ type: 'error', message: (err as Error).message });
    } finally {
      reply.raw.end();
    }
    return reply;
  });
}
