import type { FastifyInstance } from 'fastify';
import { applyUpdate, checkUpdate, localState } from '../update.ts';

/**
 * 在线更新。
 *
 * 只挂在 /api 下 —— 因此跟控制台其他端点一样走账号会话鉴权，
 * 未登录拿不到；不能让网关把「更新自己」这件事暴露给调用方。
 */
export function registerUpdateRoutes(app: FastifyInstance): void {
  /** 本地信息，不联网（页面打开就能显示） */
  app.get('/api/update', async () => localState());

  /** 联网检查（fetch + 比较，30 秒内复用结果） */
  app.get('/api/update/check', async (req) => {
    const force = (req.query as { force?: string } | undefined)?.force === '1';
    return checkUpdate(force);
  });

  /** 执行更新：pull → 必要时装依赖 → 重建前端 */
  app.post('/api/update/apply', async (_req, reply) => {
    const result = await applyUpdate();
    if (!result.ok) reply.status(409);
    return result;
  });
}
