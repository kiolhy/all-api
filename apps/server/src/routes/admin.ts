import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import {
  EndpointInputSchema,
  PlatformInputSchema,
  acceptCandidate,
  accounts,
  apiKeys,
  audit,
  chats,
  compileTool,
  endpoints,
  importJobs,
  loadConfig,
  ipAllowlistProblem,
  ipAllowed,
  platforms,
  publishAndCompile,
  rejectCandidate,
  runChat,
  runImport,
  secrets,
  settings,
  sha256,
  testEndpoint,
  tools,
  encryptSecret,
  fetchSiteInfo,
} from '@aah/core';
import type { AccountRecord, ApiKeyRecord, EndpointInput, PlatformInput, QuotaPeriod } from '@aah/core';
import { startBackgroundImport, listJobs, getJob, isRunning, onJobEvent } from '../import-runner.ts';

/** 业务错误码 → HTTP 状态码 */
const CODE_STATUS: Record<string, number> = {
  not_found: 404,
  job_running: 409,
  conflict: 409,
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

/** 设置页看到的 LLM 视图：不返回 apiKey 明文，只告诉有没有配 */
function llmView(cfg = loadConfig()) {
  return {
    enabled: cfg.llm.enabled,
    baseUrl: cfg.llm.baseUrl,
    model: cfg.llm.model,
    apiKeySet: Boolean(cfg.llm.apiKey),
    timeoutMs: cfg.llm.timeoutMs,
    concurrency: cfg.llm.concurrency,
    /** 想开但没 apiKey，会提示用户 */
    blockedByApiKey: !cfg.llm.apiKey,
  };
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
    const parsed = PlatformInputSchema.safeParse(req.body);
    if (!parsed.success) throw bad(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    if (platforms.bySlug(parsed.data.slug)) throw bad(`平台 slug 已存在：${parsed.data.slug}`);
    return platforms.create(parsed.data as PlatformInput);
  });

  app.get('/api/platforms/:id', async (req) => {
    const { id } = req.params as { id: string };
    const p = platforms.get(id);
    if (!p) throw bad('平台不存在', 'not_found');
    return p;
  });

  app.patch('/api/platforms/:id', async (req) => {
    const { id } = req.params as { id: string };
    const parsed = PlatformInputSchema.partial().safeParse(req.body);
    if (!parsed.success) throw bad(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const updated = platforms.update(id, parsed.data as Partial<PlatformInput>);
    if (!updated) throw bad('平台不存在', 'not_found');
    return updated;
  });

  app.delete('/api/platforms/:id', async (req) => {
    const { id } = req.params as { id: string };
    platforms.remove(id);
    return { ok: true };
  });

  app.post('/api/platforms/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    const p = platforms.get(id);
    if (!p) throw bad('平台不存在', 'not_found');
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(p.baseUrl, {
        method: 'GET',
        headers: { Accept: 'application/json', ...p.defaultHeaders },
        signal: controller.signal,
      });
      const text = await res.text();
      return {
        ok: res.status < 500,
        status: res.status,
        latencyMs: Date.now() - started,
        sample: text.slice(0, 300),
      };
    } catch (err) {
      return { ok: false, status: 0, latencyMs: Date.now() - started, sample: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  });

  /** 重新抓取站点标题（老平台名字还是域名时用） */
  app.post('/api/platforms/:id/refresh-title', async (req) => {
    const { id } = req.params as { id: string };
    const p = platforms.get(id);
    if (!p) throw bad('平台不存在', 'not_found');

    const body = (req.body ?? {}) as { applyName?: boolean };
    const info = await fetchSiteInfo(p.baseUrl);
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
    const body = req.body as { platformId?: unknown } & Record<string, unknown>;
    const platformId = typeof body.platformId === 'string' ? body.platformId : '';
    if (!platformId) throw bad('platformId 必须是非空字符串');
    const platform = platforms.get(platformId);
    if (!platform) throw bad('平台不存在', 'not_found');
    const parsed = EndpointInputSchema.safeParse(body);
    if (!parsed.success) throw bad(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    if (endpoints.bySlug(platformId, parsed.data.slug)) throw bad(`该平台下 slug 已存在：${parsed.data.slug}`);
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
    const { id } = req.params as { id: string };
    const parsed = EndpointInputSchema.safeParse(req.body);
    if (!parsed.success) throw bad(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const updated = endpoints.update(id, parsed.data as EndpointInput);
    if (!updated) throw bad('接口不存在', 'not_found');
    return updated;
  });

  app.delete('/api/endpoints/:id', async (req) => {
    const { id } = req.params as { id: string };
    endpoints.remove(id);
    return { ok: true };
  });

  app.post('/api/endpoints/:id/publish', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { note?: string };
    const published = publishAndCompile(id);
    if (!published) throw bad('接口不存在', 'not_found');
    if (body.note) endpoints.publish(id, body.note);
    return endpoints.get(id);
  });

  app.post('/api/endpoints/:id/archive', async (req) => {
    const { id } = req.params as { id: string };
    endpoints.setStatus(id, 'archived');
    const tool = tools.byEndpoint(id);
    if (tool) tools.setEnabled(tool.id, false);
    return endpoints.get(id);
  });

  app.post('/api/endpoints/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { args?: Record<string, unknown> };
    const result = await testEndpoint(id, body.args ?? {});
    return { ...result, data: result.data };
  });

  /* ───────────── 工具 ───────────── */
  app.get('/api/tools', async () => tools.list());

  app.patch('/api/tools/:id', async (req) => {
    const { id } = req.params as { id: string };
    const tool = tools.get(id);
    if (!tool) throw bad('工具不存在', 'not_found');
    const body = (req.body ?? {}) as {
      enabled?: boolean;
      title?: string;
      description?: string;
      cacheTtl?: number;
      namespace?: string;
    };
    return tools.upsert({
      endpointId: tool.endpointId,
      name: tool.name,
      title: body.title ?? tool.title,
      description: body.description ?? tool.description,
      inputSchema: tool.inputSchema,
      cacheTtl: body.cacheTtl ?? tool.cacheTtl,
      annotations: tool.annotations,
      enabled: body.enabled ?? tool.enabled,
      namespace: body.namespace ?? tool.namespace,
    });
  });

  app.post('/api/tools/rebuild', async () => {
    let rebuilt = 0;
    for (const ep of endpoints.list()) {
      if (ep.status !== 'published') continue;
      const platform = platforms.get(ep.platformId);
      const compiled = compileTool(ep, { platformName: platform?.name });
      const existing = tools.byEndpoint(ep.id);
      tools.upsert({
        endpointId: ep.id,
        name: existing?.name ?? compiled.name,
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
    const body = (req.body ?? {}) as { name?: string; value?: string; hint?: string };
    if (!body.name || !/^[A-Za-z0-9_.-]+$/.test(body.name)) throw bad('密钥名只能包含字母数字._-');
    if (!body.value) throw bad('密钥值不能为空');
    secrets.put(body.name, encryptSecret(body.value), body.hint ?? '');
    return { ok: true, name: body.name };
  });

  app.delete('/api/secrets/:name', async (req) => {
    const { name } = req.params as { name: string };
    secrets.remove(name);
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
    send({ type: 'snapshot', records: audit.list({ limit: 20 }) });

    const off = audit.subscribe((rec) => {
      // 控制台视图，和 GET /api/audit 一致：保留 upstreamHost 方便排查
      send({ type: 'record', record: rec });
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
    const q = req.query as { limit?: string; tool?: string };
    return audit.list({ limit: q.limit ? Number(q.limit) : 100, tool: q.tool });
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
    };
    const current = settings.get<Record<string, unknown>>('llm', {});
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
    settings.set('llm', next);
    return { ok: true, llm: llmView() };
  });

  /* ───────────── 站内对话 ───────────── */
  app.post('/api/chat/sessions', async (req) => {
    const body = (req.body ?? {}) as { title?: string };
    return chats.createSession(body.title || '新会话');
  });

  app.get('/api/chat/sessions', async () => chats.listSessions());

  app.get('/api/chat/sessions/:id/messages', async (req) => {
    const { id } = req.params as { id: string };
    return chats.listMessages(id);
  });

  app.delete('/api/chat/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    chats.removeSession(id);
    return { ok: true };
  });

  app.post('/api/chat/sessions/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { content?: string };
    if (!body.content?.trim()) throw bad('消息不能为空');
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
      reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
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
