import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  apiKeys,
  apiKeyProblem,
  buildLlmsTxt,
  buildOpenApiDoc,
  endpoints,
  invokeEndpoint,
  invokeTool,
  ipAllowed,
  platforms,
  sha256,
  tools,
  type EndpointRecord,
  type KeyScopes,
} from '@aah/core';

function deny(reply: FastifyReply, status: number, code: string, message: string) {
  reply.status(status).send({ error: { code, message } });
}

type KeyCtx = { apiKeyId?: string; scopes?: KeyScopes };

/** 令牌是否能看见某个接口（用于列表/文档过滤） */
function visibleTo(endpoint: EndpointRecord, apiKeyId: string | null): boolean {
  if (endpoint.exposure === 'closed') return false;
  if (endpoint.exposure === 'restricted') {
    return Boolean(apiKeyId && (endpoint.allowedKeyIds ?? []).includes(apiKeyId));
  }
  return true;
}

export function registerGatewayRoutes(app: FastifyInstance): void {
  // 网关鉴权：x-api-key
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/gw/v1')) return;
    const raw = req.headers['x-api-key'];
    if (typeof raw !== 'string' || !raw) {
      deny(reply, 401, 'unauthorized', '缺少 x-api-key');
      return;
    }
    const found = apiKeys.byHash(sha256(raw));
    if (!found) {
      deny(reply, 401, 'invalid_key', 'API Key 无效');
      return;
    }
    // 周期额度到点先清零，再判断可用性
    apiKeys.rollQuotaIfDue(found.id);
    const key = apiKeys.get(found.id) ?? found;
    const problem = apiKeyProblem(key);
    if (problem) {
      const status = problem.code === 'invalid_key' ? 401 : 403;
      deny(reply, status, problem.code, problem.message);
      return;
    }
    // IP 白名单：配了白名单就只放行名单内的来源
    const clientIp = req.ip || '';
    if (!ipAllowed(clientIp, key.ipAllowlist)) {
      deny(reply, 403, 'ip_forbidden', `来源 IP ${clientIp} 不在该 Key 的白名单内`);
      return;
    }
    const ctx = req as FastifyRequest & KeyCtx;
    ctx.apiKeyId = key.id;
    ctx.scopes = key.scopes as KeyScopes;
  });

  /**
   * 自省：用当前 Key 查询「我能调用哪些接口」。
   * 只返回该 Key 可见的接口，且不含任何上游域名/路径/密钥信息。
   */
  app.get('/gw/v1/me', async (req, reply) => {
    const { apiKeyId } = req as FastifyRequest & KeyCtx;
    const key = apiKeyId ? apiKeys.get(apiKeyId) : null;
    if (!key) return deny(reply, 401, 'unauthorized', '缺少 x-api-key');

    const eps = new Map(endpoints.list({ status: 'published' }).map((e) => [e.id, e]));
    const visible = tools
      .list({ enabledOnly: true })
      .filter((t) => {
        const ep = eps.get(t.endpointId);
        return ep ? visibleTo(ep, key.id) : false;
      });

    const items = visible.map((t) => {
      const ep = eps.get(t.endpointId)!;
      // 入参只给名字、类型、是否必填、说明，不给示例值里的上游痕迹
      const params = ep.params
        .filter((p) => !p.secretRef)
        .map((p) => ({
          name: p.name,
          in: p.in,
          type: p.type,
          required: Boolean(p.required),
          description: p.description ?? '',
          ...(p.enum?.length ? { enum: p.enum } : {}),
        }));
      return {
        name: t.name,
        title: t.title || t.name,
        description: ep.summary || '',
        notes: ep.notes || '',
        method: ep.method,
        sideEffect: ep.sideEffect,
        params,
        call: {
          byName: `GET /gw/v1/${t.name}`,
          byTool: `POST /gw/v1/call  {"tool":"${t.name}","args":{...}}`,
        },
      };
    });

    const quota =
      key.quotaLimit > 0
        ? {
            limit: key.quotaLimit,
            used: key.quotaUsed,
            remaining: Math.max(0, key.quotaLimit - key.quotaUsed),
            period: key.quotaPeriod,
            resetAt: key.quotaResetAt,
          }
        : { limit: 0, used: key.quotaUsed, remaining: null, period: key.quotaPeriod, resetAt: null };

    return {
      ok: true,
      key: {
        label: key.label,
        prefix: key.prefix,
        expiresAt: key.expiresAt,
        ipAllowlist: key.ipAllowlist,
        callCount: key.callCount,
      },
      quota,
      endpointCount: items.length,
      endpoints: items,
    };
  });

  app.get('/gw/v1/tools', async (req) => {
    const { apiKeyId } = req as FastifyRequest & KeyCtx;
    const eps = new Map(endpoints.list({ status: 'published' }).map((e) => [e.id, e]));
    return tools
      .list({ enabledOnly: true })
      .filter((t) => {
        const ep = eps.get(t.endpointId);
        return ep ? visibleTo(ep, apiKeyId ?? null) : false;
      })
      .map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      }));
  });

  app.post('/gw/v1/call', async (req, reply) => {
    const body = (req.body ?? {}) as { tool?: string; args?: Record<string, unknown> };
    if (!body.tool) return deny(reply, 400, 'bad_request', '缺少 tool 字段');
    const { apiKeyId, scopes } = req as FastifyRequest & KeyCtx;
    const toolResult = await invokeTool(body.tool, body.args ?? {}, 'rest', apiKeyId ?? null, scopes);
    if (apiKeyId) apiKeys.recordCall(apiKeyId);
    return reply.status(toolResult.ok ? 200 : toolResult.status).send(toolResult);
  });

  // 按对外工具名直连：/gw/v1/<对外名>，不暴露平台与上游路径
  app.all('/gw/v1/:toolName', async (req, reply) => {
    const { toolName: name } = req.params as { toolName: string };
    if (name === 'call' || name === 'tools' || name === 'me') {
      return deny(reply, 404, 'not_found', '路径不存在');
    }
    // 不在这里预检工具是否存在：交给 invokeTool 统一处理，
    // 这样「工具名写错」也会留一条审计，流水里能看到。

    const query = (req.query ?? {}) as Record<string, string>;
    const args: Record<string, unknown> = { ...query };
    if (req.method !== 'GET' && req.body) {
      Object.assign(args, req.body as Record<string, unknown>);
    }
    const { apiKeyId, scopes } = req as FastifyRequest & KeyCtx;
    const toolResult = await invokeTool(name, args, 'rest', apiKeyId ?? null, scopes);
    if (apiKeyId) apiKeys.recordCall(apiKeyId);
    return reply.status(toolResult.ok ? 200 : toolResult.status).send(toolResult);
  });

  app.get('/gw/openapi.json', async (req) => {
    const { apiKeyId } = req as FastifyRequest & KeyCtx;
    const allEndpoints = endpoints.list({ status: 'published' }).filter((e) => visibleTo(e, apiKeyId ?? null));
    const visibleIds = new Set(allEndpoints.map((e) => e.id));
    const allTools = tools.list({ enabledOnly: true }).filter((t) => visibleIds.has(t.endpointId));
    const byId = new Map(allEndpoints.map((e) => [e.id, e]));
    const host = req.headers.host ?? '127.0.0.1:8778';
    return buildOpenApiDoc({
      tools: allTools,
      platforms: platforms.list(),
      endpointById: byId,
      serverUrl: `http://${host}`,
    });
  });

  app.get('/gw/llms.txt', async (req, reply) => {
    const { apiKeyId } = req as FastifyRequest & KeyCtx;
    const eps = new Map(endpoints.list({ status: 'published' }).map((e) => [e.id, e]));
    const list = tools.list({ enabledOnly: true }).filter((t) => {
      const ep = eps.get(t.endpointId);
      return ep ? visibleTo(ep, apiKeyId ?? null) : false;
    });
    const host = req.headers.host ?? '127.0.0.1:8778';
    reply.type('text/plain; charset=utf-8');
    return buildLlmsTxt(list, `http://${host}`);
  });
}
