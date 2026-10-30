import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import {
  actorOf,
  decideAccess,
  loadConfig,
  normalizeRequestPath,
  pathStartsWith,
  resolveSession,
  setSelfTargets,
  VERSION,
  WEB_DIST,
  type AccountRecord,
  type AuthContext,
  type NormalizedPath,
} from '@aah/core';
import { registerAdminRoutes } from './routes/admin.ts';
import { bearerToken, registerAuthRoutes } from './routes/auth.ts';
import { registerGatewayRoutes } from './routes/gateway.ts';
import { registerUpdateRoutes } from './routes/update.ts';

type WithAuth = FastifyRequest & { auth?: AuthContext; account?: AccountRecord | null };

/**
 * 把「规范化后的路径」挂到请求上，供后续所有鉴权判断使用。
 *
 * 为什么不再用 req.url：
 *   find-my-way 会先解码 `%61` → `a` 再匹配路由，
 *   而上游鉴权如果用未解码的原始 URL 做 `startsWith('/api/')`，
 *   `/%61pi/settings` 就会同时"不像 /api"又"命中 /api/settings"。
 * 真实事故里这条差异让整套写接口裸奔了（包括可以解密任意 vault 密钥）。
 */
function attachPath(req: FastifyRequest): NormalizedPath {
  return normalizeRequestPath(req.url);
}

function fail(reply: FastifyReply, status: number, code: string, message: string): void {
  reply.status(status).send({ error: { code, message } });
}

export function buildApp(): FastifyInstance {
  const cfg = loadConfig();
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: undefined,
      // 请求日志里也不许出现原始 URL 的异常编码（避免靠日志做指纹探测）
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-api-key'],
    },
    bodyLimit: 8 * 1024 * 1024,
    // 路由匹配不区分大小写，鉴权判断也统一小写，避免 `/%41PI` 这一类的差异
    routerOptions: { caseSensitive: false, ignoreTrailingSlash: true },
  });

  // 记录本进程监听地址：拒绝"网关请求自己"的出网链路
  app.addHook('onReady', async () => {
    const addr = app.server.address();
    if (addr && typeof addr === 'object') setSelfTargets({ host: addr.address, port: addr.port });
    else setSelfTargets({ host: cfg.host, port: cfg.port });
  });

  app.register(cors, {
    origin: true,
    credentials: true,
    allowedHeaders: ['content-type', 'x-admin-token', 'x-api-key', 'authorization', 'x-session-token'],
  });

  // 容忍「声明了 application/json 但 body 为空」的请求。
  // DELETE 带 content-type 却不带 body 是很常见的客户端写法，
  // Fastify 默认会因为空 body 直接 400，这里把它当成 {}。
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const text = typeof body === 'string' ? body.trim() : '';
      if (!text) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        const e = err as Error & { statusCode?: number; code?: string };
        e.statusCode = 400;
        e.code = 'invalid_json';
        done(e, undefined);
      }
    },
  );

  app.setErrorHandler((err, req, reply) => {
    const e = err as { code?: string; statusCode?: number; status?: number; message?: string };
    const status = e.statusCode ?? e.status ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    reply.status(status).send({
      error: {
        code: typeof e.code === 'string' ? e.code : 'internal_error',
        message: e.message ?? '未知错误',
      },
    });
  });

  /**
   * 第一道闸：路径安全。
   *
   * 只要路径里出现「解码后语义会变」的写法（多重编码、`%2f`、反斜杠、控制字符…），
   * 就直接 400 —— 而不是猜一个路径去鉴权。
   * 这是把「鉴权用 A、路由用 B」这类不一致从根上掐掉。
   */
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const n = attachPath(req);
    (req as WithAuth & { normPath?: NormalizedPath }).normPath = n;
    if (!n.ok) {
      fail(reply, 400, 'bad_path', `请求路径不合法：${n.reason}`);
      return reply;
    }
    return;
  });

  app.get('/api/health', async () => {
    // 每次现读：设置页刚保存的 LLM 配置要立刻反映出来，
    // 不能拿建 app 时闭包里的那份快照（会一直显示重启前的状态）。
    const live = loadConfig();
    return {
      ok: true,
      version: VERSION,
      llm: { enabled: live.llm.enabled, model: live.llm.model },
      auth: 'account',
    };
  });

  /**
   * 第二道闸：路由级账号鉴权（默认拒绝）。
   *
   * 判断依据是「规范化后的路径 + 规则表」，而不是"原始 URL 前缀"。
   * 规则表见 packages/core/src/security/access-control.ts：
   *   - 公开：/api/health、/api/auth/login、/gw/*（自带 x-api-key 校验）
   *   - 管理员：secrets / platforms / endpoints / tools / settings / accounts / update /
   *            import / audit / stats，以及 /api 下任何未登记的新路由
   *   - 登录即可：chat / api-keys / auth
   */
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const bound = (req as WithAuth & { normPath?: NormalizedPath }).normPath;
    const n = bound ?? attachPath(req);
    if (!n.ok) {
      fail(reply, 400, 'bad_path', `请求路径不合法：${n.reason}`);
      return reply;
    }

    const decision = decideAccess(n);
    const ctx: AuthContext = { account: null, actor: 'anonymous', admin: false };
    const withAuth = req as WithAuth;
    withAuth.auth = ctx;
    withAuth.account = null;

    if (decision.kind === 'public') return;

    const account = resolveSession(bearerToken(req));
    if (!account) {
      fail(reply, 401, 'unauthorized', '请先登录');
      return reply;
    }
    ctx.account = account;
    ctx.actor = actorOf(account);
    ctx.admin = account.role === 'admin';
    withAuth.account = account;

    if (decision.kind === 'admin' && !ctx.admin) {
      fail(reply, 403, 'forbidden', '需要管理员权限');
      return reply;
    }
    return;
  });

  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerGatewayRoutes(app);
  registerUpdateRoutes(app);

  const webDist = WEB_DIST;
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      const n = attachPath(req);
      // 任何命中 /api 或 /gw 的请求都不该回落成 SPA 页面：
      // 以前 `/api%2faccounts`、`/%41PI/accounts` 这类请求会拿到 200 + index.html，
      // 既掩盖了真实错误，又给了探测者"路由存在性"的信号。
      if (!n.ok) {
        reply.status(400).send({ error: { code: 'bad_path', message: `请求路径不合法：${n.reason}` } });
        return;
      }
      if (pathStartsWith(n.path, '/api') || pathStartsWith(n.path, '/gw')) {
        reply.status(404).send({ error: { code: 'not_found', message: `无此路由：${n.path}` } });
        return;
      }
      reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({
      ok: true,
      hint: '控制台尚未构建：npm run web（开发）或 npx vite build --config apps/web/vite.config.ts（生产）',
    }));
  }

  return app;
}
