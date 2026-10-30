import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  apiKeys,
  apiKeyProblem,
  buildLlmsTxt,
  buildOpenApiDoc,
  endpoints,
  invokeTool,
  ipAllowed,
  paramHint,
  platforms,
  sha256,
  stripPathParenthetical,
  tools,
  type EndpointRecord,
  type KeyScopes,
} from '@aah/core';
import { accountOf, isAdminRequest } from './identity.ts';

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

/**
 * 网关鉴权：x-api-key。
 *
 * 历史漏洞：以前这个钩子注册在 `registerGatewayRoutes(app)` 里，用
 * `req.url.startsWith('/gw/v1')` 判断是否属于网关 —— 而 find-my-way 会先解码
 * `%67` → `g`，于是 `/%67w/v1/tools` 绕过钩子、又命中真实路由，匿名就能调全部工具。
 *
 * 现在的做法有三层：
 *   1. 路由整体挂进 `/gw` 作用域的**子实例**里，钩子只在这个作用域生效
 *      （不再靠字符串前缀判断"我是不是网关"）
 *   2. 每个 handler 内部还要显式校验 apiKeyId（纵深防御，钩子失效也不会裸奔）
 *   3. 文件类出口（llms.txt / openapi.json）额外要求管理员会话或有效 key
 */
export function registerGatewayRoutes(app: FastifyInstance): void {
  app.register(
    async (gw) => {
      gw.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
        const raw = req.headers['x-api-key'];
        if (typeof raw !== 'string' || !raw) {
          deny(reply, 401, 'unauthorized', '缺少 x-api-key');
          return reply;
        }
        const found = apiKeys.byHash(sha256(raw));
        if (!found) {
          deny(reply, 401, 'invalid_key', 'API Key 无效');
          return reply;
        }
        // 周期额度到点先清零，再判断可用性
        apiKeys.rollQuotaIfDue(found.id);
        const key = apiKeys.get(found.id) ?? found;
        const problem = apiKeyProblem(key);
        if (problem) {
          const status = problem.code === 'invalid_key' ? 401 : 403;
          deny(reply, status, problem.code, problem.message);
          return reply;
        }
        // IP 白名单：配了白名单就只放行名单内的来源
        const clientIp = req.ip || '';
        if (!ipAllowed(clientIp, key.ipAllowlist)) {
          deny(reply, 403, 'ip_forbidden', `来源 IP ${clientIp} 不在该 Key 的白名单内`);
          return reply;
        }
        const ctx = req as FastifyRequest & KeyCtx;
        ctx.apiKeyId = key.id;
        ctx.scopes = key.scopes as KeyScopes;
        return;
      });

      /** 纵深防御：handler 内再确认一次"确实带了有效 key" */
      function requireKey(req: FastifyRequest, reply: FastifyReply): KeyCtx | null {
        const ctx = req as FastifyRequest & KeyCtx;
        if (!ctx.apiKeyId) {
          deny(reply, 401, 'unauthorized', '缺少 x-api-key');
          return null;
        }
        return ctx;
      }

      /**
       * 自省：用当前 Key 查询「我能调用哪些接口」。
       * 只返回该 Key 可见的接口，且不含任何上游域名/路径/密钥信息。
       */
      gw.get('/v1/me', async (req, reply) => {
        const ctx = requireKey(req, reply);
        if (!ctx) return reply;
        const key = apiKeys.get(ctx.apiKeyId!);
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
              description: p.description?.trim() || paramHint(p),
              ...(p.enum?.length ? { enum: p.enum } : {}),
            }));
          return {
            name: t.name,
            title: t.title || t.name,
            // 用编译后的工具文案，不要直接拿 ep.summary —— 那是上游原文
            description: t.description || '',
            notes: stripPathParenthetical(ep.notes || ''),
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

      gw.get('/v1/tools', async (req, reply) => {
        const ctx = requireKey(req, reply);
        if (!ctx) return reply;
        const eps = new Map(endpoints.list({ status: 'published' }).map((e) => [e.id, e]));
        return tools
          .list({ enabledOnly: true })
          .filter((t) => {
            const ep = eps.get(t.endpointId);
            return ep ? visibleTo(ep, ctx.apiKeyId ?? null) : false;
          })
          .map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          }));
      });

      gw.post('/v1/call', async (req, reply) => {
        const ctx = requireKey(req, reply);
        if (!ctx) return reply;
        const body = (req.body ?? {}) as { tool?: string; args?: Record<string, unknown> };
        if (!body.tool) return deny(reply, 400, 'bad_request', '缺少 tool 字段');
        const toolResult = await invokeTool(
          body.tool,
          body.args ?? {},
          'rest',
          ctx.apiKeyId ?? null,
          ctx.scopes,
          ctx.apiKeyId ? `key:${ctx.apiKeyId}` : 'anonymous',
        );
        if (ctx.apiKeyId) apiKeys.recordCall(ctx.apiKeyId);
        return reply.status(toolResult.ok ? 200 : toolResult.status).send(toolResult);
      });

      // 按对外工具名直连：/gw/v1/<对外名>，不暴露平台与上游路径
      gw.all('/v1/:toolName', async (req, reply) => {
        const ctx = requireKey(req, reply);
        if (!ctx) return reply;
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
        const toolResult = await invokeTool(
          name,
          args,
          'rest',
          ctx.apiKeyId ?? null,
          ctx.scopes,
          ctx.apiKeyId ? `key:${ctx.apiKeyId}` : 'anonymous',
        );
        if (ctx.apiKeyId) apiKeys.recordCall(ctx.apiKeyId);
        return reply.status(toolResult.ok ? 200 : toolResult.status).send(toolResult);
      });

      /**
       * 文档类出口：以前是**完全匿名**可读的（`/gw/llms.txt`），
       * 谁都能看到「这个网关暴露了哪些工具」。现在要求：
       *   - 有效 API Key（就按该 Key 的可见性过滤），或
       *   - 已登录的管理员会话
       */
      function docAccessOk(req: FastifyRequest): boolean {
        if (isAdminRequest(req) || accountOf(req)) return true;
        return Boolean((req as FastifyRequest & KeyCtx).apiKeyId);
      }

      gw.get('/openapi.json', async (req, reply) => {
        if (!docAccessOk(req)) return deny(reply, 401, 'unauthorized', '需要 API Key 或管理员登录');
        const { apiKeyId } = req as FastifyRequest & KeyCtx;
        const allEndpoints = endpoints
          .list({ status: 'published' })
          .filter((e) => visibleTo(e, apiKeyId ?? null));
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

      gw.get('/llms.txt', async (req, reply) => {
        if (!docAccessOk(req)) return deny(reply, 401, 'unauthorized', '需要 API Key 或管理员登录');
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
    },
    { prefix: '/gw' },
  );
}
