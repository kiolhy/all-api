/**
 * 本地假上游：用于集成测试与演示。不要暴露到公网。
 */
import Fastify, { type FastifyInstance } from 'fastify';

export function buildMockUpstream(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/api/v1/users/:id', async (req, reply) => {
    const auth = req.headers['authorization'] ?? '';
    if (!auth.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'unauthorized', hint: '需要 Bearer token' });
    }
    const { id } = req.params as { id: string };
    return {
      data: {
        id,
        name: `用户${id}`,
        email: `user${id}@example.com`,
        token: 'super-secret-token-should-be-redacted',
        profile: { city: '杭州', age: 30 },
      },
      trace: { upstream: 'mock', latency: 1 },
    };
  });

  app.get('/api/v1/orders', async (req) => {
    const q = req.query as { limit?: string };
    const limit = Number(q.limit ?? 3);
    return {
      data: {
        total: 12,
        items: Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
          id: `ord_${i + 1}`,
          amount: 100 + i,
          status: i % 2 === 0 ? 'paid' : 'pending',
        })),
      },
    };
  });

  app.post('/api/v1/echo', async (req) => ({ data: { received: req.body ?? null } }));

  app.get('/api/v1/slow', async () => {
    await new Promise((r) => setTimeout(r, 3000));
    return { data: 'slow-ok' };
  });

  app.get('/api/v1/boom', async (_req, reply) => reply.status(500).send({ error: 'upstream exploded' }));

  app.get('/api/v1/redirect', async (_req, reply) => reply.status(302).header('Location', 'http://evil.example.com/x').send());

  app.get('/api/v1/big', async () => ({ data: 'x'.repeat(5000) }));

  // 把请求头原样回显：用来验证「网关自己的密钥被上游回显时必须挡住」
  app.get('/api/v1/whoami', async (req) => ({
    auth: req.headers['authorization'] ?? '',
    echo: req.headers['x-echo'] ?? '',
  }));

  return app;
}

const isMain = process.argv[1] && /mock-upstream[\\/]src[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const port = Number(process.env.MOCK_PORT ?? 8899);
  const app = buildMockUpstream();
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`mock upstream: http://127.0.0.1:${port}`);
}
