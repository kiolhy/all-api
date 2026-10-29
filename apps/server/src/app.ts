import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { loadConfig, resolveSession, VERSION, WEB_DIST } from '@aah/core';
import { registerAdminRoutes } from './routes/admin.ts';
import { bearerToken, registerAuthRoutes } from './routes/auth.ts';
import { registerGatewayRoutes } from './routes/gateway.ts';
import { registerUpdateRoutes } from './routes/update.ts';

export function buildApp(): FastifyInstance {
  const cfg = loadConfig();
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: undefined,
    },
    bodyLimit: 8 * 1024 * 1024,
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

  app.get('/api/health', async () => ({
    ok: true,
    version: VERSION,
    llm: { enabled: cfg.llm.enabled, model: cfg.llm.model },
    auth: 'account',
  }));

  // 管理 API 鉴权：账号会话（Authorization: Bearer <session token>）
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    // 公开端点
    if (url === '/api/health' || url === '/api/auth/login') return;
    if (url.startsWith('/api/auth/')) {
      // 其余 auth 端点自行校验，但这里先解析出身份挂到 req 上
      const acc = resolveSession(bearerToken(req));
      (req as FastifyRequest & { account?: unknown }).account = acc;
      return;
    }

    const acc = resolveSession(bearerToken(req));
    if (!acc) {
      reply.status(401).send({ error: { code: 'unauthorized', message: '请先登录' } });
      return;
    }
    (req as FastifyRequest & { account?: unknown }).account = acc;
  });

  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerGatewayRoutes(app);
  registerUpdateRoutes(app);

  const webDist = WEB_DIST;
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/gw')) {
        reply.status(404).send({ error: { code: 'not_found', message: `无此路由：${req.url}` } });
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
